import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID, scryptSync } from 'node:crypto';
import { join } from 'node:path';
import { loadIsolatedMatrixConfig } from './matrix-runtime-config.mjs';

const config = loadIsolatedMatrixConfig();
if (!config.disposable || !config.passwordA || !config.passwordB) {
  throw new Error('Disposable Matrix tests require NYMPH_DISPOSABLE_MATRIX=1 and two password variables.');
}
const chromePath = process.env.NYMPH_CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profileRoot = join(process.cwd(), '.matrix-e2e', `disposable-${Date.now()}`);
const harnessUrl = 'http://127.0.0.1:5174/tests/e2e/matrix-harness.html';

async function call<T>(page: Page, method: string, ...parameters: unknown[]): Promise<T> {
  return page.evaluate(
    async ({ methodName, args }) => {
      const harness = (window as Window & { nymphMatrixHarness?: Record<string, (...values: unknown[]) => unknown> }).nymphMatrixHarness;
      if (!harness || typeof harness[methodName] !== 'function') throw new Error(`Missing harness operation: ${methodName}`);
      return harness[methodName](...args);
    },
    { methodName: method, args: parameters },
  ) as Promise<T>;
}

async function waitForEvent(page: Page, eventId: string): Promise<void> {
  await page.waitForFunction(
    (id) => Boolean((window as Window & { nymphMatrixHarness?: { getEvents(): Array<{ eventId: string }> } }).nymphMatrixHarness
      ?.getEvents().some((event) => event.eventId === id)),
    eventId,
    { timeout: 120_000 },
  );
}

function storageKey(password: string, userId: string): number[] {
  const key = scryptSync(password, `nymph-disposable:${userId}`, 32);
  try { return Array.from(key); } finally { key.fill(0); }
}

async function openProfile(name: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(join(profileRoot, name), {
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await context.newPage();
  await page.goto(harnessUrl, { waitUntil: 'domcontentloaded' });
  await page.getByText('Isolated Matrix test client ready').waitFor();
  return { context, page };
}

test('disposable accounts pair, verify, exchange encrypted history, and reject invalid access', async () => {
  test.setTimeout(1_200_000);
  let contextA: BrowserContext | undefined;
  let contextB: BrowserContext | undefined;
  let pageA: Page | undefined;
  let pageB: Page | undefined;
  const passwordA = config.passwordA!;
  const passwordB = config.passwordB!;
  const deviceA = `DISPOSABLE_A_${randomUUID().replaceAll('-', '')}`;
  const deviceB = `DISPOSABLE_B_${randomUUID().replaceAll('-', '')}`;
  try {
    ({ context: contextA, page: pageA } = await openProfile('partner-a'));
    ({ context: contextB, page: pageB } = await openProfile('partner-b'));
    const sessionA = await call<{ userId: string; accessToken: string; deviceId: string; roomId: string }>(
      pageA, 'passwordLogin', config.partnerA, passwordA, 'Disposable integration A', deviceA,
    );
    const connectionA = { ...sessionA, partnerUserId: config.partnerB, roomId: '' };
    const created = await call<{ room_id: string }>(pageA, 'createRoom', connectionA);
    expect(created.room_id).toMatch(/^!/);
    connectionA.roomId = created.room_id;
    await call(pageA, 'connect', connectionA, storageKey(passwordA, config.partnerA));
    const invitation = await call<Record<string, unknown>>(pageA, 'createInvitation', connectionA);
    const qrText = await call<string>(pageA, 'encodeInvitationQr', invitation);
    expect(JSON.parse(qrText)).toMatchObject({ room_id: created.room_id, partner_user_id: config.partnerB });

    const sessionB = await call<{ userId: string; accessToken: string; deviceId: string; roomId: string }>(
      pageB, 'redeemInvitation', qrText, deviceB,
    );
    expect(sessionB.userId).toBe(config.partnerB);
    expect(sessionB.roomId).toBe(created.room_id);
    await call(pageB, 'connect', sessionB, storageKey(passwordB, config.partnerB));
    const members = await call<string[]>(pageA, 'joinedMembers', connectionA, created.room_id);
    expect(members).toEqual([config.partnerA, config.partnerB].sort());
    expect(await call<number>(pageA, 'inviteStatus', sessionA, created.room_id, '@unauthorized:nymph-dev.localhost')).toBe(403);
    // Pairing redemption is deliberately indistinguishable from an authorization
    // failure after the single-use token has been consumed.
    expect(await call<number>(pageA, 'replayInvitation', invitation)).toBe(403);
    await expect(call(pageB, 'redeemInvitation', JSON.stringify({ token: 'malformed', homeserver: config.homeserverUrl }))).rejects.toThrow();

    for (const [page, password] of [[pageA, passwordA], [pageB, passwordB]] as const) {
      const recoveryKey = await call<string>(page, 'prepareSecretStorageSetup');
      expect(recoveryKey).toMatch(/^Es/);
      await call(page, 'commitSecretStorageSetup', recoveryKey);
      await call(page, 'bootstrapSecurity', password);
    }
    await call(pageA, 'requestPartnerVerification', sessionB.deviceId);
    const incoming = await pageB.waitForFunction(
      (userId) => (window as Window & { nymphMatrixHarness?: { getVerifications(): Array<{ id: string; userId: string; phase: string }> } }).nymphMatrixHarness
        ?.getVerifications().find((item) => item.userId === userId && item.phase === 'Requested'),
      config.partnerA,
      { timeout: 120_000 },
    ).then((handle) => handle.jsonValue()) as { id: string };
    await call(pageB, 'acceptVerification', incoming.id);
    const outgoing = await pageA.waitForFunction(
      (userId) => (window as Window & { nymphMatrixHarness?: { getVerifications(): Array<{ id: string; userId: string; phase: string }> } }).nymphMatrixHarness
        ?.getVerifications().find((item) => item.userId === userId && item.phase !== 'Requested'),
      config.partnerB,
      { timeout: 120_000 },
    ).then((handle) => handle.jsonValue()) as { id: string };
    await call(pageA, 'startSasVerification', outgoing.id);
    await pageA.waitForTimeout(1000);
    const sasA = await call(pageA, 'getVerifications');
    const sasB = await call(pageB, 'getVerifications');
    expect(JSON.stringify(sasA)).toContain('emoji');
    expect(JSON.stringify(sasB)).toContain('emoji');
    await call(pageA, 'confirmSas', outgoing.id);
    await call(pageB, 'confirmSas', incoming.id);
    await pageA.waitForFunction(() => Boolean((window as Window & { nymphMatrixHarness?: { getSecurity(): { partnerVerified?: boolean } } }).nymphMatrixHarness?.getSecurity()?.partnerVerified));
    await pageB.waitForFunction(() => Boolean((window as Window & { nymphMatrixHarness?: { getSecurity(): { partnerVerified?: boolean } } }).nymphMatrixHarness?.getSecurity()?.partnerVerified));

    const first = await call<string>(pageA, 'send', {
      version: 1,
      id: randomUUID(),
      mode: 'romantic',
      kind: 'text',
      text: 'disposable encrypted A',
      sentAt: Date.now(),
      retentionPolicy: { seconds: 86_400 },
    });
    await waitForEvent(pageB, first);
    expect(await call(pageB, 'encryptionEvidence', first)).toMatchObject({ eventType: 'm.room.encrypted', hasCiphertext: true, algorithm: 'm.megolm.v1.aes-sha2' });
    await call(pageB, 'markRead', first);
    const reply = await call<string>(pageB, 'send', { version: 1, id: randomUUID(), mode: 'romantic', kind: 'text', text: 'disposable encrypted B', sentAt: Date.now(), replyToEventId: first });
    await waitForEvent(pageA, reply);
    const reaction = await call<string>(pageA, 'send', { version: 1, id: randomUUID(), mode: 'romantic', kind: 'reaction', text: '❤️', sentAt: Date.now(), reactionTo: reply });
    await waitForEvent(pageB, reaction);
    expect(await call<string[]>(pageA, 'getReadEventIds')).toContain(first);
  } finally {
    await pageA && call(pageA, 'disconnect').catch(() => undefined);
    await pageB && call(pageB, 'disconnect').catch(() => undefined);
    await contextA?.close();
    await contextB?.close();
  }
});
