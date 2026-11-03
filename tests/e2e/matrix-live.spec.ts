import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
async function waitForValue<T>(
  page: Page,
  expression: string,
  args: unknown[] = [],
  timeout = 30_000,
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
        timeoutId = setTimeout(() => reject(new Error(`Matrix test operation timed out: ${method}.`)), 60_000);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

async function openProfile(userDataDir: string, recoveryKey?: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromePath,
    headless: true,
    args: ['--disable-extensions', '--no-first-run', '--no-default-browser-check'],
  });
  if (recoveryKey) {
    await context.addInitScript((key) => {
      (window as Window & { __nymphRecoveryKey?: string }).__nymphRecoveryKey = key;
    }, recoveryKey);
  }
  const page = await context.newPage();
  await page.goto('http://localhost:5173/matrix-harness.html');
  await page.getByText('Isolated Matrix test client ready').waitFor();
  return { context, page };
}

test('independent Partner A/B sessions pair, verify and exchange real encrypted Matrix events', async () => {
  test.setTimeout(300_000);
  const versions = await fetch(`${matrixUrl}/_matrix/client/versions`);
  expect(versions.status).toBe(200);
  const partnerAPassword = (await readFile('backend/dev-secrets/partner1_password', 'utf8')).trim();
  const partnerBPassword = (await readFile('backend/dev-secrets/partner2_password', 'utf8')).trim();
  expect(partnerAPassword.length).toBeGreaterThan(0);
  expect(partnerBPassword.length).toBeGreaterThan(0);

  const profileA = await mkdtemp(join(tmpdir(), 'nymph-partner-a-'));
  const profileB = await mkdtemp(join(tmpdir(), 'nymph-partner-b-'));
  let contextA: BrowserContext | undefined;
  let contextB: BrowserContext | undefined;
  let pageA: Page;
  let pageB: Page;

  try {
    ({ context: contextA, page: pageA } = await openProfile(profileA));
    ({ context: contextB, page: pageB } = await openProfile(profileB));
    const sessionA = await call<Session>(pageA, 'passwordLogin', '@partner1:localhost', partnerAPassword, 'NYMPH E2E Partner A');
    const status = await call<{ room_id: string }>(pageA, 'roomStatus', sessionA);
    expect(status.room_id.startsWith('!')).toBeTruthy();
    sessionA.roomId = status.room_id;

    const invitation = await call<Invitation>(pageA, 'createInvitation', sessionA);
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
    const sessionB = await call<Session>(pageB, 'redeemInvitation', invitation);
    console.info('[matrix-e2e] Partner B redeemed the one-time token');
    expect(sessionB.userId).toBe('@partner2:localhost');
    expect(sessionB.roomId).toBe(status.room_id);
    expect(sessionB.deviceId).not.toBe(sessionA.deviceId);
    expect(await call<number>(pageB, 'replayInvitation', invitation)).toBe(403);

    await call(pageA, 'connect', sessionA);
    console.info('[matrix-e2e] Partner A completed encrypted sync');
    await call(pageB, 'connect', sessionB);
    console.info('[matrix-e2e] Partner B completed encrypted sync');
    const recoveryA = await call<string>(pageA, 'bootstrapSecurity', partnerAPassword);
    const recoveryB = await call<string>(pageB, 'bootstrapSecurity', partnerBPassword);
    console.info('[matrix-e2e] cross-signing bootstrap completed');
    expect(await waitForValue<boolean>(pageA, 'h => h.getSecurity()?.crossSigningReady')).toBe(true);
    expect(await waitForValue<boolean>(pageB, 'h => h.getSecurity()?.crossSigningReady')).toBe(true);

    await expect(call(pageA, 'send', {
      version: 1,
      id: randomUUID(),
      mode: 'romantic',
      kind: 'text',
      text: 'Must not send before verification',
      sentAt: Date.now(),
    })).rejects.toThrow(/Verify your partner/);

    await call(pageA, 'requestPartnerVerification');
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

    await call(pageB, 'disconnect');
    const offlineId = randomUUID();
    await call(pageA, 'send', {
      version: 1, id: offlineId, mode: 'flirty', kind: 'text',
      text: `Offline queue test ${offlineId}`, sentAt: Date.now(),
    });
    await call(pageB, 'connect', sessionB);
    await waitForValue(pageB, 'h => h.getEvents().some(event => event.id === args[0])', [offlineId]);

    await contextB.close();
    contextB = undefined;
    const restartedB = await openProfile(profileB, recoveryB);
    contextB = restartedB.context;
    pageB = restartedB.page;
    await call(pageB, 'connect', sessionB);
    await waitForValue(pageB, 'h => h.getEvents().some(event => event.id === args[0])', [replyId]);
    const afterRestart = await call<Array<{ id: string }>>(pageB, 'getEvents');
    expect(afterRestart.some((event) => event.id === replyId)).toBeTruthy();

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

    expect(createHash('sha256').update(recoveryA).digest('hex')).not.toBe(
      createHash('sha256').update(recoveryB).digest('hex'),
    );
  } finally {
    await contextA?.close();
    await contextB?.close();
    await rm(profileA, { recursive: true, force: true });
    await rm(profileB, { recursive: true, force: true });
  }
});
