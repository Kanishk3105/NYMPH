import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const build = spawnSync(process.execPath, [
  viteCli,
  'build',
  '--mode',
  'development',
  '--config',
  'vite.matrix-e2e.config.ts',
], {
  cwd: root,
  stdio: 'inherit',
});

if (build.status !== 0) process.exit(build.status ?? 1);

const server = spawn(process.execPath, [
  viteCli,
  'preview',
  '--config',
  'vite.matrix-e2e.config.ts',
  '--host',
  '127.0.0.1',
  '--port',
  '5174',
  '--strictPort',
], {
  cwd: root,
  stdio: 'inherit',
});

function stopServer() {
  if (!server.killed) server.kill();
}

process.on('SIGINT', stopServer);
process.on('SIGTERM', stopServer);
server.on('exit', (code) => process.exit(code ?? 0));
