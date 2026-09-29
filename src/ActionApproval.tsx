import { useState } from 'react';
import { Check, CreditCard, LoaderCircle, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { ToolCall } from '../shared/types';

export interface ActionApprovalData { approvalId: string; call: ToolCall; reason: string; kind?: 'browser' | 'purchase'; details?: string }

export default function ActionApproval({ approval, busy, onDecision }: { approval: ActionApprovalData; busy: boolean; onDecision: (approved: boolean, confirmedPurchase: boolean) => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const purchase = approval.kind === 'purchase';
  return <section className={`approval-card ${purchase ? 'purchase-approval' : ''}`} aria-labelledby="action-approval-title">
    <div className="approval-heading"><div className="approval-icon">{purchase ? <CreditCard size={22}/> : <ShieldCheck size={21}/>}</div><div><span className="section-eyebrow">{purchase ? 'PURCHASE OR PAYMENT CONFIRMATION' : 'YOUR APPROVAL NEEDED'}</span><h3 id="action-approval-title">{purchase ? 'Review this purchase or payment' : approval.call.name.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())}</h3></div></div>
    <p>{approval.reason}</p>
    {approval.details && <div className="approval-resolved"><strong>Action details</strong><pre>{approval.details}</pre></div>}
    {purchase && <div className="command-warning"><TriangleAlert size={17}/><span>This action may place an order, start a subscription, or transfer money. Review the destination, items, amount, and terms shown before confirming.</span></div>}
    {/command|shell|exec/i.test(approval.call.name) && <div className="command-warning"><TriangleAlert size={15}/><span>This command can affect your computer beyond the workspace. Read the full command before you allow it.</span></div>}
    <details className="approval-arguments" open={!purchase}><summary>Exact tool arguments</summary><pre>{JSON.stringify(approval.call.arguments, null, 2)}</pre></details>
    {purchase && <label className="purchase-confirmation"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)}/><span>I confirm this purchase or payment</span></label>}
    <div className="approval-buttons"><button className="button secondary" disabled={busy} onClick={() => onDecision(false, false)}>Deny action</button><button className="button primary" disabled={busy || purchase && !confirmed} onClick={() => onDecision(true, purchase && confirmed)}>{busy ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>} {purchase ? 'Confirm this purchase' : 'Allow this action'}</button></div>
  </section>;
}
