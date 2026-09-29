import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronRight, Cpu, Download, ExternalLink, HardDrive, LoaderCircle, MemoryStick, Monitor, RefreshCw, Search, ShieldCheck, Sparkles, Square, TriangleAlert, X } from 'lucide-react';
import type { HardwareInfo, HubFile, HubModel, ModelDownload, Settings } from '../shared/types';
import { chooseRecommendedFile } from '../shared/models';

const formatBytes = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`;
const fitLabels = { comfortable: 'Good fit', tight: 'Tight fit', 'too-large': 'Too large', unknown: 'Fit unknown' };
const compactNumber = (value: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export default function ModelHub({ open, settings, locked, onClose, onSaved }: { open: boolean; settings: Settings; locked: boolean; onClose: () => void; onSaved: (settings: Settings) => void }) {
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [hardwareError, setHardwareError] = useState('');
  const [hardwareBusy, setHardwareBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [models, setModels] = useState<HubModel[]>([]);
  const [selected, setSelected] = useState<HubModel | null>(null);
  const [files, setFiles] = useState<HubFile[]>([]);
  const [file, setFile] = useState<HubFile | null>(null);
  const [loading, setLoading] = useState<'search' | 'files' | 'save' | null>(null);
  const [error, setError] = useState('');
  const [download, setDownload] = useState<ModelDownload | null>(null);
  const [downloadStarting, setDownloadStarting] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [installed, setInstalled] = useState<string[]>([]);
  const [searched, setSearched] = useState(false);
  const [recommendations, setRecommendations] = useState(true);
  const latestRequest = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const api = window.orbit;
  const downloading = downloadStarting || !!download && !download.done && !download.error;

  useEffect(() => {
    if (!api) return;
    let alive = true;
    let receivedEvent = false;
    const receive = (event: ModelDownload) => {
      setDownload(event); setDownloadStarting(false);
      if (event.done || event.error) setCanceling(false);
      if (event.done && !event.error) setInstalled(old => old.includes(event.model) ? old : [...old, event.model]);
    };
    const unsubscribe = api.onDownload((event) => { receivedEvent = true; receive(event); });
    api.downloadState().then(event => { if (alive && !receivedEvent && event) receive(event); }).catch(() => {});
    return () => { alive = false; unsubscribe(); };
  }, [api]);

  useEffect(() => {
    if (!open || !api) return;
    if (!hardware && !hardwareError) api.hardware().then(setHardware).catch(e => setHardwareError(errorText(e)));
    if (!searched) void search('');
    let alive = true;
    api.testConnection({ kind: 'ollama', model: '', baseUrl: 'http://127.0.0.1:11434' }).then(result => { if (alive && result.ok && result.models) setInstalled(old => [...new Set([...old, ...result.models!])]); }).catch(() => {});
    return () => { alive = false; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement;
    dialogRef.current?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const els = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]'));
      const first = els[0]; const last = els[els.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [open]);

  async function search(value = query) {
    if (!api) { setError('Open the desktop app to search Hugging Face and check this computer’s hardware.'); return; }
    const request = ++latestRequest.current;
    setLoading('search'); setError(''); setSelected(null); setFile(null); setFiles([]); setSearched(true); setRecommendations(!value.trim());
    try { const results = await api.searchModels(value.trim()); if (request === latestRequest.current) setModels(results); }
    catch (e) { if (request === latestRequest.current) { setError(errorText(e)); setModels([]); } }
    finally { if (request === latestRequest.current) setLoading(null); }
  }
  async function selectModel(model: HubModel) {
    if (!api) return;
    const request = ++latestRequest.current;
    setSelected(model); setFiles([]); setFile(null); setError(''); setLoading('files');
    try {
      const results = await api.modelFiles(model.id);
      if (request !== latestRequest.current) return;
      setFiles(results);
      setFile(chooseRecommendedFile(results) ?? null);
    } catch (e) { if (request === latestRequest.current) setError(errorText(e)); }
    finally { if (request === latestRequest.current) setLoading(null); }
  }
  async function startDownload() {
    if (!api || !file || downloading || file.sizeBytes <= 0) return;
    setError(''); setDownloadStarting(true); setCanceling(false);
    setDownload({ model: file.ollamaModel, status: 'Starting download…', completed: 0, total: file.sizeBytes, done: false });
    try { await api.downloadModel({ model: file.ollamaModel, sizeBytes: file.sizeBytes }); }
    catch (e) { setError(errorText(e)); setDownload(old => old ? { ...old, done: true, error: errorText(e) } : null); }
    finally { setDownloadStarting(false); }
  }
  async function cancelDownload() {
    if (!api || canceling) return;
    setCanceling(true);
    try { await api.cancelDownload(); }
    catch (e) { setError(errorText(e)); }
    finally { setCanceling(false); }
  }
  async function useModel() {
    if (!api || !file || locked) return;
    setLoading('save'); setError('');
    try { const saved = await api.saveSettings({ ...settings, provider: { kind: 'ollama', model: file.ollamaModel, baseUrl: 'http://127.0.0.1:11434' } }); onSaved(saved); }
    catch (e) { setError(errorText(e)); }
    finally { setLoading(null); }
  }
  async function refreshHardware() {
    if (!api) return;
    setHardwareBusy(true); setHardwareError('');
    try { setHardware(await api.hardware()); if (selected) await selectModel(selected); else if (recommendations) await search(''); }
    catch (error) { setHardwareError(errorText(error)); }
    finally { setHardwareBusy(false); }
  }
  function external(url: string) { if (api) void api.openExternal(url).catch(error => setError(errorText(error))); else window.open(url, '_blank', 'noopener,noreferrer'); }

  if (!open) return null;
  const installedFile = !!file && installed.includes(file.ollamaModel);
  const percent = download && download.total > 0 ? Math.min(100, Math.max(0, download.completed / download.total * 100)) : null;
  return <div className="modal-backdrop hub-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} tabIndex={-1} className="dialog hub-dialog" role="dialog" aria-modal="true" aria-labelledby="hub-title">
      <div className="dialog-heading"><div><div className="section-eyebrow">LOCAL INTELLIGENCE</div><h2 id="hub-title">Model Hub</h2><p>Find a Hugging Face model that fits your computer.</p></div><button className="icon-button" onClick={onClose} aria-label="Close Model Hub"><X size={22}/></button></div>
      <div className="hub-scroll">
        <section className="hardware-section" aria-labelledby="hardware-title">
          <div className="hub-section-title"><h3 id="hardware-title"><Monitor size={17}/>Your computer</h3><span>{hardware ? `${hardware.platform} · ${hardware.arch}` : api ? 'Checking hardware…' : 'Desktop app required'}</span><button className="icon-button" disabled={!api || hardwareBusy || loading === 'files' || loading === 'search'} onClick={refreshHardware} aria-label="Refresh hardware" title="Refresh hardware and memory estimates"><RefreshCw size={16} className={hardwareBusy ? 'spin' : ''}/></button></div>
          {hardware ? <><div className="hardware-grid"><div className="hardware-item"><Cpu size={20}/><span>Processor<strong title={hardware.cpu}>{hardware.cpu}</strong><small>{hardware.logicalCores} logical cores</small></span></div><div className="hardware-item"><MemoryStick size={20}/><span>Memory<strong>{formatBytes(hardware.totalMemoryBytes)} RAM</strong><small>{formatBytes(hardware.availableMemoryBytes)} currently available</small></span></div><div className="hardware-item"><Monitor size={20}/><span>Graphics<strong>{hardware.gpus.length ? hardware.gpus.map(gpu => gpu.name).join(', ') : 'No GPU detected'}</strong><small>{hardware.gpus.length ? hardware.gpus.map(gpu => gpu.unified ? 'Shared system memory' : gpu.memoryBytes ? `${formatBytes(gpu.memoryBytes)} dedicated memory` : 'GPU memory not reported').join(' · ') : 'Models can still run on your CPU'}</small></span></div></div>{hardware.notes.length > 0 && <details className="hardware-note"><summary>Hardware detection notes</summary><p>{hardware.notes.join(' ')}</p></details>}</> : <div className="hardware-loading">{hardwareError ? <><TriangleAlert size={17}/>{hardwareError}</> : api ? <><LoaderCircle className="spin" size={17}/>Detecting processor, memory, and graphics.</> : <><Monitor size={17}/>Hardware detection is available in the desktop app. No hardware data is simulated.</>}</div>}
        </section>
        <form className="hub-search" onSubmit={event => { event.preventDefault(); void search(); }}><Search size={19}/><label className="sr-only" htmlFor="model-search">Search Hugging Face models</label><input id="model-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search Hugging Face GGUF models…"/><button className="button primary" disabled={loading === 'search'}>{loading === 'search' ? <LoaderCircle className="spin" size={16}/> : <Search size={16}/>}Search</button></form>
        <div className="hub-source-note"><ShieldCheck size={15}/><span>Public models need no account. Ollama must be running locally to download and use a model.</span><button onClick={() => external('https://ollama.com/download')}>Get Ollama <ExternalLink size={13}/></button></div>
        {error && <div className="notice failure" role="alert"><TriangleAlert size={18}/><span>{error}</span></div>}
        <div className={`hub-columns ${selected ? 'has-selection' : ''}`}>
          <section className="hub-model-list" aria-label="Model results"><div className="hub-list-heading"><h3>{recommendations ? 'Start with these models' : 'Search results'}</h3><span>{models.length} models</span></div><p className="hub-list-description">{recommendations ? 'Choose a model to see download sizes and a memory estimate for your hardware.' : 'Select a repository, then choose a model file.'}</p>{loading === 'search' ? <div className="hub-empty"><LoaderCircle size={26} className="spin"/><p>Searching Hugging Face…</p></div> : models.map(model => <button className={`hub-model-row ${selected?.id === model.id ? 'selected' : ''}`} key={model.id} onClick={() => void selectModel(model)} aria-pressed={selected?.id === model.id}><span className="model-file-icon"><Sparkles size={18}/></span><span className="model-row-copy"><strong>{model.id.split('/').slice(1).join('/') || model.id}</strong><small>{model.id.split('/')[0]}</small><span><Download size={12}/>{compactNumber(model.downloads)} downloads{model.gated && <em>Gated</em>}</span>{model.recommendedFile && <span className={"model-fit-hint " + model.recommendedFile.fit.rating}>{fitLabels[model.recommendedFile.fit.rating]} · {model.recommendedFile.quantization} · {formatBytes(model.recommendedFile.sizeBytes)}</span>}</span><ChevronRight size={17}/></button>)}{!loading && !models.length && <div className="hub-empty"><Search size={27}/><p>{api ? 'No models found. Try “Qwen” or “Llama”.' : 'Search local models in the desktop app.'}</p></div>}</section>
          {selected ? <section className="hub-model-detail" aria-label="Selected model"><button className="hub-back-button" onClick={() => { ++latestRequest.current; setSelected(null); setLoading(null); }}><ArrowLeft size={15}/>All models</button><h3>{selected.id.split('/').slice(1).join('/') || selected.id}</h3><p className="model-repo-id">{selected.id}</p><button className="model-card-link" onClick={() => external('https://huggingface.co/' + selected.id)}>Model card &amp; license <ExternalLink size={13}/></button>{loading === 'files' ? <div className="hub-empty"><LoaderCircle className="spin" size={25}/><p>Checking model files…</p></div> : <><label className="field-label" htmlFor="model-file">Model file</label><select className="field-input" id="model-file" value={file?.path || ''} onChange={event => setFile(files.find(item => item.path === event.target.value) || null)}>{files.map(item => <option key={item.path} value={item.path}>{item.quantization || item.path.split('/').pop()} · {formatBytes(item.sizeBytes)} · {fitLabels[item.fit.rating]}</option>)}</select>{file ? <><div className={`fit-card ${file.fit.rating}`}><div>{file.fit.rating === 'comfortable' ? <CheckCircle2 size={19}/> : <TriangleAlert size={19}/>}<strong>{fitLabels[file.fit.rating]}</strong><span>{file.fit.backend}</span></div><p>{file.fit.explanation}</p>{file.fit.estimatedMemoryBytes != null && <small>Estimated model memory: {formatBytes(file.fit.estimatedMemoryBytes)}</small>}</div><div className="file-facts"><div><HardDrive size={16}/><span>Download size</span><strong>{formatBytes(file.sizeBytes)}</strong></div><div><MemoryStick size={16}/><span>Quantization</span><strong>{file.quantization || 'Not specified'}</strong></div></div><p className="field-help">Quantization makes a model smaller. Q4 is often a useful starting point. Fit estimates are approximate; context length and other apps also use memory.</p><p className="model-compatibility">GGUF availability does not guarantee tool use or vision support. Small models can struggle with tool use. Check the model license before use.</p>{installedFile ? <button className="button primary hub-download-button" disabled={locked || loading === 'save'} onClick={useModel}>{loading === 'save' ? <LoaderCircle className="spin" size={17}/> : <Check size={17}/>}Use this model <ArrowRight size={16}/></button> : <button className="button primary hub-download-button" disabled={downloading || locked || file.sizeBytes <= 0} onClick={startDownload}><Download size={17}/>{downloading && download?.model === file.ollamaModel ? 'Downloading…' : `Download ${formatBytes(file.sizeBytes)}`}</button>}<p className="download-disclosure">Downloads to local Ollama storage. A large download can use significant disk space and network data.</p></> : <div className="hub-empty"><p>No supported GGUF files were found in this repository.</p></div>}</>}</section> : <div className="hub-detail-placeholder"><div><MemoryStick size={31}/></div><h3>A model that fits.</h3><p>Select a model to compare its size with your computer’s memory.</p><span>Smaller models run on more computers.<br/>Larger models generally need more memory.</span></div>}
        </div>
      </div>
      {download && <div className={`download-progress ${download.error ? 'failed' : ''}`} role="status"><div className="download-progress-top">{download.error ? <TriangleAlert size={19}/> : download.done ? <CheckCircle2 size={19}/> : <LoaderCircle className="spin" size={19}/>}<div><strong>{download.error ? 'Download stopped' : download.done ? 'Model ready' : download.status}</strong><span>{download.error || download.model}</span></div>{downloading && <button className="button secondary" disabled={canceling} onClick={cancelDownload}>{canceling ? <LoaderCircle size={14} className="spin"/> : <Square size={12}/>}Cancel</button>}</div>{!download.done && !download.error && <><div className="progress-track" role="progressbar" aria-label="Model download" aria-valuenow={percent == null ? undefined : Math.round(percent)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: percent == null ? '8%' : `${percent}%` }}/></div><div className="progress-numbers"><span>{formatBytes(download.completed)}{download.total > 0 ? ` of ${formatBytes(download.total)}` : ''}</span><span>{percent == null ? 'Preparing…' : `${Math.round(percent)}%`}</span></div></>}</div>}
      <div className="hub-footer"><span><ShieldCheck size={15}/>Local models, under your control.</span><button className="button secondary" onClick={onClose}>Done</button></div>
    </div>
  </div>;
}
