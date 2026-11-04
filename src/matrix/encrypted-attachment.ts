import type { EncryptedFile } from 'matrix-js-sdk/lib/@types/media';

const AES_CTR_ALGORITHM = 'A256CTR';
const AES_CTR_COUNTER_LENGTH = 64;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Encrypted attachment metadata is invalid.');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/=+$/g, '');
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function isEncryptedAttachment(value: unknown): value is EncryptedFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as Partial<EncryptedFile>;
  return file.v === 'v2' &&
    typeof file.url === 'string' &&
    file.url.startsWith('mxc://') &&
    file.key?.alg === AES_CTR_ALGORITHM &&
    file.key.kty === 'oct' &&
    file.key.ext === true &&
    Array.isArray(file.key.key_ops) &&
    file.key.key_ops.includes('decrypt') &&
    typeof file.key.k === 'string' &&
    typeof file.iv === 'string' &&
    typeof file.hashes?.sha256 === 'string';
}

export async function encryptAttachment(
  plaintext: ArrayBuffer | Uint8Array<ArrayBuffer>,
): Promise<{ ciphertext: ArrayBuffer; file: Omit<EncryptedFile, 'url'> }> {
  const bytes = plaintext instanceof Uint8Array ? plaintext.slice() : new Uint8Array(plaintext);
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  iv.fill(0, 8);
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CTR' }, false, ['encrypt']);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-CTR', counter: iv, length: AES_CTR_COUNTER_LENGTH },
      key,
      bytes,
    );
    const digest = await crypto.subtle.digest('SHA-256', ciphertext);
    return {
      ciphertext,
      file: {
        v: 'v2',
        key: {
          alg: AES_CTR_ALGORITHM,
          ext: true,
          k: toBase64Url(keyBytes),
          key_ops: ['encrypt', 'decrypt'],
          kty: 'oct',
        },
        iv: toBase64(iv),
        hashes: { sha256: toBase64Url(new Uint8Array(digest)) },
      },
    } satisfies { ciphertext: ArrayBuffer; file: Omit<EncryptedFile, 'url'> };
  } finally {
    keyBytes.fill(0);
    bytes.fill(0);
  }
}

export async function decryptAttachment(
  ciphertext: ArrayBuffer | Uint8Array<ArrayBuffer>,
  file: EncryptedFile,
): Promise<ArrayBuffer> {
  if (!isEncryptedAttachment(file)) throw new Error('Encrypted attachment metadata is invalid.');
  const bytes = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);
  const expectedHash = fromBase64Url(file.hashes.sha256);
  const actualHash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (
    expectedHash.length !== actualHash.length ||
    expectedHash.some((value, index) => value !== actualHash[index])
  ) {
    throw new Error('Encrypted attachment integrity check failed.');
  }
  const keyBytes = fromBase64Url(file.key.k);
  const iv = fromBase64(file.iv);
  if (keyBytes.length !== 32 || iv.length !== 16) {
    throw new Error('Encrypted attachment key or counter has an invalid length.');
  }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CTR' }, false, ['decrypt']);
  keyBytes.fill(0);
  return crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: iv, length: AES_CTR_COUNTER_LENGTH },
    key,
    bytes,
  );
}
