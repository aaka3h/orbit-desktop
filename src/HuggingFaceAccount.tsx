import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, LoaderCircle, LogIn, X } from 'lucide-react';

export default function HuggingFaceAccount({ locked, onConnected }: { locked: boolean; onConnected: () => void }) {
  const [status, setStatus] = useState<{ configured: boolean; connected: boolean; username?: string } | null>(null);
  const [flow, setFlow] = useState<{ verificationUrl: string; userCode: string; expiresAt: number; intervalSeconds: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { let alive = true; window.orbit?.hfStatus().then(value => { if (alive) setStatus(value); }).catch(error => { if (alive) setError(String(error)); }); return () => { alive = false; }; }, []);
  useEffect(() => {
    if (!flow || !window.orbit) return;
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!alive) return;
      if (Date.now() >= flow!.expiresAt) { setFlow(null); setError('Sign-in expired. Start again when you are ready.'); return; }
      try {
        const result = await window.orbit!.hfPoll();
        if (!alive) return;
        if (result.state === 'connected') { setStatus({ configured: true, connected: true, username: result.username }); setFlow(null); onConnected(); return; }
        if (result.state === 'expired') { setFlow(null); setError('Sign-in expired. Start again when you are ready.'); return; }
        timer = setTimeout(poll, Math.max(flow!.intervalSeconds, 5) * 1000);
      } catch (error) { if (alive) { setError(error instanceof Error ? error.message : String(error)); setFlow(null); } }
    }
    timer = setTimeout(poll, Math.max(flow.intervalSeconds, 5) * 1000);
    return () => { alive = false; clearTimeout(timer); };
  }, [flow]);
  async function login() {
    if (!window.orbit) return;
    setBusy(true); setError('');
    try { setFlow(await window.orbit.hfLogin()); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function cancel() { try { await window.orbit?.hfCancel(); setFlow(null); } catch (error) { setError(String(error)); } }
  return <div className="hf-account">
    {status?.connected ? <div className="inline-note"><CheckCircle2 size={18}/><span>Hugging Face account connected{status.username ? ` as ${status.username}` : ''}. Choose a cloud model and test the connection.</span></div> : <div className="inline-note"><LogIn size={18}/><div><strong>Hugging Face account</strong><p>Public local models need no sign-in. For cloud inference, paste an access token with inference permission below.</p>{status?.configured && !flow && <button className="button secondary" disabled={busy || locked} onClick={login}>{busy ? <LoaderCircle size={15} className="spin"/> : <LogIn size={15}/>}Sign in with Hugging Face</button>}{status && !status.configured && <p>One-click sign-in needs publisher OAuth setup in this build.</p>}{!window.orbit && <p>Account status is available in the desktop app.</p>}</div></div>}
    {flow && <div className="hf-device-code"><strong>Complete sign-in in your browser</strong><p>If asked, enter this code:</p><code>{flow.userCode}</code><div className="docs-links"><button onClick={() => window.orbit?.openExternal(flow.verificationUrl).catch(error => setError(String(error)))}>Open sign-in page <ExternalLink size={14}/></button><button onClick={cancel}><X size={14}/>Cancel sign-in</button></div><p className="field-help"><LoaderCircle size={13} className="spin"/> Waiting for your account…</p></div>}
    {error && <p className="notice failure" role="alert">{error}</p>}
  </div>;
}
