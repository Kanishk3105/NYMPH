import { BrowserQRCodeReader } from '@zxing/browser';
import type { IScannerControls } from '@zxing/browser';
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import QRCode from 'qrcode';
import { decryptRecoveryExport, encryptRecoveryExport } from './recovery-export';
import { PARTNER_IDENTITIES } from './partner-identity';
import type {
  MatrixMessagingClient,
  MatrixSecurityState,
  MatrixVerification,
} from './MessagingClient';

interface MatrixSecurityPanelProps {
  client: MatrixMessagingClient | null;
  security: MatrixSecurityState | null;
  verification: MatrixVerification | null;
  onRefresh(): void;
  onNotify(message: string): void;
}

export function MatrixSecurityPanel({
  client,
  security,
  verification,
  onRefresh,
  onNotify,
}: MatrixSecurityPanelProps) {
  const [password, setPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [recoveryConfirmation, setRecoveryConfirmation] = useState('');
  const [existingRecoveryKey, setExistingRecoveryKey] = useState('');
  const [recoveryVerificationKey, setRecoveryVerificationKey] = useState('');
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [exportConfirmation, setExportConfirmation] = useState('');
  const [partnerSelection, setPartnerSelection] = useState('');
  const [recoveryKeyId, setRecoveryKeyId] = useState('');
  const [crossSigningSetup, setCrossSigningSetup] = useState(false);
  const [verifiedRecoveryKeyId, setVerifiedRecoveryKeyId] = useState('');
  const [recoveryKeyVisible, setRecoveryKeyVisible] = useState(false);
  const [verificationQr, setVerificationQr] = useState('');
  const [scanOpen, setScanOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<IScannerControls | null>(null);
  const recoveryImportRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPartnerSelection(security?.userId ?? '');
    setRecoveryKey('');
    setRecoveryConfirmation('');
    setExistingRecoveryKey('');
    setRecoveryVerificationKey('');
    setExportPassphrase('');
    setExportConfirmation('');
    setRecoveryKeyId('');
    setCrossSigningSetup(false);
    setVerifiedRecoveryKeyId('');
    setPassword('');
    setRecoveryKeyVisible(false);
  }, [security?.userId]);

  useEffect(() => () => client?.discardPendingSecretStorageKey(), [client]);

  function assertSelectedPartner(): boolean {
    if (!security?.userId || partnerSelection !== security.userId) {
      onNotify('Select the partner account currently signed in on this device.');
      return false;
    }
    return true;
  }

  async function prepareRecoveryKey() {
    if (!client || !assertSelectedPartner()) return;
    setBusy(true);
    try {
      const key = await client.prepareSecretStorageSetup();
      setRecoveryKey(key);
      setRecoveryConfirmation('');
      setRecoveryKeyId('');
      setCrossSigningSetup(false);
      setVerifiedRecoveryKeyId('');
      setRecoveryKeyVisible(false);
      onNotify('A new key was generated locally. It has not been uploaded to Matrix yet.');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not prepare Secret Storage.');
    } finally {
      setBusy(false);
    }
  }

  async function exportEncryptedRecoveryKey() {
    if (!recoveryKey || !security?.userId) return;
    if (exportPassphrase.length < 12 || exportConfirmation !== exportPassphrase) {
      onNotify('Use a 12-character-or-longer export passphrase and confirm it exactly.');
      return;
    }
    setBusy(true);
    try {
      const contents = await encryptRecoveryExport({
        account: security.userId,
        keyId: recoveryKeyId || security.defaultSecretStorageKeyId,
        recoveryKey,
      }, exportPassphrase);
      const blob = new Blob([contents], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'nymph-matrix-recovery.enc';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setExportPassphrase('');
      setExportConfirmation('');
      onNotify('Encrypted recovery export downloaded. Keep its passphrase separately and offline.');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not encrypt the recovery export.');
    } finally {
      setBusy(false);
    }
  }

  async function importEncryptedRecoveryFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file || !security) return;
    if (!exportPassphrase) {
      onNotify('Enter the encrypted export passphrase first.');
      input.value = '';
      return;
    }
    setBusy(true);
    try {
      const contents = await decryptRecoveryExport(await file.text(), exportPassphrase);
      if (contents.account !== security.userId) {
        throw new Error('This encrypted recovery export belongs to a different Matrix account.');
      }
      if (
        contents.keyId &&
        contents.keyId !== security.defaultSecretStorageKeyId
      ) {
        throw new Error('This encrypted recovery export does not match the account default Secret Storage key.');
      }
      if (!security.defaultSecretStorageKeyId) {
        throw new Error('This account has no committed Secret Storage key to recover.');
      }
      setExistingRecoveryKey(contents.recoveryKey);
      setRecoveryVerificationKey(contents.recoveryKey);
      setExportPassphrase('');
      setExportConfirmation('');
      onNotify('Encrypted recovery export imported for the signed-in partner account.');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not import the encrypted recovery export.');
    } finally {
      input.value = '';
      setBusy(false);
    }
  }

  async function confirmNewRecoveryKey() {
    if (!client || !assertSelectedPartner()) return;
    if (!recoveryKeyId && recoveryConfirmation !== recoveryKey) {
      onNotify('The confirmation must exactly match the displayed recovery key.');
      return;
    }
    if (!password) {
      onNotify('Enter this Matrix account password to complete cross-signing setup.');
      return;
    }
    setBusy(true);
    try {
      if (!recoveryKeyId) {
        const keyId = await client.commitSecretStorageSetup(recoveryConfirmation);
        setRecoveryKeyId(keyId);
        setRecoveryConfirmation('');
        setPassword('');
        setCrossSigningSetup(false);
        onRefresh();
        onNotify(`The recovery key is confirmed for ${security?.userId}. Export it again now to include key ID ${keyId}, then continue cross-signing.`);
        return;
      }
      if (!crossSigningSetup) {
        await client.bootstrapSecurity(password);
        setCrossSigningSetup(true);
        setPassword('');
        onRefresh();
        onNotify('Cross-signing is ready. Re-enter the recovery key and account password to verify restoration on a separate temporary Matrix device.');
        return;
      }
      if (!recoveryVerificationKey) {
        onNotify('Re-enter the recovery key to verify it on a separate Matrix device.');
        return;
      }
      const verifiedKeyId = await client.verifyRecoveryOnSeparateDevice(recoveryVerificationKey, password);
      setVerifiedRecoveryKeyId(verifiedKeyId);
      setPassword('');
      setRecoveryVerificationKey('');
      setRecoveryConfirmation('');
      setRecoveryKey('');
      setRecoveryKeyVisible(false);
      setExportPassphrase('');
      setExportConfirmation('');
      onRefresh();
      onNotify(`Recovery was restored on a separate Matrix device and verified for ${security?.userId}. Temporary verification device revoked.`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not configure Matrix security.');
    } finally {
      setBusy(false);
    }
  }

  async function verifyExistingRecoveryKey() {
    if (!client || !assertSelectedPartner()) return;
    if (!recoveryVerificationKey || !password) {
      onNotify('Enter this account’s recovery key and Matrix password to verify recovery.');
      return;
    }
    setBusy(true);
    try {
      const verifiedKeyId = await client.verifyRecoveryOnSeparateDevice(recoveryVerificationKey, password);
      setVerifiedRecoveryKeyId(verifiedKeyId);
      setRecoveryVerificationKey('');
      setExistingRecoveryKey('');
      setPassword('');
      setExportPassphrase('');
      onRefresh();
      onNotify(`Recovery was restored on a separate Matrix device and verified for ${security?.userId}.`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not verify recovery on a separate Matrix device.');
    } finally {
      setBusy(false);
    }
  }

  async function recoverExistingKeys() {
    if (!client || !assertSelectedPartner()) return;
    if (!existingRecoveryKey || !password) {
      onNotify('Enter this account’s existing recovery key and Matrix password.');
      return;
    }
    setBusy(true);
    try {
      await client.unlockExistingSecretStorage(existingRecoveryKey, password);
      setExistingRecoveryKey('');
      setPassword('');
      onRefresh();
      onNotify(`Existing cross-signing identity restored for ${security?.userId}.`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not unlock existing Secret Storage.');
    } finally {
      setBusy(false);
    }
  }

  function discardPreparedKey() {
    client?.discardPendingSecretStorageKey();
    setRecoveryKey('');
    setRecoveryConfirmation('');
    setRecoveryKeyId('');
    setRecoveryKeyVisible(false);
    onNotify('The uncommitted recovery key was discarded from this client.');
  }

  async function startSas() {
    if (!client || !verification) return;
    setBusy(true);
    try {
      await client.startSasVerification(verification.id);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not start SAS verification.');
    } finally {
      setBusy(false);
    }
  }

  async function makeVerificationQr() {
    if (!client || !verification) return;
    setBusy(true);
    try {
      const bytes = await client.startQrVerification(verification.id);
      setVerificationQr(await QRCode.toDataURL([{ mode: 'byte', data: bytes }], {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 260,
      }));
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not generate the Matrix verification QR.');
    } finally {
      setBusy(false);
    }
  }

  async function startQrScanner() {
    if (!client || !verification || !videoRef.current) return;
    setScanOpen(true);
    try {
      const reader = new BrowserQRCodeReader();
      scannerRef.current = await reader.decodeFromVideoDevice(undefined, videoRef.current, async (result) => {
        if (!result) return;
        scannerRef.current?.stop();
        scannerRef.current = null;
        setScanOpen(false);
        setBusy(true);
        try {
          await client.scanQrVerification(verification.id, result.getRawBytes());
        } catch (error) {
          onNotify(error instanceof Error ? error.message : 'The Matrix verification QR could not be scanned.');
        } finally {
          setBusy(false);
        }
      });
    } catch (error) {
      setScanOpen(false);
      onNotify(error instanceof Error ? error.message : 'Camera access is unavailable.');
    }
  }

  async function revokeDevice(deviceId: string) {
    if (!client) return;
    const authPassword = window.prompt('Re-enter this Matrix account password to revoke this device.');
    if (!authPassword) return;
    try {
      await client.revokeDevice(deviceId, authPassword);
      onRefresh();
      onNotify('Device revoked. Its old access token can no longer sync.');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not revoke this device.');
    }
  }

  return (
    <section className="matrix-security">
      <div className="security-heading">
        <div><div className="eyebrow">MATRIX DEVICE TRUST</div><h3>Verification & recovery</h3></div>
        <button className="quiet-button" disabled={!client || busy} onClick={onRefresh}>Refresh</button>
      </div>
      {!client && <p className="discreet-note">Connect a partner device first. Pairing QR codes do not verify cryptographic identity.</p>}
      {security && (
        <>
          <div className="security-status-grid">
            <div><span>Partner identity</span><b className={security.partnerVerified ? 'security-ok' : 'security-warn'}>{security.identityChanged ? 'Changed — review' : security.partnerVerified ? 'Cross-signed & verified' : 'Not verified'}</b></div>
            <div><span>Cross-signing</span><b>{security.crossSigningReady ? 'Ready' : 'Needs setup'}</b></div>
            <div><span>Secret storage</span><b>{security.secretStorageReady ? 'Ready' : 'Needs setup'}</b></div>
            <div><span>Default Secret Storage key ID</span><b>{security.defaultSecretStorageKeyId ?? 'Not configured'}</b></div>
            <div><span>Public cross-signing keys</span><b>{security.publicCrossSigningKeysPresent ? 'Present' : 'Not found'}</b></div>
            <div><span>Private keys in Secret Storage</span><b>{security.privateCrossSigningSecretsStored ? 'Present' : 'Not confirmed'}</b></div>
            <div><span>Private keys cached on this device</span><b>{security.privateCrossSigningKeysCachedLocally ? 'Present' : 'Not confirmed'}</b></div>
            <div><span>Server key backup</span><b>{security.keyBackupVersion ? `Version ${security.keyBackupVersion}` : 'Not found'}</b></div>
            <div><span>Recovery setup</span><b className={security.recoverySetupVerified || verifiedRecoveryKeyId ? 'security-ok' : 'security-warn'}>{security.recoverySetupVerified || verifiedRecoveryKeyId ? 'Verified on a separate device' : 'Recovery verification required'}</b></div>
            <div><span>This device</span><b>{security.ownDeviceId || 'Unavailable'}</b></div>
          </div>
          <div className="security-bootstrap">
            <input ref={recoveryImportRef} type="file" accept=".enc,application/json" hidden onChange={(event) => void importEncryptedRecoveryFile(event)} />
            <label className="field-label">Partner account to manage
              <select value={partnerSelection} onChange={(event) => setPartnerSelection(event.target.value)} disabled={!client || busy}>
                <option value={PARTNER_IDENTITIES.partnerA}>Partner A · {PARTNER_IDENTITIES.partnerA}</option>
                <option value={PARTNER_IDENTITIES.partnerB}>Partner B · {PARTNER_IDENTITIES.partnerB}</option>
                {![PARTNER_IDENTITIES.partnerA, PARTNER_IDENTITIES.partnerB].includes(security.userId) && <option value={security.userId}>{security.userId} · current session</option>}
              </select>
            </label>
            <p>This security session belongs to <b>{security.userId}</b>. Recovery keys are account-specific and are never sent to the other partner.</p>
            {security.defaultSecretStorageKeyId && (!security.crossSigningReady || !security.secretStorageReady) && (
              <div className="recovery-key">
                <b>Unlock existing Secret Storage</b>
                <small>Enter this account’s original recovery key. It is checked against the default key ID before the SDK uses it. No keys are reset or regenerated.</small>
                <label className="field-label">Existing Matrix recovery key<input type="password" autoComplete="off" spellCheck={false} value={existingRecoveryKey} onChange={(event) => { setExistingRecoveryKey(event.target.value); setRecoveryVerificationKey(event.target.value); }} /></label>
                <label className="field-label">Encrypted export passphrase<input type="password" autoComplete="current-password" value={exportPassphrase} onChange={(event) => setExportPassphrase(event.target.value)} /></label>
                <button className="quiet-button full-button" disabled={busy || !exportPassphrase} onClick={() => recoveryImportRef.current?.click()}>Import encrypted recovery file</button>
                <label className="field-label">Matrix account password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
                <button className="secondary full-button" disabled={!client || busy || !existingRecoveryKey || !password || partnerSelection !== security.userId} onClick={() => void recoverExistingKeys()}>{busy ? 'Checking existing keys…' : 'Validate key and restore existing identity'}</button>
              </div>
            )}
            {!security.defaultSecretStorageKeyId && !recoveryKey && (!security.crossSigningReady || !security.secretStorageReady) &&
              security.publicCrossSigningKeysPresent && !security.privateCrossSigningKeysCachedLocally && (
                <p className="discreet-note">This account already has published cross-signing keys, but this device does not hold their private keys. Do not generate replacements. Recover the original Secret Storage or use an existing verified device.</p>
            )}
            {!security.defaultSecretStorageKeyId && !recoveryKey && (!security.crossSigningReady || !security.secretStorageReady) &&
              (!security.publicCrossSigningKeysPresent || security.privateCrossSigningKeysCachedLocally) && (
              <div className="recovery-key">
                <b>First-time Secret Storage setup</b>
                <small>A recovery key can be created only because this account has no default Secret Storage key. Existing published cross-signing keys without their private keys are never replaced.</small>
                <button className="secondary full-button" disabled={!client || busy || partnerSelection !== security.userId} onClick={() => void prepareRecoveryKey()}>{busy ? 'Preparing…' : 'Generate a new recovery key for this account'}</button>
              </div>
            )}
          </div>
          {recoveryKey && (
            <div className="recovery-key">
              <b>New recovery key for {security.userId}</b>
              {recoveryKeyId && <small>Default Secret Storage key ID: <code>{recoveryKeyId}</code></small>}
              <code>{recoveryKeyVisible ? recoveryKey : '•••• •••• •••• •••• •••• •••• •••• ••••'}</code>
              <div className="pairing-actions">
                <button className="quiet-button" onClick={() => setRecoveryKeyVisible((visible) => !visible)}>{recoveryKeyVisible ? 'Hide key' : 'Show key'}</button>
                <button className="quiet-button" onClick={() => void navigator.clipboard.writeText(recoveryKey).catch(() => onNotify('Could not copy the recovery key. Copy it manually.'))}>Copy recovery key</button>
              </div>
              <label className="field-label">Encrypted export passphrase<input type="password" autoComplete="new-password" value={exportPassphrase} onChange={(event) => setExportPassphrase(event.target.value)} /></label>
              <label className="field-label">Confirm export passphrase<input type="password" autoComplete="new-password" value={exportConfirmation} onChange={(event) => setExportConfirmation(event.target.value)} /></label>
              <button className="quiet-button full-button" disabled={busy || exportPassphrase.length < 12 || exportConfirmation !== exportPassphrase} onClick={() => void exportEncryptedRecoveryKey()}>Download encrypted offline export</button>
              {!recoveryKeyId && (
                <>
                  <small>Save this key privately before continuing. Secret Storage has not been changed yet. This export is encrypted; keep its passphrase separately. Export again after setup to include the assigned key ID.</small>
                  <label className="field-label">Type the saved recovery key to confirm
                    <input type="password" autoComplete="off" spellCheck={false} value={recoveryConfirmation} onChange={(event) => setRecoveryConfirmation(event.target.value)} />
                  </label>
                </>
              )}
              {(!recoveryKeyId || !crossSigningSetup) && (
                <label className="field-label">Matrix account password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
              )}
              {crossSigningSetup && !verifiedRecoveryKeyId && (
                <>
                  <small>Re-enter the recovery key. NYMPH will create an isolated, temporary Matrix device, restore the existing keys there, compare the identity, and revoke the test device.</small>
                  <label className="field-label">Re-enter recovery key for separate-device verification<input type="password" autoComplete="off" spellCheck={false} value={recoveryVerificationKey} onChange={(event) => setRecoveryVerificationKey(event.target.value)} /></label>
                  <label className="field-label">Matrix account password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
                </>
              )}
              <button className="primary full-button" disabled={!client || busy || partnerSelection !== security.userId || !password || (!recoveryKeyId && recoveryConfirmation !== recoveryKey) || (crossSigningSetup && !recoveryVerificationKey)} onClick={() => void confirmNewRecoveryKey()}>{busy ? 'Confirming setup…' : !recoveryKeyId ? 'Confirm saved key and set up Secret Storage' : !crossSigningSetup ? 'Continue cross-signing setup' : 'Verify recovery on a separate device'}</button>
              {!recoveryKeyId && <button className="quiet-button full-button" disabled={busy} onClick={() => void discardPreparedKey()}>Cancel and discard uncommitted key</button>}
              {verifiedRecoveryKeyId && <small className="security-ok">Recovery verified for Secret Storage key ID {verifiedRecoveryKeyId}. The temporary verification device was revoked.</small>}
              <small>Keep this key offline. Anyone who obtains it may restore encrypted account secrets. Never share it in chat or screenshots.</small>
            </div>
          )}
          {security.defaultSecretStorageKeyId && security.crossSigningReady && !security.recoverySetupVerified && !verifiedRecoveryKeyId && !recoveryKey && (
            <div className="recovery-key">
              <b>Verify recovery on a separate device</b>
              <small>Enter the original recovery key. A temporary Matrix device will independently unlock Secret Storage, restore the same cross-signing identity, and then be revoked. Setup is not marked verified until this succeeds.</small>
              <label className="field-label">Recovery key<input type="password" autoComplete="off" spellCheck={false} value={recoveryVerificationKey} onChange={(event) => { setRecoveryVerificationKey(event.target.value); setExistingRecoveryKey(event.target.value); }} /></label>
              <label className="field-label">Encrypted export passphrase<input type="password" autoComplete="current-password" value={exportPassphrase} onChange={(event) => setExportPassphrase(event.target.value)} /></label>
              <button className="quiet-button full-button" disabled={busy || !exportPassphrase} onClick={() => recoveryImportRef.current?.click()}>Import encrypted recovery file</button>
              <label className="field-label">Matrix account password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
              <button className="secondary full-button" disabled={!client || busy || !recoveryVerificationKey || !password || partnerSelection !== security.userId} onClick={() => void verifyExistingRecoveryKey()}>{busy ? 'Verifying recovery…' : 'Restore and verify existing recovery key'}</button>
            </div>
          )}
          {security.partnerDevices.length > 0 && (
            <div className="device-list">
              <b>Partner’s encryption devices</b>
              {security.partnerDevices.map((device) => <div className="device-row" key={device.deviceId}>
                <span>{device.displayName}<small>{device.deviceId}</small></span><i className={device.verified ? 'security-ok' : 'security-warn'}>{device.verified ? 'Verified' : 'Unverified'}</i>
                {!device.verified && <button className="quiet-button" disabled={!client || busy} onClick={() => void client?.requestPartnerVerification(device.deviceId).catch((error: unknown) => onNotify(error instanceof Error ? error.message : 'Could not request verification.'))}>Verify</button>}
              </div>)}
            </div>
          )}
          {security.ownDevices.length > 0 && (
            <div className="device-list">
              <b>Your account devices</b>
              {security.ownDevices.map((device) => <div className="device-row" key={device.deviceId}>
                <span>{device.displayName}<small>{device.deviceId}{device.deviceId === security.ownDeviceId ? ' · current' : ''}</small></span>
                {device.deviceId !== security.ownDeviceId && <button className="quiet-button" onClick={() => void revokeDevice(device.deviceId)}>Revoke</button>}
              </div>)}
            </div>
          )}
        </>
      )}
      {verification && (
        <div className="verification-card">
          <b>Verification with {verification.userId}</b>
          <small>{verification.deviceId ? `Device ${verification.deviceId}` : 'Compare on both partner devices'} · {verification.phase}</small>
          {verification.error && <p className="form-error">{verification.error}</p>}
          {verification.phase === 'Requested' && !verification.initiatedByMe && <button className="secondary full-button" onClick={() => void client?.acceptVerification(verification.id).catch((error: unknown) => onNotify(error instanceof Error ? error.message : 'Could not accept verification.'))}>Accept verification request</button>}
          {verification.phase === 'Ready' && <>
            <button className="secondary full-button" disabled={busy} onClick={() => void startSas()}>Compare emoji / numbers</button>
            <button className="secondary full-button" disabled={busy} onClick={() => void makeVerificationQr()}>Show Matrix verification QR</button>
            <button className="secondary full-button" disabled={busy} onClick={() => void startQrScanner()}>Scan partner’s Matrix QR</button>
          </>}
          {verification.sas && <div className="sas-panel">
            <div className="sas-emoji">{verification.sas.emoji?.map(([emoji]) => emoji).join(' ')}</div>
            {verification.sas.decimal && <strong>{verification.sas.decimal.join(' · ')}</strong>}
            <p>Compare the full sequence in person on both devices. Confirm only if every item matches.</p>
            <button className="primary full-button" onClick={() => void client?.confirmSas(verification.id).then(onRefresh).catch((error: unknown) => onNotify(error instanceof Error ? error.message : 'Could not confirm SAS verification.'))}>The codes match</button>
            <button className="secondary full-button" onClick={() => void client?.mismatchSas(verification.id).catch((error: unknown) => onNotify(error instanceof Error ? error.message : 'Could not reject SAS verification.'))}>They do not match</button>
          </div>}
          {verificationQr && <div className="pairing-qr"><img src={verificationQr} alt="Matrix device verification QR code" /></div>}
          {scanOpen && <div className="scanner-card"><video ref={videoRef} muted playsInline /><button className="secondary full-button" onClick={() => { scannerRef.current?.stop(); scannerRef.current = null; setScanOpen(false); }}>Stop scanning</button></div>}
          {verification.confirmQrScan && <div className="sas-panel"><p>Confirm only after your partner has physically scanned this Matrix QR code.</p><button className="primary full-button" onClick={() => void client?.confirmQrScan(verification.id).then(onRefresh).catch((error: unknown) => onNotify(error instanceof Error ? error.message : 'Could not confirm QR verification.'))}>Partner scanned my code</button></div>}
          <button className="quiet-button full-button" onClick={() => { setVerificationQr(''); void client?.cancelVerification(verification.id).catch((error: unknown) => onNotify(error instanceof Error ? error.message : 'Could not cancel verification.')); }}>Cancel verification</button>
        </div>
      )}
    </section>
  );
}
