import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CapabilityLibrary, parsePlugin } from '../electron/capabilities';
import type { Settings } from '../shared/types';
const settings:Settings={workspace:'',provider:{kind:'demo',model:'',baseUrl:''},maxSteps:10,allowCommands:false,allowComputer:false,pythonPath:'python3'};
const manifest={schemaVersion:1,id:'comparison',name:'Comparison',description:'Compare products',version:'1.0.0',skills:[{id:'compare',name:'Compare',description:'Compare evidence',instructions:'Compare the options with links.'}],bots:[{id:'helper',name:'Helper',description:'A helper',instructions:'Help compare.',skillIds:['compare'],tools:['web','browser']}]};
async function fixture(t:any,now?:()=>number){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-library-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const library=new CapabilityLibrary(directory,now);await library.load();return {library,directory};}
test('plugins are reviewed snapshots, namespaced, disabled until enabled and persisted',async t=>{
 const {library,directory}=await fixture(t);const preview=library.preview(JSON.stringify(manifest));preview.skills[0].instructions='Changed preview object';await library.install(preview.ticket);
 assert.equal(library.catalog(settings).plugins[0].enabled,false);assert.ok(!library.catalog(settings).skills.some(s=>s.source==='plugin'));
 const enabled={...settings,enabledPluginIds:['comparison'],selectedBotId:'plugin:comparison:bot:helper'};const selection=library.compose(enabled);
 assert.equal(selection.skills[0].id,'plugin:comparison:skill:compare');assert.match(selection.instructions,/Compare the options/);assert.doesNotMatch(selection.instructions,/Changed preview/);
 const restored=new CapabilityLibrary(directory);await restored.load();assert.deepEqual(restored.compose(enabled),selection);
 await assert.rejects(library.install(preview.ticket),/expired/);
});
test('executable plugin keys, outside skill references, duplicate IDs and excessive data rejected',()=>{
 assert.throws(()=>parsePlugin(JSON.stringify({...manifest,command:'rm -rf x'})));
 assert.throws(()=>parsePlugin(JSON.stringify({...manifest,bots:[{...manifest.bots[0],skillIds:['outside']}]})),/same plugin/);
 assert.throws(()=>parsePlugin(JSON.stringify({...manifest,skills:[...manifest.skills,...manifest.skills]})),/Duplicate/);
 assert.throws(()=>parsePlugin(' '.repeat(256*1024+1)),/256 KB/);
});
test('expired review cannot install and fresh review works',async t=>{
 let now=100;const {library}=await fixture(t,()=>now);const preview=library.preview(JSON.stringify(manifest));now+=300001;await assert.rejects(library.install(preview.ticket),/expired/);await library.install(library.preview(JSON.stringify(manifest)).ticket);
});
test('custom skill deletion updates user bots and normalizes selected skills',async t=>{
 const {library}=await fixture(t);await library.saveSkill({name:'My skill',description:'Reusable',instructions:'Explain simply.'});const skill=library.catalog(settings).skills.find(s=>s.source==='user')!;
 await library.saveBot({name:'My bot',description:'A bot',instructions:'Help.',tools:['files'],skillIds:[skill.id]},settings);const bot=library.catalog(settings).bots.find(b=>b.source==='user')!;
 assert.match(library.compose({...settings,selectedBotId:bot.id}).instructions,/Explain simply/);
 await library.deleteSkill(skill.id);assert.equal(library.compose({...settings,selectedBotId:bot.id}).skills.length,0);assert.deepEqual(library.normalize({...settings,enabledSkillIds:[skill.id]}).enabledSkillIds,[]);
 await library.deleteBot(bot.id);assert.equal(library.normalize({...settings,selectedBotId:bot.id}).selectedBotId,'builtin:general');
 await assert.rejects(library.deleteBot('builtin:general'),/own bots/);await assert.rejects(library.saveSkill({id:'builtin:research',name:'Overwrite',description:'',instructions:'No'}),/own skills/);
});
test('disabling a plugin cannot silently retain instructions or a missing dependency',async t=>{
 const {library}=await fixture(t);await library.install(library.preview(JSON.stringify(manifest)).ticket);const enabled={...settings,enabledPluginIds:['comparison']};
 await library.saveBot({name:'Dependent',description:'',instructions:'Help.',skillIds:['plugin:comparison:skill:compare'],tools:['web']},enabled);const bot=library.catalog(enabled).bots.find(b=>b.source==='user')!;
 assert.throws(()=>library.compose({...settings,selectedBotId:bot.id}),/missing or disabled skill/);
 assert.equal(library.normalize({...settings,selectedBotId:'plugin:comparison:bot:helper'}).selectedBotId,'builtin:general');
});
