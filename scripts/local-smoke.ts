import { runAgent } from '../electron/agent';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import type { AgentEvent } from '../shared/types';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-local-'));
const fixture='Orbit local integration marker: BLUE-PINE-42.';
await fs.writeFile(path.join(root,'sample.txt'),fixture);
const session={id:'local-test',title:'Local smoke',updatedAt:new Date().toISOString(),messages:[{id:'u',role:'user' as const,content:'Read sample.txt using read_file. Tell me its exact marker. Do not change any file.',createdAt:new Date().toISOString()}]};
const events:AgentEvent[]=[];
const wire:{request:any;response?:any}[]=[];
const actualFetch=globalThis.fetch;
// Capture only this synthetic fixture test. Do not use this harness with real user data.
globalThis.fetch=async(url,init)=>{
 assert.equal(String(url),'http://127.0.0.1:11434/api/chat','Local smoke must contact only the local model.');
 const entry:{request:any;response?:any}={request:JSON.parse(String(init?.body))};wire.push(entry);
 const response=await actualFetch(url,init);
 const data=await response.clone().json();
 // Diagnostic content and tool calls suffice; do not persist model reasoning.
 entry.response={model:data.model,done:data.done,done_reason:data.done_reason,message:{role:data.message?.role,content:data.message?.content,tool_calls:data.message?.tool_calls},error:data.error};
 return response;
};
try{
 await runAgent({runId:'local-test',session,settings:{workspace:root,provider:{kind:'ollama',model:process.env.ORBIT_SMOKE_MODEL??'llama3.1:latest',baseUrl:'http://127.0.0.1:11434'},allowCommands:false,allowComputer:false,pythonPath:'python3',maxSteps:5},signal:AbortSignal.timeout(180000),computerScript:'',approve:async()=>false,emit:e=>{events.push(e);if(e.type==='status')console.log(e.message);if(e.type==='tool')console.log(e.call.name,e.status);}});
 const evidence=events.some(e=>e.type==='tool'&&e.call.name==='read_file'&&e.status==='done'&&e.result===fixture);
 const delivered=wire.some(entry=>entry.request.messages.some((message:any)=>message.role==='tool'&&message.tool_name==='read_file'&&message.content===fixture));
 console.log(`Evidence checks: exact file read=${evidence}, exact tool result sent to Ollama=${delivered}`);
 assert.ok(evidence,'The agent did not successfully read the exact temporary fixture.');
 assert.ok(delivered,'The Ollama follow-up request omitted the exact tool result.');
 assert.equal(await fs.readFile(path.join(root,'sample.txt'),'utf8'),fixture,'The read-only task unexpectedly changed the fixture.');
 assert.match(session.messages.filter(m=>m.role==='assistant').map(m=>m.content).join('\n'),/BLUE-PINE-42/);
 console.log('Real Ollama agent passed: model read a temporary file and returned its exact marker.');
}finally{
 globalThis.fetch=actualFetch;
 if(process.env.ORBIT_SMOKE_TRACE){
  const target=path.resolve(process.env.ORBIT_SMOKE_TRACE);await fs.mkdir(path.dirname(target),{recursive:true});
  const withoutReasoning=JSON.parse(JSON.stringify({model:process.env.ORBIT_SMOKE_MODEL??'llama3.1:latest',fixture,wire,events,session},(key,value)=>key==='thinking'||key==='reasoning'?undefined:value));
  await fs.writeFile(target,JSON.stringify(withoutReasoning,null,2),{mode:0o600});console.log(`Synthetic smoke trace: ${target}`);
 }
 await fs.rm(root,{recursive:true,force:true});
}
