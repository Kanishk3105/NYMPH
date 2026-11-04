import { createReadStream, createWriteStream } from 'node:fs';
import { open, rm, stat, appendFile } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';

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

function safeDiagnostic(stage, error, detail) {
  const type = error instanceof Error ? error.constructor.name : typeof error;
  const code = error && typeof error === 'object' && 'code' in error &&
    typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
    ? `; code=${error.code}`
    : '';
  return new Error(
    `Backup decrypt failed [stage=${stage}; exception=${type}${code}]. ${detail}`,
    { cause: error },
  );
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
  let info;
  try {
    info = await stat(source);
  } catch (error) {
    throw safeDiagnostic('backup file read', error, 'Could not inspect the encrypted backup.');
  }
  if (info.size < HEADER_LENGTH + TAG_LENGTH) {
    throw safeDiagnostic(
      'backup format validation',
      new Error('Invalid encrypted backup length.'),
      'The encrypted backup is truncated or invalid.',
    );
  }
  let handle;
  const header = Buffer.alloc(HEADER_LENGTH);
  const tag = Buffer.alloc(TAG_LENGTH);
  try {
    handle = await open(source, 'r');
    const headerRead = await handle.read(header, 0, HEADER_LENGTH, 0);
    if (headerRead.bytesRead !== HEADER_LENGTH) {
      throw new Error('Incomplete encrypted backup header.');
    }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('Unsupported encrypted backup magic.');
    }
    const tagRead = await handle.read(tag, 0, TAG_LENGTH, info.size - TAG_LENGTH);
    if (tagRead.bytesRead !== TAG_LENGTH) {
      throw new Error('Incomplete encrypted backup authentication tag.');
    }
  } catch (error) {
    throw safeDiagnostic('encrypted header and tag read', error, 'The expected encrypted backup header or tag could not be read.');
  } finally {
    await handle?.close();
  }

  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LENGTH);
  const iv = header.subarray(MAGIC.length + SALT_LENGTH);
  let key;
  let decipher;
  try {
    key = deriveKey(passphrase, salt);
  } catch (error) {
    header.fill(0);
    tag.fill(0);
    throw safeDiagnostic('scrypt key derivation', error, 'Could not derive the backup decryption key.');
  }
  try {
    decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
  } catch (error) {
    header.fill(0);
    tag.fill(0);
    key.fill(0);
    throw safeDiagnostic('AES-256-GCM initialization', error, 'Could not initialize authenticated decryption.');
  }
  try {
    const output = destination
      ? createWriteStream(destination, { flags: 'wx', mode: 0o600 })
      : new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    await pipeline(
      createReadStream(source, { start: HEADER_LENGTH, end: info.size - TAG_LENGTH - 1 }),
      decipher,
      output,
    );
  } catch (error) {
    if (destination) {
      await rm(destination, { force: true });
    }
    const authenticationRejected = Boolean(
      error && typeof error === 'object' && (
        ('code' in error && error.code === 'ERR_OSSL_EVP_BAD_DECRYPT') ||
        ('message' in error && typeof error.message === 'string' &&
          /unable to authenticate data|authentication tag|failed to authenticate/i.test(error.message))
      ),
    );
    throw safeDiagnostic(
      authenticationRejected ? 'AES-256-GCM authentication' : 'ciphertext read or decrypted output write',
      error,
      authenticationRejected
        ? 'The authentication tag was rejected; the passphrase may differ or the ciphertext may have changed.'
        : 'Ciphertext processing failed before authenticated decryption completed.',
    );
  } finally {
    header.fill(0);
    tag.fill(0);
    key.fill(0);
  }
}

const [operation, source, destination] = process.argv.slice(2);
if (!['encrypt', 'decrypt', 'verify'].includes(operation) || !source || (operation !== 'verify' && !destination)) {
  process.stderr.write('Usage: node secure-backup.mjs <encrypt|decrypt|verify> <source> [destination]\n');
  process.exitCode = 2;
} else {
  let passphrase;
  try {
    passphrase = await readPassphrase();
    if (operation === 'encrypt') {
      await encryptFile(source, destination, passphrase);
    } else if (operation === 'decrypt') {
      await decryptFile(source, destination, passphrase);
    } else {
      await decryptFile(source, undefined, passphrase);
    }
    process.stdout.write(`${operation} complete\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Backup operation failed.'}\n`);
    process.exitCode = 1;
  } finally {
    passphrase = null;
  }
}
