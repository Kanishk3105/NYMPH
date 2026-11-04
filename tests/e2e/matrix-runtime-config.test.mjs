import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseIsolatedMatrixConfig } from './matrix-runtime-config.mjs';
import { fileURLToPath } from 'node:url';

const validConfiguration = [
  'MATRIX_SERVER_NAME=nymph-dev.localhost',
  'DEV_HOMESERVER_URL=http://127.0.0.1:18008',
  'DEV_PARTNER_A_USER_ID=@partner1-dev:nymph-dev.localhost',
  'DEV_PARTNER_B_USER_ID=@partner2-dev:nymph-dev.localhost',
].join('\n');

test('accepts only the isolated Stage 3H homeserver and partner identities', () => {
  assert.deepEqual(parseIsolatedMatrixConfig(validConfiguration), {
    homeserverUrl: 'http://127.0.0.1:18008',
    serverName: 'nymph-dev.localhost',
    partnerA: '@partner1-dev:nymph-dev.localhost',
    partnerB: '@partner2-dev:nymph-dev.localhost',
  });
});

test('rejects legacy, public, or mismatched Matrix configuration', () => {
  for (const invalid of [
    validConfiguration.replace('127.0.0.1:18008', '127.0.0.1:8008'),
    validConfiguration.replace('nymph-dev.localhost', 'localhost'),
    validConfiguration.replace('@partner1-dev:nymph-dev.localhost', '@partner1:localhost'),
    validConfiguration.replace('@partner2-dev:nymph-dev.localhost', '@partner2:localhost'),
  ]) {
    assert.throws(() => parseIsolatedMatrixConfig(invalid), /refusing non-isolated or mismatched settings/);
  }
});

test('live acceptance wiring uses isolated local credentials and never replaces an existing identity', () => {
  const spec = readFileSync(
    fileURLToPath(new URL('./matrix-dev-live.spec.ts', import.meta.url)),
    'utf8',
  );
  const harness = readFileSync(
    fileURLToPath(new URL('./matrix-harness.ts', import.meta.url)),
    'utf8',
  );
  for (const requiredOperation of [
    'partner1_dev_password',
    'partner2_dev_password',
    'prepareSecretStorageSetup',
    'commitSecretStorageSetup',
    'bootstrapSecurity',
    'verifyRecoveryOnSeparateDevice',
    'writeProtectedRecoveryExport',
    'joinedMembers',
    'cancelVerification',
    'revokeDevice',
  ]) {
    assert.ok(spec.includes(requiredOperation) || harness.includes(requiredOperation), `Missing live operation ${requiredOperation}.`);
  }
  for (const forbiddenOperation of [
    'resetKeyBackup',
    'createDeviceReplacement',
    'activateReplacement',
  ]) {
    assert.ok(!spec.includes(forbiddenOperation), `Live spec must not call ${forbiddenOperation}.`);
    assert.ok(!harness.includes(forbiddenOperation), `Test harness must not expose ${forbiddenOperation}.`);
  }
  assert.ok(spec.includes('Hey, missing you ❤️'));
  assert.ok(spec.includes('Missing you too 🥺💋'));
  assert.ok(spec.includes('UseSystemPasswordChar'));
  assert.doesNotMatch(spec, /console\.(?:log|info|debug)\s*\(/);
});
