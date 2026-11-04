import { createReadStream, createWriteStream } from 'node:fs';
import { open, rm, stat, appendFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('NYMPH-ENC-BACKUP-1\0', 'ascii');
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + SALT_LENGTH + IV_LENGTH;

function readPassphrase() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('error', reject);
    process.stdin.on('end', () => {
      const value = Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+$/, '');
      for (const chunk of chunks) chunk.fill(0);
      if (value.length < 12) {
        reject(new Error('Backup passphrase must contain at least 12 characters.'));
        return;
      }
      resolve(value);
    });
  });
}

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

async function encryptFile(source, destination, passphrase) {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  try {
    output.write(header);
    await pipeline(createReadStream(source), cipher, output);
    await appendFile(destination, cipher.getAuthTag(), { mode: 0o600 });
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  } finally {
    salt.fill(0);
    iv.fill(0);
    key.fill(0);
  }
}

async function decryptFile(source, destination, passphrase) {
  const info = await stat(source);
  if (info.size < HEADER_LENGTH + TAG_LENGTH) {
    throw new Error('Encrypted backup is truncated or invalid.');
  }
  const handle = await open(source, 'r');
  const header = Buffer.alloc(HEADER_LENGTH);
  const tag = Buffer.alloc(TAG_LENGTH);
  try {
    await handle.read(header, 0, HEADER_LENGTH, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('Encrypted backup format is unsupported.');
    }
    await handle.read(tag, 0, TAG_LENGTH, info.size - TAG_LENGTH);
  } finally {
    await handle.close();
  }

  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LENGTH);
  const iv = header.subarray(MAGIC.length + SALT_LENGTH);
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(source, { start: HEADER_LENGTH, end: info.size - TAG_LENGTH - 1 }),
      decipher,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    );
  } catch (error) {
    await rm(destination, { force: true });
    throw new Error('Encrypted backup authentication or restoration failed.', { cause: error });
  } finally {
    header.fill(0);
    tag.fill(0);
    key.fill(0);
  }
}

const [operation, source, destination] = process.argv.slice(2);
if (!['encrypt', 'decrypt'].includes(operation) || !source || !destination) {
  process.stderr.write('Usage: node secure-backup.mjs <encrypt|decrypt> <source> <destination>\n');
  process.exitCode = 2;
} else {
  try {
    const passphrase = await readPassphrase();
    try {
      if (operation === 'encrypt') {
        await encryptFile(source, destination, passphrase);
      } else {
        await decryptFile(source, destination, passphrase);
      }
      process.stdout.write(`${operation} complete\n`);
    } finally {
      process.exitCode = process.exitCode ?? 0;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Backup operation failed.'}\n`);
    process.exitCode = 1;
  }
}
