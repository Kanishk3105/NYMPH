import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateProductionEnvironment } from './validate-production-env.mjs';

const signingEnvironment = (keystorePath) => ({
  NYMPH_RELEASE_STORE_FILE: keystorePath,
  NYMPH_RELEASE_STORE_PASSWORD: 'local-test-store-secret',
  NYMPH_RELEASE_KEY_ALIAS: 'local-test-key',
  NYMPH_RELEASE_KEY_PASSWORD: 'local-test-key-secret',
});

test('release validation requires a homeserver URL', () => {
  assert.throws(() => validateProductionEnvironment({}), /VITE_MATRIX_HOMESERVER/);
});

test('release validation rejects non-HTTPS and loopback homeservers', () => {
  for (const url of ['http://matrix.example.test', 'https://localhost', 'https://127.0.0.1']) {
    assert.throws(
      () => validateProductionEnvironment({ VITE_MATRIX_HOMESERVER: url }),
      /non-loopback production hostname/,
    );
  }
});

test('release validation rejects reserved documentation domains and URL credentials', () => {
  for (const url of [
    'https://matrix.example.com',
    'https://example.org',
    'https://matrix.example.org',
    'https://matrix.example.net',
    'https://user:secret@matrix.example.org',
    'https://matrix.example.org/?token=secret',
  ]) {
    assert.throws(
      () => validateProductionEnvironment({ VITE_MATRIX_HOMESERVER: url }),
      /reserved example domains/,
    );
  }
});

test('release validation requires all signing variables and an absolute existing keystore', () => {
  assert.throws(
    () => validateProductionEnvironment({ VITE_MATRIX_HOMESERVER: 'https://matrix.nymph.com' }),
    /release signing variables/,
  );
  assert.throws(
    () =>
      validateProductionEnvironment({
        VITE_MATRIX_HOMESERVER: 'https://matrix.nymph.com',
        ...signingEnvironment('relative-keystore.jks'),
      }),
    /absolute path/,
  );
});

test('release validation rejects a directory as a signing keystore', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'nymph-release-gate-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  assert.throws(
    () =>
      validateProductionEnvironment({
        VITE_MATRIX_HOMESERVER: 'https://matrix.nymph.com',
        ...signingEnvironment(directory),
      }),
    /existing keystore file/,
  );
});

test('release validation accepts an HTTPS host and existing externally supplied keystore path', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'nymph-release-gate-'));
  const keystorePath = join(directory, 'release.jks');
  writeFileSync(keystorePath, 'test-only-keystore-placeholder');
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  assert.doesNotThrow(() =>
    validateProductionEnvironment({
      VITE_MATRIX_HOMESERVER: 'https://matrix.nymph.com',
      ...signingEnvironment(keystorePath),
    }),
  );
});
