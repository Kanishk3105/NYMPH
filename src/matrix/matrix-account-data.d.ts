import 'matrix-js-sdk/lib/@types/event.js';

declare module 'matrix-js-sdk/lib/@types/event.js' {
  interface AccountDataEvents {
    'org.nymph.security.recovery_verification': {
      key_id: string;
      verified_at: number;
      cross_signing_key_ids: {
        master_key: string;
        self_signing_key: string;
        user_signing_key: string;
      };
    };
  }
}
