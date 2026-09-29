import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { GPUInfo, HardwareInfo, ModelFit } from '../shared/types';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
type Data = Record<string, unknown>;
type DetectedGPU = GPUInfo & { bus?: string };
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : value == null ? [] : [value];
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const positive = (value: unknown): number | null => { const number = Number(value); return Number.isFinite(number) && number > 0 && number <= Number.MAX_SAFE_INTEGER ? number : null; };
const vendor = (name: string): string => /nvidia/i.test(name) ? 'NVIDIA' : /amd|radeon|advanced micro devices/i.test(name) ? 'AMD' : /intel/i.test(name) ? 'Intel' : /apple/i.test(name) ? 'Apple' : 'Unknown';
const busId = (bus: string): string => bus.toLowerCase().replace(/^00000000:/, '0000:');

/** Run only fixed read-only hardware commands, never through a shell. */
function command(file: string, args: string[], timeout = 7000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { shell: false, windowsHide: true, timeout, maxBuffer: 512 * 1024, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

function parseJson(raw: string): Data {
  try { return object(JSON.parse(raw.replace(/^\uFEFF/, ''))); } catch { return {}; }
}

/** nvidia-smi: --query-gpu=name,memory.total,pci.bus_id --format=csv,noheader,nounits */
export function parseNvidiaSmi(raw: string): DetectedGPU[] {
  return raw.split(/\r?\n/).flatMap(line => {
    const match = /^\s*(.+?),\s*([\d.]+|\[?N\/A\]?)\s*,\s*([0-9a-f:.]+)\s*$/i.exec(line);
    if (!match) return [];
    const memory = positive(match[2]);
    return [{ name: match[1].replace(/^"|"$/g, ''), vendor: 'NVIDIA', memoryBytes: memory ? Math.round(memory * MiB) : null, unified: false, bus: busId(match[3]) }];
  });
}

export function parseLinuxMeminfo(raw: string): { total?: number; available?: number } {
  const result: { total?: number; available?: number } = {};
  for (const [field, key] of [['MemTotal', 'total'], ['MemAvailable', 'available']] as const) {
    const match = new RegExp(`^${field}:\\s*(\\d+)\\s+kB$`, 'm').exec(raw);
    if (match) { const amount = Number(match[1]) * 1024; if (Number.isSafeInteger(amount) && amount >= 0) result[key] = amount; }
  }
  return result;
}

export function parseLspci(raw: string): DetectedGPU[] {
  return raw.split(/\r?\n/).flatMap(line => {
    const match = /^([0-9a-f:.]+)\s+(?:VGA compatible controller|3D controller|Display controller)(?:\s+\[[0-9a-f]+\])?:\s*(.+)$/i.exec(line);
    if (!match) return [];
    const name = match[2].replace(/\s+\(rev [^)]+\)$/, '');
    return [{ name, vendor: vendor(name), memoryBytes: null, unified: false, bus: busId(match[1]) }];
  });
}

function memoryString(raw: unknown): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(GB|MB|TB|GIB|MIB|TIB)$/i.exec(text(raw));
  if (!match) return null;
  return positive(Number(match[1]) * ({ GB: GiB, GIB: GiB, MB: MiB, MIB: MiB, TB: GiB * 1024, TIB: GiB * 1024 }[match[2].toUpperCase()] || 0));
}

export function parseMacProfiler(raw: string): { cpu?: string; gpus: GPUInfo[]; notes: string[] } {
  const data = parseJson(raw);
  const hardware = object(array(data.SPHardwareDataType)[0]);
  const cpu = text(hardware.chip_type) || text(hardware.cpu_type);
  const gpus = array(data.SPDisplaysDataType).flatMap(value => {
    const item = object(value);
    const name = text(item.sppci_model) || text(item._name);
    if (!name) return [];
    // Apple GPU memory is the same physical pool as system RAM. Never add it as VRAM.
    const unified = /apple/i.test(name) || /apple/i.test(text(item.spdisplays_vendor));
    const dynamic = text(item.spdisplays_vram_shared) || /dynamic/i.test(text(item.spdisplays_vram));
    return [{ name, vendor: unified ? 'Apple' : vendor(`${name} ${text(item.spdisplays_vendor)}`), memoryBytes: unified || dynamic ? null : memoryString(item.spdisplays_vram), unified }];
  });
  return { cpu: cpu || undefined, gpus, notes: gpus.some(gpu => gpu.unified) ? ['Apple GPU and CPU share unified system memory; it is counted once. GPU allocation limits and current memory pressure still apply.'] : [] };
}

export function parseWindowsHardware(raw: string): { cpu?: string; total?: number; available?: number; gpus: GPUInfo[]; notes: string[] } {
  const data = parseJson(raw), system = object(data.system);
  const cpu = array(data.cpu).map(value => text(object(value).Name)).filter(Boolean).join(' / ');
  const gpus = array(data.gpus).flatMap(value => {
    const gpu = object(value), name = text(gpu.Name);
    if (!name) return [];
    // AdapterRAM is uint32, can truncate >4 GiB, and may describe shared adapters.
    // https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-videocontroller
    return [{ name, vendor: vendor(`${name} ${text(gpu.AdapterCompatibility)}`), memoryBytes: null, unified: false }];
  });
  const total = positive(system.TotalVisibleMemorySize), available = Number(system.FreePhysicalMemory);
  return {
    cpu: cpu || undefined, total: total ? total * 1024 : undefined,
    available: Number.isFinite(available) && available >= 0 ? available * 1024 : undefined,
    gpus,
    notes: gpus.length ? ['Windows CIM identifies GPUs, but AdapterRAM is a 32-bit value and may be inaccurate. Dedicated VRAM is shown only when a driver query verifies it.'] : [],
  };
}

async function nvidia(): Promise<DetectedGPU[]> {
  const args = ['--query-gpu=name,memory.total,pci.bus_id', '--format=csv,noheader,nounits'];
  const candidates = process.platform === 'win32'
    ? ['nvidia-smi.exe', ...(process.env.SystemRoot ? [path.join(process.env.SystemRoot, 'System32', 'nvidia-smi.exe')] : []), ...(process.env.ProgramW6432 ? [path.join(process.env.ProgramW6432, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe')] : [])]
    : ['nvidia-smi'];
  for (const candidate of candidates) { try { return parseNvidiaSmi(await command(candidate, args)); } catch { /* Missing driver/utility is normal on non-NVIDIA machines. */ } }
  return [];
}

async function linuxGPU(): Promise<{ gpus: DetectedGPU[]; notes: string[] }> {
  const results = await Promise.allSettled([nvidia(), command('lspci', ['-D', '-nn'])]);
  const nvidiaGPUs = results[0].status === 'fulfilled' ? results[0].value : [];
  const pci = results[1].status === 'fulfilled' ? parseLspci(results[1].value) : [];
  const gpus = [...nvidiaGPUs, ...pci.filter(gpu => !nvidiaGPUs.some(existing => existing.bus === gpu.bus))];
  const notes: string[] = [];
  try {
    const cards = (await fs.readdir('/sys/class/drm')).filter(name => /^card\d+$/.test(name)).slice(0, 32);
    await Promise.allSettled(cards.map(async card => {
      const devicePath = `/sys/class/drm/${card}/device`;
      const pciAddress = busId(path.basename(await fs.realpath(devicePath)));
      const vendorId = (await fs.readFile(`${devicePath}/vendor`, 'utf8')).trim();
      if (vendorId !== '0x1002') return;
      const existing = gpus.find(gpu => gpu.bus === pciAddress);
      const amount = positive((await fs.readFile(`${devicePath}/mem_info_vram_total`, 'utf8')).trim());
      if (existing && amount) existing.memoryBytes = amount;
      else if (amount) {
        const deviceId = (await fs.readFile(`${devicePath}/device`, 'utf8')).trim();
        gpus.push({ name: `AMD GPU (PCI ${vendorId}:${deviceId}, ${pciAddress})`, vendor: 'AMD', memoryBytes: amount, unified: false, bus: pciAddress });
      }
    }));
  } catch { /* Machines without DRM sysfs still have CPU and memory information. */ }
  if (gpus.some(gpu => gpu.vendor === 'AMD' && gpu.memoryBytes !== null)) notes.push('AMD memory is driver-reported VRAM. An integrated GPU may expose a reserved shared-memory aperture; it is not added to system RAM.');
  if (results[1].status === 'rejected') notes.push('PCI GPU discovery was unavailable. GPU names may be incomplete; no driver was installed or changed.');
  return { gpus, notes };
}

/** A local snapshot only. Does not install software, request privileges, or contact a service. */
export async function detectHardware(): Promise<HardwareInfo> {
  const cpus = os.cpus();
  const result: HardwareInfo = {
    platform: process.platform, arch: os.arch(), cpu: cpus[0]?.model.trim() || 'CPU name unavailable', logicalCores: cpus.length,
    totalMemoryBytes: os.totalmem(), availableMemoryBytes: os.freemem(), gpus: [], notes: [],
  };
  if (process.platform === 'linux') {
    const readings = await Promise.allSettled([fs.readFile('/proc/meminfo', 'utf8'), linuxGPU()]);
    if (readings[0].status === 'fulfilled') {
      const memory = parseLinuxMeminfo(readings[0].value);
      if (memory.total) result.totalMemoryBytes = memory.total;
      if (memory.available !== undefined) result.availableMemoryBytes = memory.available;
      else result.notes.push('MemAvailable was unavailable; current free memory is used as a conservative fallback.');
    } else result.notes.push('Linux memory details were unavailable; operating-system free memory is used.');
    if (readings[1].status === 'fulfilled') { result.gpus = readings[1].value.gpus; result.notes.push(...readings[1].value.notes); }
  } else if (process.platform === 'darwin') {
    try {
      const parsed = parseMacProfiler(await command('/usr/sbin/system_profiler', ['-json', 'SPHardwareDataType', 'SPDisplaysDataType'], 12_000));
      if (parsed.cpu) result.cpu = parsed.cpu;
      result.gpus = parsed.gpus; result.notes.push(...parsed.notes);
    } catch { result.notes.push('macOS System Information did not return GPU details. System memory and CPU measurements are still available.'); }
    result.notes.push('Available memory is the operating-system free-memory snapshot; macOS may reclaim more cached memory. This estimate can be conservative.');
  } else if (process.platform === 'win32') {
    const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); @{cpu=@(Get-CimInstance Win32_Processor | Select-Object Name); system=(Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory); gpus=@(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterCompatibility,AdapterRAM)} | ConvertTo-Json -Depth 4 -Compress";
    const readings = await Promise.allSettled([command('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], 12_000), nvidia()]);
    if (readings[0].status === 'fulfilled') {
      const parsed = parseWindowsHardware(readings[0].value);
      if (parsed.cpu) result.cpu = parsed.cpu;
      if (parsed.total) result.totalMemoryBytes = parsed.total;
      if (parsed.available !== undefined) result.availableMemoryBytes = parsed.available;
      result.gpus = parsed.gpus; result.notes.push(...parsed.notes);
    } else result.notes.push('Windows CIM hardware discovery was unavailable. CPU and memory use operating-system measurements.');
    if (readings[1].status === 'fulfilled' && readings[1].value.length) {
      const verified = readings[1].value;
      result.gpus = [...verified, ...result.gpus.filter(gpu => gpu.vendor !== 'NVIDIA')];
    }
  } else result.notes.push('GPU discovery is not implemented for this operating system.');
  result.gpus = result.gpus.map(({ name, vendor, memoryBytes, unified }) => ({ name, vendor, memoryBytes, unified }));
  result.availableMemoryBytes = Math.max(0, Math.min(result.availableMemoryBytes, result.totalMemoryBytes));
  if (!result.gpus.length) result.notes.push('No GPU was detected. This can also mean a VM, missing utility, or unavailable driver; CPU fallback remains possible.');
  result.notes.push('GPU names and memory do not verify model/runtime compatibility or speed. Current GPU free memory was not measured.');
  return result;
}

const gib = (bytes: number): string => `${(bytes / GiB).toFixed(1)} GiB`;

/** Conservative planning heuristic for one GGUF model and approximately 4k context tokens. */
export function estimateFit(fileBytes: number, hardware: HardwareInfo): ModelFit {
  if (!Number.isFinite(fileBytes) || fileBytes <= 0 || fileBytes > Number.MAX_SAFE_INTEGER) {
    return { rating: 'unknown', estimatedMemoryBytes: null, backend: 'Undetermined', explanation: 'The model file size is unknown. Memory fit cannot be estimated until its size is available.' };
  }
  // File weights + loading/runtime overhead + heuristic KV/context allowance. Actual KV sizes vary by architecture.
  const estimate = Math.ceil(fileBytes * 1.1 + Math.max(2 * GiB, fileBytes * 0.2));
  const total = positive(hardware.totalMemoryBytes);
  const available = Number.isFinite(hardware.availableMemoryBytes) && hardware.availableMemoryBytes >= 0 ? hardware.availableMemoryBytes : null;
  if (!total || available === null) return { rating: 'unknown', estimatedMemoryBytes: estimate, backend: 'Undetermined', explanation: `Estimated ${gib(estimate)} for weights and an approximately 4k context, but reliable RAM measurements are unavailable.` };
  const reserve = Math.min(4 * GiB, Math.max(2 * GiB, total * 0.15));
  const usable = Math.max(0, Math.min(total, available) - reserve);
  const hasUnified = hardware.platform === 'darwin' && hardware.gpus.some(gpu => gpu.unified && gpu.vendor === 'Apple');
  const dedicated = hardware.gpus.filter(gpu => !gpu.unified && positive(gpu.memoryBytes));
  const largest = dedicated.reduce<GPUInfo | undefined>((best, next) => (next.memoryBytes || 0) > (best?.memoryBytes || 0) ? next : best, undefined);
  // Never add VRAM across GPUs or add unified memory to RAM. Leave space for display/runtime use.
  const gpuBudget = largest?.memoryBytes ? Math.max(0, largest.memoryBytes * 0.8 - 512 * MiB) : 0;
  const gpuFits = gpuBudget >= estimate;
  const backend = hasUnified ? 'Apple unified memory · acceleration unverified' : gpuFits ? `${largest?.vendor} GPU candidate · compatibility unverified` : 'CPU fallback · may be slow';
  let explanation = `Estimated ${gib(estimate)} for weights, runtime, and about 4k context tokens. ${gib(usable)} RAM budget remains after a ${gib(reserve)} OS/apps reserve from current available memory. `;
  const rating: ModelFit['rating'] = estimate > usable ? 'too-large' : estimate > usable * 0.8 ? 'tight' : 'comfortable';
  explanation += rating === 'comfortable' ? 'There is memory headroom; this is not a speed guarantee. ' : rating === 'tight' ? 'Memory headroom is limited. Close other apps and use a shorter context. ' : 'This exceeds the current conservative RAM budget. Choose a smaller file or close apps and refresh hardware. ';
  if (hasUnified) explanation += 'Apple GPU memory is shared with RAM and is counted once; runtime allocation limits still apply. ';
  else if (gpuFits) explanation += `The estimate also fits a conservative portion of ${largest?.name} total VRAM. GPU free memory and driver support are unverified. `;
  else if (largest) explanation += 'The model does not fit the conservative single-GPU budget. CPU or partial offload may be much slower. ';
  else explanation += 'Dedicated GPU memory is unknown or unavailable, so only CPU memory fit is estimated; generation may be slow. ';
  explanation += 'Longer context, vision components, multiple models, or different architectures can require substantially more memory.';
  return { rating, estimatedMemoryBytes: estimate, backend, explanation };
}
