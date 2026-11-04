import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = fileURLToPath(new URL('./secure-backup.mjs', import.meta.url));
const passphrase = randomBytes(32).toString('base64');

function run(operation, source, destination, input = passphrase) {
  const args = [helper, operation, source];
  if (destination) args.push(destination);
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    input: `${input}\n`,
    timeout: 30_000,
  });
}

test('authenticates encrypted backups without writing decrypted plaintext', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nymph-backup-verify-test-'));
  const source = join(root, 'staging.tar');
  const encrypted = join(root, 'backup.enc');
  try {
    await writeFile(source, Buffer.from('private backup fixture'));
    const encryption = run('encrypt', source, encrypted);
    assert.equal(encryption.status, 0, encryption.stderr);

    const verification = run('verify', encrypted);
    assert.equal(verification.status, 0, verification.stderr);
    assert.match(verification.stdout, /verify complete/);
    assert.deepEqual((await readdir(root)).sort(), ['backup.enc', 'staging.tar']);

    const bytes = await readFile(encrypted);
    bytes[bytes.length - 1] ^= 0x01;
    await writeFile(encrypted, bytes);
    const tampered = run('verify', encrypted);
    assert.equal(tampered.status, 1);
    assert.doesNotMatch(tampered.stderr, /private backup fixture/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('encrypts and restores backup data into a fresh isolated temporary directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nymph-backup-test-'));
  const source = join(root, 'staging.tar');
  const encrypted = join(root, 'backup.age-like.enc');
  const restoreRoot = await mkdtemp(join(tmpdir(), 'nymph-restore-test-'));
  const restored = join(restoreRoot, 'restored.tar');
  const contents = Buffer.from('offline development database and isolated state fixture');
  try {
    await writeFile(source, contents);
    const encryption = run('encrypt', source, encrypted);
    assert.equal(encryption.status, 0, encryption.stderr);
    assert.doesNotMatch(await readFile(encrypted, 'utf8'), /offline development database/);

    const restoration = run('decrypt', encrypted, restored);
    assert.equal(restoration.status, 0, restoration.stderr);
    assert.deepEqual(await readFile(restored), contents);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(restoreRoot, { recursive: true, force: true });
  }
});

test('preserves UTF-8 passphrases and enforces the minimum length', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nymph-backup-utf8-test-'));
  const source = join(root, 'staging.tar');
  const encrypted = join(root, 'backup.enc');
  const restored = join(root, 'restored.tar');
  const secret = `NYMPH-${randomBytes(24).toString('base64')} 🌙`;
  try {
    await writeFile(source, Buffer.from('utf8 credential fixture'));
    const encryption = run('encrypt', source, encrypted, secret);
    assert.equal(encryption.status, 0, encryption.stderr);
    const decryption = run('decrypt', encrypted, restored, secret);
    assert.equal(decryption.status, 0, decryption.stderr);
    assert.deepEqual(await readFile(restored), await readFile(source));

    const shortSecret = run('encrypt', source, join(root, 'short.enc'), 'x'.repeat(5));
    assert.equal(shortSecret.status, 1);
    await assert.rejects(readFile(join(root, 'short.enc')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects wrong passphrases and authenticated-data tampering without leaving plaintext', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nymph-backup-failure-test-'));
  const source = join(root, 'staging.tar');
  const encrypted = join(root, 'backup.enc');
  const rejected = join(root, 'rejected.tar');
  try {
    await writeFile(source, Buffer.from('sensitive isolated fixture'));
    const encryption = run('encrypt', source, encrypted);
    assert.equal(encryption.status, 0, encryption.stderr);

    const wrongPassphrase = run('decrypt', encrypted, rejected, randomBytes(24).toString('base64'));
    assert.equal(wrongPassphrase.status, 1);
    assert.match(wrongPassphrase.stderr, /stage=AES-256-GCM authentication/);
    assert.match(wrongPassphrase.stderr, /passphrase may differ or the ciphertext may have changed/);
    assert.doesNotMatch(wrongPassphrase.stderr, /sensitive isolated fixture/);
    await assert.rejects(readFile(rejected));

    const bytes = await readFile(encrypted);
    bytes[bytes.length - 1] ^= 0x01;
    await writeFile(encrypted, bytes);
    const tampered = run('decrypt', encrypted, rejected);
    assert.equal(tampered.status, 1);
    assert.match(tampered.stderr, /stage=AES-256-GCM authentication/);
    await assert.rejects(readFile(rejected));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
