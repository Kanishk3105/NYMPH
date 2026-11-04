export const DEMO_STATE_STORAGE_KEY = 'nymph.local.v1';

export function getNymphStateStorageKey(userId?: string): string {
  return userId ? `${DEMO_STATE_STORAGE_KEY}.${encodeURIComponent(userId)}` : DEMO_STATE_STORAGE_KEY;
}

export function getMatrixDeviceStorageKey(userId: string): string {
  return `nymph.matrix.device.v1.${encodeURIComponent(userId)}`;
}
