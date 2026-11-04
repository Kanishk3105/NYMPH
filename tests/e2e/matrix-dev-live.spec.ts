import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { randomUUID, scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decryptRecoveryExport, encryptRecoveryExport } from '../../src/matrix/recovery-export.ts';
import { loadIsolatedMatrixConfig } from './matrix-runtime-config.mjs';

type Session = {
  homeserver: string;
  userId: string;
  partnerUserId: string;
  accessToken: string;
  roomId: string;
  deviceId?: string;
};

const matrixConfig = loadIsolatedMatrixConfig();
const chromePath = process.env.NYMPH_CHROME_PATH ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const secretDirectory = join(process.cwd(), 'backend', 'dev-isolated', 'secrets');
const profileRoot = join(process.cwd(), '.matrix-e2e', 'isolated-stage-3i');
const matrixOperationTimeout = 120_000;
const expectedRoomId = '!Fcs8AEBEJCozGtC_scKDI55dHg-E1Xy6Biiz29O_Pjw';

const recoveryKeyConfirmationScript = `
Add-Type -AssemblyName System.Windows.Forms
$account = [Console]::In.ReadLine()
$recoveryKey = [Console]::In.ReadLine()
$form = New-Object System.Windows.Forms.Form
$form.Text = "Save Matrix recovery key - $account"
$form.Width = 680
$form.Height = 300
$form.StartPosition = 'CenterScreen'
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Copy this recovery key to secure offline storage. Continue only after you have saved it.'
$label.AutoSize = $true
$label.Left = 12
$label.Top = 12
$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.ReadOnly = $true
$box.ScrollBars = 'Vertical'
$box.Text = $recoveryKey
$box.Left = 12
$box.Top = 42
$box.Width = 640
$box.Height = 100
$saved = New-Object System.Windows.Forms.CheckBox
$saved.Text = 'I saved this recovery key offline and can retrieve it later.'
$saved.AutoSize = $true
$saved.Left = 12
$saved.Top = 155
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Confirm saved key'
$ok.Left = 480
$ok.Top = 205
$ok.Width = 170
$ok.Enabled = $false
$saved.Add_CheckedChanged({ $ok.Enabled = $saved.Checked })
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Left = 390
$cancel.Top = 205
$cancel.Width = 80
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.AddRange(@($label, $box, $saved, $ok, $cancel))
$form.AcceptButton = $ok
$form.CancelButton = $cancel
$result = $form.ShowDialog()
$savedConfirmed = $saved.Checked
$form.Dispose()
if ($result -ne [System.Windows.Forms.DialogResult]::OK -or -not $savedConfirmed) { exit 2 }
[Console]::Out.Write('confirmed')
`;

const recoveryPassphraseScript = `
Add-Type -AssemblyName System.Windows.Forms
$account = [Console]::In.ReadLine()
$form = New-Object System.Windows.Forms.Form
$form.Text = "Encrypted recovery export passphrase - $account"
$form.Width = 560
$form.Height = 270
$form.StartPosition = 'CenterScreen'
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Choose a unique passphrase of at least 12 characters. Store it separately from the encrypted export.'
$label.Left = 12
$label.Top = 12
$label.Width = 520
$label.Height = 36
$firstLabel = New-Object System.Windows.Forms.Label
$firstLabel.Text = 'Passphrase'
$firstLabel.Left = 12
$firstLabel.Top = 65
$firstLabel.Width = 100
$first = New-Object System.Windows.Forms.TextBox
$first.Left = 120
$first.Top = 62
$first.Width = 400
$first.UseSystemPasswordChar = $true
$confirmLabel = New-Object System.Windows.Forms.Label
$confirmLabel.Text = 'Confirm'
$confirmLabel.Left = 12
$confirmLabel.Top = 105
$confirmLabel.Width = 100
$confirm = New-Object System.Windows.Forms.TextBox
$confirm.Left = 120
$confirm.Top = 102
$confirm.Width = 400
$confirm.UseSystemPasswordChar = $true
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Use passphrase'
$ok.Left = 380
$ok.Top = 165
$ok.Width = 140
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Left = 290
$cancel.Top = 165
$cancel.Width = 80
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.AddRange(@($label, $firstLabel, $first, $confirmLabel, $confirm, $ok, $cancel))
$form.AcceptButton = $ok
$form.CancelButton = $cancel
while ($true) {
    $result = $form.ShowDialog()
    if ($result -ne [System.Windows.Forms.DialogResult]::OK) {
        $form.Dispose()
        exit 2
    }
    if ($first.Text.Length -ge 12 -and $first.Text -ceq $confirm.Text) { break }
    [System.Windows.Forms.MessageBox]::Show(
        'The passphrase must be at least 12 characters and both entries must match.',
        'Passphrase not accepted',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
}
$passphrase = $first.Text
$first.Clear()
$confirm.Clear()
$form.Dispose()
[Console]::Out.Write($passphrase)
`;

const recoveryKeyInputScript = `
Add-Type -AssemblyName System.Windows.Forms
$account = [Console]::In.ReadLine()
$form = New-Object System.Windows.Forms.Form
$form.Text = "Existing Matrix recovery key - $account"
$form.Width = 560
$form.Height = 190
$form.StartPosition = 'CenterScreen'
$label = New-Object System.Windows.Forms.Label
$label.Text = 'Enter the existing recovery key from your offline copy. It is not displayed or saved by this dialog.'
$label.Left = 12
$label.Top = 12
$label.Width = 520
$label.Height = 36
$key = New-Object System.Windows.Forms.TextBox
$key.Left = 12
$key.Top = 60
$key.Width = 520
$key.UseSystemPasswordChar = $true
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Continue'
$ok.Left = 440
$ok.Top = 105
$ok.Width = 90
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Left = 345
$cancel.Top = 105
$cancel.Width = 80
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.AddRange(@($label, $key, $ok, $cancel))
$form.AcceptButton = $ok
$form.CancelButton = $cancel
$result = $form.ShowDialog()
$recoveryKey = $key.Text
$key.Clear()
$form.Dispose()
if ($result -ne [System.Windows.Forms.DialogResult]::OK -or -not $recoveryKey) { exit 2 }
[Console]::Out.Write($recoveryKey)
`;

const protectRecoveryExportScript = `
$path = [Console]::In.ReadLine()
$acl = Get-Acl -LiteralPath $path
$acl.SetAccessRuleProtection($true, $false)
$acl.Access | ForEach-Object { $null = $acl.RemoveAccessRuleSpecific($_) }
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
foreach ($sid in @($userSid, $systemSid)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $path -AclObject $acl
$verified = Get-Acl -LiteralPath $path
$actual = @($verified.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
if (-not $verified.AreAccessRulesProtected -or $actual.Count -ne 2 -or $actual -notcontains $userSid.Value -or $actual -notcontains $systemSid.Value) { exit 3 }
[Console]::Out.Write('protected')
`;

function runLocalPowerShellDialog(script: string, input: string, failure: string): string {
  const utf8 = '$utf8 = New-Object System.Text.UTF8Encoding($false); [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8; ';
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-STA', '-Command', utf8 + script],
    { input, encoding: 'utf8', windowsHide: false, maxBuffer: 16 * 1024 },
  );
  if (result.error || result.status !== 0) throw new Error(failure);
  return result.stdout.replace(/\r?\n$/, '');
}

function confirmRecoveryKeyOffline(userId: string, recoveryKey: string): void {
  const result = runLocalPowerShellDialog(
    recoveryKeyConfirmationScript,
    `${userId}\n${recoveryKey}\n`,
    `Recovery-key confirmation was not completed for ${userId}.`,
  );
  if (result !== 'confirmed') throw new Error(`Recovery-key confirmation was not completed for ${userId}.`);
}

function requestExportPassphrase(userId: string): string {
  const passphrase = runLocalPowerShellDialog(
    recoveryPassphraseScript,
    `${userId}\n`,
    `A local recovery-export passphrase was not provided for ${userId}.`,
  );
  if (passphrase.length < 12) throw new Error(`Recovery-export passphrase is too short for ${userId}.`);
  return passphrase;
}

function requestExistingRecoveryKey(userId: string): string {
  const recoveryKey = runLocalPowerShellDialog(
    recoveryKeyInputScript,
    `${userId}\n`,
    `The existing recovery key was not provided for ${userId}.`,
  );
  if (!recoveryKey) throw new Error(`The existing recovery key was not provided for ${userId}.`);
  return recoveryKey;
}

async function writeProtectedRecoveryExport(path: string, encryptedExport: string): Promise<void> {
  await writeFile(path, encryptedExport, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', protectRecoveryExportScript],
      { input: `${path}\n`, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 },
    );
    if (result.error || result.status !== 0 || result.stdout !== 'protected') {
      throw new Error('Recovery-export file permissions could not be restricted to this Windows user and SYSTEM.');
    }
  } catch (error) {
    await unlink(path);
    throw error;
  }
}

async function readIsolatedFile(name: string): Promise<string> {
  const value = (await readFile(join(secretDirectory, name), 'utf8')).trim();
  if (!value) throw new Error(`Required isolated development credential file ${name} is empty.`);
  return value;
}

type RecoverySecurityState = {
  crossSigningReady: boolean;
  defaultSecretStorageKeyId: string | null;
  publicCrossSigningKeysPresent: boolean;
  privateCrossSigningSecretsStored: boolean;
  keyBackupVersion: string | null;
  recoverySetupVerified: boolean;
};

async function prepareAndVerifyRecovery(
  page: Page,
  userId: string,
  password: string,
  exportFile: string,
  passphrase: string,
): Promise<{ recoveryKey: string; identityIds: string[] }> {
  let security = await call<RecoverySecurityState>(page, 'refreshSecurity');
  let recoveryKey: string;
  let exportContents: Awaited<ReturnType<typeof decryptRecoveryExport>> | undefined;

  if (!security.defaultSecretStorageKeyId) {
    if (security.publicCrossSigningKeysPresent) {
      throw new Error(
        `An existing cross-signing identity is published for ${userId} without Secret Storage; refusing to replace it.`,
      );
    }
    if (await fileExists(exportFile)) {
      throw new Error(`A recovery export already exists for ${userId}, but Secret Storage is not configured; refusing to overwrite state.`);
    }

    recoveryKey = await call<string>(page, 'prepareSecretStorageSetup');
    if (!recoveryKey) throw new Error(`Matrix did not generate a recovery key for ${userId}.`);
    confirmRecoveryKeyOffline(userId, recoveryKey);
    await call<string>(page, 'commitSecretStorageSetup', recoveryKey);
    const keyId = (await call<RecoverySecurityState>(page, 'refreshSecurity')).defaultSecretStorageKeyId;
    if (!keyId) throw new Error(`Secret Storage was not committed for ${userId}.`);
    const encryptedExport = await encryptRecoveryExport(
      { account: userId, keyId, recoveryKey },
      passphrase,
    );
    await writeProtectedRecoveryExport(exportFile, encryptedExport);
    await call(page, 'bootstrapSecurity', password);
  } else {
    if (await fileExists(exportFile)) {
      const encryptedExport = await readFile(exportFile, 'utf8');
      exportContents = await decryptRecoveryExport(encryptedExport, passphrase);
      if (
        exportContents.account !== userId ||
        exportContents.keyId !== security.defaultSecretStorageKeyId
      ) {
        exportContents.recoveryKey = '';
        throw new Error(`The encrypted recovery export does not match ${userId}'s existing Secret Storage key.`);
      }
      recoveryKey = exportContents.recoveryKey;
      exportContents.recoveryKey = '';
    } else {
      recoveryKey = requestExistingRecoveryKey(userId);
    }

    if (!security.crossSigningReady) {
      if (security.publicCrossSigningKeysPresent) {
        if (!security.privateCrossSigningSecretsStored) {
          throw new Error(`Existing cross-signing secrets are unavailable for ${userId}; refusing to replace the identity.`);
        }
        await call(page, 'unlockExistingSecretStorage', recoveryKey, password);
      } else {
        await call(page, 'bootstrapSecurity', password);
      }
    }
  }

  const keyId = await call<string>(page, 'verifyRecoveryOnSeparateDevice', recoveryKey, password);
  if (!(await fileExists(exportFile))) {
    const securityState = await call<RecoverySecurityState>(page, 'refreshSecurity');
    if (!securityState.defaultSecretStorageKeyId) {
      throw new Error(`Secret Storage is not configured for ${userId}.`);
    }
    const encryptedExport = await encryptRecoveryExport(
      { account: userId, keyId: securityState.defaultSecretStorageKeyId, recoveryKey },
      passphrase,
    );
    await writeProtectedRecoveryExport(exportFile, encryptedExport);
  }
  const encryptedExport = await readFile(exportFile, 'utf8');
  await call(page, 'validateRecoveryExport', encryptedExport, passphrase, recoveryKey, userId);
  exportContents = undefined;
  security = await call<RecoverySecurityState>(page, 'refreshSecurity');
  if (
    keyId !== security.defaultSecretStorageKeyId ||
    !security.crossSigningReady ||
    !security.recoverySetupVerified ||
    !security.keyBackupVersion
  ) {
    throw new Error(`Independent recovery or room-key backup validation did not complete for ${userId}.`);
  }
  const identityIds = await call<string[]>(page, 'crossSigningIdentityIds');
  if (identityIds.length !== 3 || new Set(identityIds).size !== 3) {
    throw new Error(`The published cross-signing identity is incomplete for ${userId}.`);
  }
  return { recoveryKey, identityIds };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function deriveStorageKey(password: string, userId: string): number[] {
  const key = scryptSync(password, `nymph-stage3i:${userId}`, 32);
  try {
    return Array.from(key);
  } finally {
    key.fill(0);
  }
}

async function call<T>(
  page: Page,
  method: string,
  ...args: unknown[]
): Promise<T> {
  const result = page.evaluate(
    async ({ methodName, parameters }) => {
      const harnessValue = (window as Window & { nymphMatrixHarness?: unknown }).nymphMatrixHarness;
      if (!harnessValue || typeof harnessValue !== 'object') {
        throw new Error('The isolated Matrix test harness is unavailable.');
      }
      const operation = (harnessValue as Record<string, (...values: unknown[]) => unknown>)[methodName];
      if (typeof operation !== 'function') {
        throw new Error('The requested isolated Matrix test operation is unavailable.');
      }
      return operation.apply(harnessValue, parameters);
    },
    { methodName: method, parameters: args },
  ) as Promise<T>;

  let timeoutId: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Isolated Matrix operation timed out: ${method}.`)),
          matrixOperationTimeout,
        );
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
  timeout = matrixOperationTimeout,
): Promise<T> {
  await page.waitForFunction(
    ({ source, values }) => {
      const getter = new Function('harness', 'args', `return (${source})(harness, ...args)`);
      return getter((window as Window & { nymphMatrixHarness?: unknown }).nymphMatrixHarness, values);
    },
    { source: expression, values: args },
    { timeout },
  );
  return page.evaluate(
    ({ source, values }) => {
      const getter = new Function('harness', 'args', `return (${source})(harness, ...args)`);
      return getter((window as Window & { nymphMatrixHarness?: unknown }).nymphMatrixHarness, values);
    },
    { source: expression, values: args },
  ) as Promise<T>;
}

async function openPartnerProfile(
  partner: 'partner-a' | 'partner-b',
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(join(profileRoot, partner), {
    executablePath: chromePath,
    headless: true,
    args: ['--disable-extensions', '--no-first-run', '--no-default-browser-check'],
  });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5174/tests/e2e/matrix-harness.html', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.getByText('Isolated Matrix test client ready').waitFor({ timeout: 30_000 });
  return { context, page };
}

test('isolated partners join the existing room, recover crypto, verify trust, and exchange encrypted messages', async () => {
  test.setTimeout(1_200_000);

  let passwordA = await readIsolatedFile('partner1_dev_password');
  let passwordB = await readIsolatedFile('partner2_dev_password');
  if (passwordA === passwordB) throw new Error('Partner login credentials must be independent.');

  const partnerA = matrixConfig.partnerA;
  const partnerB = matrixConfig.partnerB;
  const passwordDeviceA = await readIsolatedFile('partner1_dev_device_id');
  const passwordDeviceB = await readIsolatedFile('partner2_dev_device_id');
  const recoveryExportAPath = join(secretDirectory, 'partner1_dev_recovery.enc');
  const recoveryExportBPath = join(secretDirectory, 'partner2_dev_recovery.enc');

  let contextA: BrowserContext | undefined;
  let contextB: BrowserContext | undefined;
  let pageA: Page | undefined;
  let pageB: Page | undefined;
  let sessionA: Session | undefined;
  let sessionB: Session | undefined;
  let storageKeyA: number[] = [];
  let storageKeyB: number[] = [];
  let recoveryKeyA = '';
  let recoveryKeyB = '';
  let exportPassphraseA = '';
  let exportPassphraseB = '';
  let identityIdsA: string[] = [];
  let identityIdsB: string[] = [];

  try {
    ({ context: contextA, page: pageA } = await openPartnerProfile('partner-a'));
    ({ context: contextB, page: pageB } = await openPartnerProfile('partner-b'));
    expect(contextA).not.toBe(contextB);

    sessionA = await call<Session>(
      pageA,
      'passwordLogin',
      partnerA,
      passwordA,
      'NYMPH isolated Partner A',
      passwordDeviceA,
    );
    sessionB = await call<Session>(
      pageB,
      'passwordLogin',
      partnerB,
      passwordB,
      'NYMPH isolated Partner B',
      passwordDeviceB,
    );
    expect(sessionA.userId).toBe(partnerA);
    expect(sessionB.userId).toBe(partnerB);
    expect(sessionA.deviceId).not.toBe(sessionB.deviceId);
    expect(sessionA.homeserver).toBe(matrixConfig.homeserverUrl);
    expect(sessionB.homeserver).toBe(matrixConfig.homeserverUrl);
    sessionA.roomId = expectedRoomId;
    sessionB.roomId = expectedRoomId;

    storageKeyA = deriveStorageKey(passwordA, partnerA);
    storageKeyB = deriveStorageKey(passwordB, partnerB);
    await call(pageB, 'connect', sessionB, storageKeyB);
    await call(pageA, 'connect', sessionA, storageKeyA);
    const roomStatus = await call<{ room_id: string }>(pageA, 'roomStatus', sessionA);
    expect(roomStatus.room_id).toBe(expectedRoomId);

    const joinedMembers = await call<string[]>(pageA, 'joinedMembers', sessionA, expectedRoomId);
    expect(joinedMembers).toEqual([partnerA, partnerB].sort());
    expect(await call<number>(
      pageA,
      'inviteStatus',
      sessionA,
      expectedRoomId,
      '@third-dev:nymph-dev.localhost',
    )).toBe(403);

    exportPassphraseA = requestExportPassphrase(partnerA);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      exportPassphraseB = requestExportPassphrase(partnerB);
      if (exportPassphraseB !== exportPassphraseA) break;
      exportPassphraseB = '';
    }
    if (!exportPassphraseB) {
      throw new Error('Each partner must use a distinct recovery-export passphrase.');
    }
    const recoveryA = await prepareAndVerifyRecovery(
      pageA,
      partnerA,
      passwordA,
      recoveryExportAPath,
      exportPassphraseA,
    );
    recoveryKeyA = recoveryA.recoveryKey;
    identityIdsA = recoveryA.identityIds;
    const recoveryB = await prepareAndVerifyRecovery(
      pageB,
      partnerB,
      passwordB,
      recoveryExportBPath,
      exportPassphraseB,
    );
    recoveryKeyB = recoveryB.recoveryKey;
    identityIdsB = recoveryB.identityIds;
    expect(recoveryKeyA).not.toBe(recoveryKeyB);
    expect(exportPassphraseA).not.toBe(exportPassphraseB);
    expect(identityIdsA).toHaveLength(3);
    expect(identityIdsB).toHaveLength(3);
    expect(new Set([...identityIdsA, ...identityIdsB]).size).toBe(6);

    await call(pageA, 'requestPartnerVerification', sessionB.deviceId);
    const canceledIncoming = await waitForValue<{ id: string }>(
      pageB,
      'h => h.getVerifications().find(item => item.userId === args[0] && item.phase === "Requested")',
      [partnerA],
    );
    const canceledOutgoing = await waitForValue<{ id: string }>(
      pageA,
      'h => h.getVerifications().find(item => item.userId === args[0] && item.phase === "Requested")',
      [partnerB],
    );
    await call(pageA, 'cancelVerification', canceledOutgoing.id);
    await waitForValue<boolean>(
      pageB,
      'h => h.getVerifications().some(item => item.id === args[0] && item.phase !== "Requested")',
      [canceledIncoming.id],
    );
    expect((await call<RecoverySecurityState & { partnerVerified: boolean }>(
      pageA,
      'refreshSecurity',
    )).partnerVerified).toBe(false);

    await call(pageA, 'requestPartnerVerification', sessionB.deviceId);
    const incoming = await waitForValue<{ id: string }>(
      pageB,
      'h => h.getVerifications().find(item => item.userId === args[0] && item.phase === "Requested")',
      [partnerA],
    );
    await call(pageB, 'acceptVerification', incoming.id);
    const outgoing = await waitForValue<{ id: string }>(
      pageA,
      'h => h.getVerifications().find(item => item.userId === args[0] && item.id !== args[1])',
      [partnerB, canceledOutgoing.id],
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

    const securityA = await call<RecoverySecurityState & {
      partnerVerified: boolean;
      partnerDevices: Array<{ deviceId: string; verified: boolean }>;
    }>(pageA, 'refreshSecurity');
    const securityB = await call<RecoverySecurityState & {
      partnerVerified: boolean;
      partnerDevices: Array<{ deviceId: string; verified: boolean }>;
    }>(pageB, 'refreshSecurity');
    expect(securityA.crossSigningReady).toBe(true);
    expect(securityB.crossSigningReady).toBe(true);
    expect(securityA.partnerVerified).toBe(true);
    expect(securityB.partnerVerified).toBe(true);
    expect(securityA.partnerDevices.find((device) => device.deviceId === sessionB?.deviceId)?.verified).toBe(true);
    expect(securityB.partnerDevices.find((device) => device.deviceId === sessionA?.deviceId)?.verified).toBe(true);

    const messageIds: string[] = [];
    const firstMessage = {
      version: 1 as const,
      id: randomUUID(),
      mode: 'romantic' as const,
      kind: 'text' as const,
      text: 'Hey, missing you ❤️',
      sentAt: Date.now(),
    };
    const firstEventId = await call<string>(pageA, 'send', firstMessage);
    await waitForValue<boolean>(
      pageB,
      'h => h.getEvents().some(event => event.eventId === args[0])',
      [firstEventId],
    );
    const receivedFirst = await call<Array<{
      eventId: string; sender: string; mode: string; text: string; kind: string;
    }>>(pageB, 'getEvents');
    expect(receivedFirst.find((event) => event.eventId === firstEventId)).toMatchObject({
      sender: partnerA,
      mode: 'romantic',
      kind: 'text',
      text: 'Hey, missing you ❤️',
    });
    messageIds.push(firstEventId);

    await call(pageB, 'markRead', firstEventId);
    await waitForValue<boolean>(
      pageA,
      'h => h.getReadEventIds().includes(args[0])',
      [firstEventId],
    );

    const reply = {
      version: 1 as const,
      id: randomUUID(),
      mode: 'romantic' as const,
      kind: 'text' as const,
      text: 'Missing you too 🥺💋',
      sentAt: Date.now(),
      replyToEventId: firstEventId,
    };
    const replyEventId = await call<string>(pageB, 'send', reply);
    await waitForValue<boolean>(
      pageA,
      'h => h.getEvents().some(event => event.eventId === args[0])',
      [replyEventId],
    );
    const receivedReply = await call<Array<{
      eventId: string; sender: string; mode: string; text: string; replyToEventId?: string;
    }>>(pageA, 'getEvents');
    expect(receivedReply.find((event) => event.eventId === replyEventId)).toMatchObject({
      sender: partnerB,
      mode: 'romantic',
      text: 'Missing you too 🥺💋',
      replyToEventId: firstEventId,
    });
    messageIds.push(replyEventId);

    const reactionEventId = await call<string>(pageB, 'send', {
      version: 1,
      id: randomUUID(),
      mode: 'romantic',
      kind: 'reaction',
      text: '❤️',
      sentAt: Date.now(),
      reactionTo: firstEventId,
    });
    await waitForValue<boolean>(
      pageA,
      'h => h.getEvents().some(event => event.eventId === args[0])',
      [reactionEventId],
    );
    const reactions = await call<Array<{
      eventId: string; sender: string; mode: string; kind: string; reactionTo?: string;
    }>>(pageA, 'getEvents');
    expect(reactions.find((event) => event.eventId === reactionEventId)).toMatchObject({
      sender: partnerB,
      mode: 'romantic',
      kind: 'reaction',
      reactionTo: firstEventId,
    });
    messageIds.push(reactionEventId);

    for (const mode of ['flirty', 'spicy', 'kinky'] as const) {
      const id = randomUUID();
      const text = `NYMPH ${mode} mode acceptance ${id}`;
      const eventId = await call<string>(pageA, 'send', {
        version: 1,
        id,
        mode,
        kind: 'text',
        text,
        sentAt: Date.now(),
      });
      await waitForValue<boolean>(
        pageB,
        'h => h.getEvents().some(event => event.eventId === args[0])',
        [eventId],
      );
      const received = await call<Array<{ eventId: string; sender: string; mode: string; text: string }>>(
        pageB,
        'getEvents',
      );
      expect(received.find((event) => event.eventId === eventId)).toMatchObject({
        sender: partnerA,
        mode,
        text,
      });
      messageIds.push(eventId);
    }

    await call(pageB, 'disconnect');
    const offlineEventId = await call<string>(pageA, 'send', {
      version: 1,
      id: randomUUID(),
      mode: 'romantic',
      kind: 'text',
      text: 'Offline delivery acceptance',
      sentAt: Date.now(),
    });
    await call(pageB, 'connect', sessionB, storageKeyB);
    await waitForValue<boolean>(
      pageB,
      'h => h.getEvents().some(event => event.eventId === args[0])',
      [offlineEventId],
    );
    messageIds.push(offlineEventId);

    await call(pageA, 'disconnect');
    await call(pageB, 'disconnect');
    await contextA.close();
    contextA = undefined;
    await contextB.close();
    contextB = undefined;

    ({ context: contextA, page: pageA } = await openPartnerProfile('partner-a'));
    ({ context: contextB, page: pageB } = await openPartnerProfile('partner-b'));
    await call(pageB, 'connect', sessionB, storageKeyB);
    await call(pageA, 'connect', sessionA, storageKeyA);
    for (const eventId of messageIds) {
      await waitForValue<boolean>(
        pageA,
        'h => h.getEvents().some(event => event.eventId === args[0])',
        [eventId],
      );
      await waitForValue<boolean>(
        pageB,
        'h => h.getEvents().some(event => event.eventId === args[0])',
        [eventId],
      );
    }
    expect(await call<string[]>(pageA, 'crossSigningIdentityIds')).toEqual(identityIdsA);
    expect(await call<string[]>(pageB, 'crossSigningIdentityIds')).toEqual(identityIdsB);

    const revokedSession = await call<Session>(
      pageA,
      'passwordLogin',
      partnerA,
      passwordA,
      'NYMPH revoked-device acceptance',
    );
    if (!revokedSession.deviceId || revokedSession.deviceId === sessionA.deviceId) {
      throw new Error('The temporary revocation test did not create an independent Matrix device.');
    }
    await call(pageA, 'revokeDevice', revokedSession.deviceId, passwordA);
    expect(await call<number>(pageA, 'whoamiStatus', revokedSession)).toBe(401);

    const finalMembers = await call<string[]>(pageA, 'joinedMembers', sessionA, expectedRoomId);
    expect(finalMembers).toEqual([partnerA, partnerB].sort());
  } finally {
    if (pageA) await call(pageA, 'disconnect');
    if (pageB) await call(pageB, 'disconnect');
    await contextA?.close();
    await contextB?.close();
    storageKeyA.fill(0);
    storageKeyB.fill(0);
    recoveryKeyA = '';
    recoveryKeyB = '';
    exportPassphraseA = '';
    exportPassphraseB = '';
    passwordA = '';
    passwordB = '';
  }
});
