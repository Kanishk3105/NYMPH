const EXPORT_FORMAT = 'nymph.matrix-recovery';
const EXPORT_VERSION = 1;
const KDF = 'PBKDF2-SHA-256';
const CIPHER = 'AES-256-GCM';
const ITERATIONS = 310_000;
const MIN_PASSPHRASE_LENGTH = 12;

export interface RecoveryExportContents {
  account: string;
  keyId: string | null;
  recoveryKey: string;
}

interface EncryptedRecoveryExport {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  kdf: typeof KDF;
  iterations: typeof ITERATIONS;
  cipher: typeof CIPHER;
  salt: string;
  iv: string;
  ciphertext: string;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function deriveExportKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Use an export passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  const passphraseBytes = new TextEncoder().encode(passphrase);
  try {
    const material = await crypto.subtle.importKey('raw', passphraseBytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    passphraseBytes.fill(0);
  }
}

function additionalData(): Uint8Array {
  return new TextEncoder().encode(`${EXPORT_FORMAT}:${EXPORT_VERSION}:${KDF}:${ITERATIONS}:${CIPHER}`);
}

export async function encryptRecoveryExport(
  contents: RecoveryExportContents,
  passphrase: string,
): Promise<string> {
  if (!contents.account.startsWith('@') || !contents.recoveryKey) {
    throw new Error('The recovery export data is incomplete.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveExportKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(contents));
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData() },
      key,
      plaintext,
    );
    const exported: EncryptedRecoveryExport = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      kdf: KDF,
      iterations: ITERATIONS,
      cipher: CIPHER,
      salt: encodeBase64(salt),
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    };
    return JSON.stringify(exported, null, 2);
  } finally {
    plaintext.fill(0);
    salt.fill(0);
    iv.fill(0);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function decryptRecoveryExport(
  serialized: string,
  passphrase: string,
): Promise<RecoveryExportContents> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error('The selected file is not a valid NYMPH recovery export.');
  }
  if (
    !isRecord(envelope) ||
    envelope.format !== EXPORT_FORMAT ||
    envelope.version !== EXPORT_VERSION ||
    envelope.kdf !== KDF ||
    envelope.iterations !== ITERATIONS ||
    envelope.cipher !== CIPHER ||
    typeof envelope.salt !== 'string' ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.ciphertext !== 'string'
  ) {
    throw new Error('The selected file is not a supported NYMPH recovery export.');
  }

  let salt: Uint8Array | undefined;
  let iv: Uint8Array | undefined;
  let ciphertext: Uint8Array | undefined;
  let plaintext: Uint8Array<ArrayBuffer>;
  try {
    salt = decodeBase64(envelope.salt);
    iv = decodeBase64(envelope.iv);
    ciphertext = decodeBase64(envelope.ciphertext);
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 16) {
      throw new Error('Invalid encrypted recovery export dimensions.');
    }
    const key = await deriveExportKey(passphrase, salt);
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData() },
      key,
      ciphertext,
    ));
  } catch {
    throw new Error('The recovery export could not be decrypted. Check its passphrase and file integrity.');
  } finally {
    salt?.fill(0);
    iv?.fill(0);
    ciphertext?.fill(0);
  }

  try {
    const contents: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    if (
      !isRecord(contents) ||
      typeof contents.account !== 'string' ||
      !contents.account.startsWith('@') ||
      (contents.keyId !== null && typeof contents.keyId !== 'string') ||
      typeof contents.recoveryKey !== 'string' ||
      !contents.recoveryKey
    ) {
      throw new Error('The decrypted recovery export has an invalid structure.');
    }
    return {
      account: contents.account,
      keyId: contents.keyId,
      recoveryKey: contents.recoveryKey,
    };
  } catch {
    throw new Error('The decrypted recovery export has an invalid structure.');
  } finally {
    plaintext.fill(0);
  }
}
