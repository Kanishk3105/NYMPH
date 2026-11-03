# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: matrix-live.spec.ts >> independent Partner A/B sessions pair, verify and exchange real encrypted Matrix events
- Location: tests\e2e\matrix-live.spec.ts:180:1

# Error details

```
Error: Live test stopped before login: set both NYMPH_E2E_PARTNER1_RECOVERY_KEY and NYMPH_E2E_PARTNER2_RECOVERY_KEY to the original account recovery keys.
```

# Test source

```ts
  90  |     device_keys?: Record<string, Record<string, unknown>>;
  91  |   };
  92  |   return Object.keys(body.device_keys?.[userId] ?? {});
  93  | }
  94  | 
  95  | async function openProfile(
  96  |   name: 'partner-a' | 'partner-b',
  97  |   userDataDir: string,
  98  | ): Promise<{ context: BrowserContext; page: Page }> {
  99  |   const context = await chromium.launchPersistentContext(userDataDir, {
  100 |     executablePath: chromePath,
  101 |     headless: true,
  102 |     args: ['--disable-extensions', '--no-first-run', '--no-default-browser-check'],
  103 |   });
  104 |   await mark(`${name}-browser-launched`);
  105 |   const page = await context.newPage();
  106 |   const failedResponses: string[] = [];
  107 |   page.on('pageerror', (error) => {
  108 |     console.error(`[matrix-e2e][${name}][pageerror] ${error.name}: ${error.message}`);
  109 |   });
  110 |   page.on('console', (message) => {
  111 |     if (message.type() === 'error') {
  112 |       console.error(`[matrix-e2e][${name}][console] ${message.text()}`);
  113 |     }
  114 |   });
  115 |   page.on('response', (response) => {
  116 |     if (response.status() >= 400) {
  117 |       const path = new URL(response.url()).pathname;
  118 |       if (
  119 |         (response.status() === 403 && path.endsWith('/_synapse/client/nymph/pairing/redeem')) ||
  120 |         (response.status() === 404 && path.endsWith('/_matrix/client/v3/room_keys/version'))
  121 |       ) return;
  122 |       const failure = `${response.status()} ${path}`;
  123 |       failedResponses.push(failure);
  124 |       console.error(`[matrix-e2e][${name}][response] ${failure}`);
  125 |     }
  126 |   });
  127 |   page.on('request', (request) => {
  128 |     if (new URL(request.url()).pathname.endsWith('/_matrix/client/v3/keys/upload')) {
  129 |       const body = request.postDataJSON() as {
  130 |         device_keys?: unknown;
  131 |         one_time_keys?: Record<string, unknown>;
  132 |       };
  133 |       const deviceKeyFields = body.device_keys && typeof body.device_keys === 'object'
  134 |         ? Object.keys(body.device_keys)
  135 |         : [];
  136 |       console.info(
  137 |         `[matrix-e2e][${name}] keys/upload device_key_fields=${deviceKeyFields.join(',') || 'none'} ` +
  138 |         `one_time_key_count=${Object.keys(body.one_time_keys ?? {}).length}`,
  139 |       );
  140 |     }
  141 |   });
  142 |   page.on('response', async (response) => {
  143 |     if (new URL(response.url()).pathname.endsWith('/_matrix/client/v3/keys/upload')) {
  144 |       const body = await response.json() as { failures?: Record<string, unknown> };
  145 |       console.info(
  146 |         `[matrix-e2e][${name}] keys/upload response status=${response.status()} ` +
  147 |         `failure_count=${Object.keys(body.failures ?? {}).length}`,
  148 |       );
  149 |     }
  150 |   });
  151 |   try {
  152 |     await page.goto('http://127.0.0.1:5174/tests/e2e/matrix-harness.html', {
  153 |       waitUntil: 'domcontentloaded',
  154 |       timeout: 15_000,
  155 |     });
  156 |     await mark(`${name}-harness-navigated`);
  157 |     await page.getByText('Isolated Matrix test client ready').waitFor({ timeout: 15_000 });
  158 |     await mark(`${name}-harness-ready`);
  159 |     return { context, page };
  160 |   } catch (error) {
  161 |     await mark(`${name}-harness-start-failed`);
  162 |     const status = await page.locator('#status').textContent({ timeout: 2_000 }).catch(() => null);
  163 |     const pageInfo = await page.evaluate(() => ({
  164 |       path: location.pathname,
  165 |       title: document.title,
  166 |       hasStatusNode: Boolean(document.querySelector('#status')),
  167 |       scriptCount: document.scripts.length,
  168 |     })).catch(() => null);
  169 |     await mark(`${name}-harness-status-read`);
  170 |     await context.close();
  171 |     await mark(`${name}-failed-browser-closed`);
  172 |     throw new Error(
  173 |       `The Matrix test harness did not initialize (status: ${status ?? 'unavailable'}; ` +
  174 |       `page: ${JSON.stringify(pageInfo)}; failed responses: ${failedResponses.join(', ') || 'none'}).`,
  175 |       { cause: error },
  176 |     );
  177 |   }
  178 | }
  179 | 
  180 | test('independent Partner A/B sessions pair, verify and exchange real encrypted Matrix events', async () => {
  181 |   test.setTimeout(180_000);
  182 |   const recoveryKeyA = process.env.NYMPH_E2E_PARTNER1_RECOVERY_KEY;
  183 |   const recoveryKeyB = process.env.NYMPH_E2E_PARTNER2_RECOVERY_KEY;
  184 |   const hasRecoveryKeyA = Boolean(recoveryKeyA?.trim());
  185 |   const hasRecoveryKeyB = Boolean(recoveryKeyB?.trim());
  186 |   console.info(
  187 |     `[matrix-e2e] Existing recovery-key variables present: Partner A=${hasRecoveryKeyA}, Partner B=${hasRecoveryKeyB}`,
  188 |   );
  189 |   if (!hasRecoveryKeyA || !hasRecoveryKeyB) {
> 190 |     throw new Error(
      |           ^ Error: Live test stopped before login: set both NYMPH_E2E_PARTNER1_RECOVERY_KEY and NYMPH_E2E_PARTNER2_RECOVERY_KEY to the original account recovery keys.
  191 |       'Live test stopped before login: set both NYMPH_E2E_PARTNER1_RECOVERY_KEY and ' +
  192 |       'NYMPH_E2E_PARTNER2_RECOVERY_KEY to the original account recovery keys.',
  193 |     );
  194 |   }
  195 | 
  196 |   await mkdir(localProfileRoot, { recursive: true });
  197 |   const versions = await fetch(`${matrixUrl}/_matrix/client/versions`);
  198 |   expect(versions.status).toBe(200);
  199 |   await versions.arrayBuffer();
  200 |   await mark('synapse-ready');
  201 |   const partnerAPassword = (await readFile('backend/dev-secrets/partner1_password', 'utf8')).trim();
  202 |   const partnerBPassword = (await readFile('backend/dev-secrets/partner2_password', 'utf8')).trim();
  203 |   expect(partnerAPassword.length).toBeGreaterThan(0);
  204 |   expect(partnerBPassword.length).toBeGreaterThan(0);
  205 | 
  206 |   const profileA = join(localProfileRoot, 'partner-a-live-2');
  207 |   const profileB = join(localProfileRoot, 'partner-b-live-2');
  208 |   let contextA: BrowserContext | undefined;
  209 |   let contextB: BrowserContext | undefined;
  210 |   let pageA: Page;
  211 |   let pageB: Page;
  212 |   let sessionA: Session | undefined;
  213 |   let sessionB: Session | undefined;
  214 | 
  215 |   try {
  216 |     ({ context: contextA, page: pageA } = await openProfile('partner-a', profileA));
  217 |     await mark('partner-a-profile-ready');
  218 |     ({ context: contextB, page: pageB } = await openProfile('partner-b', profileB));
  219 |     await mark('partner-b-profile-ready');
  220 |     sessionA = await call<Session>(
  221 |       pageA,
  222 |       'passwordLogin',
  223 |       '@partner1:localhost',
  224 |       partnerAPassword,
  225 |       'NYMPH E2E Partner A',
  226 |     );
  227 |     await mark('partner-a-authenticated');
  228 |     const status = await call<{ room_id: string }>(pageA, 'roomStatus', sessionA);
  229 |     expect(status.room_id.startsWith('!')).toBeTruthy();
  230 |     sessionA.roomId = status.room_id;
  231 | 
  232 |     const invitation = await call<Invitation>(pageA, 'createInvitation', sessionA);
  233 |     await mark('invitation-created');
  234 |     console.info('[matrix-e2e] pairing invitation created');
  235 |     expect(Object.keys(invitation).sort()).toEqual([
  236 |       'expires_at',
  237 |       'homeserver',
  238 |       'partner_user_id',
  239 |       'room_id',
  240 |       'token',
  241 |       'version',
  242 |     ]);
  243 |     expect(invitation.partner_user_id).toBe('@partner2:localhost');
  244 |     expect(invitation.room_id).toBe(status.room_id);
  245 |     expect(invitation.token.length).toBeGreaterThanOrEqual(40);
  246 |     expect(invitation.expires_at).toBeGreaterThan(Date.now());
  247 |     sessionB = await call<Session>(pageB, 'redeemInvitation', invitation);
  248 |     await mark('partner-b-paired');
  249 |     console.info('[matrix-e2e] Partner B redeemed the one-time token');
  250 |     expect(sessionB.userId).toBe('@partner2:localhost');
  251 |     expect(sessionB.roomId).toBe(status.room_id);
  252 |     expect(sessionB.deviceId).not.toBe(sessionA.deviceId);
  253 |     expect(await call<number>(pageB, 'replayInvitation', invitation)).toBe(403);
  254 | 
  255 |     const storageKeyA = Array.from(scryptSync(partnerAPassword, 'nymph-matrix-e2e-partner1-v1', 32));
  256 |     const storageKeyB = Array.from(scryptSync(partnerBPassword, 'nymph-matrix-e2e-partner2-v1', 32));
  257 |     await call(pageA, 'connect', sessionA, storageKeyA);
  258 |     await mark('partner-a-encrypted-sync');
  259 |     console.info('[matrix-e2e] Partner A completed encrypted sync');
  260 |     await call(pageB, 'connect', sessionB, storageKeyB);
  261 |     await mark('partner-b-encrypted-sync');
  262 |     console.info('[matrix-e2e] Partner B completed encrypted sync');
  263 |     if (!sessionB.deviceId) throw new Error('Partner B login did not return a device ID.');
  264 |     const remoteDeviceIds = await queryRemoteDeviceIds(sessionA, sessionB.userId);
  265 |     const ownDeviceIds = await queryRemoteDeviceIds(sessionB, sessionB.userId);
  266 |     console.info(
  267 |       `[matrix-e2e] Synapse reports ${remoteDeviceIds.length} Partner B devices to A and ` +
  268 |       `${ownDeviceIds.length} to B; target present=${remoteDeviceIds.includes(sessionB.deviceId)}`,
  269 |     );
  270 |     const unlockResults = await Promise.allSettled([
  271 |       call<string>(pageA, 'unlockExistingSecretStorage', recoveryKeyA, partnerAPassword),
  272 |       call<string>(pageB, 'unlockExistingSecretStorage', recoveryKeyB, partnerBPassword),
  273 |     ]);
  274 |     const unlockedA = unlockResults[0].status === 'fulfilled';
  275 |     const unlockedB = unlockResults[1].status === 'fulfilled';
  276 |     console.info(
  277 |       `[matrix-e2e] Existing Secret Storage decrypted: Partner A=${unlockedA}, Partner B=${unlockedB}`,
  278 |     );
  279 |     if (!unlockedA || !unlockedB) {
  280 |       const failedPartners = [
  281 |         ...(!unlockedA ? ['Partner A'] : []),
  282 |         ...(!unlockedB ? ['Partner B'] : []),
  283 |       ];
  284 |       throw new Error(
  285 |         `${failedPartners.join(' and ')} could not unlock existing Secret Storage; ` +
  286 |         'cross-signing bootstrap was not attempted.',
  287 |       );
  288 |     }
  289 | 
  290 |     const securityA = await call<{ crossSigningReady: boolean }>(pageA, 'refreshSecurity');
```