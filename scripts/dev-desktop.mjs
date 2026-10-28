import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

// Build the Electron entry points once; Vite handles renderer hot updates.
await import('./build-main.mjs');
const server = await createServer();
await server.listen();
server.printUrls();

const require = createRequire(import.meta.url);
const electron = spawn(require('electron'), ['.'], {
  env: { ...process.env, QINGTU_DEV: '1' },
  stdio: 'inherit',
});
electron.on('error', async error => {
  console.error('无法启动 Electron：', error);
  await server.close();
  process.exitCode = 1;
});
electron.on('exit', async code => {
  await server.close();
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => electron.kill());
}
