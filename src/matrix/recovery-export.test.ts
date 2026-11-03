import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptRecoveryExport, encryptRecoveryExport } from './recovery-export.ts';

const contents = {
  account: '@partner1:localhost',
  keyId: 'key-id-1',
  recoveryKey: 'Es4z 8s1f m3xc 0kl5 w9pq 7jtn 2yab 6vcd',
};
const passphrase = 'a long private export passphrase';

test('encrypts and restores the account-specific recovery export', async () => {
  const encrypted = await encryptRecoveryExport(contents, passphrase);

  assert.equal(encrypted.includes(contents.recoveryKey), false);
  assert.deepEqual(await decryptRecoveryExport(encrypted, passphrase), contents);
});

test('rejects a recovery export with the wrong passphrase', async () => {
  const encrypted = await encryptRecoveryExport(contents, passphrase);

  await assert.rejects(
    decryptRecoveryExport(encrypted, 'a different private passphrase'),
    /could not be decrypted/,
  );
});

test('rejects malformed or tampered recovery exports', async () => {
  await assert.rejects(decryptRecoveryExport('not-json', passphrase), /not a valid/);
  const encrypted = JSON.parse(await encryptRecoveryExport(contents, passphrase)) as Record<string, unknown>;
  encrypted.ciphertext = 'AAAA';

  await assert.rejects(
    decryptRecoveryExport(JSON.stringify(encrypted), passphrase),
    /could not be decrypted/,
  );
});
