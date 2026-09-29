import { useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, Globe2, LoaderCircle, LockKeyhole, RefreshCw, Square, TriangleAlert } from 'lucide-react';
import type { BrowserChannel, BrowserStatus, Settings } from '../shared/types';

export default function BrowserPanel({ settings, locked, onSaved }: { settings: Settings; locked: boolean; onSaved: (settings: Settings) => void }) {
  const [enabled, setEnabled] = useState(!!settings.allowBrowser);
  const [channel, setChannel] = useState<BrowserChannel>(settings.browserChannel || 'chrome');
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [busy, setBusy] = useState<'save' | 'open' | 'close' | 'refresh' | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const mounted = useRef(false);
  const api = window.orbit;
  const dirty = enabled !== !!settings.allowBrowser || channel !== (settings.browserChannel || 'chrome');

  useEffect(() => { mounted.current = true; let alive = true; if (api) api.browserStatus().then(value => { if (alive) setStatus(value); }).catch(error => { if (alive) setNotice({ok:false,text:String(error)}); }); return () => { alive = false; mounted.current = false; }; }, [api]);
  async function action(kind: 'save' | 'open' | 'close' | 'refresh') {
    if (!api) { setNotice({ok:false,text:'Browser control is available in the desktop app.'}); return; }
    setBusy(kind); setNotice(null);
    try {
      if (kind === 'save') { const saved = await api.saveSettings({...settings, allowBrowser:enabled, browserChannel:channel}); if (mounted.current) onSaved(saved); const browserState=await api.browserStatus(); if (mounted.current) { setStatus(browserState); setNotice({ok:true,text:'Browser setup saved. Open the browser when you are ready.'}); } }
      else { const value = await (kind === 'open' ? api.openBrowser() : kind === 'close' ? api.closeBrowser() : api.browserStatus()); if (mounted.current) setStatus(value); }
    } catch (error) { if (mounted.current) setNotice({ok:false,text:error instanceof Error ? error.message : String(error)}); }
    finally { if (mounted.current) setBusy(null); }
  }

  return <div className="browser-panel">
    <div className="library-intro"><span className="library-feature-icon"><Globe2 size={24}/></span><div><h3>A browser you can see and control.</h3><p>Orbit opens a separate browser profile for research and shopping. Your usual browsing profile stays separate.</p></div></div>
    <div className="toggle-field"><div><strong>Allow browser control</strong><p>Let permitted agents read pages and request browser actions.</p></div><button className={`toggle ${enabled ? 'on' : ''}`} role="switch" aria-checked={enabled} aria-label="Allow browser control" disabled={locked || !!busy} onClick={() => setEnabled(!enabled)}><span/></button></div>
    <label className="field-label" htmlFor="browser-channel">Browser</label><select className="field-input" id="browser-channel" value={channel} disabled={locked || !!busy || !!status?.running} onChange={event => setChannel(event.target.value as BrowserChannel)}><option value="chrome">Google Chrome</option><option value="msedge">Microsoft Edge</option><option value="chromium">Chromium (if installed for Orbit)</option></select>
    <p className="field-help">Chrome or Edge must be installed on this computer. Close Orbit’s browser before switching browsers.</p>
    <div className="browser-controls"><button className="button primary" disabled={locked || !!busy || !dirty} onClick={() => action('save')}>{busy === 'save' ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>}Save browser setup</button><button className="button secondary" disabled={locked || !!busy || dirty || !settings.allowBrowser || !!status?.running} onClick={() => action('open')}>{busy === 'open' ? <LoaderCircle size={16} className="spin"/> : <ExternalLink size={16}/>}Open browser</button><button className="button secondary" disabled={locked || !!busy || !status?.running} onClick={() => action('close')}><Square size={13}/>Close browser</button></div>
    {dirty && <p className="field-help">Save your browser setup before opening a browser.</p>}
    <div className="browser-guide"><h4>Sign in yourself, then ask Orbit to help.</h4><ol><li>Open the visible browser and visit the website you need.</li><li>Enter your password and complete any verification directly on that website. Orbit does not ask you to paste a password here.</li><li>Return to Orbit, choose a browser-capable bot, and describe your task and budget.</li><li>Review requested actions. Detected checkout and purchase actions require extra confirmation. Review every action because websites differ.</li></ol><p><LockKeyhole size={15}/> Signed-in pages may contain private information. Approved page content goes to the selected model.</p></div>
    <div className="browser-status-heading"><h4>Browser status</h4><button className="icon-button" disabled={!!busy} onClick={() => action('refresh')} aria-label="Refresh browser status"><RefreshCw size={16} className={busy === 'refresh' ? 'spin' : ''}/></button></div>
    <div className="browser-state"><span className={`browser-indicator ${status?.running ? 'open' : ''}`}/>{status ? status.running ? `${status.channel === 'msedge' ? 'Microsoft Edge' : status.channel === 'chrome' ? 'Google Chrome' : 'Chromium'} is open` : 'Orbit browser is closed' : api ? 'Checking browser…' : 'Desktop app required'}</div>
    {status?.tabs.map(tab => <div className="browser-tab-row" key={tab.id}><Globe2 size={17}/><div><strong>{tab.title || 'Untitled tab'}</strong><span>{tab.url}</span></div></div>)}
    {status?.running && status.tabs.length === 0 && <p className="field-help">No open tabs were reported. Use the browser window to open a page.</p>}
    {notice && <div className={`notice ${notice.ok ? 'success' : 'failure'}`} role="status">{notice.ok ? <Check size={17}/> : <TriangleAlert size={17}/>}<span>{notice.text}</span></div>}
  </div>;
}
