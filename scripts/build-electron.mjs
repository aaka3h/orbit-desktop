import { build } from 'esbuild';
await build({entryPoints:['electron/main.ts','electron/preload.ts'],outdir:'dist-electron',outExtension:{'.js':'.cjs'},bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron','playwright-core'],sourcemap:true});
const fs=await import('node:fs/promises');
await fs.copyFile('scripts/computer.py','dist-electron/computer.py');
