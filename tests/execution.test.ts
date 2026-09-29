import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchTool, permittedTools, assertApprovalConfirmation, type ExecutionOptions } from '../electron/execution';
import type { AgentEvent, Settings, ToolCall, ToolSpec } from '../shared/types';
import type { PreparedBrowserAction } from '../electron/browser';
const settings:Settings={workspace:'.',provider:{kind:'demo',model:'',baseUrl:''},maxSteps:10,allowCommands:false,allowComputer:false,allowBrowser:true,pythonPath:'python3'};
const specs:ToolSpec[]=['browser','run_command','computer','read_file'].map(name=>({name,description:name,parameters:{type:'object'}}));
const call:ToolCall={id:'1',name:'browser',arguments:{action:'click',ref:'buy'}};
function fixture(){let executed=0;const events:AgentEvent[]=[];const o:ExecutionOptions={runId:'run',settings,specs,computerScript:'',emit:e=>events.push(e),approve:async()=>true,browser:{prepare:async(c)=>({call:c,reason:'Review purchase',details:'Buy test item · $10',kind:'purchase',token:'ticket'} as PreparedBrowserAction),executePrepared:async()=>{executed++;return{content:'ok'}}}};return{o,events,count:()=>executed};}
test('bot scope intersects global access and unavailable tool never prepares or runs',async()=>{
 assert.deepEqual(permittedTools(specs,['browser','commands','computer'],settings).map(t=>t.name),['browser']);
 const {o,count}=fixture();o.specs=[];o.browser.prepare=async()=>{throw new Error('Must not prepare')};await assert.rejects(dispatchTool(call,new AbortController().signal,o),/unavailable/);assert.equal(count(),0);
});
test('resolved browser purchase details reach approval before exact prepared execution',async()=>{
 const {o,count,events}=fixture();o.approve=async(c,reason,signal,details)=>{assert.equal(count(),0);assert.equal(details?.kind,'purchase');assert.match(details?.details??'',/\$10/);return true};
 await dispatchTool(call,new AbortController().signal,o);assert.equal(count(),1);assert.deepEqual(events.filter(e=>e.type==='tool').map(e=>e.status),['running','done']);
});
test('denial and cancellation while awaiting approval never execute',async()=>{
 const {o,count,events}=fixture();o.approve=async()=>false;await assert.rejects(dispatchTool(call,new AbortController().signal,o),/denied/);assert.equal(count(),0);assert.equal(events.filter(e=>e.type==='tool'&&e.status==='denied').length,1);
 const controller=new AbortController();o.approve=async()=>{controller.abort();return true};await assert.rejects(dispatchTool(call,controller.signal,o),/abort/i);assert.equal(count(),0);
});
test('disabled browser rejected even with accidentally exposed model tool schema',async()=>{
 const {o,count}=fixture();o.settings={...settings,allowBrowser:false};await assert.rejects(dispatchTool(call,new AbortController().signal,o),/disabled/);assert.equal(count(),0);
});

test('purchase approval requires a separate confirmation but denial does not',()=>{assert.throws(()=>assertApprovalConfirmation('purchase',true),/confirmation/);assert.throws(()=>assertApprovalConfirmation('purchase',true,false),/confirmation/);assert.doesNotThrow(()=>assertApprovalConfirmation('purchase',true,true));assert.doesNotThrow(()=>assertApprovalConfirmation('purchase',false));assert.doesNotThrow(()=>assertApprovalConfirmation('browser',true));});
