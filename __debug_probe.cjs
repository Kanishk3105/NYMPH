const { chromium } = require('@playwright/test');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { scryptSync } = require('node:crypto');
const config = { homeserverUrl: 'http://127.0.0.1:18008', serverName: 'nymph-dev.localhost', partnerA: '@partner1-dev:nymph-dev.localhost', partnerB: '@partner2-dev:nymph-dev.localhost' };
const profileRoot = join(process.cwd(), '.matrix-e2e', 'isolated-stage-3i');
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const readSecret = async (name) => (await readFile(join(process.cwd(),'backend','dev-isolated','secrets',name), 'utf8')).trim();
const deriveStorageKey = (password, userId) => Array.from(scryptSync(password, `nymph-stage3i:${userId}`, 32));
async function openPartnerProfile(partner) {
  const context = await chromium.launchPersistentContext(join(profileRoot, partner), { executablePath: chromePath, headless: true, args:['--disable-extensions','--no-first-run','--no-default-browser-check'] });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5174/tests/e2e/matrix-harness.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByText('Isolated Matrix test client ready').waitFor({ timeout: 30000 });
  return { context, page };
}
(async () => {
  const { context: contextA, page: pageA } = await openPartnerProfile('partner-a');
  const { context: contextB, page: pageB } = await openPartnerProfile('partner-b');
  const passwordA = await readSecret('partner1_dev_password');
  const passwordB = await readSecret('partner2_dev_password');
  const deviceA = await readSecret('partner1_dev_device_id');
  const deviceB = await readSecret('partner2_dev_device_id');
  const call = async (page, method, ...args) => page.evaluate(async ({ methodName, parameters }) => {
    const harness = window.nymphMatrixHarness;
    const op = harness[methodName];
    return op.apply(harness, parameters);
  }, { methodName: method, parameters: args });
  const sessionA = await call(pageA, 'passwordLogin', config.partnerA, passwordA, 'probe A', deviceA);
  const sessionB = await call(pageB, 'passwordLogin', config.partnerB, passwordB, 'probe B', deviceB);
  sessionA.roomId = '!Fcs8AEBEJCozGtC_scKDI55dHg-E1Xy6Biiz29O_Pjw';
  sessionB.roomId = '!Fcs8AEBEJCozGtC_scKDI55dHg-E1Xy6Biiz29O_Pjw';
  await call(pageA, 'connect', sessionA, deriveStorageKey(passwordA, config.partnerA));
  await call(pageB, 'connect', sessionB, deriveStorageKey(passwordB, config.partnerB));
  const canvasBytes = await pageA.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 24;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#9b1c42';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('bad')), 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const sent = await call(pageA, 'sendAttachment', {
    version: 1,
    id: 'probe-' + Date.now(),
    mode: 'romantic',
    kind: 'media',
    text: 'Probe photo',
    sentAt: Date.now(),
    viewOnceSeconds: 60,
    mediaType: 'image/png',
    mediaName: 'probe.png',
  }, canvasBytes, 'image/png', 'probe.png');
  console.log('sent', sent.eventId, sent.attachment && sent.attachment.url);
  await pageB.waitForFunction(({ eventId }) => !!(window.nymphMatrixHarness && window.nymphMatrixHarness.getEvents().find((e) => e.eventId === eventId)), { eventId: sent.eventId }, { timeout: 120000 });
  const events = await pageB.evaluate(() => window.nymphMatrixHarness.getEvents());
  console.log('count', events.length, JSON.stringify(events.slice(-5).map((e) => ({ id: e.eventId, kind: e.kind, hasAttachment: !!e.attachment, url: e.attachment && e.attachment.url })), null, 2));
  const found = events.find((e) => e.eventId === sent.eventId);
  console.log('found?', !!found, found && { kind: found.kind, hasAttachment: !!found.attachment, url: found.attachment && found.attachment.url });
  try {
    const exp = await call(pageB, 'openEphemeralMedia', sent.eventId);
    console.log('open ok', exp);
  } catch (error) {
    console.error('open fail', error && error.message ? error.message : error);
  }
  setTimeout(async () => { await contextA.close(); await contextB.close(); }, 2000);
})();
