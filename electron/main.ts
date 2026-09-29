import { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, nativeTheme } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store';
import { detectHardware } from './hardware';
import { searchModels, modelFiles, pullModel } from './hub';
import { chooseRecommendedFile, compareRecommendedModels } from '../shared/models';
import { HFAuth } from './hf-auth';
import { runAgent } from './agent';
import { executeTool } from './tools';
import { testConnection } from './providers';
import { codexLogin, codexStatus, runCodex, closeCodex } from './codex';
import type { AgentEvent, Settings, Session, ToolCall } from '../shared/types';
const providerSchema=z.object({kind:z.enum(['ollama','openai','anthropic','gemini','compatible','demo','codex','huggingface']),model:z.string().max(200),baseUrl:z.string().max(2000),apiKey:z.string().max(4096).optional(),hasKey:z.boolean().optional()});
const settingsSchema=z.object({provider:providerSchema,workspace:z.string().max(4096),maxSteps:z.number().int().min(1).max(40),allowCommands:z.boolean(),allowComputer:z.boolean(),pythonPath:z.string().min(1).max(4096),theme:z.enum(['system','light','dark']).default('system'),textSize:z.enum(['normal','large','extra-large']).default('normal')});
let window:BrowserWindow;let store:Store;let active:{id:string;sessionId:string;controller:AbortController}|null=null;
let startingRun=false;
let hfAuth:HFAuth;
let download:AbortController|null=null;
let lastDownload:import('../shared/types').ModelDownload|null=null;
const downloadable=new Map<string,{bytes:number;expires:number}>();
const approvals=new Map<string,{runId:string;resolve:(yes:boolean)=>void}>();
const devURL=!app.isPackaged&&process.env.ORBIT_DEV_URL==='http://127.0.0.1:5173'?process.env.ORBIT_DEV_URL:undefined;
const uiFile=path.join(__dirname,'../dist/index.html');
function emit(event:AgentEvent){if(window&&!window.isDestroyed())window.webContents.send('orbit:event',event);}
function approve(runId:string,call:ToolCall,reason:string,signal:AbortSignal):Promise<boolean>{
 if(signal.aborted)return Promise.resolve(false);
 return new Promise(resolve=>{const approvalId=randomUUID();const abort=()=>finish(false);const finish=(yes:boolean)=>{signal.removeEventListener('abort',abort);approvals.delete(approvalId);resolve(yes);};approvals.set(approvalId,{runId,resolve:finish});signal.addEventListener('abort',abort,{once:true});emit({type:'approval',runId,approvalId,call,reason});});
}
const allowedLinks=['huggingface.co','claude.ai','ollama.com','docs.ollama.com','platform.openai.com','developers.openai.com','learn.chatgpt.com','chatgpt.com','openai.com','auth.openai.com','auth0.openai.com','claude.com','code.claude.com','console.anthropic.com','platform.claude.com','ai.google.dev','aistudio.google.com','gemini.google.com','antigravity.google','developers.google.com','www.python.org','pyautogui.readthedocs.io'];
async function external(raw:string){const url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password||!allowedLinks.includes(url.hostname))throw new Error('Only supported provider documentation and sign-in links can be opened.');await shell.openExternal(url.toString());}
function handle(channel:string,fn:(...args:any[])=>unknown){ipcMain.handle(channel,(event,...args)=>{const expected=devURL?`${devURL}/`:pathToFileURL(uiFile).href;if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url.split('#')[0]!==expected)throw new Error('Untrusted application window.');return fn(...args);});}
function upsert(session:Session){session.updatedAt=new Date().toISOString();store.sessions=[session,...store.sessions.filter(s=>s.id!==session.id)].slice(0,100);}
function register(){
 handle('orbit:bootstrap',()=>({settings:store.publicSettings(),sessions:store.sessions,platform:process.platform,secureStorage:store.secure(),version:app.getVersion()}));
 handle('orbit:save-settings',async(raw:unknown)=>{if(active||startingRun)throw new Error('Stop the active task before changing its settings.');const value=settingsSchema.parse(raw) as Settings;if(value.workspace){const resolved=await fs.realpath(value.workspace);if(!(await fs.stat(resolved)).isDirectory())throw new Error('Workspace must be a folder.');value.workspace=resolved;}nativeTheme.themeSource=value.theme??'system';return store.saveSettings(value);});
 handle('orbit:choose-workspace',async()=>{if(active||startingRun)throw new Error('Stop the task before changing workspace.');const result=await dialog.showOpenDialog(window,{title:'Choose the folder Orbit may work in',properties:['openDirectory','createDirectory']});return result.canceled?null:result.filePaths[0];});
 handle('orbit:test-connection',async(raw:unknown)=>{const p=providerSchema.parse(raw);if(p.kind==='codex'){const status=await codexStatus();return {ok:status.authenticated,message:status.authenticated?`Signed in${status.email?` as ${status.email}`:''}.`:'Install Codex CLI and sign in with ChatGPT.'};}return testConnection(store.configured({...store.settings,provider:p}).provider);});
 handle('orbit:hardware',()=>detectHardware());
 handle('orbit:search-models',async(raw:unknown)=>{const query=z.string().max(100).parse(raw);const rows=await searchModels(query);if(query.trim())return rows;const hardware=await detectHardware();const recommendations=await Promise.allSettled(rows.map(async row=>{const files=await modelFiles(row.id,hardware);for(const file of files)downloadable.set(file.ollamaModel,{bytes:file.sizeBytes,expires:Date.now()+15*60_000});return {...row,recommendedFile:chooseRecommendedFile(files)};}));const values=recommendations.map((result,index)=>result.status==='fulfilled'?result.value:rows[index]);return values.sort(compareRecommendedModels);});
 handle('orbit:model-files',async(raw:unknown)=>{const repo=z.string().max(200).parse(raw);const files=await modelFiles(repo,await detectHardware());if(downloadable.size>2000)downloadable.clear();for(const file of files)downloadable.set(file.ollamaModel,{bytes:file.sizeBytes,expires:Date.now()+15*60_000});return files;});
 handle('orbit:download-model',async(raw:unknown)=>{if(download)throw new Error('A model download is already running.');const input=z.object({model:z.string().max(500),sizeBytes:z.number().positive().finite()}).parse(raw);const verified=downloadable.get(input.model);if(!verified||verified.expires<Date.now()||verified.bytes!==input.sizeBytes)throw new Error('Refresh the model files before downloading.');download=new AbortController();const controller=download;const timeout=setTimeout(()=>controller.abort(),2*60*60_000);const notify=(event:import('../shared/types').ModelDownload)=>{lastDownload=event;if(window&&!window.isDestroyed())window.webContents.send('orbit:download',event);};notify({model:input.model,status:'Starting download',completed:0,total:input.sizeBytes,done:false});void pullModel(input.model,controller.signal,notify).catch((e)=>notify({model:input.model,status:controller.signal.aborted?'Stopped':'Download failed',completed:0,total:input.sizeBytes,done:true,error:controller.signal.aborted?'Download stopped. Ollama can retain partial data for the next attempt.':(e as Error).message})).finally(()=>{clearTimeout(timeout);if(download===controller)download=null;});});
 handle('orbit:download-state',()=>lastDownload);
 handle('orbit:cancel-download',()=>download?.abort());
 handle('orbit:hf-status',()=>hfAuth.status());
 handle('orbit:hf-login',async()=>{const login=await hfAuth.begin();await external(login.verificationUrl);return login;});
 handle('orbit:hf-poll',()=>hfAuth.poll());
 handle('orbit:hf-cancel',()=>hfAuth.cancel());
 handle('orbit:codex-login',async()=>{const result=await codexLogin();await external(result.url);return result;});
 handle('orbit:codex-status',()=>codexStatus());
 handle('orbit:open-external',(raw:unknown)=>external(z.string().max(4000).parse(raw)));
 handle('orbit:delete-session',async(raw:unknown)=>{const id=z.string().uuid().parse(raw);if(active?.sessionId===id)throw new Error('Stop the task before deleting it.');store.sessions=store.sessions.filter(s=>s.id!==id);await store.save();});
 handle('orbit:approve',(raw:unknown)=>{const {approvalId,approved}=z.object({approvalId:z.string().uuid(),approved:z.boolean()}).parse(raw);const pending=approvals.get(approvalId);if(!pending||pending.runId!==active?.id)throw new Error('This approval is no longer active.');pending.resolve(approved);});
 handle('orbit:cancel-run',()=>{active?.controller.abort();});
 handle('orbit:start-run',async(raw:unknown)=>{
  if(active||startingRun)throw new Error('A task is already running.');startingRun=true;try{const input=z.object({sessionId:z.string().uuid().optional(),prompt:z.string().trim().min(1).max(32000)}).parse(raw);
  const settings=store.configured(store.settings);if(!settings.workspace)throw new Error('Choose a workspace folder in Settings first.');if(!(await fs.stat(settings.workspace)).isDirectory())throw new Error('Workspace folder is unavailable.');
  const previous=input.sessionId?store.sessions.find(s=>s.id===input.sessionId):undefined;if(input.sessionId&&!previous)throw new Error('This task no longer exists.');
  const session:Session=previous??{id:randomUUID(),title:input.prompt.slice(0,60),messages:[],updatedAt:new Date().toISOString()};
  const userMessage={id:randomUUID(),role:'user' as const,content:input.prompt,createdAt:new Date().toISOString()};session.messages.push(userMessage);upsert(session);
  const runId=randomUUID();const controller=new AbortController();active={id:runId,sessionId:session.id,controller};try{await store.save();}catch(e){active=null;throw e;}
  setTimeout(async()=>{
   emit({type:'message',runId,message:userMessage});
   try{
    if(settings.provider.kind==='codex'){
     const prompt=session.messages.slice(-20).map(m=>`${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
     const text=await runCodex({prompt,workspace:settings.workspace,model:settings.provider.model||undefined,signal:controller.signal,onApproval:({call,reason})=>approve(runId,call,reason,controller.signal),onEvent:e=>{if(e.type==='tool')emit({type:'tool',runId,call:{id:e.id??randomUUID(),name:'codex',arguments:{detail:e.message}},status:e.status??'running'});else emit({type:'status',runId,message:e.type==='text'?'Codex is responding…':e.message});}});
     if(text){const message={id:randomUUID(),role:'assistant' as const,content:text,createdAt:new Date().toISOString()};session.messages.push(message);emit({type:'message',runId,message});}
    }else await runAgent({runId,session,settings,signal:controller.signal,emit,approve:(call,reason)=>approve(runId,call,reason,controller.signal),computerScript:app.isPackaged?path.join(process.resourcesPath,'computer.py'):path.join(__dirname,'computer.py'),execute:async(call,settings,signal,script)=>{if(call.name!=='computer')return executeTool(call,settings,signal,script);window.hide();try{await new Promise(r=>setTimeout(r,400));signal.throwIfAborted();return await executeTool(call,settings,signal,script);}finally{if(!window.isDestroyed())window.showInactive();}}});
   }catch(e){const message=controller.signal.aborted?'Task stopped. Completed actions remain applied.':(e as Error).message;const entry={id:randomUUID(),role:'assistant' as const,content:`${controller.signal.aborted?'Stopped':'Task error'}: ${message}`,createdAt:new Date().toISOString()};session.messages.push(entry);emit({type:'message',runId,message:entry});emit({type:'error',runId,message});}
   finally{for(const [id,pending]of approvals)if(pending.runId===runId){pending.resolve(false);approvals.delete(id);}upsert(session);try{await store.save();}catch(e){emit({type:'error',runId,message:`Could not save task history: ${(e as Error).message}`});}active=null;emit({type:'done',runId,session});}
  },50);
  return{runId,sessionId:session.id};
 }finally{startingRun=false;}
 });
}
async function createWindow(){
 window=new BrowserWindow({width:1380,height:900,minWidth:780,minHeight:620,title:'Orbit',backgroundColor:nativeTheme.shouldUseDarkColors?'#17191b':'#f6f7f5',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 window.on('close',event=>{if(active){const answer=dialog.showMessageBoxSync(window,{type:'question',buttons:['Keep working','Stop and quit'],defaultId:0,cancelId:0,message:'A task is still running. Stop it and close Orbit?'});if(answer===0){event.preventDefault();return;}active.controller.abort();}});
 if(devURL)await window.loadURL(devURL);else await window.loadFile(uiFile);
}
app.whenReady().then(async()=>{if(process.env.ORBIT_TEST_DATA_DIR)app.setPath('userData',path.resolve(process.env.ORBIT_TEST_DATA_DIR));store=new Store(app.getPath('userData'));await store.load();nativeTheme.themeSource=store.settings.theme??'system';hfAuth=new HFAuth({clientId:process.env.ORBIT_HF_CLIENT_ID,getToken:()=>store.getSecret('huggingface'),saveToken:(token)=>store.setSecret('huggingface',token)});register();await createWindow();globalShortcut.register('CommandOrControl+Alt+Shift+O',()=>{active?.controller.abort();if(!window.isDestroyed())window.show();});app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)void createWindow();});});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
app.on('before-quit',()=>{active?.controller.abort();download?.abort();hfAuth?.cancel();closeCodex();});
