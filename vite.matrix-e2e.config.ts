import { defineConfig, mergeConfig } from 'vite';
import appConfig from './vite.config';

export default mergeConfig(appConfig, defineConfig({
  build: {
    outDir: '.matrix-e2e/build',
    emptyOutDir: true,
    rollupOptions: {
      input: 'tests/e2e/matrix-harness.html',
    },
  },
}));
