import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-appearance-'));
const env={...process.env,ORBIT_TEST_DATA_DIR:root};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({args:['.'],env});const errors=[];
try{
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
 await page.getByRole('heading',{name:'What can we get done?'}).waitFor();
 async function appearance(theme,size){await page.getByRole('button',{name:'Settings',exact:false}).first().click();await page.getByRole('tab',{name:'Appearance',exact:true}).click();await page.getByLabel('Theme',{exact:true}).selectOption(theme);await page.getByLabel('Text size',{exact:true}).selectOption(size);await page.getByRole('button',{name:'Save setup',exact:true}).click();await page.waitForFunction(({theme,size})=>document.documentElement.dataset.theme===theme&&document.documentElement.dataset.textSize===size,{theme,size});}
 await appearance('dark','normal');
 assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).fontSize),'16px');
 await page.screenshot({path:'../orbit-home-dark.png'});
 await appearance('light','large');
 assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).fontSize),'18px');
 await page.screenshot({path:'../orbit-home-light.png'});
 await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.theme==='light'&&document.documentElement.dataset.textSize==='large');
 // Changing the operating-system preference while System is selected must update the interface.
 await page.getByRole('button',{name:'Settings',exact:false}).first().click();await page.getByRole('tab',{name:'Appearance',exact:true}).click();await page.getByLabel('Theme',{exact:true}).selectOption('system');await page.getByLabel('Text size',{exact:true}).selectOption('normal');await page.getByRole('button',{name:'Save setup',exact:true}).click();
 await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
 await page.emulateMedia({colorScheme:null});
 await page.getByRole('button',{name:'Model Hub',exact:true}).click();
 await page.getByRole('button',{name:/Qwen3-4B-GGUF/}).waitFor({timeout:60000});
 await page.getByRole('button',{name:/Qwen3-4B-GGUF/}).click();
 await page.getByLabel('Model file',{exact:true}).waitFor({timeout:30000});
 await page.getByRole('button',{name:/Download .*GiB|Download .*GB/}).waitFor();
 await page.screenshot({path:'../orbit-model-hub.png'});
 const hardware=await page.evaluate(()=>window.orbit.hardware());assert.ok(hardware.totalMemoryBytes>0);assert.ok(hardware.cpu);assert.equal(await page.evaluate(()=>window.orbit.downloadState()),null);
 await page.getByRole('button',{name:'Close Model Hub',exact:true}).click();
 await page.getByRole('button',{name:'Settings',exact:false}).first().click();await page.getByLabel('Provider',{exact:true}).selectOption('huggingface');
 await page.getByText(/browser sign-in|publisher|OAuth/i).first().waitFor();
 await page.getByRole('button',{name:'Close settings',exact:true}).click();
 await appearance('dark','extra-large');await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:820,height:700}));
 assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).fontSize),'20px');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 await page.getByRole('textbox',{name:'Tell Orbit what you want to do'}).fill('A readable task');await page.getByRole('button',{name:'Send task',exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('Appearance/Hub passed: real light and dark views, 16/18/20px sizes, persisted preferences, system media changes, real hardware/HF metadata, model file fit, no automatic downloads, cloud-login availability, small window layout.');
}finally{await app.close();await fs.rm(root,{recursive:true,force:true});}
