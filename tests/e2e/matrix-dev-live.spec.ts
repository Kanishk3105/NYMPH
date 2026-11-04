import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID, scryptSync } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type Session = {
  homeserver: string;
  userId: string;
  partnerUserId: string;
  accessToken: string;
  roomId: string;
  deviceId?: string;
};

type Invitation = {
  version: 1;
  token: string;
  room_id: string;
  partner_user_id: string;
  expires_at: number;
};

const chromePath = process.env.NYMPH_CHROME_PATH ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const matrixUrl = 'http://127.0.0.1:8008';
const secretsDirectory = join(process.cwd(), 'backend', 'dev-secrets');
const profileRoot = join(process.cwd(), '.matrix-e2e', 'dev-stage-3h');
const partnerA = '@partner1-dev:localhost';
const partnerB = '@partner2-dev:localhost';

async function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  const result = page.evaluate(
    async ({ methodName, parameters }) => {
      const harnessValue = (window as Window & { nymphMatrixHarness?: unknown }).nymphMatrixHarness;
      if (!harnessValue || typeof harnessValue !== 'object') {
        throw new Error('The isolated Matrix test harness is unavailable.');
      }
      const harness = harnessValue as Record<string, (...values: unknown[]) => unknown>;
      const operation = harness[methodName];
      if (typeof operation !== 'function') throw new Error('The requested Matrix test operation is unavailable.');
      return operation(...parameters);
    },
    { methodName: method, parameters: args },
  ) as Promise<T>;
  let timeoutId: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Matrix operation timed out: ${method}.`)), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

async function waitForValue<T>(
  page: Page,
  expression: string,
  args: unknown[] = [],
  timeout = 20_000,
): Promise<T> {
  await page.waitForFunction(
    ({ expression: source, values }) => {
      const getter = new Function('harness', 'args', `return (${source})(harness, ...args)`);
      return getter((window as Window & { nymphMatrixHarness?: unknown }).nymphMatrixHarness, values);
    },
    { expression, values: args },
    { timeout },
  );
  return page.evaluate(
    ({ expression: source, values }) => {
      const getter = new Function('harness', 'args', `return (${source})(harness, ...args)`);
      return getter((window as Window & { nymphMatrixHarness?: unknown }).nymphMatrixHarness, values);
    },
    { expression, values: args },
  ) as Promise<T>;
}

async function openProfile(
  userDataDirectory: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(userDataDirectory, {
    executablePath: chromePath,
    headless: true,
    args: ['--disable-extensions', '--no-first-run', '--no-default-browser-check'],
  });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5174/tests/e2e/matrix-harness.html', {
    waitUntil: 'domcontentloaded',
    timeout: 15_000,
  });
  await page.getByText('Isolated Matrix test client ready').waitFor({ timeout: 15_000 });
  return { context, page };
}

async function readLocalSecret(name: string): Promise<string> {
  const value = (await readFile(join(secretsDirectory, name), 'utf8')).trim();
  if (!value) throw new Error(`The local development file ${name} is empty.`);
  return value;
}

async function writeEncryptedExport(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
  await rename(temporaryPath, path);
}

async function updateViteDeviceId(filePath: string, deviceId: string): Promise<void> {
  const contents = await readFile(filePath, 'utf8');
  const variable = 'VITE_MATRIX_PARTNER_A_DEVICE_ID';
  const updated = new RegExp(`^${variable}=.*$`, 'm').test(contents)
    ? contents.replace(new RegExp(`^${variable}=.*$`, 'm'), `${variable}=${deviceId}`)
    : `${contents.trimEnd()}\n${variable}=${deviceId}\n`;
  await writeFile(filePath, updated, 'utf8');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function deriveStorageKey(password: string, salt: string): number[] {
  const key = scryptSync(password, salt, 32);
  try {
    return Array.from(key);
  } finally {
    key.fill(0);
  }
}

async function setupOrRestoreSecurity(
  page: Page,
  userId: string,
  password: string,
  passphrase: string,
  exportPath: string,
): Promise<string[]> {
  const security = await call<{
    defaultSecretStorageKeyId: string | null;
    crossSigningReady: boolean;
  }>(page, 'refreshSecurity');
  const exportExists = await fileExists(exportPath);
  if (security.defaultSecretStorageKeyId) {
    if (!exportExists) {
      throw new Error(`Existing Secret Storage for ${userId} has no encrypted recovery export; refusing to replace it.`);
    }
    return call<string[]>(
      page,
      'restoreRecoveryExport',
      await readFile(exportPath, 'utf8'),
      passphrase,
      password,
    );
  }
  if (exportExists) {
    throw new Error(`An encrypted recovery export exists for ${userId}, but the account has no default Secret Storage key.`);
  }

  const prepared = await call<{ keyId: string; encryptedExport: string }>(
    page,
    'prepareRecoveryExport',
    passphrase,
  );
  await writeEncryptedExport(exportPath, prepared.encryptedExport);
  const identityIds = await call<string[]>(page, 'finishRecoverySetup', password);
  expect(prepared.keyId.length).toBeGreaterThan(0);
  return identityIds;
}

test('isolated dev partners recover, verify, exchange encrypted messages, restart, and replace a device', async () => {
  test.setTimeout(300_000);
  const passphraseA = process.env.NYMPH_DEV_RECOVERY_EXPORT_PASSPHRASE_A;
  const passphraseB = process.env.NYMPH_DEV_RECOVERY_EXPORT_PASSPHRASE_B;
  if (!passphraseA || !passphraseB || passphraseA.length < 12 || passphraseB.length < 12) {
    throw new Error(
      'Set NYMPH_DEV_RECOVERY_EXPORT_PASSPHRASE_A and NYMPH_DEV_RECOVERY_EXPORT_PASSPHRASE_B to distinct local passphrases of at least 12 characters.',
    );
  }
  if (passphraseA === passphraseB) {
    throw new Error('Use different offline-export passphrases for Partner A and Partner B.');
  }

  const versions = await fetch(`${matrixUrl}/_matrix/client/versions`);
  expect(versions.status).toBe(200);
  await versions.arrayBuffer();
  const passwordA = await readLocalSecret('partner1_dev_password');
  const passwordB = await readLocalSecret('partner2_dev_password');
  const deviceIdPathA = join(secretsDirectory, 'partner1_dev_device_id');
  const deviceIdPathB = join(secretsDirectory, 'partner2_dev_device_id');
  let deviceIdA = await readLocalSecret('partner1_dev_device_id');
  const deviceIdB = await readLocalSecret('partner2_dev_device_id');
  const exportPathA = join(secretsDirectory, 'partner1_dev_recovery.enc');
  const exportPathB = join(secretsDirectory, 'partner2_dev_recovery.enc');

  await mkdir(profileRoot, { recursive: true });
  let contextA: BrowserContext | undefined;
  let contextB: BrowserContext | undefined;
  let pageA: Page;
  let pageB: Page;
  let sessionA: Session | undefined;
  let sessionB: Session | undefined;
  let replacementSession: Session | undefined;
  let oldDeviceRevoked = false;
  let replacementActivated = false;
  let replacementCleanupFailed = false;
  let storageKeyA: number[] = [];
  let storageKeyB: number[] = [];

  try {
    ({ context: contextA, page: pageA } = await openProfile(join(profileRoot, 'partner-a')));
    ({ context: contextB, page: pageB } = await openProfile(join(profileRoot, 'partner-b')));

    sessionA = await call<Session>(pageA, 'passwordLogin', partnerA, passwordA, 'NYMPH dev Partner A', deviceIdA);
    const roomStatus = await call<{ room_id: string }>(pageA, 'roomStatus', sessionA);
    expect(roomStatus.room_id.startsWith('!')).toBeTruthy();
    sessionA.roomId = roomStatus.room_id;

    const invitation = await call<Invitation>(pageA, 'createInvitation', sessionA);
    expect(invitation.partner_user_id).toBe(partnerB);
    expect(invitation.room_id).toBe(sessionA.roomId);
    sessionB = await call<Session>(pageB, 'redeemInvitation', invitation, deviceIdB);
    expect(sessionB.userId).toBe(partnerB);
    expect(sessionB.deviceId).not.toBe(sessionA.deviceId);
    expect(await call<number>(pageB, 'replayInvitation', invitation)).toBe(403);

    storageKeyA = deriveStorageKey(passwordA, 'nymph-dev-stage-3h-partner-a-v1');
    storageKeyB = deriveStorageKey(passwordB, 'nymph-dev-stage-3h-partner-b-v1');
    await call(pageA, 'connect', sessionA, storageKeyA);
    await call(pageB, 'connect', sessionB, storageKeyB);
    expect(await call<number>(pageA, 'inviteStatus', sessionA, sessionA.roomId, '@unauthorized:localhost')).toBe(403);

    const identityIdsA = await setupOrRestoreSecurity(
      pageA,
      partnerA,
      passwordA,
      passphraseA,
      exportPathA,
    );
    const identityIdsB = await setupOrRestoreSecurity(
      pageB,
      partnerB,
      passwordB,
      passphraseB,
      exportPathB,
    );
    expect(identityIdsA).toHaveLength(3);
    expect(identityIdsB).toHaveLength(3);
    expect(new Set([...identityIdsA, ...identityIdsB]).size).toBe(6);

    const securityA = await call<{
      crossSigningReady: boolean;
      recoverySetupVerified: boolean;
      defaultSecretStorageKeyId: string | null;
      keyBackupVersion: string | null;
    }>(pageA, 'refreshSecurity');
    const securityB = await call<{
      crossSigningReady: boolean;
      recoverySetupVerified: boolean;
      defaultSecretStorageKeyId: string | null;
      keyBackupVersion: string | null;
    }>(pageB, 'refreshSecurity');
    expect(securityA.crossSigningReady).toBe(true);
    expect(securityB.crossSigningReady).toBe(true);
    expect(securityA.recoverySetupVerified).toBe(true);
    expect(securityB.recoverySetupVerified).toBe(true);
    expect(securityA.defaultSecretStorageKeyId).toBeTruthy();
    expect(securityB.defaultSecretStorageKeyId).toBeTruthy();
    expect(securityA.defaultSecretStorageKeyId).not.toBe(securityB.defaultSecretStorageKeyId);
    expect(securityA.keyBackupVersion).toBeTruthy();
    expect(securityB.keyBackupVersion).toBeTruthy();

    if (!sessionB.deviceId) throw new Error('Partner B login did not return a device ID.');
    await call(pageA, 'requestPartnerVerification', sessionB.deviceId);
    const incoming = await waitForValue<{ id: string }>(
      pageB,
      'h => h.getVerifications().find(item => item.userId === args[0] && item.phase === "Requested")',
      [partnerA],
    );
    await call(pageB, 'acceptVerification', incoming.id);
    const outgoing = await waitForValue<{ id: string }>(
      pageA,
      'h => h.getVerifications().find(item => item.userId === args[0])',
      [partnerB],
    );
    await call(pageA, 'startSasVerification', outgoing.id);
    await call(pageB, 'startSasVerification', incoming.id);
    const sasA = await waitForValue<{ emoji?: unknown[]; decimal?: unknown[] }>(
      pageA,
      'h => h.getVerifications().find(item => item.id === args[0])?.sas',
      [outgoing.id],
    );
    const sasB = await waitForValue<{ emoji?: unknown[]; decimal?: unknown[] }>(
      pageB,
      'h => h.getVerifications().find(item => item.id === args[0])?.sas',
      [incoming.id],
    );
    expect(sasA).toEqual(sasB);
    expect(Boolean(sasA.emoji?.length || sasA.decimal?.length)).toBe(true);
    await call(pageA, 'confirmSas', outgoing.id);
    await call(pageB, 'confirmSas', incoming.id);
    await waitForValue<boolean>(pageA, 'h => h.getSecurity()?.partnerVerified');
    await waitForValue<boolean>(pageB, 'h => h.getSecurity()?.partnerVerified');

    const messageId = randomUUID();
    await call(pageA, 'send', {
      version: 1,
      id: messageId,
      mode: 'romantic',
      kind: 'text',
      text: `Encrypted dev acceptance message ${messageId}`,
      sentAt: Date.now(),
    });
    await waitForValue(pageB, 'h => h.getEvents().some(event => event.id === args[0])', [messageId]);
    const received = await call<Array<{ id: string; sender: string }>>(pageB, 'getEvents');
    expect(received.find((event) => event.id === messageId)?.sender).toBe(partnerA);

    const replyId = randomUUID();
    await call(pageB, 'send', {
      version: 1,
      id: replyId,
      mode: 'romantic',
      kind: 'text',
      text: `Encrypted dev acceptance reply ${replyId}`,
      sentAt: Date.now(),
    });
    await waitForValue(pageA, 'h => h.getEvents().some(event => event.id === args[0])', [replyId]);
    const returned = await call<Array<{ id: string; sender: string }>>(pageA, 'getEvents');
    expect(returned.find((event) => event.id === replyId)?.sender).toBe(partnerB);

    await call(pageA, 'disconnect');
    await call(pageB, 'disconnect');
    await contextA.close();
    contextA = undefined;
    await contextB.close();
    contextB = undefined;

    ({ context: contextA, page: pageA } = await openProfile(join(profileRoot, 'partner-a')));
    ({ context: contextB, page: pageB } = await openProfile(join(profileRoot, 'partner-b')));
    await call(pageA, 'connect', sessionA, storageKeyA);
    await call(pageB, 'connect', sessionB, storageKeyB);
    await waitForValue(pageA, 'h => h.getEvents().some(event => event.id === args[0])', [replyId]);
    await waitForValue(pageB, 'h => h.getEvents().some(event => event.id === args[0])', [messageId]);
    expect(await call<string[]>(pageA, 'crossSigningIdentityIds')).toEqual(identityIdsA);
    expect(await call<string[]>(pageB, 'crossSigningIdentityIds')).toEqual(identityIdsB);

    if (!sessionA.deviceId) throw new Error('Partner A login did not return a device ID.');
    const previousSession = sessionA;
    const previousDeviceId = previousSession.deviceId;
    const replacementDeviceId = `NYMPH_DEV_A_${randomUUID().replaceAll('-', '')}`;
    await call(pageA, 'disconnect');
    const authorization = await call<{
      user_id: string;
      device_id: string;
      previous_device_id: string;
      login_token: string;
    }>(pageA, 'createDeviceReplacement', sessionA, replacementDeviceId);
    expect(authorization.previous_device_id).toBe(previousDeviceId);
    replacementSession = await call<Session>(pageA, 'loginReplacement', matrixUrl, authorization);
    replacementSession.roomId = sessionA.roomId;
    await call(pageA, 'deleteDevice', replacementSession, previousDeviceId, passwordA);
    oldDeviceRevoked = true;
    await call(pageA, 'activateReplacement', replacementSession);
    replacementActivated = true;
    sessionA = replacementSession;
    deviceIdA = replacementDeviceId;
    await writeFile(deviceIdPathA, `${deviceIdA}\n`, 'utf8');
    await Promise.all([
      updateViteDeviceId(join(process.cwd(), '.env.development.local'), deviceIdA),
      updateViteDeviceId(join(process.cwd(), '.env.android.local'), deviceIdA),
    ]);

    expect([401, 403]).toContain(await call(pageA, 'whoamiStatus', previousSession));
    await expect(
      call<Session>(pageA, 'passwordLogin', partnerA, passwordA, 'NYMPH revoked-device check', previousDeviceId),
    ).rejects.toThrow();

    await call(pageA, 'connect', sessionA, storageKeyA);
    await call(
      pageA,
      'restoreRecoveryExport',
      await readFile(exportPathA, 'utf8'),
      passphraseA,
      passwordA,
    );
    expect((await call<{ crossSigningReady: boolean }>(pageA, 'refreshSecurity')).crossSigningReady).toBe(true);
  } finally {
    if (replacementSession && !replacementActivated) {
      if (oldDeviceRevoked) {
        await call(pageA!, 'activateReplacement', replacementSession).then(async () => {
          replacementActivated = true;
          deviceIdA = replacementSession!.deviceId ?? deviceIdA;
          await writeFile(deviceIdPathA, `${deviceIdA}\n`, 'utf8');
        }).catch(() => { replacementCleanupFailed = true; });
      } else {
        try {
          await call(pageA!, 'cancelReplacement', replacementSession);
          await call(pageA!, 'logout', replacementSession);
        } catch {
          replacementCleanupFailed = true;
        }
      }
    }
    if (contextA) await call(pageA!, 'disconnect');
    if (contextB) await call(pageB!, 'disconnect');
    const sessionsToLogout = new Set(
      [sessionB, replacementActivated ? replacementSession : sessionA].filter(
        (session): session is Session => Boolean(session),
      ),
    );
    for (const session of sessionsToLogout) {
      const status = await call<number>(pageA!, 'whoamiStatus', session);
      if (status === 200) await call(pageA!, 'logout', session);
      else if (status !== 401 && status !== 403) throw new Error('Could not confirm the cleanup status of a Matrix session.');
    }
    await contextA?.close();
    await contextB?.close();
    storageKeyA.fill(0);
    storageKeyB.fill(0);
    if (replacementCleanupFailed) {
      throw new Error('The active-device replacement cleanup did not complete; inspect the dev account device list before retrying.');
    }
  }
});
