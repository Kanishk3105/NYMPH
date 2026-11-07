export const DEMO_STATE_STORAGE_KEY = 'nymph.local.v1';

export interface JsonStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readJsonState<T>(storage: Pick<JsonStateStorage, 'getItem'>, key: string): T | undefined {
  const serialized = storage.getItem(key);
  return serialized === null ? undefined : JSON.parse(serialized) as T;
}

export function writeJsonState(
  storage: Pick<JsonStateStorage, 'setItem'>,
  key: string,
  state: object,
): void {
  const serialized = JSON.stringify(state);
  if (serialized === undefined) throw new Error('Local NYMPH state could not be serialized.');
  storage.setItem(key, serialized);
}

export function getNymphStateStorageKey(userId?: string): string {
  return userId ? `${DEMO_STATE_STORAGE_KEY}.${encodeURIComponent(userId)}` : DEMO_STATE_STORAGE_KEY;
}

export function getMatrixDeviceStorageKey(userId: string): string {
  return `nymph.matrix.device.v1.${encodeURIComponent(userId)}`;
}
