import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptAttachment, encryptAttachment } from './encrypted-attachment.ts';

test('encrypts attachments in Matrix v2 format and verifies them on decryption', async () => {
  const plaintext = new TextEncoder().encode('private NYMPH attachment');
  const { ciphertext, file } = await encryptAttachment(plaintext);
  const completeFile = { ...file, url: 'mxc://nymph-dev.localhost/private-media' };

  assert.equal(completeFile.v, 'v2');
  assert.equal(completeFile.key.alg, 'A256CTR');
  assert.equal(completeFile.key.kty, 'oct');
  assert.deepEqual(
    new Uint8Array(await decryptAttachment(ciphertext, completeFile)),
    plaintext,
  );
});

test('rejects encrypted attachment ciphertext that fails its SHA-256 integrity check', async () => {
  const { ciphertext, file } = await encryptAttachment(new TextEncoder().encode('private attachment'));
  const tampered = new Uint8Array(ciphertext.slice(0));
  tampered[0] ^= 0xff;

  await assert.rejects(
    decryptAttachment(tampered, { ...file, url: 'mxc://nymph-dev.localhost/private-media' }),
    /integrity check failed/,
  );
});
