import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('dist-main',{recursive:true});
for (const name of ['main','preload','image-worker']) {
  await build({entryPoints:[`src/main/${name}.ts`],bundle:true,platform:'node',target:'node22',format:'cjs',outfile:`dist-main/${name}.cjs`,external:['electron','sql.js','sharp','exceljs','undici'],sourcemap:false});
}
