import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const RESERVED_HOSTS = ['example.com', 'example.org', 'example.net'];
const RESERVED_SUFFIXES = [
  '.localhost',
  '.local',
  '.test',
  '.example',
  '.invalid',
  '.example.com',
  '.example.org',
  '.example.net',
];

export function validateProductionEnvironment(env = process.env) {
  const homeserver = env.VITE_MATRIX_HOMESERVER?.trim();

  if (!homeserver) {
    throw new Error('Set VITE_MATRIX_HOMESERVER to the deployed HTTPS Matrix URL before building a release.');
  }

  let parsed;
  try {
    parsed = new URL(homeserver);
  } catch {
    throw new Error('VITE_MATRIX_HOMESERVER must be a valid HTTPS URL.');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname) ||
    hostname.endsWith('.localhost') ||
    RESERVED_HOSTS.includes(hostname) ||
    RESERVED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new Error('VITE_MATRIX_HOMESERVER must use HTTPS and a non-loopback production hostname without reserved example domains.');
  }

  const signingVariables = [
    'NYMPH_RELEASE_STORE_FILE',
    'NYMPH_RELEASE_STORE_PASSWORD',
    'NYMPH_RELEASE_KEY_ALIAS',
    'NYMPH_RELEASE_KEY_PASSWORD',
  ];
  const missingSigningVariables = signingVariables.filter((name) => !env[name]);
  if (missingSigningVariables.length) {
    throw new Error(`Set all release signing variables before building: ${missingSigningVariables.join(', ')}.`);
  }
  const releaseKeystore = env.NYMPH_RELEASE_STORE_FILE;
  if (
    !isAbsolute(releaseKeystore) ||
    !existsSync(releaseKeystore) ||
    !statSync(releaseKeystore).isFile()
  ) {
    throw new Error('NYMPH_RELEASE_STORE_FILE must identify an existing keystore file by absolute path.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateProductionEnvironment();
}
