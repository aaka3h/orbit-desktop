import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateFit, parseLinuxMeminfo, parseNvidiaSmi, parseLspci, parseMacProfiler, parseWindowsHardware } from '../electron/hardware';
import type { GPUInfo, HardwareInfo } from '../shared/types';

const GiB = 1024 ** 3;
function hardware(overrides: Partial<HardwareInfo> = {}): HardwareInfo {
  return { platform: 'linux', arch: 'x64', cpu: 'Fixture CPU', logicalCores: 8, totalMemoryBytes: 32 * GiB, availableMemoryBytes: 24 * GiB, gpus: [], notes: [], ...overrides };
}
const gpu = (memory: number, name = 'NVIDIA fixture'): GPUInfo => ({ name, vendor: 'NVIDIA', memoryBytes: memory * GiB, unified: false });

test('Linux parser uses MemAvailable rather than counting free/cache fields twice', () => {
  assert.deepEqual(parseLinuxMeminfo('MemTotal:       16384000 kB\nMemFree:        1000000 kB\nMemAvailable:  12000000 kB\nCached: 3000000 kB\n'), { total: 16384000 * 1024, available: 12000000 * 1024 });
  assert.deepEqual(parseLinuxMeminfo('MemTotal: nope\nMemFree: 999 kB'), {});
  assert.equal(parseLinuxMeminfo('MemAvailable: 0 kB').available, 0);
});

test('NVIDIA CSV preserves names and driver-reported VRAM, including unavailable memory', () => {
  const parsed = parseNvidiaSmi('NVIDIA GeForce RTX 4090, 24564, 00000000:01:00.0\nNVIDIA Test GPU, [N/A], 00000000:02:00.0\n');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].memoryBytes, 24564 * 1024 ** 2);
  assert.equal(parsed[0].bus, '0000:01:00.0');
  assert.equal(parsed[1].memoryBytes, null);
  assert.deepEqual(parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.'), []);
});

test('PCI parser recognizes display/compute adapters without inventing VRAM', () => {
  const parsed = parseLspci('0000:00:02.0 VGA compatible controller [0300]: Intel Corporation Graphics [8086:1234] (rev 04)\n0000:01:00.0 3D controller [0302]: NVIDIA Corporation GPU [10de:1234]\n0000:03:00.0 Display controller [0380]: Advanced Micro Devices, Inc. [AMD/ATI] Radeon\n0000:04:00.0 Network controller [0280]: Example device');
  assert.deepEqual(parsed.map(item => item.vendor), ['Intel', 'NVIDIA', 'AMD']);
  assert.ok(parsed.every(item => item.memoryBytes === null));
  assert.equal(parsed[0].name, 'Intel Corporation Graphics [8086:1234]');
});

test('macOS Apple GPU is unified and does not receive duplicate system memory', () => {
  const parsed = parseMacProfiler(JSON.stringify({ SPHardwareDataType: [{ chip_type: 'Apple M4 Pro', physical_memory: '24 GB' }], SPDisplaysDataType: [{ sppci_model: 'Apple M4 Pro', spdisplays_vendor: 'sppci_vendor_Apple', spdisplays_vram: '24 GB' }] }));
  assert.equal(parsed.cpu, 'Apple M4 Pro');
  assert.deepEqual(parsed.gpus[0], { name: 'Apple M4 Pro', vendor: 'Apple', memoryBytes: null, unified: true });
  assert.match(parsed.notes[0], /counted once/);
});

test('macOS dedicated VRAM is parsed while dynamic shared memory stays unknown', () => {
  const parsed = parseMacProfiler(JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'AMD Radeon Pro', spdisplays_vram: '8 GB' }, { sppci_model: 'Intel Iris Plus', spdisplays_vram_shared: '1536 MB', spdisplays_vram: '1536 MB' }] }));
  assert.equal(parsed.gpus[0].memoryBytes, 8 * GiB);
  assert.equal(parsed.gpus[1].memoryBytes, null);
  assert.deepEqual(parseMacProfiler('not json').gpus, []);
});

test('Windows CIM reports actual CPU/RAM but never treats uint32 AdapterRAM as verified VRAM', () => {
  const parsed = parseWindowsHardware(JSON.stringify({ cpu: [{ Name: 'Example Core CPU' }], system: { TotalVisibleMemorySize: 33554432, FreePhysicalMemory: 16777216 }, gpus: [{ Name: 'NVIDIA GeForce RTX 4090', AdapterRAM: 4293918720, AdapterCompatibility: 'NVIDIA' }, { Name: 'Intel UHD', AdapterRAM: 1073741824 }] }));
  assert.equal(parsed.cpu, 'Example Core CPU');
  assert.equal(parsed.total, 32 * GiB);
  assert.equal(parsed.available, 16 * GiB);
  assert.ok(parsed.gpus.every(item => item.memoryBytes === null));
  assert.match(parsed.notes[0], /32-bit/);
});

test('unknown file size and invalid RAM yield an unknown estimate', () => {
  for (const size of [0, -1, NaN, Infinity]) assert.equal(estimateFit(size, hardware()).rating, 'unknown');
  assert.equal(estimateFit(4 * GiB, hardware({ totalMemoryBytes: 0 })).rating, 'unknown');
  assert.equal(estimateFit(4 * GiB, hardware({ availableMemoryBytes: NaN })).rating, 'unknown');
});

test('CPU fit explicitly distinguishes memory headroom from generation speed', () => {
  const fit = estimateFit(4 * GiB, hardware());
  assert.equal(fit.rating, 'comfortable');
  assert.ok((fit.estimatedMemoryBytes || 0) > 6 * GiB);
  assert.match(fit.backend, /CPU fallback.*slow/);
  assert.match(fit.explanation, /not a speed guarantee/);
  assert.match(fit.explanation, /4k/);
});

test('tight fit reserves memory for the OS and responds to currently available memory', () => {
  const fit = estimateFit(4 * GiB, hardware({ totalMemoryBytes: 16 * GiB, availableMemoryBytes: 10 * GiB }));
  assert.equal(fit.rating, 'tight');
  const tooLarge = estimateFit(4 * GiB, hardware({ totalMemoryBytes: 64 * GiB, availableMemoryBytes: 8 * GiB }));
  assert.equal(tooLarge.rating, 'too-large');
  assert.match(tooLarge.explanation, /current conservative RAM budget/);
  assert.equal(estimateFit(1 * GiB, hardware({ availableMemoryBytes: 0 })).rating, 'too-large');
});

test('Apple unified memory is counted once and cannot rescue insufficient RAM', () => {
  const apple: GPUInfo = { name: 'Apple M4', vendor: 'Apple', unified: true, memoryBytes: 16 * GiB };
  const fit = estimateFit(8 * GiB, hardware({ platform: 'darwin', totalMemoryBytes: 16 * GiB, availableMemoryBytes: 12 * GiB, gpus: [apple] }));
  assert.equal(fit.rating, 'too-large');
  assert.match(fit.backend, /Apple unified memory/);
  assert.match(fit.explanation, /counted once/);
});

test('dedicated GPU fit is conditional and never aggregates separate cards', () => {
  const accelerated = estimateFit(4 * GiB, hardware({ gpus: [gpu(24)] }));
  assert.equal(accelerated.rating, 'comfortable');
  assert.match(accelerated.backend, /GPU candidate/);
  assert.match(accelerated.explanation, /free memory and driver support are unverified/);
  const twoSmall = estimateFit(8 * GiB, hardware({ gpus: [gpu(8, 'one'), gpu(8, 'two')] }));
  assert.match(twoSmall.backend, /CPU fallback/);
  assert.match(twoSmall.explanation, /single-GPU budget/);
});

test('unknown GPU memory never earns a GPU-acceleration fit label', () => {
  const fit = estimateFit(2 * GiB, hardware({ gpus: [{ name: 'GPU identified', vendor: 'Unknown', memoryBytes: null, unified: false }] }));
  assert.match(fit.backend, /CPU fallback/);
  assert.match(fit.explanation, /unknown or unavailable/);
});
