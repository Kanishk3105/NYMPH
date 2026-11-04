import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = fileURLToPath(new URL('./secure-backup.mjs', import.meta.url));
const passphrase = 'isolated offline backup test passphrase';

function run(operation, source, destination, input = passphrase) {
  return spawnSync(process.execPath, [helper, operation, source, destination], {
    encoding: 'utf8',
    input: `${input}\n`,
    timeout: 30_000,
  });
}

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

test('rejects wrong passphrases and authenticated-data tampering without leaving plaintext', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nymph-backup-failure-test-'));
  const source = join(root, 'staging.tar');
  const encrypted = join(root, 'backup.enc');
  const rejected = join(root, 'rejected.tar');
  try {
    await writeFile(source, Buffer.from('sensitive isolated fixture'));
    const encryption = run('encrypt', source, encrypted);
    assert.equal(encryption.status, 0, encryption.stderr);

    const wrongPassphrase = run('decrypt', encrypted, rejected, 'incorrect offline passphrase');
    assert.equal(wrongPassphrase.status, 1);
    await assert.rejects(readFile(rejected));

    const bytes = await readFile(encrypted);
    bytes[bytes.length - 1] ^= 0x01;
    await writeFile(encrypted, bytes);
    const tampered = run('decrypt', encrypted, rejected);
    assert.equal(tampered.status, 1);
    await assert.rejects(readFile(rejected));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
