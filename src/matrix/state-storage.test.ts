import assert from 'node:assert/strict';
import test from 'node:test';
import { getMatrixDeviceStorageKey, getNymphStateStorageKey, readJsonState, writeJsonState } from './state-storage.ts';

test('keeps demo and each partner local state in separate storage namespaces', () => {
  const demoKey = getNymphStateStorageKey();
  const partnerAKey = getNymphStateStorageKey('@partner1-dev:localhost');
  const partnerBKey = getNymphStateStorageKey('@partner2-dev:localhost');

  assert.notEqual(demoKey, partnerAKey);
  assert.notEqual(partnerAKey, partnerBKey);
  assert.notEqual(partnerBKey, demoKey);
});

test('stores a device identifier under the matching account namespace', () => {
  assert.notEqual(
    getMatrixDeviceStorageKey('@partner1-dev:localhost'),
    getMatrixDeviceStorageKey('@partner2-dev:localhost'),
  );
});

test('persists imported sticker packs across a fresh state read', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const stateKey = getNymphStateStorageKey('@partner1-dev:localhost');
  const stickerData = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
  const state = {
    customStickerPacks: [{
      id: 'pack-1',
      name: 'Private GIFs',
      adult: false,
      description: 'Shared moments',
      categories: ['Love'],
      coverStickerId: 'sticker-1',
      stickers: [{
        id: 'sticker-1',
        name: 'Tiny loop',
        type: 'image/gif',
        dataUrl: stickerData,
      }],
    }],
  };

  writeJsonState(storage, stateKey, state);

  assert.deepEqual(readJsonState<typeof state>(storage, stateKey), state);
  assert.equal(readJsonState<typeof state>(storage, getNymphStateStorageKey('@partner2-dev:localhost')), undefined);
});
