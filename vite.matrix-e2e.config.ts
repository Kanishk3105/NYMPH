import { defineConfig, mergeConfig } from 'vite';
import appConfig from './vite.config';
import { loadIsolatedMatrixConfig } from './tests/e2e/matrix-runtime-config.mjs';

const matrixConfig = loadIsolatedMatrixConfig();

export default mergeConfig(appConfig, defineConfig({
  define: {
    'import.meta.env.DEV': 'true',
    'import.meta.env.VITE_MATRIX_HOMESERVER': JSON.stringify(matrixConfig.homeserverUrl),
    'import.meta.env.VITE_MATRIX_SERVER_NAME': JSON.stringify(matrixConfig.serverName),
    'import.meta.env.VITE_MATRIX_PARTNER_A_USER_ID': JSON.stringify(matrixConfig.partnerA),
    'import.meta.env.VITE_MATRIX_PARTNER_B_USER_ID': JSON.stringify(matrixConfig.partnerB),
  },
  build: {
    outDir: '.matrix-e2e/build',
    emptyOutDir: true,
    rollupOptions: {
      input: 'tests/e2e/matrix-harness.html',
    },
  },
}));
