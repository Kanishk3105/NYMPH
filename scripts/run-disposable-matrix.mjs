import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import net from 'node:net';

const root = resolve(import.meta.dirname, '..');
const composeFile = join(root, 'backend', 'compose.dev.isolated.yaml');
const runRoot = join(root, '.matrix-e2e', `fresh-${Date.now()}-${randomUUID()}`);
const secrets = join(runRoot, 'secrets');
const project = `nymph-disposable-${process.pid}-${Date.now()}`.toLowerCase();
const serverName = 'nymph-dev.localhost';
const port = await new Promise((resolvePort, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (!address || typeof address === 'string') {
      reject(new Error('Could not allocate a disposable Matrix loopback port.'));
      return;
    }
    probe.close((error) => error ? reject(error) : resolvePort(address.port));
  });
});
const homeserver = `http://127.0.0.1:${port}`;
const suffix = randomBytes(4).toString('hex');
const usernameA = `qa-a-${suffix}`;
const usernameB = `qa-b-${suffix}`;
const partnerA = `@${usernameA}:${serverName}`;
const partnerB = `@${usernameB}:${serverName}`;
const passwordA = randomBytes(36).toString('base64url');
const passwordB = randomBytes(36).toString('base64url');

mkdirSync(secrets, { recursive: true, mode: 0o700 });
const secret = (name) => {
  const value = randomBytes(48).toString('base64url');
  const path = join(secrets, name);
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return value;
};
const registrationSecret = secret('registration_shared_secret');
secret('postgres_password');
const envPath = join(runRoot, 'compose.env');
writeFileSync(envPath, [
  `MATRIX_SERVER_NAME=${serverName}`,
  `DEV_HOMESERVER_URL=${homeserver}`,
  `DEV_MATRIX_PORT=${port}`,
  `DEV_PARTNER_A_USER_ID=${partnerA}`,
  `DEV_PARTNER_B_USER_ID=${partnerB}`,
  `DEV_APP_ORIGINS=http://localhost:5173,http://127.0.0.1:5174,https://localhost`,
  `DEV_SECRETS_DIR=${secrets}`,
  'NYMPH_DISPOSABLE_MATRIX=1',
  'SYNAPSE_IMAGE=matrixdotorg/synapse:v1.164.2',
  'POSTGRES_IMAGE=postgres:16.10-alpine',
].join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });

const compose = (...args) => execFileSync('docker', [
  'compose', '--project-name', project, '--env-file', envPath, '-f', composeFile, ...args,
], { cwd: root, stdio: 'inherit' });
const waitForHomeserver = async () => {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    try {
      const response = await fetch(`${homeserver}/_matrix/client/versions`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error('Fresh disposable Synapse did not become ready.');
};
const register = async (username, password) => {
  const challengeResponse = await fetch(`${homeserver}/_synapse/admin/v1/register`);
  if (!challengeResponse.ok) throw new Error('Fresh disposable registration challenge failed.');
  const challenge = await challengeResponse.json();
  const message = `${challenge.nonce}\0${username}\0${password}\0notadmin`;
  const mac = createHmac('sha1', registrationSecret).update(message).digest('hex');
  const response = await fetch(`${homeserver}/_synapse/admin/v1/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: challenge.nonce, username, password, admin: false, mac }),
  });
  if (!response.ok) throw new Error(`Fresh disposable account registration failed (${response.status}).`);
};

let exitCode = 1;
try {
  compose('--profile', 'init', 'run', '--rm', 'synapse-generate');
  compose('up', '-d', 'postgres', 'synapse');
  await waitForHomeserver();
  console.error('Fresh disposable Synapse is ready.');
  await register(usernameA, passwordA);
  console.error('Fresh disposable Partner A registered.');
  await register(usernameB, passwordB);
  console.error('Fresh disposable Partner B registered.');
  const playwrightPath = join(root, 'node_modules', '.bin', 'playwright');
  const result = process.platform === 'win32'
    ? spawnSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/c', `${playwrightPath}.cmd test --config=playwright.matrix.disposable.config.ts`],
      {
        cwd: root,
        stdio: 'inherit',
        env: {
          ...process.env,
          NYMPH_DISPOSABLE_MATRIX: '1',
          NYMPH_DISPOSABLE_COMPOSE_PROJECT: project,
          NYMPH_MATRIX_TEST_HOMESERVER: homeserver,
          NYMPH_MATRIX_TEST_PARTNER_A: partnerA,
          NYMPH_MATRIX_TEST_PARTNER_B: partnerB,
          NYMPH_MATRIX_TEST_PASSWORD_A: passwordA,
          NYMPH_MATRIX_TEST_PASSWORD_B: passwordB,
        },
      },
    )
    : spawnSync(
      playwrightPath,
      ['test', '--config=playwright.matrix.disposable.config.ts'],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        NYMPH_DISPOSABLE_MATRIX: '1',
        NYMPH_DISPOSABLE_COMPOSE_PROJECT: project,
        NYMPH_MATRIX_TEST_PARTNER_A: partnerA,
        NYMPH_MATRIX_TEST_PARTNER_B: partnerB,
        NYMPH_MATRIX_TEST_PASSWORD_A: passwordA,
        NYMPH_MATRIX_TEST_PASSWORD_B: passwordB,
      },
    },
    );
  if (result.error) throw result.error;
  exitCode = result.status ?? 1;
} catch (error) {
  console.error('Disposable Matrix setup failed before test execution.');
  try { execFileSync('docker', [
    'compose', '--project-name', project, '--env-file', envPath, '-f', composeFile, 'ps', '-a',
  ], { cwd: root, stdio: 'inherit' }); } catch {}
  try { execFileSync('docker', [
    'compose', '--project-name', project, '--env-file', envPath, '-f', composeFile, 'logs', '--no-color', 'synapse',
  ], { cwd: root, stdio: 'inherit' }); } catch {}
  throw error;
} finally {
  if (process.env.NYMPH_KEEP_DISPOSABLE !== '1') {
    try { compose('down', '-v', '--remove-orphans'); } catch {}
    rmSync(runRoot, { recursive: true, force: true });
  } else {
    console.error(`Disposable environment retained for diagnostics under ${runRoot}.`);
  }
}
process.exit(exitCode);
