import assert from 'node:assert/strict';
import test from 'node:test';
import { getMatrixDeviceStorageKey, getNymphStateStorageKey } from './state-storage.ts';

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
