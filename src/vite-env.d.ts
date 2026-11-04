/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly MODE: string;
  readonly VITE_MATRIX_HOMESERVER?: string;
  readonly VITE_MATRIX_PARTNER_A_USER_ID?: string;
  readonly VITE_MATRIX_PARTNER_B_USER_ID?: string;
  readonly VITE_MATRIX_PARTNER_A_DEVICE_ID?: string;
  readonly VITE_MATRIX_PARTNER_B_DEVICE_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
