import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bot, BookOpen, Check, ChevronRight, FileJson, Globe2, LoaderCircle, LockKeyhole, Package, Pencil, Plus, ShieldCheck, Trash2, TriangleAlert, X } from 'lucide-react';
import type { BotDefinition, BotInput, CapabilityCatalog, PluginPreview, Settings, SkillDefinition, SkillInput, ToolGroup } from '../shared/types';
import BrowserPanel from './BrowserPanel';

type LibraryTab = 'bots' | 'skills' | 'plugins' | 'browser';
type Editor = { kind: 'skill'; source: SkillDefinition['source']; draft: SkillInput } | { kind: 'bot'; source: BotDefinition['source']; draft: BotInput };
type DeleteTarget = { kind: 'skill' | 'bot' | 'plugin'; id: string; name: string };
const toolGroups: { id: ToolGroup; name: string; description: string }[] = [
  {id:'files',name:'Files',description:'Read files and propose changes in the workspace.'},
  {id:'web',name:'Web pages',description:'Fetch public page content with approval.'},
  {id:'browser',name:'Browser',description:'Research and interact with the visible Orbit browser.'},
  {id:'commands',name:'Terminal',description:'Request commands when terminal access is enabled.'},
  {id:'computer',name:'Desktop',description:'Request screenshots, mouse, and keyboard actions.'},
];
const emptyCatalog: CapabilityCatalog = {bots:[],skills:[],plugins:[]};

export default function AgentsLibrary({ initialTab = 'bots', settings, catalog, locked, onSaved, onCatalog, onClose }: { initialTab?: LibraryTab; settings: Settings; catalog: CapabilityCatalog | null; locked: boolean; onSaved: (settings: Settings) => void; onCatalog: (catalog: CapabilityCatalog) => void; onClose: () => void }) {
  const [tab, setTab] = useState<LibraryTab>(initialTab);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [remove, setRemove] = useState<DeleteTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ok:boolean;text:string} | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const removeRef = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  const api = window.orbit;
  const data = catalog || emptyCatalog;
  const editing = !!editor && (tab === 'bots' && editor.kind === 'bot' || tab === 'skills' && editor.kind === 'skill');
  const readOnly = editor?.source !== 'user';
  const disabled = locked || !!busy;

  useEffect(() => {
    mounted.current = true; let alive = true;
    if (api) api.capabilities().then(value => { if (alive) onCatalog(value); }).catch(error => { if (alive) setNotice({ok:false,text:String(error)}); });
    const previous = document.activeElement as HTMLElement;
    dialogRef.current?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const elements = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]')).filter(el => el.getClientRects().length && !el.closest('[inert]'));
      const first=elements[0]; const last=elements[elements.length-1];
      if(event.shiftKey && (document.activeElement===first || document.activeElement===dialogRef.current)){event.preventDefault();last?.focus();}
      else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
    };
    document.addEventListener('keydown',trap);
    return () => { alive=false;mounted.current=false;document.removeEventListener('keydown',trap);previous?.focus(); };
  }, [api]);
  useEffect(() => { if (!remove) return; const previous=document.activeElement as HTMLElement; removeRef.current?.focus(); return () => previous?.focus(); }, [remove]);

  async function run(name:string, work:()=>Promise<void>) {
    if(!api){setNotice({ok:false,text:'Open the desktop app to manage agents, skills, and plugins.'});return;}
    if(disabled)return;
    setBusy(name);setNotice(null);
    try{await work();}catch(error){if(mounted.current)setNotice({ok:false,text:error instanceof Error?error.message:String(error)});}
    finally{if(mounted.current)setBusy(null);}
  }
  async function updateCatalog(value:CapabilityCatalog) {
    if(!mounted.current)return;
    onCatalog(value);
    const boot=await api!.bootstrap();
    if(mounted.current)onSaved(boot.settings);
  }
  async function updateSettings(value:Settings, message:string) {
    const saved=await api!.saveSettings(value);
    const next=await api!.capabilities();
    if(mounted.current){onSaved(saved);onCatalog(next);setNotice({ok:true,text:message});}
  }
  function openSkill(skill:SkillDefinition){setEditor({kind:'skill',source:skill.source,draft:{id:skill.id,name:skill.name,description:skill.description,instructions:skill.instructions}});setNotice(null);}
  function openBot(bot:BotDefinition){setEditor({kind:'bot',source:bot.source,draft:{id:bot.id,name:bot.name,description:bot.description,instructions:bot.instructions,skillIds:[...bot.skillIds],tools:[...bot.tools]}});setNotice(null);}
  function newEntry(){setEditor(tab==='skills'?{kind:'skill',source:'user',draft:{name:'',description:'',instructions:''}}:{kind:'bot',source:'user',draft:{name:'',description:'',instructions:'',skillIds:[],tools:['files','web','browser']}});setNotice(null);}
  function updateDraft(field:'name'|'description'|'instructions', value:string){setEditor(old=>old?{...old,draft:{...old.draft,[field]:value}} as Editor:null);}
  function toggleBotItem(field:'tools'|'skillIds', value:string){setEditor(old=>{if(!old||old.kind!=='bot')return old;const items=old.draft[field];return {...old,draft:{...old.draft,[field]:items.includes(value as ToolGroup)?items.filter(item=>item!==value):[...items,value]}} as Editor;});}
  function saveEditor(){if(!editor||readOnly)return;void run('save-entry',async()=>{const next=editor.kind==='skill'?await api!.saveSkill(editor.draft):await api!.saveBot(editor.draft);await updateCatalog(next);if(mounted.current){setEditor(null);setNotice({ok:true,text:editor.kind==='skill'?'Skill saved. Enable it or add it to a bot.':'Bot saved. Select Use bot when you want to work with it.'});}});}
  function deleteEntry(){if(!remove)return;void run('delete',async()=>{const next=remove.kind==='skill'?await api!.deleteSkill(remove.id):remove.kind==='bot'?await api!.deleteBot(remove.id):await api!.removePlugin(remove.id);await updateCatalog(next);if(mounted.current){setRemove(null);setEditor(null);setNotice({ok:true,text:`${remove.name} removed.`});}});}
  function previewPlugin(){void run('preview',async()=>{const value=await api!.previewPlugin();if(mounted.current){setPreview(value);setReviewed(false);}});}
  function installPlugin(){if(!preview||!reviewed)return;void run('install',async()=>{const next=await api!.installPlugin(preview.ticket);await updateCatalog(next);if(mounted.current){setPreview(null);setReviewed(false);setNotice({ok:true,text:'Plugin installed. Use its enable switch to make its bots and skills available.'});}});}
  function togglePlugin(id:string, enabled:boolean){const ids=data.plugins.filter(item=>item.enabled).map(item=>item.id);void run(`plugin-${id}`,()=>updateSettings({...settings,enabledPluginIds:enabled?[...new Set([...ids,id])]:ids.filter(item=>item!==id)},enabled?'Plugin enabled. Its bots and skills are now available.':'Plugin disabled.'));}
  function toggleSkill(id:string, enabled:boolean){const ids=settings.enabledSkillIds||[];void run(`skill-${id}`,()=>updateSettings({...settings,enabledSkillIds:enabled?[...new Set([...ids,id])]:ids.filter(item=>item!==id)},enabled?'Skill enabled for your tasks.':'Skill disabled globally. Bots may still include it.'));}
  const tabs=[{id:'bots',label:'Bots',icon:Bot},{id:'skills',label:'Skills',icon:BookOpen},{id:'plugins',label:'Plugins',icon:Package},{id:'browser',label:'Browser',icon:Globe2}] as const;

  return <div className="modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}><div ref={dialogRef} tabIndex={-1} className="dialog library-dialog" role="dialog" aria-modal="true" aria-labelledby="library-title">
    <div className="dialog-heading" inert={!!remove}><div><span className="section-eyebrow">MAKE ORBIT YOURS</span><h2 id="library-title">Agents &amp; skills</h2><p>Choose how your assistant works, and which tools it can request.</p></div><button className="icon-button" disabled={!!busy} onClick={onClose} aria-label="Close agents and skills"><X size={22}/></button></div>
    <div className="settings-tabs library-tabs" inert={!!remove} role="tablist" aria-label="Agent library">{tabs.map(item=><button key={item.id} id={`library-tab-${item.id}`} role="tab" aria-selected={tab===item.id} aria-controls={`library-panel-${item.id}`} className={tab===item.id?'selected':''} disabled={!!busy} onClick={()=>{setTab(item.id);setNotice(null);}}><item.icon size={17}/>{item.label}</button>)}</div>
    <div className="library-body" inert={!!remove} role="tabpanel" id={`library-panel-${tab}`} aria-labelledby={`library-tab-${tab}`}>
      {locked&&<div className="inline-note"><LockKeyhole size={17}/><span>Finish or stop the task before changing agents, skills, or browser settings.</span></div>}
      {!api&&<div className="inline-note"><TriangleAlert size={17}/><span>Browser preview: your desktop agents and settings are available in the Orbit app.</span></div>}
      {notice&&<div className={`notice ${notice.ok?'success':'failure'}`} role="status">{notice.ok?<Check size={17}/>:<TriangleAlert size={17}/>}<span>{notice.text}</span></div>}
      {tab==='browser'&&<BrowserPanel settings={settings} locked={locked} onSaved={onSaved}/>}
      {(tab==='bots'||tab==='skills')&&!editing&&<>
        <div className="library-section-heading"><div><h3>{tab==='bots'?'A bot for the task at hand.':'Reusable instructions for better work.'}</h3><p>{tab==='bots'?'Bots combine a role, skills, and permitted tool groups.':'Enable a skill for all tasks, or attach it to a particular bot.'}</p></div><button className="button primary" disabled={disabled} onClick={newEntry}><Plus size={16}/>{tab==='bots'?'New bot':'New skill'}</button></div>
        {tab==='bots'&&data.bots.map(bot=><article className="library-entry" key={bot.id}><div className="library-entry-top"><span className="library-feature-icon"><Bot size={21}/></span><div className="library-entry-copy"><h4>{bot.name}{settings.selectedBotId===bot.id&&<span className="selected-label"><Check size={12}/>Selected</span>}</h4><p>{bot.description}</p></div><span className="source-label">{bot.source==='builtin'?'Built in':bot.source==='plugin'?'Plugin':'Yours'}</span></div><div className="library-tags">{bot.tools.map(tool=><span key={tool}>{toolGroups.find(item=>item.id===tool)?.name||tool}</span>)}<span>{bot.skillIds.length} {bot.skillIds.length===1?'skill':'skills'}</span></div><div className="library-entry-actions"><button className="button secondary" onClick={()=>openBot(bot)}><BookOpen size={15}/>{bot.source==='user'?'View / edit':'View instructions'}</button>{bot.source==='user'&&<button className="icon-button delete-button" disabled={disabled} onClick={()=>setRemove({kind:'bot',id:bot.id,name:bot.name})} aria-label={`Delete bot ${bot.name}`}><Trash2 size={16}/></button>}<button className="button primary" disabled={disabled||settings.selectedBotId===bot.id} onClick={()=>void run(`select-${bot.id}`,()=>updateSettings({...settings,selectedBotId:bot.id},`${bot.name} selected for your next task.`))}>{settings.selectedBotId===bot.id?<Check size={15}/>:<ChevronRight size={15}/>}Use bot</button></div></article>)}
        {tab==='skills'&&data.skills.map(skill=><article className="library-entry" key={skill.id}><div className="library-entry-top"><span className="library-feature-icon"><BookOpen size={21}/></span><div className="library-entry-copy"><h4>{skill.name}</h4><p>{skill.description}</p></div><span className="source-label">{skill.source==='builtin'?'Built in':skill.source==='plugin'?'Plugin':'Yours'}</span></div><div className="library-entry-actions"><button className="button secondary" onClick={()=>openSkill(skill)}><BookOpen size={15}/>{skill.source==='user'?'View / edit':'View instructions'}</button>{skill.source==='user'&&<button className="icon-button delete-button" disabled={disabled} onClick={()=>setRemove({kind:'skill',id:skill.id,name:skill.name})} aria-label={`Delete skill ${skill.name}`}><Trash2 size={16}/></button>}<label className="library-checkbox"><input type="checkbox" disabled={disabled} checked={(settings.enabledSkillIds||[]).includes(skill.id)} onChange={event=>toggleSkill(skill.id,event.target.checked)}/>Enable for tasks</label></div></article>)}
        {(tab==='bots'?data.bots:data.skills).length===0&&<div className="empty-state"><BookOpen size={28}/><p>{catalog?'No entries are available. Create your own to get started.':'Loading your library…'}</p></div>}
        <div className="inline-note"><ShieldCheck size={17}/><span>Bots and skills never grant extra permission. Orbit applies your global tool settings and asks for approval when an action needs it.</span></div>
      </>}
      {editing&&editor&&<div className="library-editor"><button className="library-back" onClick={()=>setEditor(null)}><ArrowLeft size={16}/>Back to {editor.kind==='bot'?'bots':'skills'}</button><h3>{readOnly?'View':editor.draft.id?'Edit':'Create'} {editor.kind}</h3>{readOnly&&<div className="inline-note"><LockKeyhole size={17}/><span>{editor.source==='builtin'?'Built-in':'Plugin'} instructions are read-only. Create your own entry to use different instructions.</span></div>}
        <label className="field-label" htmlFor="entry-name">Name</label><input className="field-input" id="entry-name" value={editor.draft.name} readOnly={readOnly} disabled={disabled} maxLength={80} onChange={event=>updateDraft('name',event.target.value)}/>
        <label className="field-label" htmlFor="entry-description">Description</label><input className="field-input" id="entry-description" value={editor.draft.description} readOnly={readOnly} disabled={disabled} maxLength={500} onChange={event=>updateDraft('description',event.target.value)}/>
        <label className="field-label" htmlFor="entry-instructions">Instructions</label><textarea className="field-input instructions-input" id="entry-instructions" rows={9} maxLength={16000} value={editor.draft.instructions} readOnly={readOnly} disabled={disabled} onChange={event=>updateDraft('instructions',event.target.value)} placeholder="Explain the role, the steps to follow, and the result you expect."/><p className="field-help">Instruction text is sent to the selected model. Keep passwords, tokens, and other secrets out of this field.</p>
        {editor.kind==='bot'&&<><fieldset className="library-fieldset"><legend>Tool groups</legend><p>These are requests for access. Global permissions still apply.</p>{toolGroups.map(group=><label className="tool-group-choice" key={group.id}><input type="checkbox" checked={editor.draft.tools.includes(group.id)} disabled={readOnly||disabled} onChange={()=>toggleBotItem('tools',group.id)}/><span><strong>{group.name}</strong><small>{group.description}</small></span></label>)}</fieldset><fieldset className="library-fieldset"><legend>Included skills</legend>{data.skills.map(skill=><label className="library-checkbox" key={skill.id}><input type="checkbox" checked={editor.draft.skillIds.includes(skill.id)} disabled={readOnly||disabled} onChange={()=>toggleBotItem('skillIds',skill.id)}/>{skill.name}</label>)}{editor.draft.skillIds.filter(id=>!data.skills.some(skill=>skill.id===id)).map(id=><label className="library-checkbox" key={id}><input type="checkbox" checked disabled={readOnly||disabled} onChange={()=>toggleBotItem('skillIds',id)}/><span>Unavailable: {id} — remove this skill or enable its plugin.</span></label>)}{!data.skills.length&&<p>Create a skill first to add it here.</p>}</fieldset></>}
        {!readOnly&&<div className="editor-footer"><span>Changes stay in this draft until you save.</span><button className="button primary" disabled={disabled||!editor.draft.name.trim()||!editor.draft.instructions.trim()} onClick={saveEditor}>{busy==='save-entry'?<LoaderCircle size={16} className="spin"/>:<Check size={16}/>}Save {editor.kind}</button></div>}
      </div>}
      {tab==='plugins'&&<>
        <div className="library-section-heading"><div><h3>Shareable instruction packs.</h3><p>Plugins in Orbit 0.3 contain bot definitions and skills. They do not execute plugin code or connect MCP servers.</p></div><button className="button primary" disabled={disabled||!!preview} onClick={previewPlugin}>{busy==='preview'?<LoaderCircle size={16} className="spin"/>:<FileJson size={16}/>}Import plugin</button></div>
        {preview&&<section className="plugin-preview"><div className="plugin-review-header"><Package size={23}/><div><span className="section-eyebrow">REVIEW BEFORE INSTALLING</span><h3>{preview.name} <span>v{preview.version}</span></h3><p>{preview.description}</p></div></div><p className="field-help">The full bot and skill instructions below will be available to your model when enabled. Review the complete text before installing.</p>
          {preview.skills.map(skill=><div className="plugin-instruction" key={skill.id}><h4>Skill: {skill.name}</h4><p className="field-help">ID: {skill.id}</p><p>{skill.description}</p><pre>{skill.instructions}</pre></div>)}
          {preview.bots.map(bot=><div className="plugin-instruction" key={bot.id}><h4>Bot: {bot.name}</h4><p className="field-help">ID: {bot.id}</p><p>{bot.description}</p><p className="field-help">Tool groups: {bot.tools.join(', ')||'None'}<br/>Skills: {bot.skillIds.join(', ')||'None'}</p><pre>{bot.instructions}</pre></div>)}
          <label className="purchase-confirmation"><input type="checkbox" checked={reviewed} disabled={disabled} onChange={event=>setReviewed(event.target.checked)}/><span>I have reviewed these bot and skill instructions</span></label><div className="approval-buttons"><button className="button secondary" disabled={!!busy} onClick={()=>{setPreview(null);setReviewed(false);}}>Cancel preview</button><button className="button primary" disabled={disabled||!reviewed} onClick={installPlugin}>{busy==='install'?<LoaderCircle size={16} className="spin"/>:<Check size={16}/>}Install plugin</button></div>
        </section>}
        {data.plugins.map(plugin=><article className="library-entry" key={plugin.id}><div className="library-entry-top"><span className="library-feature-icon"><Package size={21}/></span><div className="library-entry-copy"><h4>{plugin.name}<span className="source-label">v{plugin.version}</span></h4><p>{plugin.description}</p></div></div><div className="library-tags"><span>{plugin.botIds.length} bots</span><span>{plugin.skillIds.length} skills</span><span>Instructions only</span></div><div className="library-entry-actions"><button className="button secondary" disabled={disabled} onClick={()=>setRemove({kind:'plugin',id:plugin.id,name:plugin.name})}><Trash2 size={15}/>Remove</button><label className="library-checkbox"><input type="checkbox" checked={plugin.enabled} disabled={disabled} onChange={event=>togglePlugin(plugin.id,event.target.checked)}/>Enabled</label></div></article>)}
        {!data.plugins.length&&!preview&&<div className="empty-state"><Package size={31}/><h3>Your plugin shelf is empty.</h3><p>Import a local plugin manifest to review its instructions. Nothing is installed until you choose Install plugin.</p></div>}
      </>}
    </div>
    <div className="library-footer" inert={!!remove}><span><ShieldCheck size={15}/>Your tools remain under your control.</span><button className="button secondary" disabled={!!busy} onClick={onClose}>Done</button></div>
    {remove&&<div className="library-confirm"><section ref={removeRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="remove-library-title"><Trash2 size={25}/><h3 id="remove-library-title">Remove {remove.name}?</h3><p>{remove.kind==='plugin'?'This removes the plugin’s installed bots and skills.':'This removes the saved entry from your library.'} Your task history and workspace files are kept.</p><div className="approval-buttons"><button className="button secondary" disabled={!!busy} onClick={()=>setRemove(null)}>Keep it</button><button className="button danger" disabled={disabled} onClick={deleteEntry}>{busy==='delete'?<LoaderCircle size={15} className="spin"/>:<Trash2 size={15}/>}Remove {remove.kind}</button></div></section></div>}
  </div></div>;
}
