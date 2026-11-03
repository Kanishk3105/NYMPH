/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly MODE: string;
  readonly VITE_MATRIX_HOMESERVER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
