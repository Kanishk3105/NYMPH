import { BrowserQRCodeReader } from '@zxing/browser';
import type { IScannerControls } from '@zxing/browser';
import { useRef, useState } from 'react';
import QRCode from 'qrcode';
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
  const [verificationQr, setVerificationQr] = useState('');
  const [scanOpen, setScanOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<IScannerControls | null>(null);

  async function bootstrap() {
    if (!client || !password) {
      onNotify('Enter this Matrix account password to set up cross-signing.');
      return;
    }
    setBusy(true);
    try {
      const key = await client.bootstrapSecurity(password);
      setRecoveryKey(key);
      setPassword('');
      onRefresh();
      onNotify(key
        ? 'Cross-signing and secret storage are configured. Save the new recovery key somewhere private.'
        : 'Cross-signing setup completed. Keep using the account’s existing recovery key.');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not configure Matrix security.');
    } finally {
      setBusy(false);
    }
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
            <div><span>This device</span><b>{security.ownDeviceId || 'Unavailable'}</b></div>
          </div>
          {(!security.crossSigningReady || !security.secretStorageReady) && (
            <div className="security-bootstrap">
              <p>Set up cross-signing using this account’s password. The recovery key is shown once; store it outside this device.</p>
              <label className="field-label">Matrix account password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
              <button className="secondary full-button" disabled={!client || busy || !password} onClick={() => void bootstrap()}>{busy ? 'Setting up…' : 'Set up cross-signing & secret storage'}</button>
            </div>
          )}
          {recoveryKey && <div className="recovery-key"><b>Save this Matrix recovery key</b><code>{recoveryKey}</code><button className="quiet-button" onClick={() => void navigator.clipboard.writeText(recoveryKey).catch(() => onNotify('Could not copy the recovery key. Copy it manually.'))}>Copy recovery key</button><small>Anyone with this key can restore encrypted account secrets. Do not send it in chat.</small></div>}
          {security.partnerDevices.length > 0 && (
            <div className="device-list">
              <b>Partner’s encryption devices</b>
              {security.partnerDevices.map((device) => <div className="device-row" key={device.deviceId}>
                <span>{device.displayName}<small>{device.deviceId}</small></span><i className={device.verified ? 'security-ok' : 'security-warn'}>{device.verified ? 'Verified' : 'Unverified'}</i>
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
      {client && !security?.partnerVerified && (
        <button className="primary full-button" disabled={busy} onClick={() => void client.requestPartnerVerification().catch((error: unknown) => onNotify(error instanceof Error ? error.message : 'Could not request verification.'))}>
          Request partner verification
        </button>
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
