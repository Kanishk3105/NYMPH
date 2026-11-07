import { build, preview } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const configFile = fileURLToPath(new URL('../vite.matrix-e2e.config.ts', import.meta.url));
process.chdir(root);

await build({ configFile, mode: 'development' });

const server = await preview({
  configFile,
  mode: 'development',
  preview: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
});
server.printUrls();

let stopping = false;
function stopServer() {
  if (stopping) return;
  stopping = true;
  server.httpServer.close((error) => {
    if (error) {
      console.error('Could not stop the isolated Matrix harness server cleanly.', error);
      process.exitCode = 1;
    }
  });
}

process.once('SIGINT', stopServer);
process.once('SIGTERM', stopServer);
