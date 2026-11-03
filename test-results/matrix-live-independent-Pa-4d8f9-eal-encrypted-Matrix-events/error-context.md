# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: matrix-live.spec.ts >> independent Partner A/B sessions pair, verify and exchange real encrypted Matrix events
- Location: tests\e2e\matrix-live.spec.ts:79:1

# Error details

```
Error: page.evaluate: TypeError: Failed to execute 'compile' on 'WebAssembly': Incorrect response MIME type. Expected 'application/wasm'.
```

# Test source

```ts
  1   | import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
  2   | import { createHash, randomUUID } from 'node:crypto';
  3   | import { mkdtemp, readFile, rm } from 'node:fs/promises';
  4   | import { tmpdir } from 'node:os';
  5   | import { join } from 'node:path';
  6   | 
  7   | type Session = {
  8   |   homeserver: string;
  9   |   userId: string;
  10  |   partnerUserId: string;
  11  |   accessToken: string;
  12  |   roomId: string;
  13  |   deviceId?: string;
  14  | };
  15  | 
  16  | type Invitation = {
  17  |   version: 1;
  18  |   token: string;
  19  |   room_id: string;
  20  |   partner_user_id: string;
  21  |   expires_at: number;
  22  | };
  23  | 
  24  | const chromePath = process.env.NYMPH_CHROME_PATH ??
  25  |   'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  26  | const matrixUrl = 'http://127.0.0.1:8008';
  27  | async function waitForValue<T>(
  28  |   page: Page,
  29  |   expression: string,
  30  |   args: unknown[] = [],
  31  |   timeout = 30_000,
  32  | ): Promise<T> {
  33  |   await page.waitForFunction(
  34  |     ({ expression: source, args: values }) => {
  35  |       const getter = new Function('harness', 'args', `return (${source})(harness, ...args)`);
  36  |       return getter((window as Window & { nymphMatrixHarness?: unknown }).nymphMatrixHarness, values);
  37  |     },
  38  |     { expression, args },
  39  |     { timeout },
  40  |   );
  41  |   return page.evaluate(
  42  |     ({ expression: source, args: values }) => {
  43  |       const getter = new Function('harness', 'args', `return (${source})(harness, ...args)`);
  44  |       return getter((window as Window & { nymphMatrixHarness?: unknown }).nymphMatrixHarness, values);
  45  |     },
  46  |     { expression, args },
  47  |   ) as Promise<T>;
  48  | }
  49  | 
  50  | async function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
> 51  |   return page.evaluate(
      |               ^ Error: page.evaluate: TypeError: Failed to execute 'compile' on 'WebAssembly': Incorrect response MIME type. Expected 'application/wasm'.
  52  |     async ({ methodName, parameters }) => {
  53  |       const harness = (window as Window & {
  54  |         nymphMatrixHarness: Record<string, (...values: unknown[]) => unknown>;
  55  |       }).nymphMatrixHarness;
  56  |       return harness[methodName](...parameters);
  57  |     },
  58  |     { methodName: method, parameters: args },
  59  |   ) as Promise<T>;
  60  | }
  61  | 
  62  | async function openProfile(userDataDir: string, recoveryKey?: string): Promise<{ context: BrowserContext; page: Page }> {
  63  |   const context = await chromium.launchPersistentContext(userDataDir, {
  64  |     executablePath: chromePath,
  65  |     headless: true,
  66  |     args: ['--disable-extensions', '--no-first-run', '--no-default-browser-check'],
  67  |   });
  68  |   if (recoveryKey) {
  69  |     await context.addInitScript((key) => {
  70  |       (window as Window & { __nymphRecoveryKey?: string }).__nymphRecoveryKey = key;
  71  |     }, recoveryKey);
  72  |   }
  73  |   const page = await context.newPage();
  74  |   await page.goto('http://localhost:5173/tests/e2e/matrix-harness.html');
  75  |   await page.getByText('Isolated Matrix test client ready').waitFor();
  76  |   return { context, page };
  77  | }
  78  | 
  79  | test('independent Partner A/B sessions pair, verify and exchange real encrypted Matrix events', async () => {
  80  |   test.setTimeout(300_000);
  81  |   const versions = await fetch(`${matrixUrl}/_matrix/client/versions`);
  82  |   expect(versions.status).toBe(200);
  83  |   const partnerAPassword = (await readFile('backend/dev-secrets/partner1_password', 'utf8')).trim();
  84  |   const partnerBPassword = (await readFile('backend/dev-secrets/partner2_password', 'utf8')).trim();
  85  |   expect(partnerAPassword.length).toBeGreaterThan(0);
  86  |   expect(partnerBPassword.length).toBeGreaterThan(0);
  87  | 
  88  |   const profileA = await mkdtemp(join(tmpdir(), 'nymph-partner-a-'));
  89  |   const profileB = await mkdtemp(join(tmpdir(), 'nymph-partner-b-'));
  90  |   let contextA: BrowserContext | undefined;
  91  |   let contextB: BrowserContext | undefined;
  92  |   let pageA: Page;
  93  |   let pageB: Page;
  94  | 
  95  |   try {
  96  |     ({ context: contextA, page: pageA } = await openProfile(profileA));
  97  |     ({ context: contextB, page: pageB } = await openProfile(profileB));
  98  |     const sessionA = await call<Session>(pageA, 'passwordLogin', '@partner1:localhost', partnerAPassword, 'NYMPH E2E Partner A');
  99  |     const status = await call<{ room_id: string }>(pageA, 'roomStatus', sessionA);
  100 |     expect(status.room_id.startsWith('!')).toBeTruthy();
  101 |     sessionA.roomId = status.room_id;
  102 | 
  103 |     const invitation = await call<Invitation>(pageA, 'createInvitation', sessionA);
  104 |     expect(Object.keys(invitation).sort()).toEqual([
  105 |       'expires_at',
  106 |       'homeserver',
  107 |       'partner_user_id',
  108 |       'room_id',
  109 |       'token',
  110 |       'version',
  111 |     ]);
  112 |     expect(invitation.partner_user_id).toBe('@partner2:localhost');
  113 |     expect(invitation.room_id).toBe(status.room_id);
  114 |     expect(invitation.token.length).toBeGreaterThanOrEqual(40);
  115 |     expect(invitation.expires_at).toBeGreaterThan(Date.now());
  116 |     const sessionB = await call<Session>(pageB, 'redeemInvitation', invitation);
  117 |     expect(sessionB.userId).toBe('@partner2:localhost');
  118 |     expect(sessionB.roomId).toBe(status.room_id);
  119 |     expect(sessionB.deviceId).not.toBe(sessionA.deviceId);
  120 |     expect(await call<number>(pageB, 'replayInvitation', invitation)).toBe(403);
  121 | 
  122 |     await call(pageA, 'connect', sessionA);
  123 |     await call(pageB, 'connect', sessionB);
  124 |     const recoveryA = await call<string>(pageA, 'bootstrapSecurity', partnerAPassword);
  125 |     const recoveryB = await call<string>(pageB, 'bootstrapSecurity', partnerBPassword);
  126 |     expect(await waitForValue<boolean>(pageA, 'h => h.getSecurity()?.crossSigningReady')).toBe(true);
  127 |     expect(await waitForValue<boolean>(pageB, 'h => h.getSecurity()?.crossSigningReady')).toBe(true);
  128 | 
  129 |     await expect(call(pageA, 'send', {
  130 |       version: 1,
  131 |       id: randomUUID(),
  132 |       mode: 'romantic',
  133 |       kind: 'text',
  134 |       text: 'Must not send before verification',
  135 |       sentAt: Date.now(),
  136 |     })).rejects.toThrow(/Verify your partner/);
  137 | 
  138 |     await call(pageA, 'requestPartnerVerification');
  139 |     const incoming = await waitForValue<{ id: string }>(
  140 |       pageB,
  141 |       'h => h.getVerifications().find(item => item.userId === "@partner1:localhost" && item.phase === "Requested")',
  142 |     );
  143 |     await call(pageB, 'acceptVerification', incoming.id);
  144 |     const outgoing = await waitForValue<{ id: string }>(
  145 |       pageA,
  146 |       'h => h.getVerifications().find(item => item.userId === "@partner2:localhost")',
  147 |     );
  148 |     await call(pageA, 'startSasVerification', outgoing.id);
  149 |     await call(pageB, 'startSasVerification', incoming.id);
  150 |     const sasA = await waitForValue<{ emoji?: [string, string][]; decimal?: [number, number, number] }>(
  151 |       pageA,
```