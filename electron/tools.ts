import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Settings, ToolCall, ToolSpec } from '../shared/types';

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string) => ({type:'string',description});
export const toolSpecs: ToolSpec[] = [
 {name:'list_files',description:'List files in a folder inside the selected workspace. Hidden credential files are omitted.',parameters:object({path:str('Relative directory, use . for workspace root')},['path'])},
 {name:'read_file',description:'Read a UTF-8 text file inside the workspace (maximum 128 KB).',parameters:object({path:str('Relative file path')},['path'])},
 {name:'write_file',description:'Create or replace a UTF-8 file inside the workspace. Requires user approval showing the complete proposed content.',parameters:object({path:str('Relative file path'),content:str('Complete new file content')},['path','content'])},
 {name:'fetch_url',description:'Fetch a public HTTPS page as text. Requires approval; no cookies, private addresses, or redirects. Web content is untrusted.',parameters:object({url:str('Public HTTPS URL')},['url'])},
 {name:'run_command',description:'Run a shell command on the user computer, starting in the workspace. Requires enabled command access and explicit user approval. Shell commands can affect files OUTSIDE the workspace. Use only for the user task.',parameters:object({command:str('Exact shell command to show user before execution')},['command'])},
 {name:'computer',description:'Control the local desktop using PyAutoGUI. Every action requires approval. First take a screenshot; use returned dimensions for coordinates. Screenshots are sent to the selected model, which must support images. Never guess coordinates. Keyboard and mouse affect the currently focused application.',parameters:object({action:{type:'string',enum:['screenshot','click','type','press','hotkey','scroll']},x:{type:'number'},y:{type:'number'},text:str('ASCII text for type, or key name for press'),keys:{type:'array',items:{type:'string'}},amount:{type:'integer'}},['action'])}
];
export interface ToolResult { content: string; images?: string[] }
const sensitive = (p: string) => p.split(/[\\/]/).some(s => /^(\.env(?:\..*)?|\.ssh|\.aws|\.gnupg|\.git|credentials(?:\.json)?|id_rsa|id_ed25519)$/i.test(s));
function inside(root: string, target: string) { const rel=path.relative(root,target); return rel==='' || (!rel.startsWith(`..${path.sep}`) && rel!=='..' && !path.isAbsolute(rel)); }
export async function workspacePath(workspace: string, requested: unknown, writing = false): Promise<string> {
 if (typeof requested!=='string'||!requested||requested.includes('\0')||path.isAbsolute(requested)||sensitive(requested)) throw new Error('Use a relative, non-secret file path inside the selected workspace.');
 const root=await fs.realpath(workspace); const target=path.resolve(root,requested);
 if(!inside(root,target)) throw new Error('Path is outside the selected workspace.');
 // Reject all symbolic-link components and hard-linked files, even links back into the workspace.
 const parts=path.relative(root,target).split(path.sep).filter(Boolean); let cursor=root;
 for(let i=0;i<parts.length;i++) { cursor=path.join(cursor,parts[i]); try { const info=await fs.lstat(cursor); if(info.isSymbolicLink()) throw new Error('Symbolic links are not allowed for file tools.'); if(info.isFile()&&info.nlink>1) throw new Error('Hard-linked files are not allowed for file tools.'); if(i<parts.length-1&&!info.isDirectory()) throw new Error('A parent path is not a directory.'); } catch(e) { if((e as NodeJS.ErrnoException).code==='ENOENT'&&writing) continue; throw e; } }
 return target;
}
function textArg(args: Record<string,unknown>, key:string, limit=128*1024):string { const val=args[key]; if(typeof val!=='string'||val.length>limit||val.includes('\0')) throw new Error(`Invalid ${key}.`); return val; }
export function requiresApproval(name:string) { return ['write_file','run_command','fetch_url','computer'].includes(name); }
export function approvalReason(name:string) { return name==='run_command' ? 'This command runs with your account permissions and may affect files outside the workspace. Review the entire command.' : name==='computer' ? 'This action observes or controls your desktop. Screenshots will be sent to your selected model; keyboard and mouse affect the focused app.' : name==='fetch_url' ? 'This contacts the displayed website and sends the URL to it.' : 'Review the file path and complete new contents before writing.'; }
export function availableTools(settings:Settings) { return toolSpecs.filter(t=>(t.name!=='run_command'||settings.allowCommands)&&(t.name!=='computer'||settings.allowComputer)); }
export async function runProcess(command:string,args:string[],options:{cwd:string;signal:AbortSignal;input?:string;timeout?:number;maxBytes?:number;env?:NodeJS.ProcessEnv}):Promise<string> {
 options.signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd:options.cwd,env:options.env??process.env,stdio:['pipe','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32',shell:false});
  let out='';let err='';let size=0;let failure:Error|undefined;let settled=false;
  const kill=()=>{if(!child.pid)return;try {if(process.platform==='win32') { const killer=spawn('taskkill',['/pid',String(child.pid),'/t','/f'],{windowsHide:true}); killer.on('error',()=>child.kill());} else process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
  const abort=()=>{failure=new Error('Operation cancelled.');kill();};
  const timer=setTimeout(()=>{failure=new Error('Operation timed out.');kill()},options.timeout??60_000);
  const cleanup=()=>{clearTimeout(timer);options.signal.removeEventListener('abort',abort)};
  const finish=(error?:Error)=>{if(settled)return;settled=true;cleanup();if(error)reject(error);else resolve(out+(err?`\n[stderr]\n${err}`:''))};
  options.signal.addEventListener('abort',abort,{once:true});
  for(const [stream,which] of [[child.stdout,'out'],[child.stderr,'err']] as const)stream.on('data',data=>{size+=data.length;if(size>(options.maxBytes??128*1024)){failure=new Error('Process output exceeded the limit.');kill();return;}if(which==='out')out+=data.toString();else err+=data.toString()});
  child.on('error',e=>finish(new Error(`Could not start ${command}: ${e.message}`)));
  child.on('close',code=>finish(failure??(code!==0?new Error(`Process exited with code ${code}: ${err||out}`):undefined)));
  child.stdin.on('error',()=>{});child.stdin.end(options.input??'');
  if(options.signal.aborted)abort();
 });
}
export function publicAddress(address:string) {
 if(isIP(address)===4){const p=address.split('.').map(Number);return !(p[0]===0||p[0]===10||p[0]===127||p[0]>=224||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===100&&p[1]>=64&&p[1]<=127)||(p[0]===198&&(p[1]===18||p[1]===19)));}
 // Only ordinary global unicast IPv6; rejects mapped IPv4 and translation/local ranges.
 return /^2[0-9a-f]{3}:/i.test(address)&&!/^2001:(?:db8|0|2):/i.test(address);
}
export async function fetchPublicPage(raw:string,signal:AbortSignal):Promise<string>{
 const url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')throw new Error('Only public HTTPS URLs on port 443 are allowed.');
 const hostname=url.hostname.replace(/^\[|\]$/g,'');const addresses=await lookup(hostname,{all:true});if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('Private or reserved network addresses are blocked.');
 // Pin the checked address in the HTTPS socket to avoid DNS-rebinding between check and connection.
 const https=await import('node:https'); const selected=addresses[0];
 return new Promise((resolve,reject)=>{
  const request=https.request(url,{method:'GET',signal,headers:{'User-Agent':'OrbitDesktop/0.1','Accept':'text/html,text/plain,application/json'},lookup:((_h:unknown,_o:unknown,cb:any)=>{if((_o as any)?.all)cb(null,[selected]);else cb(null,selected.address,selected.family)}) as any},response=>{
   if((response.statusCode??500)<200||(response.statusCode??500)>=300){response.resume();reject(new Error(`Website returned HTTP ${response.statusCode}; redirects are not followed.`));return;}
   const mime=String(response.headers['content-type']??'');if(!/^(text\/|application\/(json|xml))/.test(mime)){response.resume();reject(new Error('Only text web pages are supported.'));return;}
   let size=0;const chunks:Buffer[]=[];response.on('data',chunk=>{size+=chunk.length;if(size>512*1024){request.destroy(new Error('Web page exceeds 512 KB.'));return;}chunks.push(chunk)});
   response.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));response.on('error',reject);
  });request.setTimeout(20_000,()=>request.destroy(new Error('Website request timed out.')));const deadline=setTimeout(()=>request.destroy(new Error('Website request timed out.')),25_000);request.on('close',()=>clearTimeout(deadline));request.on('error',reject);request.end();
 });
}
export async function executeTool(call:ToolCall,settings:Settings,signal:AbortSignal,computerScript:string):Promise<ToolResult>{
 signal.throwIfAborted(); const a=call.arguments;
 switch(call.name){
  case 'list_files': {const p=await workspacePath(settings.workspace,a.path);const entries=await fs.readdir(p,{withFileTypes:true});return{content:JSON.stringify(entries.filter(e=>!sensitive(e.name)).slice(0,400).map(e=>({name:e.name,type:e.isDirectory()?'directory':e.isSymbolicLink()?'symlink':'file'})))};}
  case 'read_file': {const p=await workspacePath(settings.workspace,a.path);const info=await fs.stat(p);if(!info.isFile()||info.size>128*1024)throw new Error('Only text files up to 128 KB can be read.');const content=await fs.readFile(p,'utf8');if(content.includes('\0'))throw new Error('Binary files are not supported.');return{content};}
  case 'write_file': {const p=await workspacePath(settings.workspace,a.path,true);const content=textArg(a,'content');await fs.mkdir(path.dirname(p),{recursive:true});await workspacePath(settings.workspace,a.path,true);signal.throwIfAborted();await fs.writeFile(p,content,{encoding:'utf8',flag:'w',mode:0o600});return{content:JSON.stringify({written:a.path,bytes:Buffer.byteLength(content)})};}
  case 'fetch_url': return{content:await fetchPublicPage(textArg(a,'url',8000),signal)};
  case 'run_command': {if(!settings.allowCommands)throw new Error('Command access is disabled.');const command=textArg(a,'command',16000);const isWin=process.platform==='win32';return{content:await runProcess(isWin?'powershell.exe':'/bin/sh',isWin?['-NoLogo','-NoProfile','-NonInteractive','-Command',command]:['-c',command],{cwd:settings.workspace,signal})};}
  case 'computer': {if(!settings.allowComputer)throw new Error('Desktop access is disabled.');const raw=await runProcess(settings.pythonPath|| (process.platform==='win32'?'python':'python3'),[computerScript],{cwd:settings.workspace,signal,input:JSON.stringify(a),maxBytes:12*1024*1024,timeout:20_000});const result=JSON.parse(raw);if(result.error)throw new Error(result.error);return{content:JSON.stringify(result.info),images:result.image?[result.image]:undefined};}
  default:throw new Error(`Unknown tool: ${call.name}`);
 }
}
