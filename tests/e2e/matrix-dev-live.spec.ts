import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomUUID, scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReceivedNymphEvent } from '../../src/matrix/MessagingClient.ts';
import { RecoveryExportPassphraseSession } from '../../src/matrix/recovery-export-session.ts';
import type { RecoveryExportPassphrasePurpose } from '../../src/matrix/recovery-export-session.ts';
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
$label.Text = 'Save this recovery key offline, then re-enter it below to confirm that your saved copy is correct.'
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
$saved = New-Object System.Windows.Forms.Label
$saved.Text = 'Re-enter the recovery key from your saved copy:'
$saved.AutoSize = $true
$saved.Left = 12
$saved.Top = 155
$verify = New-Object System.Windows.Forms.TextBox
$verify.Left = 12
$verify.Top = 180
$verify.Width = 640
$verify.UseSystemPasswordChar = $true
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Confirm saved key'
$ok.Left = 480
$ok.Top = 205
$ok.Width = 170
$ok.Enabled = $false
$verify.Add_TextChanged({ $ok.Enabled = ($verify.Text -ceq $recoveryKey) })
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Left = 390
$cancel.Top = 205
$cancel.Width = 80
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.AddRange(@($label, $box, $saved, $verify, $ok, $cancel))
$form.AcceptButton = $ok
$form.CancelButton = $cancel
$result = $form.ShowDialog()
$savedConfirmed = $verify.Text -ceq $recoveryKey
$verify.Clear()
$form.Dispose()
if ($result -ne [System.Windows.Forms.DialogResult]::OK -or -not $savedConfirmed) { exit 2 }
[Console]::Out.Write('confirmed')
`;

const recoveryPassphraseScript = `
Add-Type -AssemblyName System.Windows.Forms
$account = [Console]::In.ReadLine()
$purpose = [Console]::In.ReadLine()
$existingExport = $purpose -eq 'existing'
$form = New-Object System.Windows.Forms.Form
if ($existingExport) {
    $form.Text = "Existing recovery export passphrase - $account"
} else {
    $form.Text = "New recovery export passphrase - $account"
}
$form.Width = 560
$form.Height = 270
$form.StartPosition = 'CenterScreen'
$label = New-Object System.Windows.Forms.Label
if ($existingExport) {
    $label.Text = 'Enter the original passphrase used to encrypt this existing export. Do not choose a new passphrase.'
} else {
    $label.Text = 'Choose a unique passphrase of at least 12 characters. Store it separately from the encrypted export.'
}
$label.Left = 12
$label.Top = 12
$label.Width = 520
$label.Height = 36
$firstLabel = New-Object System.Windows.Forms.Label
if ($existingExport) {
    $firstLabel.Text = 'Original passphrase'
} else {
    $firstLabel.Text = 'Passphrase'
}
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
$confirmLabel.Visible = -not $existingExport
$confirmLabel.Left = 12
$confirmLabel.Top = 105
$confirmLabel.Width = 100
$confirm = New-Object System.Windows.Forms.TextBox
$confirm.Left = 120
$confirm.Top = 102
$confirm.Width = 400
$confirm.UseSystemPasswordChar = $true
$confirm.Visible = -not $existingExport
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
    if ($first.Text.Length -ge 12 -and ($existingExport -or $first.Text -ceq $confirm.Text)) { break }
    $message = if ($existingExport) {
        'Enter the original export passphrase. It must contain at least 12 characters.'
    } else {
        'Use a passphrase of at least 12 characters and confirm it exactly.'
    }
    [System.Windows.Forms.MessageBox]::Show(
        $message,
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

function requestExportPassphrase(
  userId: string,
  purpose: RecoveryExportPassphrasePurpose,
): string {
  const passphrase = runLocalPowerShellDialog(
    recoveryPassphraseScript,
    `${userId}\n${purpose}\n`,
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
  passphraseSession: RecoveryExportPassphraseSession,
): Promise<{ recoveryKey: string; identityIds: string[] }> {
  let security = await call<RecoverySecurityState>(page, 'refreshSecurity');
  let recoveryKey: string;

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
    security = await call<RecoverySecurityState>(page, 'refreshSecurity');
    const keyId = security.defaultSecretStorageKeyId;
    if (!keyId) throw new Error(`Secret Storage was not committed for ${userId}.`);
    const encryptedExport = await passphraseSession.createEncryptedExport(
      userId,
      { account: userId, keyId, recoveryKey },
      (contents) => validateRecoveryContents(contents, userId, keyId, recoveryKey),
    );
    await writeProtectedRecoveryExport(exportFile, encryptedExport);
    await call(page, 'bootstrapSecurity', password);
  } else {
    if (await fileExists(exportFile)) {
      const encryptedExport = await readFile(exportFile, 'utf8');
      const exportContents = await passphraseSession.decryptExport(
        userId,
        encryptedExport,
        (contents) => validateRecoveryContents(contents, userId, security.defaultSecretStorageKeyId),
      );
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
    const encryptedExport = await passphraseSession.createEncryptedExport(
      userId,
      { account: userId, keyId: securityState.defaultSecretStorageKeyId, recoveryKey },
      (contents) => validateRecoveryContents(
        contents,
        userId,
        securityState.defaultSecretStorageKeyId,
        recoveryKey,
      ),
    );
    await writeProtectedRecoveryExport(exportFile, encryptedExport);
  }
  const encryptedExport = await readFile(exportFile, 'utf8');
  const validatedExport = await passphraseSession.decryptExport(
    userId,
    encryptedExport,
    (contents) => validateRecoveryContents(
      contents,
      userId,
      security.defaultSecretStorageKeyId,
      recoveryKey,
    ),
  );
  validatedExport.recoveryKey = '';
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

function validateRecoveryContents(
  contents: { account: string; keyId: string | null; recoveryKey: string },
  userId: string,
  keyId: string | null,
  recoveryKey?: string,
): void {
  if (contents.account !== userId || contents.keyId !== keyId) {
    throw new Error(`The encrypted recovery export does not match ${userId}'s existing Secret Storage key.`);
  }
  if (recoveryKey !== undefined && contents.recoveryKey !== recoveryKey) {
    throw new Error(`The encrypted recovery export contains an unexpected recovery key for ${userId}.`);
  }
}

async function recoverPartner(
  page: Page,
  userId: string,
  password: string,
  exportFile: string,
): Promise<{ recoveryKey: string; identityIds: string[] }> {
  const passphraseSession = new RecoveryExportPassphraseSession(requestExportPassphrase);
  try {
    return await prepareAndVerifyRecovery(page, userId, password, exportFile, passphraseSession);
  } finally {
    passphraseSession.finish();
  }
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

function mediaIdFromAttachment(attachment: { url: string }): string {
  const mediaUrl = new URL(attachment.url);
  const match = mediaUrl.pathname.match(/^\/_synapse\/client\/nymph\/media\/content\/([A-Za-z0-9._=-]{1,255})$/);
  if (mediaUrl.origin !== new URL(matrixConfig.homeserverUrl).origin || !match) {
    throw new Error('The encrypted view-once attachment has an invalid media reference.');
  }
  return match[1];
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
  const profileDir = join(profileRoot, partner);
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: true,
    args: [
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5174/tests/e2e/matrix-harness.html', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.getByText('Isolated Matrix test client ready').waitFor({ timeout: 30_000 });
  return { context, page };
}

async function restartExistingIsolatedSynapse(page: Page): Promise<void> {
  const restart = spawnSync('docker', ['restart', 'nymph-stage3h1-dev-synapse-1'], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  if (restart.error || restart.status !== 0) {
    throw new Error('The existing isolated Synapse service could not be restarted safely.', {
      cause: restart.error ?? new Error(restart.stderr || `docker exited with ${restart.status}`),
    });
  }
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const health = spawnSync(
      'docker',
      ['inspect', '--format', '{{.State.Health.Status}}', 'nymph-stage3h1-dev-synapse-1'],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true },
    );
    if (health.status === 0 && health.stdout.trim() === 'healthy') return;
    await page.waitForTimeout(1_000);
  }
  throw new Error('The existing isolated Synapse service did not become healthy after restart.');
}

async function restoreExistingCrossSigningForCurrentDevice(
  page: Page,
  userId: string,
  password: string,
  exportFile: string,
): Promise<void> {
  const before = await call<RecoverySecurityState>(page, 'refreshSecurity');
  if (before.crossSigningReady) return;
  if (
    !before.defaultSecretStorageKeyId ||
    !before.publicCrossSigningKeysPresent ||
    !before.privateCrossSigningSecretsStored
  ) {
    throw new Error(
      `Existing cross-signing state is incomplete for ${userId}; refusing to create or replace identity keys.`,
    );
  }
  if (!(await fileExists(exportFile))) {
    throw new Error(`The existing encrypted recovery export is missing for ${userId}.`);
  }

  const originalIdentityIds = await call<string[]>(page, 'crossSigningIdentityIds');
  if (originalIdentityIds.length !== 3 || new Set(originalIdentityIds).size !== 3) {
    throw new Error(`The published cross-signing identity is incomplete for ${userId}.`);
  }

  const passphraseSession = new RecoveryExportPassphraseSession(requestExportPassphrase);
  let recoveryKey = '';
  try {
    const encryptedExport = await readFile(exportFile, 'utf8');
    const contents = await passphraseSession.decryptExport(
      userId,
      encryptedExport,
      (value) => validateRecoveryContents(value, userId, before.defaultSecretStorageKeyId),
    );
    recoveryKey = contents.recoveryKey;
    contents.recoveryKey = '';

    const keyId = await call<string>(page, 'unlockExistingSecretStorage', recoveryKey, password);
    if (keyId !== before.defaultSecretStorageKeyId) {
      throw new Error(`Secret Storage changed unexpectedly while restoring ${userId}'s current device.`);
    }

    const after = await call<RecoverySecurityState>(page, 'refreshSecurity');
    const restoredIdentityIds = await call<string[]>(page, 'crossSigningIdentityIds');
    if (
      !after.crossSigningReady ||
      after.defaultSecretStorageKeyId !== before.defaultSecretStorageKeyId ||
      !after.publicCrossSigningKeysPresent ||
      JSON.stringify(restoredIdentityIds) !== JSON.stringify(originalIdentityIds)
    ) {
      throw new Error(`Existing cross-signing state could not be restored unchanged for ${userId}.`);
    }
  } finally {
    recoveryKey = '';
    passphraseSession.finish();
  }
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
  if (!(await fileExists(recoveryExportAPath))) throw new Error('Partner A recovery export is missing.');
  const recoveryExportBExistedBeforeTest = await fileExists(recoveryExportBPath);
  if (!recoveryExportBExistedBeforeTest) throw new Error('Partner B recovery export is missing.');

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
  let identityIdsA: string[] = [];
  let identityIdsB: string[] = [];
  let partnerARecoveryAlreadyVerified = false;
  let partnerBRecoveryAlreadyVerified = false;

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

    const preflightSecurityA = await call<RecoverySecurityState>(pageA, 'refreshSecurity');
    if (!preflightSecurityA.defaultSecretStorageKeyId) {
      throw new Error(`Existing Secret Storage is not configured for ${partnerA}; refusing to replace its recovery key.`);
    }
    const preflightSecurityB = await call<RecoverySecurityState>(pageB, 'refreshSecurity');
    if (!preflightSecurityB.defaultSecretStorageKeyId) {
      if (preflightSecurityB.publicCrossSigningKeysPresent) {
        throw new Error(
          `Partner B has an existing published cross-signing identity without Secret Storage; refusing to replace it.`,
        );
      }
      if (await fileExists(recoveryExportBPath)) {
        throw new Error('Partner B has an existing recovery export without Secret Storage; refusing to overwrite state.');
      }
    }

    if (
      preflightSecurityA.recoverySetupVerified &&
      preflightSecurityA.crossSigningReady &&
      preflightSecurityA.keyBackupVersion
    ) {
      partnerARecoveryAlreadyVerified = true;
      identityIdsA = await call<string[]>(pageA, 'crossSigningIdentityIds');
    } else {
      const recoveryA = await recoverPartner(
        pageA,
        partnerA,
        passwordA,
        recoveryExportAPath,
      );
      recoveryKeyA = recoveryA.recoveryKey;
      identityIdsA = recoveryA.identityIds;
    }
    if (
      preflightSecurityB.recoverySetupVerified &&
      preflightSecurityB.crossSigningReady &&
      preflightSecurityB.keyBackupVersion
    ) {
      partnerBRecoveryAlreadyVerified = true;
      identityIdsB = await call<string[]>(pageB, 'crossSigningIdentityIds');
    } else {
      const recoveryB = await recoverPartner(
        pageB,
        partnerB,
        passwordB,
        recoveryExportBPath,
      );
      recoveryKeyB = recoveryB.recoveryKey;
      identityIdsB = recoveryB.identityIds;
    }
    if (recoveryKeyA && recoveryKeyB && recoveryKeyA === recoveryKeyB) {
      throw new Error('Partner recovery keys must be independent.');
    }
    expect(identityIdsA).toHaveLength(3);
    expect(identityIdsB).toHaveLength(3);
    expect(new Set([...identityIdsA, ...identityIdsB]).size).toBe(6);

    const initialTrustA = await call<RecoverySecurityState & { partnerVerified: boolean }>(
      pageA,
      'refreshSecurity',
    );
    const initialTrustB = await call<RecoverySecurityState & { partnerVerified: boolean }>(
      pageB,
      'refreshSecurity',
    );
    if (initialTrustA.partnerVerified !== initialTrustB.partnerVerified) {
      throw new Error('Partner trust is inconsistent; refusing to start a duplicate SAS verification.');
    }
    if (!initialTrustA.partnerVerified) {
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
    }

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
    passwordA = '';
    passwordB = '';
  }
});

test('isolated partners send and decrypt encrypted photo and video attachments', async () => {
  test.setTimeout(600_000);
  let passwordA = await readIsolatedFile('partner1_dev_password');
  let passwordB = await readIsolatedFile('partner2_dev_password');
  const partnerA = matrixConfig.partnerA;
  const partnerB = matrixConfig.partnerB;
  const deviceA = await readIsolatedFile('partner1_dev_device_id');
  const deviceB = await readIsolatedFile('partner2_dev_device_id');
  let contextA: BrowserContext | undefined;
  let contextB: BrowserContext | undefined;
  let pageA: Page | undefined;
  let pageB: Page | undefined;
  let storageKeyA: number[] = [];
  let storageKeyB: number[] = [];
  let sessionA: Session | undefined;
  let sessionB: Session | undefined;

  try {
    ({ context: contextA, page: pageA } = await openPartnerProfile('partner-a'));
    ({ context: contextB, page: pageB } = await openPartnerProfile('partner-b'));
    sessionA = await call<Session>(pageA, 'passwordLogin', partnerA, passwordA, 'NYMPH media acceptance A', deviceA);
    sessionB = await call<Session>(pageB, 'passwordLogin', partnerB, passwordB, 'NYMPH media acceptance B', deviceB);
    sessionA.roomId = expectedRoomId;
    sessionB.roomId = expectedRoomId;
    storageKeyA = deriveStorageKey(passwordA, partnerA);
    storageKeyB = deriveStorageKey(passwordB, partnerB);
    await call(pageA, 'connect', sessionA, storageKeyA);
    await call(pageB, 'connect', sessionB, storageKeyB);

    const securityA = await call<{ partnerVerified: boolean }>(pageA, 'refreshSecurity');
    const securityB = await call<{ partnerVerified: boolean }>(pageB, 'refreshSecurity');
    expect(securityA.partnerVerified).toBe(true);
    expect(securityB.partnerVerified).toBe(true);
    expect(await call<string[]>(pageA, 'joinedMembers', sessionA, expectedRoomId)).toEqual([partnerA, partnerB].sort());

    const photoBytes = await pageA.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 48;
      canvas.height = 32;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable for the photo fixture.');
      context.fillStyle = '#7b2344';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#f2b8cc';
      context.fillRect(9, 8, 24, 16);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Could not encode the photo fixture.')), 'image/png'),
      );
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });

    const thumbnailBytes = await pageA.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 48;
      canvas.height = 32;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas is unavailable for the thumbnail fixture.');
      context.fillStyle = '#7b2344';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Could not encode the thumbnail fixture.')), 'image/webp'),
      );
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });

    const paddedPhoto = await pageA.evaluate((bytes) => {
      const padded = new Uint8Array(bytes.length + 2 * 1024 * 1024);
      padded.set(bytes);
      return Array.from(padded);
    }, photoBytes);
    const interrupted = await call<boolean>(pageA, 'cancelAttachmentDuringUpload', {
      version: 1,
      id: randomUUID(),
      mode: 'romantic',
      kind: 'media',
      text: 'Interrupted private photo',
      sentAt: Date.now(),
      mediaType: 'image/png',
      mediaName: 'photo.png',
    }, paddedPhoto, 'image/png', 'photo.png', thumbnailBytes);
    expect(interrupted).toBe(true);

    const photo = await call<{
      eventId: string;
      attachment: { url: string; hashes: { sha256: string } };
      thumbnailAttachment?: { url: string };
    }>(pageA, 'sendAttachment', {
      version: 1,
      id: randomUUID(),
      mode: 'romantic',
      kind: 'media',
      text: 'A private photo',
      sentAt: Date.now(),
      mediaType: 'image/png',
      mediaName: 'photo.png',
    }, photoBytes, 'image/png', 'photo.png', thumbnailBytes);
    await waitForValue<boolean>(
      pageB,
      'h => h.getEvents().some(event => event.eventId === args[0])',
      [photo.eventId],
    );
    const photoEvent = await waitForValue<{
      attachment?: { url: string; hashes: { sha256: string } };
      thumbnailAttachment?: { url: string };
      mediaType?: string;
    }>(
      pageB,
      'h => h.getEvents().find(event => event.eventId === args[0])',
      [photo.eventId],
    );
    expect(photoEvent.mediaType).toBe('image/png');
    expect(photoEvent.attachment?.url).toMatch(/^mxc:/);
    expect(photoEvent.thumbnailAttachment?.url).toMatch(/^mxc:/);
    expect(await call<number[]>(pageB, 'downloadAttachment', photo.eventId)).toEqual(photoBytes);
    expect(await call<number[]>(pageB, 'downloadAttachment', photo.eventId, true)).toEqual(thumbnailBytes);
    const storedPhoto = await call<number[]>(pageA, 'downloadStoredCiphertext', photo.attachment.url);
    expect(storedPhoto).not.toEqual(photoBytes);
    expect(createHash('sha256').update(Buffer.from(storedPhoto)).digest('base64url')).toBe(photo.attachment.hashes.sha256);
    expect([401, 403, 404]).toContain(
      await call<number>(pageB, 'unauthenticatedMediaStatus', photo.attachment.url),
    );
    expect(await call<boolean>(pageB, 'rejectsCorruptedAttachment', photo.eventId)).toBe(true);

    const videoBytes = await pageB.evaluate(async () => {
      if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is unavailable for the video fixture.');
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 24;
      const context = canvas.getContext('2d');
      if (!context || typeof canvas.captureStream !== 'function') throw new Error('Video capture is unavailable.');
      const stream = canvas.captureStream(8);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks: Blob[] = [];
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size) chunks.push(event.data);
      });
      const result = new Promise<number[]>((resolve, reject) => {
        recorder.addEventListener('stop', async () => {
          stream.getTracks().forEach((track) => track.stop());
          try {
            const blob = new Blob(chunks, { type: recorder.mimeType });
            resolve(Array.from(new Uint8Array(await blob.arrayBuffer())));
          } catch (error) {
            reject(error);
          }
        }, { once: true });
        recorder.addEventListener('error', () => reject(new Error('Video recording fixture failed.')), { once: true });
      });
      recorder.start();
      const draw = () => {
        context.fillStyle = `hsl(${Math.floor(Math.random() * 360)} 55% 40%)`;
        context.fillRect(0, 0, canvas.width, canvas.height);
      };
      draw();
      const timer = window.setInterval(draw, 80);
      window.setTimeout(() => {
        window.clearInterval(timer);
        recorder.stop();
      }, 700);
      return result;
    });
    expect(videoBytes.length).toBeGreaterThan(0);
    const video = await call<{
      eventId: string;
      attachment: { url: string; hashes: { sha256: string } };
    }>(pageB, 'sendAttachment', {
      version: 1,
      id: randomUUID(),
      mode: 'flirty',
      kind: 'media',
      text: 'A private video',
      sentAt: Date.now(),
      mediaType: 'video/webm',
      mediaName: 'moment.webm',
    }, videoBytes, 'video/webm', 'moment.webm', thumbnailBytes);
    await waitForValue<boolean>(
      pageA,
      'h => h.getEvents().some(event => event.eventId === args[0])',
      [video.eventId],
    );
    expect(await call<number[]>(pageA, 'downloadAttachment', video.eventId)).toEqual(videoBytes);
    const storedVideo = await call<number[]>(pageB, 'downloadStoredCiphertext', video.attachment.url);
    expect(storedVideo).not.toEqual(videoBytes);
    expect(createHash('sha256').update(Buffer.from(storedVideo)).digest('base64url')).toBe(video.attachment.hashes.sha256);

    await call(pageB, 'disconnect');
    const offlineMedia = await call<{ eventId: string }>(pageA, 'sendAttachment', {
      version: 1,
      id: randomUUID(),
      mode: 'spicy',
      kind: 'media',
      text: 'Saved for when you are back',
      sentAt: Date.now(),
      mediaType: 'image/png',
      mediaName: 'offline-photo.png',
    }, photoBytes, 'image/png', 'offline-photo.png', thumbnailBytes);
    await call(pageB, 'connect', sessionB, storageKeyB);
    await waitForValue<boolean>(
      pageB,
      'h => h.getEvents().some(event => event.eventId === args[0])',
      [offlineMedia.eventId],
    );
    expect(await call<number[]>(pageB, 'downloadAttachment', offlineMedia.eventId)).toEqual(photoBytes);
  } finally {
    if (pageA) await call(pageA, 'disconnect');
    if (pageB) await call(pageB, 'disconnect');
    await contextA?.close();
    await contextB?.close();
    storageKeyA.fill(0);
    storageKeyB.fill(0);
    passwordA = '';
    passwordB = '';
  }
});

test('existing isolated partners complete encrypted view-once photo, video, offline, and expiry acceptance', async () => {
  test.setTimeout(600_000);
  let passwordA = await readIsolatedFile('partner1_dev_password');
  let passwordB = await readIsolatedFile('partner2_dev_password');
  const partnerA = matrixConfig.partnerA;
  const partnerB = matrixConfig.partnerB;
  const deviceA = await readIsolatedFile('partner1_dev_device_id');
  const deviceB = await readIsolatedFile('partner2_dev_device_id');
  let contextA: BrowserContext | undefined;
  let contextB: BrowserContext | undefined;
  let pageA: Page | undefined;
  let pageB: Page | undefined;
  let storageKeyA: number[] = [];
  let storageKeyB: number[] = [];
  let sessionA: Session | undefined;
  let sessionB: Session | undefined;

  try {
    ({ context: contextA, page: pageA } = await openPartnerProfile('partner-a'));
    ({ context: contextB, page: pageB } = await openPartnerProfile('partner-b'));
    sessionA = await call<Session>(pageA, 'passwordLogin', partnerA, passwordA, 'NYMPH view-once acceptance A', deviceA);
    sessionB = await call<Session>(pageB, 'passwordLogin', partnerB, passwordB, 'NYMPH view-once acceptance B', deviceB);
    sessionA.roomId = expectedRoomId;
    sessionB.roomId = expectedRoomId;
    storageKeyA = deriveStorageKey(passwordA, partnerA);
    storageKeyB = deriveStorageKey(passwordB, partnerB);
    await call(pageA, 'connect', sessionA, storageKeyA);
    await call(pageB, 'connect', sessionB, storageKeyB);
    expect((await call<{ partnerVerified: boolean }>(pageA, 'refreshSecurity')).partnerVerified).toBe(true);
    expect((await call<{ partnerVerified: boolean }>(pageB, 'refreshSecurity')).partnerVerified).toBe(true);

    const photoBytes = await pageA.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 24;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not create the view-once photo fixture.');
      context.fillStyle = '#9b1c42';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        (value) => value ? resolve(value) : reject(new Error('Could not encode the view-once photo fixture.')),
        'image/png',
      ));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    const photoMessageId = randomUUID();
    const photo = await call<{
      eventId: string;
      attachment: NonNullable<ReceivedNymphEvent['attachment']>;
    }>(pageA, 'sendAttachment', {
      version: 1,
      id: photoMessageId,
      mode: 'romantic',
      kind: 'media',
      text: 'View-once acceptance photo',
      sentAt: Date.now(),
      viewOnceSeconds: 60,
      mediaType: 'image/png',
      mediaName: 'acceptance-photo.png',
    }, photoBytes, 'image/png', 'acceptance-photo.png');
    await waitForValue<boolean>(pageB, 'h => h.getEvents().some(event => event.eventId === args[0])', [photo.eventId]);
    const photoMediaId = mediaIdFromAttachment(photo.attachment);
    const photoStatusBeforeOpen = await call<{ state: string; media_exists: boolean }>(pageA, 'mediaStoreStatus', photoMediaId);
    expect(photoStatusBeforeOpen).toMatchObject({ state: 'pending', media_exists: true });
    await expect(call(pageA, 'downloadAttachmentReference', photo.attachment, 'image/png')).rejects.toThrow();

    const storedPhotoCiphertext = await call<number[]>(
      pageA,
      'downloadStoredCiphertext',
      `mxc://${matrixConfig.serverName}/${photoMediaId}`,
    );
    expect(storedPhotoCiphertext).not.toEqual(photoBytes);

    await expect(call(pageA, 'openEphemeralMediaReference', photo.attachment)).rejects.toThrow();
    const photoExpiry = await call<number>(pageB, 'openEphemeralMedia', photo.eventId);
    expect(await call<{ state: string; media_exists: boolean }>(pageB, 'mediaStoreStatus', photoMediaId))
      .toMatchObject({ state: 'opened', media_exists: true });
    const decryptedPhoto = await call<number[]>(pageB, 'downloadAttachment', photo.eventId);
    const imageSize = await pageB.evaluate(async (bytes) => {
      const image = new Image();
      const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: 'image/png' }));
      try {
        image.src = url;
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      } finally {
        URL.revokeObjectURL(url);
      }
    }, decryptedPhoto);
    expect(imageSize).toEqual({ width: 32, height: 24 });
    await expect(call(pageB, 'openEphemeralMediaReference', photo.attachment)).rejects.toThrow();

    const photoReceiptId = await call<string>(pageB, 'send', {
      version: 1,
      id: randomUUID(),
      mode: 'romantic',
      kind: 'text',
      text: '',
      sentAt: Date.now(),
      viewOnceReceipt: { messageId: photoMessageId, expiresAt: photoExpiry },
    });
    const receivedReceipt = await waitForValue<{
      viewOnceReceipt?: { messageId: string; expiresAt: number };
    }>(pageA, 'h => h.getEvents().find(event => event.eventId === args[0])', [photoReceiptId]);
    expect(receivedReceipt.viewOnceReceipt).toEqual({ messageId: photoMessageId, expiresAt: photoExpiry });

    const videoFixtureBytes = Array.from(new Uint8Array(await readFile(join(process.cwd(), 'tests', 'fixtures', 'view-once-acceptance-video.mp4'))));
    expect(videoFixtureBytes.length).toBeGreaterThan(0);
    const videoMessageId = randomUUID();
    const video = await call<{
      eventId: string;
      attachment: NonNullable<ReceivedNymphEvent['attachment']>;
    }>(pageA, 'sendAttachment', {
      version: 1,
      id: videoMessageId,
      mode: 'flirty',
      kind: 'media',
      text: 'View-once acceptance video',
      sentAt: Date.now(),
      viewOnceSeconds: 60,
      mediaType: 'video/mp4',
      mediaName: 'acceptance-video.mp4',
    }, videoFixtureBytes, 'video/mp4', 'acceptance-video.mp4');
    const videoMediaId = mediaIdFromAttachment(video.attachment);
    await waitForValue<boolean>(pageB, 'h => h.getEvents().some(event => event.eventId === args[0])', [video.eventId]);
    await call(pageB, 'openEphemeralMedia', video.eventId);
    const decryptedVideo = await call<number[]>(pageB, 'downloadAttachment', video.eventId);
    const playbackDuration = await pageB.evaluate(async ({ bytes, type }) => {
      const videoElement = document.createElement('video');
      videoElement.muted = true;
      const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type }));
      try {
        videoElement.src = url;
        await new Promise<void>((resolve, reject) => {
          videoElement.addEventListener('loadedmetadata', () => resolve(), { once: true });
          videoElement.addEventListener('error', () => reject(new Error('The decrypted view-once video could not be decoded.')), { once: true });
        });
        await videoElement.play();
        await new Promise<void>((resolve, reject) => {
          videoElement.addEventListener('ended', () => resolve(), { once: true });
          videoElement.addEventListener('error', () => reject(new Error('The decrypted view-once video could not play.')), { once: true });
        });
        return videoElement.duration;
      } finally {
        videoElement.pause();
        URL.revokeObjectURL(url);
      }
    }, { bytes: decryptedVideo, type: 'video/mp4' });
    expect(playbackDuration).toBeGreaterThan(0);

    const durationMessages: Array<{ mediaId: string; seconds: number }> = [];
    for (const seconds of [5, 10, 15, 30, 60, 7]) {
      const sent = await call<{
        eventId: string;
        attachment: NonNullable<ReceivedNymphEvent['attachment']>;
      }>(pageA, 'sendAttachment', {
        version: 1,
        id: randomUUID(),
        mode: 'romantic',
        kind: 'media',
        text: `View duration ${seconds}`,
        sentAt: Date.now(),
        viewOnceSeconds: seconds,
        mediaType: 'image/png',
        mediaName: `duration-${seconds}.png`,
      }, photoBytes, 'image/png', `duration-${seconds}.png`);
      await waitForValue<boolean>(pageB, 'h => h.getEvents().some(event => event.eventId === args[0])', [sent.eventId]);
      const claimedAt = Date.now();
      const expiresAt = await call<number>(pageB, 'openEphemeralMedia', sent.eventId);
      expect(expiresAt - claimedAt).toBeGreaterThan(seconds * 1000 - 2_000);
      expect(expiresAt - claimedAt).toBeLessThan(seconds * 1000 + 2_000);
      durationMessages.push({ mediaId: mediaIdFromAttachment(sent.attachment), seconds });
    }

    await call(pageB, 'disconnect');
    const unopened = await call<{
      eventId: string;
      attachment: NonNullable<ReceivedNymphEvent['attachment']>;
    }>(pageA, 'sendAttachment', {
      version: 1,
      id: randomUUID(),
      mode: 'romantic',
      kind: 'media',
      text: 'Unopened expiry fixture',
      sentAt: Date.now(),
      viewOnceSeconds: 5,
      mediaType: 'image/png',
      mediaName: 'unopened.png',
    }, photoBytes, 'image/png', 'unopened.png', undefined, 2);
    const unopenedMediaId = mediaIdFromAttachment(unopened.attachment);
    await expect.poll(
      async () => (await call<{ media_exists: boolean }>(pageA, 'mediaStoreStatus', unopenedMediaId)).media_exists,
      { timeout: 20_000, intervals: [1_000, 2_000, 3_000] },
    ).toBe(false);
    await call(pageB, 'connect', sessionB, storageKeyB);
    await expect(call(pageB, 'openEphemeralMediaReference', unopened.attachment)).rejects.toThrow();

    await call(pageB, 'disconnect');
    const offlineMessageId = randomUUID();
    const offline = await call<{
      eventId: string;
      attachment: NonNullable<ReceivedNymphEvent['attachment']>;
    }>(pageA, 'sendAttachment', {
      version: 1,
      id: offlineMessageId,
      mode: 'spicy',
      kind: 'media',
      text: 'Delivered while Partner B was offline',
      sentAt: Date.now(),
      viewOnceSeconds: 60,
      mediaType: 'image/png',
      mediaName: 'offline-view-once.png',
    }, photoBytes, 'image/png', 'offline-view-once.png');
    const offlineMediaId = mediaIdFromAttachment(offline.attachment);
    await call(pageB, 'connect', sessionB, storageKeyB);
    await waitForValue<boolean>(pageB, 'h => h.getEvents().some(event => event.eventId === args[0])', [offline.eventId]);
    const offlineExpiry = await call<number>(pageB, 'openEphemeralMedia', offline.eventId);
    expect(await call<number[]>(pageB, 'downloadAttachment', offline.eventId)).toEqual(photoBytes);
    const offlineReceiptId = await call<string>(pageB, 'send', {
      version: 1,
      id: randomUUID(),
      mode: 'spicy',
      kind: 'text',
      text: '',
      sentAt: Date.now(),
      viewOnceReceipt: { messageId: offlineMessageId, expiresAt: offlineExpiry },
    });
    const offlineReceipt = await waitForValue<{
      viewOnceReceipt?: { messageId: string; expiresAt: number };
    }>(pageA, 'h => h.getEvents().find(event => event.eventId === args[0])', [offlineReceiptId]);
    expect(offlineReceipt.viewOnceReceipt).toEqual({ messageId: offlineMessageId, expiresAt: offlineExpiry });

    await expect.poll(
      async () => {
        const eventIds = [
            ...durationMessages.map(({ mediaId }) => mediaId),
            photoMediaId,
            videoMediaId,
            offlineMediaId,
        ];
        const [statusesA, statusesB] = await Promise.all([
            Promise.all(eventIds.map((mediaId) =>
              call<{ state: string; media_exists: boolean }>(pageA, 'mediaStoreStatus', mediaId),
          )),
            Promise.all(eventIds.map((mediaId) =>
              call<{ state: string; media_exists: boolean }>(pageB, 'mediaStoreStatus', mediaId),
          )),
        ]);
        return [...statusesA, ...statusesB].every((status) => status.state === 'deleted' && !status.media_exists);
      },
      { timeout: 100_000, intervals: [1_000, 3_000, 5_000] },
    ).toBe(true);
    await expect(call(pageB, 'openEphemeralMediaReference', photo.attachment)).rejects.toThrow();
    await expect(call(pageB, 'openEphemeralMediaReference', video.attachment)).rejects.toThrow();
    await expect(call(pageB, 'openEphemeralMediaReference', offline.attachment)).rejects.toThrow();
    expect(await call<{ state: string; media_exists: boolean }>(pageA, 'mediaStoreStatus', photoMediaId))
      .toMatchObject({ state: 'deleted', media_exists: false });
  } finally {
    if (pageA) await call(pageA, 'disconnect').catch(() => undefined);
    if (pageB) await call(pageB, 'disconnect').catch(() => undefined);
    await contextA?.close();
    await contextB?.close();
    storageKeyA.fill(0);
    storageKeyB.fill(0);
    passwordA = '';
    passwordB = '';
  }
});

test('existing isolated partners synchronize server retention, Never, offline expiry, relations, and restart jobs', async () => {
  test.setTimeout(600_000);
  let passwordA = await readIsolatedFile('partner1_dev_password');
  let passwordB = await readIsolatedFile('partner2_dev_password');
  const partnerA = matrixConfig.partnerA;
  const partnerB = matrixConfig.partnerB;
  const deviceA = await readIsolatedFile('partner1_dev_device_id');
  const deviceB = await readIsolatedFile('partner2_dev_device_id');
  const recoveryExportA = join(secretDirectory, 'partner1_dev_recovery.enc');
  const recoveryExportB = join(secretDirectory, 'partner2_dev_recovery.enc');
  let contextA: BrowserContext | undefined;
  let contextB: BrowserContext | undefined;
  let pageA: Page | undefined;
  let pageB: Page | undefined;
  let storageKeyA: number[] = [];
  let storageKeyB: number[] = [];
  let sessionA: Session | undefined;
  let sessionB: Session | undefined;
  let previousPolicy: number | null = null;
  let policyChanged = false;

  const policyEnvelope = (seconds: number | null) => ({
    version: 1 as const,
    id: randomUUID(),
    mode: 'romantic' as const,
    kind: 'text' as const,
    text: '',
    sentAt: Date.now(),
    retentionPolicy: { seconds },
  });

  try {
    ({ context: contextA, page: pageA } = await openPartnerProfile('partner-a'));
    ({ context: contextB, page: pageB } = await openPartnerProfile('partner-b'));
    sessionA = await call<Session>(pageA, 'passwordLogin', partnerA, passwordA, 'NYMPH retention acceptance A', deviceA);
    sessionB = await call<Session>(pageB, 'passwordLogin', partnerB, passwordB, 'NYMPH retention acceptance B', deviceB);
    sessionA.roomId = expectedRoomId;
    sessionB.roomId = expectedRoomId;
    storageKeyA = deriveStorageKey(passwordA, partnerA);
    storageKeyB = deriveStorageKey(passwordB, partnerB);
    await call(pageA, 'connect', sessionA, storageKeyA);
    await call(pageB, 'connect', sessionB, storageKeyB);
    await restoreExistingCrossSigningForCurrentDevice(pageA, partnerA, passwordA, recoveryExportA);
    await restoreExistingCrossSigningForCurrentDevice(pageB, partnerB, passwordB, recoveryExportB);
    expect((await call<{ partnerVerified: boolean }>(pageA, 'refreshSecurity')).partnerVerified).toBe(true);
    expect((await call<{ partnerVerified: boolean }>(pageB, 'refreshSecurity')).partnerVerified).toBe(true);
    previousPolicy = (await call<{ seconds: number | null }>(pageA, 'getRetentionPolicy')).seconds;

    const neverPolicyId = await call<string>(pageA, 'send', policyEnvelope(null));
    policyChanged = true;
    await waitForValue<boolean>(pageB, 'h => h.getEvents().some(event => event.eventId === args[0])', [neverPolicyId]);
    expect(await call<{ seconds: number | null }>(pageA, 'getRetentionPolicy')).toMatchObject({ seconds: null });
    expect(await call<{ seconds: number | null }>(pageB, 'getRetentionPolicy')).toMatchObject({ seconds: null });
    const neverMessageId = await call<string>(pageA, 'send', {
      version: 1,
      id: randomUUID(),
      mode: 'romantic',
      kind: 'text',
      text: 'Never-retained live acceptance event',
      sentAt: Date.now(),
    });
    await waitForValue<boolean>(pageB, 'h => h.getEvents().some(event => event.eventId === args[0])', [neverMessageId]);
    await expect.poll(
      async () => (await call<{ state: string }>(pageA, 'messageExpiryStatus', neverMessageId)).state,
    ).toBe('never');
    await pageA.waitForTimeout(6_000);
    expect(await call<string[]>(pageA, 'getRedactedEventIds')).not.toContain(neverMessageId);
    expect(await call<string[]>(pageB, 'getRedactedEventIds')).not.toContain(neverMessageId);
    expect(await call<unknown[]>(pageA, 'getEvents')).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: neverMessageId }),
    ]));

    const customPolicyId = await call<string>(pageA, 'send', policyEnvelope(2));
    await waitForValue<boolean>(pageB, 'h => h.getEvents().some(event => event.eventId === args[0])', [customPolicyId]);
    expect(await call<{ seconds: number | null }>(pageB, 'getRetentionPolicy')).toMatchObject({ seconds: 2 });
    const offlineMessageId = await (async () => {
      await call(pageB, 'disconnect');
      return call<string>(pageA, 'send', {
        version: 1,
        id: randomUUID(),
        mode: 'flirty',
        kind: 'text',
        text: 'Offline recipient expiry fixture',
        sentAt: Date.now(),
      });
    })();
    expect(await call<{ state: string }>(pageA, 'messageExpiryStatus', offlineMessageId)).toMatchObject({ state: 'scheduled' });
    await expect.poll(
      async () => (await call<{ state: string }>(pageA, 'messageExpiryStatus', offlineMessageId)).state,
      { timeout: 20_000, intervals: [1_000, 2_000, 3_000] },
    ).toBe('redacted');
    await call(pageB, 'connect', sessionB, storageKeyB);
    await waitForValue<boolean>(
      pageB,
      'h => h.getRedactedEventIds().includes(args[0])',
      [offlineMessageId],
    );
    expect(await call<string[]>(pageA, 'redactedContentKeys', offlineMessageId))
      .not.toContain('ciphertext');

    const restartPolicyId = await call<string>(pageA, 'send', policyEnvelope(15));
    await waitForValue<boolean>(pageB, 'h => h.getEvents().some(event => event.eventId === args[0])', [restartPolicyId]);
    const parentEventId = await call<string>(pageA, 'send', {
      version: 1,
      id: randomUUID(),
      mode: 'spicy',
      kind: 'text',
      text: 'Parent message with server expiry',
      sentAt: Date.now(),
    });
    await waitForValue<boolean>(pageB, 'h => h.getEvents().some(event => event.eventId === args[0])', [parentEventId]);
    const replyEventId = await call<string>(pageB, 'send', {
      version: 1,
      id: randomUUID(),
      mode: 'spicy',
      kind: 'text',
      text: 'Reply expires with its parent',
      sentAt: Date.now(),
      replyToEventId: parentEventId,
    });
    const reactionEventId = await call<string>(pageB, 'send', {
      version: 1,
      id: randomUUID(),
      mode: 'spicy',
      kind: 'reaction',
      text: '❤️',
      sentAt: Date.now(),
      reactionTo: parentEventId,
    });
    await waitForValue<boolean>(pageA, 'h => h.getEvents().some(event => event.eventId === args[0])', [replyEventId]);
    await waitForValue<boolean>(pageA, 'h => h.getEvents().some(event => event.eventId === args[0])', [reactionEventId]);
    for (const eventId of [parentEventId, replyEventId, reactionEventId]) {
      expect(await call<{ state: string }>(pageA, 'messageExpiryStatus', eventId))
        .toMatchObject({ state: 'scheduled' });
    }

    await restartExistingIsolatedSynapse(pageA);
    for (const eventId of [parentEventId, replyEventId, reactionEventId]) {
      await expect.poll(
        async () => (await call<{ state: string }>(pageA, 'messageExpiryStatus', eventId)).state,
        { timeout: 30_000, intervals: [1_000, 2_000, 3_000] },
      ).toBe('redacted');
      await waitForValue<boolean>(
        pageA,
        'h => h.getRedactedEventIds().includes(args[0])',
        [eventId],
        60_000,
      );
      await waitForValue<boolean>(
        pageB,
        'h => h.getRedactedEventIds().includes(args[0])',
        [eventId],
        60_000,
      );
    }
    expect(await call<string[]>(pageA, 'redactedContentKeys', parentEventId))
      .not.toContain('ciphertext');
  } finally {
    if (pageA && policyChanged && previousPolicy !== null) {
      try {
        await call(pageA, 'send', policyEnvelope(previousPolicy));
      } catch (error) {
        console.error('Could not restore the pre-acceptance retention policy.', error);
      }
    } else if (pageA && policyChanged && previousPolicy === null) {
      try {
        await call(pageA, 'send', policyEnvelope(null));
      } catch (error) {
        console.error('Could not restore Never retention after acceptance.', error);
      }
    }
    if (pageA) await call(pageA, 'disconnect').catch(() => undefined);
    if (pageB) await call(pageB, 'disconnect').catch(() => undefined);
    await contextA?.close();
    await contextB?.close();
    storageKeyA.fill(0);
    storageKeyB.fill(0);
    passwordA = '';
    passwordB = '';
  }
});

test('isolated partners exchange encrypted voice messages and private sticker-pack assets', async () => {
  test.setTimeout(600_000);
  let passwordA = await readIsolatedFile('partner1_dev_password');
  let passwordB = await readIsolatedFile('partner2_dev_password');
  const partnerA = matrixConfig.partnerA;
  const partnerB = matrixConfig.partnerB;
  const deviceA = await readIsolatedFile('partner1_dev_device_id');
  const deviceB = await readIsolatedFile('partner2_dev_device_id');
  let contextA: BrowserContext | undefined;
  let contextB: BrowserContext | undefined;
  let pageA: Page | undefined;
  let pageB: Page | undefined;
  let storageKeyA: number[] = [];
  let storageKeyB: number[] = [];
  let sessionA: Session | undefined;
  let sessionB: Session | undefined;

  try {
    ({ context: contextA, page: pageA } = await openPartnerProfile('partner-a'));
    ({ context: contextB, page: pageB } = await openPartnerProfile('partner-b'));
    sessionA = await call<Session>(pageA, 'passwordLogin', partnerA, passwordA, 'NYMPH voice and sticker acceptance A', deviceA);
    sessionB = await call<Session>(pageB, 'passwordLogin', partnerB, passwordB, 'NYMPH voice and sticker acceptance B', deviceB);
    sessionA.roomId = expectedRoomId;
    sessionB.roomId = expectedRoomId;
    storageKeyA = deriveStorageKey(passwordA, partnerA);
    storageKeyB = deriveStorageKey(passwordB, partnerB);
    await call(pageA, 'connect', sessionA, storageKeyA);
    await call(pageB, 'connect', sessionB, storageKeyB);
    expect((await call<{ partnerVerified: boolean }>(pageA, 'refreshSecurity')).partnerVerified).toBe(true);
    expect((await call<{ partnerVerified: boolean }>(pageB, 'refreshSecurity')).partnerVerified).toBe(true);

    const audioBytes = await pageA.evaluate(async () => {
      if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is unavailable for voice acceptance.');
      const audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      const oscillator = audioContext.createOscillator();
      oscillator.frequency.value = 440;
      oscillator.connect(destination);
      oscillator.connect(audioContext.destination);
      const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
        .find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(destination.stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size) chunks.push(event.data);
      });
      const recorded = new Promise<number[]>((resolve, reject) => {
        recorder.addEventListener('stop', async () => {
          oscillator.stop();
          destination.stream.getTracks().forEach((track) => track.stop());
          await audioContext.close();
          try {
            const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
            resolve(Array.from(new Uint8Array(await blob.arrayBuffer())));
          } catch (error) {
            reject(error);
          }
        }, { once: true });
        recorder.addEventListener('error', () => reject(new Error('Voice fixture recording failed.')), { once: true });
      });
      await audioContext.resume();
      if (audioContext.state !== 'running') throw new Error('The audio fixture context did not start.');
      oscillator.start();
      recorder.start(100);
      window.setTimeout(() => recorder.stop(), 1000);
      return recorded;
    });
    expect(audioBytes.length).toBeGreaterThan(0);
    const playDecryptedVoice = (page: Page, bytes: number[]) => page.evaluate(async (rawBytes) => {
      const url = URL.createObjectURL(new Blob([Uint8Array.from(rawBytes)], { type: 'audio/webm' }));
      const audio = new Audio();
      audio.muted = true;
      const metadata = new Promise<void>((resolve, reject) => {
        audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
        audio.addEventListener('error', () => reject(new Error('Decrypted voice message could not be decoded for playback.')), { once: true });
      });
      audio.src = url;
      try {
        await metadata;
        const duration = audio.duration;
        await audio.play();
        await new Promise<void>((resolve, reject) => {
          audio.addEventListener('ended', () => resolve(), { once: true });
          audio.addEventListener('error', () => reject(new Error('Decrypted voice playback failed.')), { once: true });
        });
        return duration;
      } finally {
        audio.pause();
        URL.revokeObjectURL(url);
      }
    }, bytes);
    const retryAudio = Buffer.alloc(1_100_044);
    const retryDataSize = retryAudio.length - 44;
    retryAudio.write('RIFF', 0);
    retryAudio.writeUInt32LE(retryAudio.length - 8, 4);
    retryAudio.write('WAVEfmt ', 8);
    retryAudio.writeUInt32LE(16, 16);
    retryAudio.writeUInt16LE(1, 20);
    retryAudio.writeUInt16LE(1, 22);
    retryAudio.writeUInt32LE(8000, 24);
    retryAudio.writeUInt32LE(16000, 28);
    retryAudio.writeUInt16LE(2, 32);
    retryAudio.writeUInt16LE(16, 34);
    retryAudio.write('data', 36);
    retryAudio.writeUInt32LE(retryDataSize, 40);
    for (let offset = 44; offset < retryAudio.length; offset += 2) {
      retryAudio.writeInt16LE(Math.round(Math.sin((offset - 44) / 16000 * Math.PI * 2 * 440) * 32767), offset);
    }
    const retryEnvelope = {
      version: 1 as const,
      id: randomUUID(),
      mode: 'romantic' as const,
      kind: 'media' as const,
      text: 'Interrupted voice upload retry',
      sentAt: Date.now(),
      durationMs: Math.round(retryDataSize / 16000 * 1000),
      mediaType: 'audio/wav',
      mediaName: 'voice-retry.wav',
    };
    expect(await call<boolean>(pageA, 'cancelAttachmentDuringUpload', {
      ...retryEnvelope,
    }, Array.from(retryAudio), 'audio/wav', 'voice-retry.wav')).toBe(true);
    const retriedVoice = await call<{ eventId: string }>(
      pageA,
      'sendAttachment',
      retryEnvelope,
      Array.from(retryAudio),
      'audio/wav',
      'voice-retry.wav',
    );
    await waitForValue<boolean>(pageB, 'h => h.getEvents().some(event => event.eventId === args[0])', [retriedVoice.eventId]);
    expect(await call<number[]>(pageB, 'downloadAttachment', retriedVoice.eventId)).toEqual(Array.from(retryAudio));

    await call(pageB, 'disconnect');
    const voiceA = await call<{ eventId: string; attachment: { url: string; hashes: { sha256: string } } }>(
      pageA,
      'sendAttachment',
      {
        version: 1,
        id: randomUUID(),
        mode: 'romantic',
        kind: 'media',
        text: 'A private voice message',
        sentAt: Date.now(),
        durationMs: 1000,
        waveform: [0.2, 0.4, 0.8, 1],
        mediaType: 'audio/webm',
        mediaName: 'voice-note.webm',
      },
      audioBytes,
      'audio/webm',
      'voice-note.webm',
    );
    await call(pageB, 'connect', sessionB, storageKeyB);
    await waitForValue<boolean>(pageB, 'h => h.getEvents().some(event => event.eventId === args[0])', [voiceA.eventId]);
    const receivedVoiceA = await waitForValue<{ durationMs?: number; mediaType?: string; waveform?: number[] }>(
      pageB,
      'h => h.getEvents().find(event => event.eventId === args[0])',
      [voiceA.eventId],
    );
    expect(receivedVoiceA.durationMs).toBe(1000);
    expect(receivedVoiceA.mediaType).toBe('audio/webm');
    expect(receivedVoiceA.waveform).toEqual([0.2, 0.4, 0.8, 1]);
    const decryptedVoiceA = await call<number[]>(pageB, 'downloadAttachment', voiceA.eventId);
    expect(decryptedVoiceA).toEqual(audioBytes);
    expect(await playDecryptedVoice(pageB, decryptedVoiceA)).toBeGreaterThan(0);
    expect(await call<boolean>(pageB, 'rejectsCorruptedAttachment', voiceA.eventId)).toBe(true);
    const storedVoice = await call<number[]>(pageA, 'downloadStoredCiphertext', voiceA.attachment.url);
    expect(storedVoice).not.toEqual(audioBytes);
    expect(createHash('sha256').update(Buffer.from(storedVoice)).digest('base64url')).toBe(voiceA.attachment.hashes.sha256);

    const voiceB = await call<{ eventId: string }>(
      pageB,
      'sendAttachment',
      {
        version: 1,
        id: randomUUID(),
        mode: 'flirty',
        kind: 'media',
        text: 'A voice reply',
        sentAt: Date.now(),
        durationMs: 1000,
        waveform: [0.3, 0.7, 0.5, 0.9],
        mediaType: 'audio/webm',
        mediaName: 'voice-reply.webm',
      },
      audioBytes,
      'audio/webm',
      'voice-reply.webm',
    );
    await waitForValue<boolean>(pageA, 'h => h.getEvents().some(event => event.eventId === args[0])', [voiceB.eventId]);
    const decryptedVoiceB = await call<number[]>(pageA, 'downloadAttachment', voiceB.eventId);
    expect(decryptedVoiceB).toEqual(audioBytes);
    expect(await playDecryptedVoice(pageA, decryptedVoiceB)).toBeGreaterThan(0);

    const stickerBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=',
      'base64',
    );
    const packId = randomUUID();
    const stickerId = randomUUID();
    await call(pageB, 'disconnect');
    const sticker = await call<{ eventId: string; attachment: { url: string; hashes: { sha256: string } } }>(
      pageA,
      'sendAttachment',
      {
        version: 1,
        id: randomUUID(),
        mode: 'kinky',
        kind: 'sticker',
        text: '',
        sentAt: Date.now(),
        stickerSync: {
          operation: 'pack-upsert',
          packId,
          packName: 'Private fantasy',
          adult: true,
          description: 'Partner-only collection',
          categories: ['Fantasy'],
          stickerId,
          stickerName: 'Moon',
          stickerType: 'image/png',
        },
        mediaType: 'image/png',
        mediaName: 'private-sticker.png',
      },
      Array.from(stickerBytes),
      'image/png',
      'private-sticker.png',
    );
    await call(pageB, 'connect', sessionB, storageKeyB);
    await waitForValue<boolean>(pageB, 'h => h.getEvents().some(event => event.eventId === args[0])', [sticker.eventId]);
    const receivedSticker = await waitForValue<{
      kind: string;
      mode: string;
      stickerSync?: { packId: string; adult: boolean; stickerId?: string };
    }>(pageB, 'h => h.getEvents().find(event => event.eventId === args[0])', [sticker.eventId]);
    expect(receivedSticker.kind).toBe('sticker');
    expect(receivedSticker.mode).toBe('kinky');
    expect(receivedSticker.stickerSync).toMatchObject({ packId, adult: true, stickerId });
    expect(await call<number[]>(pageB, 'downloadAttachment', sticker.eventId)).toEqual(Array.from(stickerBytes));
    const storedSticker = await call<number[]>(pageA, 'downloadStoredCiphertext', sticker.attachment.url);
    expect(storedSticker).not.toEqual(Array.from(stickerBytes));
    expect(createHash('sha256').update(Buffer.from(storedSticker)).digest('base64url')).toBe(sticker.attachment.hashes.sha256);

    const gifBytes = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64');
    const gifPackId = randomUUID();
    const gifId = randomUUID();
    const gif = await call<{ eventId: string; attachment: { url: string; hashes: { sha256: string } } }>(
      pageB,
      'sendAttachment',
      {
        version: 1,
        id: randomUUID(),
        mode: 'romantic',
        kind: 'sticker',
        text: '',
        sentAt: Date.now(),
        stickerSync: {
          operation: 'pack-upsert',
          packId: gifPackId,
          packName: 'Love loops',
          adult: false,
          description: 'Everyday moments',
          categories: ['Kisses'],
          stickerId: gifId,
          stickerName: 'Tiny loop',
          stickerType: 'image/gif',
        },
        mediaType: 'image/gif',
        mediaName: 'private-loop.gif',
      },
      Array.from(gifBytes),
      'image/gif',
      'private-loop.gif',
    );
    const receivedGif = await waitForValue<{
      mode: string;
      stickerSync?: { packId: string; adult: boolean; stickerId?: string };
    }>(pageA, 'h => h.getEvents().find(event => event.eventId === args[0])', [gif.eventId]);
    expect(receivedGif.mode).toBe('romantic');
    expect(receivedGif.stickerSync).toMatchObject({ packId: gifPackId, adult: false, stickerId: gifId });
    expect(await call<number[]>(pageA, 'downloadAttachment', gif.eventId)).toEqual(Array.from(gifBytes));
    const storedGif = await call<number[]>(pageB, 'downloadStoredCiphertext', gif.attachment.url);
    expect(storedGif).not.toEqual(Array.from(gifBytes));
    expect(createHash('sha256').update(Buffer.from(storedGif)).digest('base64url')).toBe(gif.attachment.hashes.sha256);

    const renamedPackEventId = await call<string>(pageB, 'send', {
      version: 1,
      id: randomUUID(),
      mode: 'romantic',
      kind: 'sticker',
      text: '',
      sentAt: Date.now(),
      stickerSync: {
        operation: 'pack-upsert',
        packId: gifPackId,
        packName: 'Love loops renamed',
        adult: false,
        description: 'Our everyday collection',
        categories: ['Kisses', 'Love'],
      },
    });
    const renamedPackEvent = await waitForValue<{
      mode: string;
      stickerSync?: { packId: string; packName: string; adult: boolean };
    }>(pageA, 'h => h.getEvents().find(event => event.eventId === args[0])', [renamedPackEventId]);
    expect(renamedPackEvent.mode).toBe('romantic');
    expect(renamedPackEvent.stickerSync).toMatchObject({
      packId: gifPackId,
      packName: 'Love loops renamed',
      adult: false,
    });

    for (const stickerSync of [
      { operation: 'favorite' as const, stickerId: gifId, active: true },
      { operation: 'recent' as const, stickerId: gifId },
    ]) {
      const eventId = await call<string>(pageB, 'send', {
        version: 1,
        id: randomUUID(),
        mode: 'romantic',
        kind: 'sticker',
        text: '',
        sentAt: Date.now(),
        stickerSync,
      });
      const syncedEvent = await waitForValue<{
        mode: string;
        stickerSync?: { operation: string; stickerId: string };
      }>(pageA, 'h => h.getEvents().find(event => event.eventId === args[0])', [eventId]);
      expect(syncedEvent.mode).toBe('romantic');
      expect(syncedEvent.stickerSync).toMatchObject({
        operation: stickerSync.operation,
        stickerId: gifId,
      });
    }

    await call(pageB, 'disconnect');
    const offlineStickerBytes = Buffer.from(stickerBytes);
    const offlineStickerId = randomUUID();
    const offlineSticker = await call<{ eventId: string }>(
      pageA,
      'sendAttachment',
      {
        version: 1,
        id: randomUUID(),
        mode: 'romantic',
        kind: 'sticker',
        text: '',
        sentAt: Date.now(),
        stickerSync: {
          operation: 'pack-upsert',
          packId: gifPackId,
          packName: 'Love loops renamed',
          adult: false,
          description: 'Our everyday collection',
          categories: ['Kisses', 'Love'],
          stickerId: offlineStickerId,
          stickerName: 'Offline heart',
          stickerType: 'image/png',
        },
        mediaType: 'image/png',
        mediaName: 'offline-heart.png',
      },
      Array.from(offlineStickerBytes),
      'image/png',
      'offline-heart.png',
    );
    await call(pageB, 'connect', sessionB, storageKeyB);
    await waitForValue<boolean>(
      pageB,
      'h => h.getEvents().some(event => event.eventId === args[0])',
      [offlineSticker.eventId],
    );
    expect(await call<number[]>(pageB, 'downloadAttachment', offlineSticker.eventId))
      .toEqual(Array.from(offlineStickerBytes));

    await call(pageA, 'disconnect');
    await call(pageB, 'disconnect');
    await contextA.close();
    contextA = undefined;
    pageA = undefined;
    await contextB.close();
    contextB = undefined;
    pageB = undefined;

    ({ context: contextA, page: pageA } = await openPartnerProfile('partner-a'));
    ({ context: contextB, page: pageB } = await openPartnerProfile('partner-b'));
    const restartedSessionA = await call<Session>(
      pageA,
      'passwordLogin',
      partnerA,
      passwordA,
      'NYMPH voice and sticker restart A',
      deviceA,
    );
    const restartedSessionB = await call<Session>(
      pageB,
      'passwordLogin',
      partnerB,
      passwordB,
      'NYMPH voice and sticker restart B',
      deviceB,
    );
    expect(restartedSessionA.deviceId).toBe(deviceA);
    expect(restartedSessionB.deviceId).toBe(deviceB);
    restartedSessionA.roomId = expectedRoomId;
    restartedSessionB.roomId = expectedRoomId;
    await call(pageA, 'connect', restartedSessionA, storageKeyA);
    await call(pageB, 'connect', restartedSessionB, storageKeyB);
    expect((await call<{ partnerVerified: boolean }>(pageA, 'refreshSecurity')).partnerVerified).toBe(true);
    expect((await call<{ partnerVerified: boolean }>(pageB, 'refreshSecurity')).partnerVerified).toBe(true);
    for (const eventId of [voiceA.eventId, voiceB.eventId, sticker.eventId, gif.eventId, offlineSticker.eventId]) {
      await waitForValue<boolean>(
        eventId === voiceB.eventId || eventId === gif.eventId || eventId === offlineSticker.eventId ? pageB : pageA,
        'h => h.getEvents().some(event => event.eventId === args[0])',
        [eventId],
      );
    }
    expect(await call<number[]>(pageA, 'downloadAttachment', voiceB.eventId)).toEqual(audioBytes);
    expect(await call<number[]>(pageB, 'downloadAttachment', voiceA.eventId)).toEqual(audioBytes);
    expect(await call<number[]>(pageB, 'downloadAttachment', sticker.eventId)).toEqual(Array.from(stickerBytes));
    expect(await call<number[]>(pageA, 'downloadAttachment', gif.eventId)).toEqual(Array.from(gifBytes));
    expect(await call<number[]>(pageB, 'downloadAttachment', offlineSticker.eventId))
      .toEqual(Array.from(offlineStickerBytes));
  } finally {
    if (pageA) await call(pageA, 'disconnect');
    if (pageB) await call(pageB, 'disconnect');
    await contextA?.close();
    await contextB?.close();
    storageKeyA.fill(0);
    storageKeyB.fill(0);
    passwordA = '';
    passwordB = '';
  }
});

test('authorized temporary-device revocation stays separate from core messaging', async () => {
  test.setTimeout(180_000);
  let password = await readIsolatedFile('partner1_dev_password');
  const userId = matrixConfig.partnerA;
  const deviceId = await readIsolatedFile('partner1_dev_device_id');
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let storageKey: number[] = [];

  try {
    ({ context, page } = await openPartnerProfile('partner-a'));
    const session = await call<Session>(
      page,
      'passwordLogin',
      userId,
      password,
      'NYMPH authorized lifecycle acceptance',
      deviceId,
    );
    session.roomId = expectedRoomId;
    storageKey = deriveStorageKey(password, userId);
    await call(page, 'connect', session, storageKey);
    const membersBefore = await call<string[]>(page, 'joinedMembers', session, expectedRoomId);
    expect(membersBefore).toEqual([matrixConfig.partnerA, matrixConfig.partnerB].sort());

    await call(page, 'revokeAuthorizedTemporaryDevice', password);

    const membersAfter = await call<string[]>(page, 'joinedMembers', session, expectedRoomId);
    expect(membersAfter).toEqual(membersBefore);
  } finally {
    if (page) await call(page, 'disconnect');
    await context?.close();
    storageKey.fill(0);
    password = '';
  }
});
