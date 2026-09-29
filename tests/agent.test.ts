import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../electron/agent';
import type { AgentEvent,Session,Settings,ModelReply } from '../shared/types';
async function fixture(t:any){const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-agent-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
function setup(workspace:string){const settings:Settings={workspace,provider:{kind:'demo',model:'demo',baseUrl:''},maxSteps:5,allowCommands:false,allowComputer:false,pythonPath:'python3'};const session:Session={id:'test',title:'Test',updatedAt:new Date().toISOString(),messages:[{id:'u',role:'user',content:'Run demo',createdAt:new Date().toISOString()}]};return{settings,session};}
test('demo completes multi-step file creation after approval',async t=>{const root=await fixture(t);const events:AgentEvent[]=[];let approvals=0;await runAgent({...setup(root),runId:'r',signal:new AbortController().signal,computerScript:'',emit:e=>events.push(e),approve:async()=>{approvals++;return true}});assert.equal(approvals,1);assert.ok((await fs.readFile(path.join(root,'orbit-demo.md'),'utf8')).length>0);assert.ok(events.some(e=>e.type==='tool'&&e.status==='done'));});
test('denial prevents writes and reports denial to the model',async t=>{const root=await fixture(t);const o=setup(root);await runAgent({...o,runId:'r',signal:new AbortController().signal,computerScript:'',emit:()=>{},approve:async()=>false});await assert.rejects(fs.stat(path.join(root,'orbit-demo.md')));assert.match(o.session.messages.at(-1)!.content,/denied|declined|not.*(write|creat)|no.*file|did not/i);});
test('step limits stop runaway loops',async t=>{const root=await fixture(t);const o=setup(root);o.settings.maxSteps=2;let requests=0;await assert.rejects(runAgent({...o,runId:'r',signal:new AbortController().signal,computerScript:'',emit:()=>{},approve:async()=>false,model:async()=>{requests++;return{text:'',toolCalls:[{id:String(requests),name:'list_files',arguments:{path:'.'}}]} as ModelReply;}}),/step limit/);assert.equal(requests,2);});
test('cancelled run never reaches provider or tools',async t=>{const root=await fixture(t);const controller=new AbortController();controller.abort();await assert.rejects(runAgent({...setup(root),runId:'r',signal:controller.signal,computerScript:'',emit:()=>{},approve:async()=>true,model:async()=>{throw new Error('Provider must not be invoked')}}),/abort/i);});
