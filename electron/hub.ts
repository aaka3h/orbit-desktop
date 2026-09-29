import type { HardwareInfo, HubModel, HubFile, ModelDownload } from '../shared/types';
import { estimateFit } from './hardware';
const HF='https://huggingface.co';
const curated=['unsloth/Qwen3-0.6B-GGUF','unsloth/Qwen3-1.7B-GGUF','unsloth/Qwen3-4B-GGUF','unsloth/Qwen3-8B-GGUF'];
const repoPattern=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;
export function validateRepo(repo:string){if(!repoPattern.test(repo)||repo.includes('..'))throw new Error('Enter a Hugging Face repository as owner/model.');return repo;}
async function json(url:string,fetcher:typeof fetch=fetch):Promise<any>{
 const response=await fetcher(url,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error(`Hugging Face returned HTTP ${response.status}. ${response.status===429?'Wait a moment before searching again.':'Check your connection or choose a public model.'}`);
 if(Number(response.headers.get('content-length'))>4*1024*1024){await response.body?.cancel();throw new Error('Model metadata is too large.');}
 const reader=response.body?.getReader();let bytes=0;const chunks:Uint8Array[]=[];if(!reader)throw new Error('Hugging Face returned no metadata.');
 try {while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>4*1024*1024){await reader.cancel();throw new Error('Model metadata is too large.');}chunks.push(value);}}finally{reader.releaseLock();}
 return JSON.parse(Buffer.concat(chunks).toString());
}
function modelRow(value:any):HubModel|null{if(!value||typeof value!=='object')return null;const id=value.id??value.modelId;if(typeof id!=='string'||!repoPattern.test(id)||id.includes('..'))return null;return{id,downloads:Number(value.downloads)||0,likes:Number(value.likes)||0,gated:!!value.gated,tags:Array.isArray(value.tags)?value.tags.filter((s:unknown)=>typeof s==='string').slice(0,30):[]};}
export async function searchModels(query:string,fetcher:typeof fetch=fetch):Promise<HubModel[]>{
 const clean=query.trim();if(clean.length>100)throw new Error('Keep the model search under 100 characters.');
 if(!clean){const results=await Promise.allSettled(curated.map(repo=>json(`${HF}/api/models/${repo}`,fetcher)));const rows=results.flatMap(r=>r.status==='fulfilled'?[modelRow(r.value)]:[]).filter((r):r is HubModel=>!!r);if(!rows.length)throw new Error('Could not load starter models. Check your internet connection and try again.');return rows;}
 const params=new URLSearchParams({search:clean,filter:'gguf',sort:'downloads',direction:'-1',limit:'24',full:'true'});
 const data=await json(`${HF}/api/models?${params}`,fetcher);if(!Array.isArray(data))throw new Error('Invalid Hugging Face model list.');return data.map(modelRow).filter((r):r is HubModel=>!!r);
}
export function parseModelFiles(repo:string,data:any,hardware:HardwareInfo):HubFile[]{
 validateRepo(repo);if(!data||typeof data!=='object')throw new Error('Hugging Face returned invalid model metadata.');if(data.gated)throw new Error('This repository requires access approval. Use its Hugging Face page and configure access in Ollama. The built-in downloader supports public models.');
 if(!Array.isArray(data.siblings))return[];
 // Only exact, single-file GGUFs. Split shards and vision projector files are not standalone chat models.
 return data.siblings.filter((f:any)=>f&&typeof f.rfilename==='string'&&/\.gguf$/i.test(f.rfilename)&&!f.rfilename.includes('/')&&/^[A-Za-z0-9_.-]+$/.test(f.rfilename)&&!f.rfilename.includes('..')&&!/mmproj|projector|-\d{5}-of-\d{5}/i.test(f.rfilename)).map((f:any)=>{
 const reportedSize=Number(f.size??f.lfs?.size);const size=Number.isSafeInteger(reportedSize)&&reportedSize>0?reportedSize:0;const quant=String(f.rfilename).match(/(?:IQ|Q)\d[^.\-]*(?:_[A-Za-z0-9]+)*|[BF]+F?16|F32/i)?.[0]?.toUpperCase()??'GGUF';
 return{path:f.rfilename,sizeBytes:size,quantization:quant,ollamaModel:`hf.co/${repo}:${f.rfilename}`,fit:estimateFit(size,hardware)};
 }).sort((a:HubFile,b:HubFile)=>a.sizeBytes-b.sizeBytes).slice(0,80);
}
export async function modelFiles(repo:string,hardware:HardwareInfo,fetcher:typeof fetch=fetch):Promise<HubFile[]>{validateRepo(repo);return parseModelFiles(repo,await json(`${HF}/api/models/${repo}?blobs=true`,fetcher),hardware);}
export function parseDownloadModel(model:string):{repo:string;filename:string}{
 const match=/^hf\.co\/([^/]+\/[^/:]+):([A-Za-z0-9_.-]+\.gguf)$/i.exec(model);if(!match||match[2].includes('..')||/mmproj|projector|-\d{5}-of-\d{5}/i.test(match[2]))throw new Error('Choose a complete GGUF file from Model Hub.');return{repo:validateRepo(match[1]),filename:match[2]};
}
export async function pullModel(model:string,signal:AbortSignal,emit:(event:ModelDownload)=>void,fetcher:typeof fetch=fetch):Promise<void>{
 parseDownloadModel(model);signal.throwIfAborted();
 let response:Response;try{response=await fetcher('http://127.0.0.1:11434/api/pull',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,stream:true}),signal,redirect:'error'});}catch(e){if(signal.aborted)throw new Error('Download stopped. Ollama may retain partial data for the next attempt.');throw new Error('Start Ollama on this computer, then try Download again. Install it from ollama.com if needed.');}
 if(!response.ok||!response.body){await response.body?.cancel();throw new Error(`Ollama returned HTTP ${response.status}. Start a current Ollama version and try again.`);}
 const reader=response.body.getReader();const decoder=new TextDecoder();let pending='';let done=false;let completed=0,total=0;let lastEmit=0;
 const layers=new Map<string,{completed:number;total:number}>();
 const cancelReader=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancelReader,{once:true});
 const line=(raw:string)=>{
  if(!raw.trim()||done)return;let event:any;try{event=JSON.parse(raw);}catch{throw new Error('Ollama returned invalid download status. Try again to resume.');}
  if(!event||typeof event!=='object')throw new Error('Ollama returned invalid download status. Try again to resume.');
  if(event.error)throw new Error(String(event.error).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,500));
  const hasTotal=Number.isSafeInteger(event.total)&&event.total>=0,hasCompleted=Number.isSafeInteger(event.completed)&&event.completed>=0;
  if(hasTotal||hasCompleted){
   const digest=typeof event.digest==='string'&&event.digest?event.digest:'unidentified-layer';
   if(!layers.has(digest)&&layers.size>=256)throw new Error('Ollama returned too many download layers.');
   const layer=layers.get(digest)??{completed:0,total:0};
   if(hasTotal)layer.total=Math.max(layer.total,event.total);
   if(hasCompleted)layer.completed=Math.max(layer.completed,event.completed);
   if(layer.total)layer.completed=Math.min(layer.completed,layer.total);
   layers.set(digest,layer);
   total=0;completed=0;
   for(const value of layers.values()){total=Math.min(Number.MAX_SAFE_INTEGER,total+value.total);completed=Math.min(Number.MAX_SAFE_INTEGER,completed+value.completed);}
  }
  const status=String(event.status??'Downloading');if(status==='success'){done=true;if(total)completed=total;}
  const now=Date.now();if(done||now-lastEmit>150){emit({model,status,completed,total,done});lastEmit=now;}
 };
 try{while(!done){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;pending+=decoder.decode(next.value,{stream:true});if(pending.length>512*1024)throw new Error('Ollama download status exceeded the size limit.');let index;while(!done&&(index=pending.indexOf('\n'))>=0){line(pending.slice(0,index));pending=pending.slice(index+1);}}pending+=decoder.decode();line(pending);if(!done)throw new Error('Ollama download ended before confirmation. Try again to resume.');}
 catch(error){if(signal.aborted)throw new Error('Download stopped. Ollama may retain partial data for the next attempt.');throw error;}
 finally{signal.removeEventListener('abort',cancelReader);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
