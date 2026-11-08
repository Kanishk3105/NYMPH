import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const isolatedEnvironmentPath = fileURLToPath(
  new URL('../../backend/.env.dev.isolated', import.meta.url),
);

const requiredValues = {
  MATRIX_SERVER_NAME: 'nymph-dev.localhost',
  DEV_HOMESERVER_URL: 'http://127.0.0.1:18008',
  DEV_PARTNER_A_USER_ID: '@partner1-dev:nymph-dev.localhost',
  DEV_PARTNER_B_USER_ID: '@partner2-dev:nymph-dev.localhost',
};

function parseValues(contents) {
  const values = new Map();
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

function createConfig(values, partnerA, partnerB, passwords) {
  if (
    values.get('MATRIX_SERVER_NAME') !== requiredValues.MATRIX_SERVER_NAME ||
    values.get('DEV_HOMESERVER_URL') !== requiredValues.DEV_HOMESERVER_URL ||
    !/^@[A-Za-z0-9._=-]+:nymph-dev\.localhost$/.test(partnerA) ||
    !/^@[A-Za-z0-9._=-]+:nymph-dev\.localhost$/.test(partnerB) ||
    partnerA === partnerB
  ) {
    throw new Error('Disposable Matrix identities must belong to the isolated local homeserver and be distinct.');
  }
  if (passwords && (!passwords[0] || !passwords[1] || passwords[0] === passwords[1])) {
    throw new Error('Disposable Matrix credentials must contain two distinct non-empty passwords.');
  }
  return Object.freeze({
    homeserverUrl: values.get('DEV_HOMESERVER_URL'),
    serverName: values.get('MATRIX_SERVER_NAME'),
    partnerA,
    partnerB,
    passwordA: passwords?.[0],
    passwordB: passwords?.[1],
    disposable: Boolean(passwords),
  });
}

export function parseIsolatedMatrixConfig(contents, environment = process.env) {
  const values = parseValues(contents);
  if (environment.NYMPH_DISPOSABLE_MATRIX === '1') {
    return createConfig(
      values,
      environment.NYMPH_MATRIX_TEST_PARTNER_A,
      environment.NYMPH_MATRIX_TEST_PARTNER_B,
      [environment.NYMPH_MATRIX_TEST_PASSWORD_A, environment.NYMPH_MATRIX_TEST_PASSWORD_B],
    );
  }
  for (const [name, expected] of Object.entries(requiredValues)) {
    if (values.get(name) !== expected) {
      throw new Error(
        `Isolated Matrix configuration ${name} must be ${expected}; refusing non-isolated or mismatched settings.`,
      );
    }
  }

  return createConfig(values, values.get('DEV_PARTNER_A_USER_ID'), values.get('DEV_PARTNER_B_USER_ID'));
}

export function loadIsolatedMatrixConfig() {
  let contents;
  try {
    contents = readFileSync(isolatedEnvironmentPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        'Missing backend/.env.dev.isolated. Configure the isolated Matrix deployment before running live tests.',
      );
    }
    throw new Error('Could not read backend/.env.dev.isolated.', { cause: error });
  }
  return parseIsolatedMatrixConfig(contents);
}
