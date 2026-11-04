import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID, scryptSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test.skip(true, 'Legacy Matrix live suite is disabled. Use the isolated Stage 3I configuration.');

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
const localProfileRoot = join(process.cwd(), '.matrix-e2e');
const progressPath = join(localProfileRoot, 'progress.txt');

async function mark(stage: string): Promise<void> {
  await writeFile(progressPath, `${stage}\n`, 'utf8');
}

async function waitForValue<T>(
  page: Page,
  expression: string,
  args: unknown[] = [],
  timeout = 15_000,
): Promise<T> {
  await page.waitForFunction(
    ({ expression: source, args: values }) => {
      const getter = new Function('harness', 'args', `return (${source})(harness, ...args)`);
      return getter((window as Window & { nymphMatrixHarness?: unknown }).nymphMatrixHarness, values);
    },
    { expression, args },
    { timeout },
  );
  return page.evaluate(
    ({ expression: source, args: values }) => {
      const getter = new Function('harness', 'args', `return (${source})(harness, ...args)`);
      return getter((window as Window & { nymphMatrixHarness?: unknown }).nymphMatrixHarness, values);
    },
    { expression, args },
  ) as Promise<T>;
}

async function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  const result = page.evaluate(
    async ({ methodName, parameters }) => {
      const harness = (window as Window & {
        nymphMatrixHarness: Record<string, (...values: unknown[]) => unknown>;
      }).nymphMatrixHarness;
      return harness[methodName](...parameters);
    },
    { methodName: method, parameters: args },
  ) as Promise<T>;
  let timeoutId: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Matrix test operation timed out: ${method}.`)), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

async function queryRemoteDeviceIds(session: Session, userId: string): Promise<string[]> {
  const response = await fetch(`${matrixUrl}/_matrix/client/v3/keys/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ device_keys: { [userId]: [] } }),
  });
  if (!response.ok) throw new Error(`Matrix device-key query failed (${response.status}).`);
  const body = await response.json() as {
    device_keys?: Record<string, Record<string, unknown>>;
  };
  return Object.keys(body.device_keys?.[userId] ?? {});
}

async function openProfile(
  name: 'partner-a' | 'partner-b',
  userDataDir: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromePath,
    headless: true,
    args: ['--disable-extensions', '--no-first-run', '--no-default-browser-check'],
  });
  await mark(`${name}-browser-launched`);
  const page = await context.newPage();
  const failedResponses: string[] = [];
  page.on('pageerror', (error) => {
    console.error(`[matrix-e2e][${name}][pageerror] ${error.name}: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      console.error(`[matrix-e2e][${name}][console] ${message.text()}`);
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      const path = new URL(response.url()).pathname;
      if (
        (response.status() === 403 && path.endsWith('/_synapse/client/nymph/pairing/redeem')) ||
        (response.status() === 404 && path.endsWith('/_matrix/client/v3/room_keys/version'))
      ) return;
      const failure = `${response.status()} ${path}`;
      failedResponses.push(failure);
      console.error(`[matrix-e2e][${name}][response] ${failure}`);
    }
  });
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/_matrix/client/v3/keys/upload')) {
      const body = request.postDataJSON() as {
        device_keys?: unknown;
        one_time_keys?: Record<string, unknown>;
      };
      const deviceKeyFields = body.device_keys && typeof body.device_keys === 'object'
        ? Object.keys(body.device_keys)
        : [];
      console.info(
        `[matrix-e2e][${name}] keys/upload device_key_fields=${deviceKeyFields.join(',') || 'none'} ` +
        `one_time_key_count=${Object.keys(body.one_time_keys ?? {}).length}`,
      );
    }
  });
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname.endsWith('/_matrix/client/v3/keys/upload')) {
      const body = await response.json() as { failures?: Record<string, unknown> };
      console.info(
        `[matrix-e2e][${name}] keys/upload response status=${response.status()} ` +
        `failure_count=${Object.keys(body.failures ?? {}).length}`,
      );
    }
  });
  try {
    await page.goto('http://127.0.0.1:5174/tests/e2e/matrix-harness.html', {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });
    await mark(`${name}-harness-navigated`);
    await page.getByText('Isolated Matrix test client ready').waitFor({ timeout: 15_000 });
    await mark(`${name}-harness-ready`);
    return { context, page };
  } catch (error) {
    await mark(`${name}-harness-start-failed`);
    const status = await page.locator('#status').textContent({ timeout: 2_000 }).catch(() => null);
    const pageInfo = await page.evaluate(() => ({
      path: location.pathname,
      title: document.title,
      hasStatusNode: Boolean(document.querySelector('#status')),
      scriptCount: document.scripts.length,
    })).catch(() => null);
    await mark(`${name}-harness-status-read`);
    await context.close();
    await mark(`${name}-failed-browser-closed`);
    throw new Error(
      `The Matrix test harness did not initialize (status: ${status ?? 'unavailable'}; ` +
      `page: ${JSON.stringify(pageInfo)}; failed responses: ${failedResponses.join(', ') || 'none'}).`,
      { cause: error },
    );
  }
}

test('independent Partner A/B sessions pair, verify and exchange real encrypted Matrix events', async () => {
  test.setTimeout(180_000);
  const recoveryKeyA = process.env.NYMPH_E2E_PARTNER1_RECOVERY_KEY;
  const recoveryKeyB = process.env.NYMPH_E2E_PARTNER2_RECOVERY_KEY;
  const hasRecoveryKeyA = Boolean(recoveryKeyA?.trim());
  const hasRecoveryKeyB = Boolean(recoveryKeyB?.trim());
  console.info(
    `[matrix-e2e] Existing recovery-key variables present: Partner A=${hasRecoveryKeyA}, Partner B=${hasRecoveryKeyB}`,
  );
  if (!hasRecoveryKeyA || !hasRecoveryKeyB) {
    throw new Error(
      'Live test stopped before login: set both NYMPH_E2E_PARTNER1_RECOVERY_KEY and ' +
      'NYMPH_E2E_PARTNER2_RECOVERY_KEY to the original account recovery keys.',
    );
  }

  await mkdir(localProfileRoot, { recursive: true });
  const versions = await fetch(`${matrixUrl}/_matrix/client/versions`);
  expect(versions.status).toBe(200);
  await versions.arrayBuffer();
  await mark('synapse-ready');
  const partnerAPassword = (await readFile('backend/dev-secrets/partner1_password', 'utf8')).trim();
  const partnerBPassword = (await readFile('backend/dev-secrets/partner2_password', 'utf8')).trim();
  expect(partnerAPassword.length).toBeGreaterThan(0);
  expect(partnerBPassword.length).toBeGreaterThan(0);

  const profileA = join(localProfileRoot, 'partner-a-live-2');
  const profileB = join(localProfileRoot, 'partner-b-live-2');
  let contextA: BrowserContext | undefined;
  let contextB: BrowserContext | undefined;
  let pageA: Page;
  let pageB: Page;
  let sessionA: Session | undefined;
  let sessionB: Session | undefined;

  try {
    ({ context: contextA, page: pageA } = await openProfile('partner-a', profileA));
    await mark('partner-a-profile-ready');
    ({ context: contextB, page: pageB } = await openProfile('partner-b', profileB));
    await mark('partner-b-profile-ready');
    sessionA = await call<Session>(
      pageA,
      'passwordLogin',
      '@partner1:localhost',
      partnerAPassword,
      'NYMPH E2E Partner A',
    );
    await mark('partner-a-authenticated');
    const status = await call<{ room_id: string }>(pageA, 'roomStatus', sessionA);
    expect(status.room_id.startsWith('!')).toBeTruthy();
    sessionA.roomId = status.room_id;

    const invitation = await call<Invitation>(pageA, 'createInvitation', sessionA);
    await mark('invitation-created');
    console.info('[matrix-e2e] pairing invitation created');
    expect(Object.keys(invitation).sort()).toEqual([
      'expires_at',
      'homeserver',
      'partner_user_id',
      'room_id',
      'token',
      'version',
    ]);
    expect(invitation.partner_user_id).toBe('@partner2:localhost');
    expect(invitation.room_id).toBe(status.room_id);
    expect(invitation.token.length).toBeGreaterThanOrEqual(40);
    expect(invitation.expires_at).toBeGreaterThan(Date.now());
    sessionB = await call<Session>(pageB, 'redeemInvitation', invitation);
    await mark('partner-b-paired');
    console.info('[matrix-e2e] Partner B redeemed the one-time token');
    expect(sessionB.userId).toBe('@partner2:localhost');
    expect(sessionB.roomId).toBe(status.room_id);
    expect(sessionB.deviceId).not.toBe(sessionA.deviceId);
    expect(await call<number>(pageB, 'replayInvitation', invitation)).toBe(403);

    const storageKeyA = Array.from(scryptSync(partnerAPassword, 'nymph-matrix-e2e-partner1-v1', 32));
    const storageKeyB = Array.from(scryptSync(partnerBPassword, 'nymph-matrix-e2e-partner2-v1', 32));
    await call(pageA, 'connect', sessionA, storageKeyA);
    await mark('partner-a-encrypted-sync');
    console.info('[matrix-e2e] Partner A completed encrypted sync');
    await call(pageB, 'connect', sessionB, storageKeyB);
    await mark('partner-b-encrypted-sync');
    console.info('[matrix-e2e] Partner B completed encrypted sync');
    if (!sessionB.deviceId) throw new Error('Partner B login did not return a device ID.');
    const remoteDeviceIds = await queryRemoteDeviceIds(sessionA, sessionB.userId);
    const ownDeviceIds = await queryRemoteDeviceIds(sessionB, sessionB.userId);
    console.info(
      `[matrix-e2e] Synapse reports ${remoteDeviceIds.length} Partner B devices to A and ` +
      `${ownDeviceIds.length} to B; target present=${remoteDeviceIds.includes(sessionB.deviceId)}`,
    );
    const unlockResults = await Promise.allSettled([
      call<string>(pageA, 'unlockExistingSecretStorage', recoveryKeyA, partnerAPassword),
      call<string>(pageB, 'unlockExistingSecretStorage', recoveryKeyB, partnerBPassword),
    ]);
    const unlockedA = unlockResults[0].status === 'fulfilled';
    const unlockedB = unlockResults[1].status === 'fulfilled';
    console.info(
      `[matrix-e2e] Existing Secret Storage decrypted: Partner A=${unlockedA}, Partner B=${unlockedB}`,
    );
    if (!unlockedA || !unlockedB) {
      const failedPartners = [
        ...(!unlockedA ? ['Partner A'] : []),
        ...(!unlockedB ? ['Partner B'] : []),
      ];
      throw new Error(
        `${failedPartners.join(' and ')} could not unlock existing Secret Storage; ` +
        'cross-signing bootstrap was not attempted.',
      );
    }

    const securityA = await call<{ crossSigningReady: boolean }>(pageA, 'refreshSecurity');
    const securityB = await call<{ crossSigningReady: boolean }>(pageB, 'refreshSecurity');
    expect(securityA.crossSigningReady).toBe(true);
    console.info('[matrix-e2e] Partner A existing cross-signing identity restored');
    expect(securityB.crossSigningReady).toBe(true);
    console.info('[matrix-e2e] Partner B existing cross-signing identity restored');
    await mark('cross-signing-ready');
    const recoveryVerification = await Promise.all([
      call<string>(pageA, 'verifyRecoveryOnSeparateDevice', recoveryKeyA, partnerAPassword),
      call<string>(pageB, 'verifyRecoveryOnSeparateDevice', recoveryKeyB, partnerBPassword),
    ]);
    expect(recoveryVerification.every(Boolean)).toBe(true);
    console.info('[matrix-e2e] Both recovery keys restored the existing identities on separate temporary devices');
    await mark('separate-device-recovery-verified');

    await expect(call(pageA, 'send', {
      version: 1,
      id: randomUUID(),
      mode: 'romantic',
      kind: 'text',
      text: 'Must not send before verification',
      sentAt: Date.now(),
    })).rejects.toThrow(/Verify your partner/);

    const partnerDevices = await call<{ partnerDevices: Array<{ deviceId: string; verified: boolean }> }>(
      pageA,
      'refreshSecurity',
    );
    console.info(
      `[matrix-e2e] Partner A sees ${partnerDevices.partnerDevices.length} Partner B devices; ` +
      `target is present=${partnerDevices.partnerDevices.some((device) => device.deviceId === sessionB.deviceId)}`,
    );
    await call(pageA, 'requestPartnerVerification', sessionB.deviceId);
    const incoming = await waitForValue<{ id: string }>(
      pageB,
      'h => h.getVerifications().find(item => item.userId === "@partner1:localhost" && item.phase === "Requested")',
    );
    await call(pageB, 'acceptVerification', incoming.id);
    const outgoing = await waitForValue<{ id: string }>(
      pageA,
      'h => h.getVerifications().find(item => item.userId === "@partner2:localhost")',
    );
    await call(pageA, 'startSasVerification', outgoing.id);
    await call(pageB, 'startSasVerification', incoming.id);
    const sasA = await waitForValue<{ emoji?: [string, string][]; decimal?: [number, number, number] }>(
      pageA,
      'h => h.getVerifications().find(item => item.id === args[0])?.sas',
      [outgoing.id],
    );
    const sasB = await waitForValue<{ emoji?: [string, string][]; decimal?: [number, number, number] }>(
      pageB,
      'h => h.getVerifications().find(item => item.id === args[0])?.sas',
      [incoming.id],
    );
    expect(sasA).toEqual(sasB);
    expect(Boolean(sasA.emoji?.length || sasA.decimal?.length)).toBeTruthy();
    await call(pageA, 'confirmSas', outgoing.id);
    await call(pageB, 'confirmSas', incoming.id);
    await mark('sas-confirmed');
    console.info('[matrix-e2e] matching SAS confirmed on both independent clients');
    await waitForValue<boolean>(pageA, 'h => h.getSecurity()?.partnerVerified');
    await waitForValue<boolean>(pageB, 'h => h.getSecurity()?.partnerVerified');

    const sentIds: string[] = [];
    for (const mode of ['romantic', 'flirty', 'spicy', 'kinky'] as const) {
      const id = randomUUID();
      sentIds.push(id);
      await call(pageA, 'send', {
        version: 1, id, mode, kind: 'text',
        text: `Encrypted ${mode} test ${id}`, sentAt: Date.now(),
      });
      await waitForValue(pageB, 'h => h.getEvents().some(event => event.id === args[0])', [id]);
    }
    const messageEvents = await call<Array<{ id: string; mode: string }>>(pageB, 'getEvents');
    expect(sentIds.map((id) => messageEvents.find((item) => item.id === id)?.mode))
      .toEqual(['romantic', 'flirty', 'spicy', 'kinky']);
    await mark('four-modes-decrypted');

    const replyId = randomUUID();
    const replyEventId = await call<string>(pageB, 'send', {
      version: 1, id: replyId, mode: 'romantic', kind: 'text',
      text: 'Partner B reply', sentAt: Date.now(),
      replyTo: `Encrypted romantic test ${sentIds[0]}`,
      replyToEventId: messageEvents.find((item) => item.id === sentIds[0])?.eventId,
    });
    await waitForValue(pageA, 'h => h.getEvents().some(event => event.id === args[0])', [replyId]);
    const reactionId = randomUUID();
    const reactionTarget = messageEvents.find((item) => item.id === sentIds[0]);
    expect(reactionTarget?.eventId).toBeTruthy();
    await call(pageB, 'send', {
      version: 1, id: reactionId, mode: 'romantic', kind: 'reaction',
      text: '❤️', sentAt: Date.now(), reactionTo: reactionTarget?.eventId,
    });
    await waitForValue(pageA, 'h => h.getEvents().some(event => event.id === args[0])', [reactionId]);

    await call(pageB, 'setTyping', true);
    await waitForValue<boolean>(pageA, 'h => h.getTyping()');
    await call(pageB, 'setTyping', false);
    await call(pageB, 'markRead', reactionTarget!.eventId);
    await waitForValue(pageA, 'h => h.getReadEventIds().includes(args[0])', [reactionTarget!.eventId]);
    await mark('reactions-typing-receipts-passed');

    await call(pageB, 'disconnect');
    const offlineId = randomUUID();
    await call(pageA, 'send', {
      version: 1, id: offlineId, mode: 'flirty', kind: 'text',
      text: `Offline queue test ${offlineId}`, sentAt: Date.now(),
    });
    await call(pageB, 'connect', sessionB, storageKeyB);
    await waitForValue(pageB, 'h => h.getEvents().some(event => event.id === args[0])', [offlineId]);
    await mark('offline-delivery-passed');

    await contextB.close();
    contextB = undefined;
    const restartedB = await openProfile('partner-b', profileB);
    contextB = restartedB.context;
    pageB = restartedB.page;
    await call(pageB, 'connect', sessionB, storageKeyB);
    await call(pageB, 'unlockExistingSecretStorage', recoveryKeyB, partnerBPassword);
    await waitForValue(pageB, 'h => h.getEvents().some(event => event.id === args[0])', [replyId]);
    const afterRestart = await call<Array<{ id: string }>>(pageB, 'getEvents');
    expect(afterRestart.some((event) => event.id === replyId)).toBeTruthy();
    await mark('profile-restart-recovery-passed');

    const secondDevice = await call<Session>(
      pageA,
      'passwordLogin',
      '@partner1:localhost',
      partnerAPassword,
      'NYMPH revocation test device',
    );
    expect(secondDevice.deviceId).not.toBe(sessionA.deviceId);
    await call(pageA, 'revokeDevice', secondDevice.deviceId, partnerAPassword);
    const revokedResponse = await fetch(`${matrixUrl}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${secondDevice.accessToken}` },
    });
    expect([401, 403]).toContain(revokedResponse.status);
    await revokedResponse.arrayBuffer();
    await mark('revocation-passed');

  } finally {
    await mark('closing-test-clients');
    await contextA?.close();
    await mark('partner-a-context-closed');
    await contextB?.close();
    await mark('partner-b-context-closed');
    for (const session of [sessionA, sessionB]) {
      if (session?.accessToken) {
        const response = await fetch(`${matrixUrl}/_matrix/client/v3/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.accessToken}` },
        });
        if (!response.ok) throw new Error(`Could not log out Matrix test session (${response.status}).`);
        await response.arrayBuffer();
      }
    }
    await mark('sessions-logged-out');
  }
});
