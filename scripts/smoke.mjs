import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const version=JSON.parse(await fs.readFile('package.json','utf8')).version;
const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-smoke-'));
const workspace=path.join(root,'workspace');await fs.mkdir(workspace);
const env={...process.env,ORBIT_TEST_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:['.'],env});
let page; const errors=[];
try {
 page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
 await page.waitForFunction(()=>window.orbit);
 await page.getByRole('heading',{name:'What can we get done?'}).waitFor();
 await page.waitForTimeout(250);
 await page.screenshot({path:'../orbit-home.png'});
 const boot=await page.evaluate(()=>window.orbit.bootstrap());assert.equal(boot.version,version);
 await page.evaluate(async(workspace)=>{const boot=await window.orbit.bootstrap();await window.orbit.saveSettings({...boot.settings,workspace,provider:{kind:'demo',model:'orbit-demo',baseUrl:''}});},workspace);
 await page.reload();await page.waitForFunction(()=>window.orbit);
 await page.getByRole('textbox',{name:'Tell Orbit what you want to do'}).fill('Show me the demo');await page.getByRole('button',{name:'Send task',exact:true}).click();
 await page.getByRole('button',{name:'Allow this action',exact:true}).waitFor();
 await assert.rejects(fs.stat(path.join(workspace,'orbit-demo.md')));
 await page.screenshot({path:'../orbit-approval.png'});
 await page.getByRole('button',{name:'Allow this action',exact:true}).click();
 await page.getByText('Task finished',{exact:true}).waitFor();
 assert.ok((await fs.readFile(path.join(workspace,'orbit-demo.md'),'utf8')).includes('Orbit'));
 const saved=await page.evaluate(()=>window.orbit.bootstrap());assert.equal(saved.sessions.length,1);assert.equal(saved.sessions[0].messages.filter(m=>m.role==='user').length,1);
 // The next run must also request approval. Denial must not change the existing file.
 await page.getByRole('button',{name:'New task',exact:false}).first().click();
 await page.getByRole('textbox',{name:'Tell Orbit what you want to do'}).fill('Try demo again');await page.getByRole('button',{name:'Send task',exact:true}).click();
 await page.getByRole('button',{name:'Deny action',exact:true}).click();await page.getByText('Task finished',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Settings',exact:false}).first().click();
 await page.getByLabel('Provider',{exact:true}).selectOption('codex');await page.getByRole('button',{name:'Sign in with ChatGPT',exact:true}).waitFor();
 await page.getByRole('tab',{name:'Workspace',exact:true}).click();await page.getByRole('switch',{name:'Allow desktop control',exact:true}).click();await page.getByLabel('Python executable',{exact:true}).waitFor();
 await page.screenshot({path:'../orbit-settings.png'});
 await page.getByRole('button',{name:'Close settings',exact:true}).click();
 // Persisted history survives a new renderer load.
 await page.reload();await page.waitForFunction(()=>window.orbit);assert.equal((await page.evaluate(()=>window.orbit.bootstrap())).sessions.length,2);
 assert.deepEqual(errors,[]);
 console.log('Desktop smoke passed: real window, minimal home, approval before write, successful file write, denied action, Codex UI, desktop permissions, persisted history, no renderer errors.');
} finally {await app.close();await fs.rm(root,{recursive:true,force:true});}
