import { safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProviderKind, Session, Settings } from '../shared/types';
export class Store {
 settings:Settings={provider:{kind:'ollama',model:'qwen3:8b',baseUrl:'http://localhost:11434'},workspace:'',maxSteps:12,allowCommands:false,allowComputer:false,allowBrowser:false,browserChannel:'chrome',selectedBotId:'builtin:general',enabledSkillIds:[],enabledPluginIds:[],theme:'system',textSize:'normal',pythonPath:process.platform==='win32'?'python':'python3'};
 sessions:Session[]=[];
 private keys:Partial<Record<ProviderKind,string>>={};
 private encrypted:Partial<Record<ProviderKind,string>>={};
 private writing:Promise<void>=Promise.resolve();
 constructor(private directory:string){}
 secure(){return safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend()!=='basic_text');}
 async load(){
  await fs.mkdir(this.directory,{recursive:true,mode:0o700});
  try {const data=JSON.parse(await fs.readFile(path.join(this.directory,'state.json'),'utf8'));if(data.settings)this.settings={...this.settings,...data.settings,provider:{...this.settings.provider,...data.settings.provider,apiKey:undefined}};this.sessions=Array.isArray(data.sessions)?data.sessions.slice(0,100):[];this.encrypted=data.keys??{};if(this.secure())for(const [kind,cipher] of Object.entries(this.encrypted)){try{this.keys[kind as ProviderKind]=safeStorage.decryptString(Buffer.from(cipher as string,'base64'));}catch{/* Keep undecryptable values for keychain recovery. */}}}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')await fs.copyFile(path.join(this.directory,'state.json'),path.join(this.directory,`state-unreadable-${Date.now()}.json`)).catch(()=>{});}
 }
 publicSettings():Settings{return{...this.settings,provider:{...this.settings.provider,apiKey:undefined,hasKey:!!this.keys[this.settings.provider.kind]}};}
 configured(settings:Settings):Settings{return{...settings,provider:{...settings.provider,apiKey:settings.provider.apiKey??this.keys[settings.provider.kind]}};}
 getSecret(kind:ProviderKind){return this.keys[kind];}
 async setSecret(kind:ProviderKind,token:string){if(token){this.keys[kind]=token;if(this.secure())this.encrypted[kind]=safeStorage.encryptString(token).toString('base64');else delete this.encrypted[kind];}else{delete this.keys[kind];delete this.encrypted[kind];}await this.save();}
 async saveSettings(value:Settings){const p=value.provider;if(p.apiKey!==undefined){if(p.apiKey.trim()){this.keys[p.kind]=p.apiKey.trim();if(this.secure())this.encrypted[p.kind]=safeStorage.encryptString(p.apiKey.trim()).toString('base64');else delete this.encrypted[p.kind];}else{delete this.keys[p.kind];delete this.encrypted[p.kind];}}
 this.settings={...value,provider:{...p,apiKey:undefined,hasKey:undefined}};await this.save();return this.publicSettings();}
 async save(){const payload=JSON.stringify({settings:this.settings,sessions:this.sessions.slice(0,100),keys:this.encrypted},null,2);this.writing=this.writing.catch(()=>{}).then(async()=>{const tmp=path.join(this.directory,'state.tmp');await fs.writeFile(tmp,payload,{mode:0o600});await fs.rename(tmp,path.join(this.directory,'state.json'));});return this.writing;}
}
