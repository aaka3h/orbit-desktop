import {_electron as electron} from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const version=JSON.parse(await fs.readFile('package.json','utf8')).version;
const root=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-package-'));const env={...process.env,ORBIT_TEST_DATA_DIR:root};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.resolve(`release/${version}/linux-unpacked/orbit-desktop`),args:[],env});
try {const page=await app.firstWindow();await page.getByRole('heading',{name:'What can we get done?'}).waitFor();const b=await page.evaluate(()=>window.orbit.bootstrap());assert.equal(b.version,version);assert.ok((await fs.stat(`release/${version}/linux-unpacked/resources/computer.py`)).size>0);console.log('Packaged Linux desktop launched; bridge and bundled Python helper present.');} finally{await app.close();await fs.rm(root,{recursive:true,force:true});}
