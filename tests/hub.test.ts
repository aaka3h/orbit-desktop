import test from 'node:test';
import assert from 'node:assert/strict';
import {searchModels,modelFiles,parseModelFiles,parseDownloadModel,pullModel,validateRepo} from '../electron/hub';
import {requestModel} from '../electron/providers';
import type {HardwareInfo,ModelDownload} from '../shared/types';
const hw:HardwareInfo={platform:'linux',arch:'x64',cpu:'Test CPU',logicalCores:8,totalMemoryBytes:16*2**30,availableMemoryBytes:12*2**30,gpus:[],notes:[]};
test('hub rejects repository and filename traversal or non-model resources',()=>{for(const id of ['../secret','https://huggingface.co/x/y','owner/repo/extra','owner/a..b'])assert.throws(()=>validateRepo(id));for(const name of ['example.com/x/y:tiny.gguf','hf.co/owner/repo:../test.gguf','hf.co/owner/repo:mmproj.gguf','hf.co/owner/repo:model-00001-of-00002.gguf'])assert.throws(()=>parseDownloadModel(name));assert.deepEqual(parseDownloadModel('hf.co/Qwen/Small-GGUF:Small-Q4_K_M.gguf'),{repo:'Qwen/Small-GGUF',filename:'Small-Q4_K_M.gguf'});});
test('only full GGUF files get actual sizes and fit estimates',()=>{const files=parseModelFiles('owner/repo',{siblings:[{rfilename:'model-Q4_K_M.gguf',size:2**30},{rfilename:'README.md',size:10},{rfilename:'mmproj.gguf',size:100},{rfilename:'model-00001-of-00002.gguf',size:100},{rfilename:'nested/model.gguf',size:100}]},hw);assert.equal(files.length,1);assert.equal(files[0].sizeBytes,2**30);assert.equal(files[0].quantization,'Q4_K_M');assert.equal(files[0].ollamaModel,'hf.co/owner/repo:model-Q4_K_M.gguf');assert.notEqual(files[0].fit.rating,'unknown');assert.throws(()=>parseModelFiles('owner/private',{gated:true,siblings:[]},hw),/requires access/);});
test('search encodes user query and fixed public endpoint',async()=>{let observed='';const f=(async(input)=>{observed=String(input);return Response.json([{id:'owner/good',downloads:12,gated:false},{id:'../../bad'}]);}) as typeof fetch;const r=await searchModels('hi & filter=bad',f);const url=new URL(observed);assert.equal(url.hostname,'huggingface.co');assert.equal(url.searchParams.get('search'),'hi & filter=bad');assert.equal(url.searchParams.get('filter'),'gguf');assert.equal(r.length,1);});
test('Ollama download parses split status chunks and requires final success',async()=>{const events:ModelDownload[]=[];let input:RequestInit|undefined;const f=(async(url,options)=>{assert.equal(String(url),'http://127.0.0.1:11434/api/pull');input=options;return new Response('{"status":"pulling","total":100,"completed":50}\n{"status":"success"}\n');}) as typeof fetch;await pullModel('hf.co/owner/repo:model.gguf',new AbortController().signal,e=>events.push(e),f);assert.equal(JSON.parse(String(input!.body)).model,'hf.co/owner/repo:model.gguf');assert.equal(events.at(-1)?.done,true);assert.equal(events.at(-1)?.status,'success');await assert.rejects(pullModel('hf.co/owner/repo:model.gguf',new AbortController().signal,()=>{},(async()=>new Response('{"status":"pulling"}\n')) as typeof fetch),/before confirmation/);});
test('Ollama errors and cancellation are surfaced without executing shell',async()=>{await assert.rejects(pullModel('hf.co/owner/repo:model.gguf',new AbortController().signal,()=>{},(async()=>new Response('{"error":"unsupported architecture"}\n')) as typeof fetch),/unsupported architecture/);const c=new AbortController();c.abort();await assert.rejects(pullModel('hf.co/owner/repo:model.gguf',c.signal,()=>{}),/abort/i);});

test('Hub ignores malformed entries and treats invalid sizes as unknown',()=>{
 const files=parseModelFiles('owner/repo',{siblings:[null,3,{}, {rfilename:'negative.gguf',size:-100},{rfilename:'large.gguf',size:Number.MAX_SAFE_INTEGER+1},{rfilename:'valid.gguf',lfs:{size:12345}}]},hw);
 assert.equal(files.length,3);
 assert.equal(files.find(f=>f.path==='negative.gguf')?.sizeBytes,0);
 assert.equal(files.find(f=>f.path==='large.gguf')?.fit.rating,'unknown');
 assert.equal(files.find(f=>f.path==='valid.gguf')?.sizeBytes,12345);
 assert.throws(()=>parseModelFiles('owner/repo',null,hw),/invalid model metadata/);
});

test('Hardware information never leaves the machine in model metadata requests',async()=>{
 let observed:RequestInit|undefined;
 await modelFiles('owner/repo',hw,(async(url,init)=>{assert.equal(String(url),'https://huggingface.co/api/models/owner/repo?blobs=true');observed=init;return Response.json({siblings:[{rfilename:'valid.gguf',size:12345}]});}) as typeof fetch);
 assert.equal(observed?.body,undefined);
 assert.equal(new Headers(observed?.headers).has('Authorization'),false);
 assert.ok(!JSON.stringify(observed).includes(hw.cpu));
});

test('Download status handles actual split chunks and exits on success without waiting for EOF',async()=>{
 const enc=new TextEncoder();let cancelled=false;const events:ModelDownload[]=[];
 const body=new ReadableStream({start(controller){controller.enqueue(enc.encode('{"status":"pull'));controller.enqueue(enc.encode('ing","total":100,"completed":-4}\n{"status":"suc'));controller.enqueue(enc.encode('cess"}\n'));},cancel(){cancelled=true;}});
 await pullModel('hf.co/owner/repo:exact-Q4.gguf',new AbortController().signal,e=>events.push(e),(async()=>new Response(body)) as typeof fetch);
 assert.equal(cancelled,true);
 assert.equal(events.at(-1)?.done,true);
 assert.equal(events[0].completed,0);
 assert.equal(events[0].model,'hf.co/owner/repo:exact-Q4.gguf');
});

test('Stopping a stalled download cancels its reader and reports resumable partial data',async()=>{
 let cancelled=false;const c=new AbortController();
 const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"status":"pulling","total":100,"completed":50}\n'));},cancel(){cancelled=true;}});
 const download=pullModel('hf.co/owner/repo:model.gguf',c.signal,()=>{},(async()=>new Response(body)) as typeof fetch);
 const rejection=assert.rejects(download,/partial data/);
 await new Promise<void>(resolve=>setImmediate(resolve));
 c.abort();await rejection;
 assert.equal(cancelled,true);
});

test('Download progress sums separate digests without replacing completed model bytes with template bytes',async t=>{
 const events:ModelDownload[]=[];let now=1000;
 t.mock.method(Date,'now',()=>{now+=200;return now;});
 const lines=[
  {status:'pulling model',digest:'sha256:model',total:100000,completed:90000},
  {status:'pulling model',digest:'sha256:model',total:100000,completed:100000},
  {status:'pulling template',digest:'sha256:template',total:100,completed:50},
  {status:'pulling template',digest:'sha256:template',total:100,completed:100},
  {status:'success'},
 ];
 await pullModel('hf.co/owner/repo:model.gguf',new AbortController().signal,e=>events.push(e),(async()=>new Response(lines.map(value=>JSON.stringify(value)).join('\n'))) as typeof fetch);
 assert.equal(events[2].completed,100050);
 assert.equal(events[2].total,100100);
 assert.ok(events[2].completed/events[2].total>0.99);
 assert.equal(events.at(-1)?.completed,100100);
 assert.equal(events.at(-1)?.total,100100);
 assert.equal(events.at(-1)?.done,true);
});

test('Repeated or out-of-order progress for the same digest does not double-count or regress bytes',async t=>{
 const events:ModelDownload[]=[];let now=1000;
 t.mock.method(Date,'now',()=>{now+=200;return now;});
 const lines=[
  {status:'pulling',digest:'sha256:model',total:100,completed:80},
  {status:'pulling',digest:'sha256:model',total:100,completed:80},
  {status:'pulling',digest:'sha256:model',total:100,completed:20},
  {status:'success'},
 ];
 await pullModel('hf.co/owner/repo:model.gguf',new AbortController().signal,e=>events.push(e),(async()=>new Response(lines.map(value=>JSON.stringify(value)).join('\n'))) as typeof fetch);
 assert.deepEqual(events.slice(0,3).map(event=>event.completed),[80,80,80]);
 assert.ok(events.every(event=>event.total===100));
 assert.equal(events.at(-1)?.completed,100);
});

test('Hugging Face inference ignores custom origins and preserves assistant/tool roles',async t=>{
 const requests:{url:string;init:RequestInit;body:any}[]=[];
 t.mock.method(globalThis,'fetch',async(url:unknown,init:RequestInit)=>{requests.push({url:String(url),init,body:JSON.parse(String(init.body))});return Response.json({choices:[{message:{role:'assistant',content:'Completed.'},finish_reason:'stop'}]});});
 await requestModel({kind:'huggingface',model:'owner/model',baseUrl:'https://untrusted.invalid',apiKey:'hf_test_private'},[
  {role:'user',content:'Inspect my files.'},
  {role:'assistant',content:'',toolCalls:[{id:'read1',name:'read_file',arguments:{path:'notes.md'}}]},
  {role:'tool',toolCallId:'read1',name:'read_file',content:'Some notes'},
 ],[],new AbortController().signal);
 assert.equal(requests[0].url,'https://router.huggingface.co/v1/chat/completions');
 assert.equal(new Headers(requests[0].init.headers).get('authorization'),'Bearer hf_test_private');
 assert.equal(requests[0].init.redirect,'error');
 assert.deepEqual(requests[0].body.messages.map((m:any)=>m.role),['user','assistant','tool']);
 assert.equal(requests[0].body.messages[2].tool_call_id,'read1');
 assert.ok(!JSON.stringify(requests[0].body).includes('hf_test_private'));
});
