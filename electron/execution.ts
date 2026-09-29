import type { AgentEvent, Settings, ToolCall, ToolSpec, ToolGroup } from '../shared/types';
import { executeTool, requiresApproval, approvalReason, type ToolResult } from './tools';
import type { BrowserController, PreparedBrowserAction } from './browser';

export const toolGroups:Record<string,ToolGroup>={list_files:'files',read_file:'files',write_file:'files',fetch_url:'web',browser:'browser',run_command:'commands',computer:'computer'};
export function permittedTools(specs:ToolSpec[],groups:ToolGroup[],settings:Settings){return specs.filter(t=>groups.includes(toolGroups[t.name])&&(t.name!=='browser'||settings.allowBrowser)&&(t.name!=='computer'||settings.allowComputer)&&(t.name!=='run_command'||settings.allowCommands));}
export interface ApprovalDetails { kind?:'browser'|'purchase'; details?:string }
export interface ExecutionOptions {
 runId:string;settings:Settings;specs:ToolSpec[];computerScript:string;
 browser:Pick<BrowserController,'prepare'|'executePrepared'>;
 approve:(call:ToolCall,reason:string,signal:AbortSignal,details?:ApprovalDetails)=>Promise<boolean>;
 emit:(event:AgentEvent)=>void; execute?:typeof executeTool;
}
// Both cloud API providers and the subscription bridge enter this same boundary.
export async function dispatchTool(call:ToolCall,signal:AbortSignal,o:ExecutionOptions):Promise<ToolResult>{
 signal.throwIfAborted();
 try{
  if(!o.specs.some(t=>t.name===call.name))throw new Error('Tool is unavailable for this bot or disabled in Settings.');
  if(call.name==='browser'&&!o.settings.allowBrowser||call.name==='computer'&&!o.settings.allowComputer||call.name==='run_command'&&!o.settings.allowCommands)throw new Error('Tool access is disabled.');
  let prepared:PreparedBrowserAction|undefined;
  if(call.name==='browser')prepared=await o.browser.prepare(call,signal);
  if(prepared||requiresApproval(call.name)){
   const approved=await o.approve(call,prepared?.reason??approvalReason(call.name),signal,prepared?{kind:prepared.kind,details:prepared.details}:undefined);
   signal.throwIfAborted();
   if(!approved){const error='User denied this action. Do not retry it or work around this decision.';o.emit({type:'tool',runId:o.runId,call,status:'denied',result:error});throw new DeniedAction(error);}
  }
  signal.throwIfAborted();o.emit({type:'tool',runId:o.runId,call,status:'running'});
  const result=prepared?await o.browser.executePrepared(prepared,signal):await(o.execute??executeTool)(call,o.settings,signal,o.computerScript);
  signal.throwIfAborted();o.emit({type:'tool',runId:o.runId,call,status:'done',result:result.content.slice(0,16000)});return result;
 }catch(e){signal.throwIfAborted();if(!(e instanceof DeniedAction))o.emit({type:'tool',runId:o.runId,call,status:'error',result:(e as Error).message});throw e;}
}
class DeniedAction extends Error{}

export function assertApprovalConfirmation(kind:string|undefined,approved:boolean,confirmedPurchase?:boolean){if(approved&&kind==='purchase'&&!confirmedPurchase)throw new Error('Explicit purchase confirmation is required.');}
