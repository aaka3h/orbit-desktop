import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('..', import.meta.url));
console.log('Checking the Orbit browser against isolated local fixtures. No shopping, sign-in, or external website actions.');
const child = spawn(process.execPath, ['--import', 'tsx', '--test', 'tests/browser.test.ts'], {
  cwd, stdio: 'inherit', shell: false, env: { ...process.env, ORBIT_BROWSER_REQUIRE: '1' },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
