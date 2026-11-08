import { BrowserQRCodeReader } from '@zxing/browser';
import type { IScannerControls } from '@zxing/browser';
import { Capacitor } from '@capacitor/core';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { MatrixConnection, MatrixMessagingClient } from './MessagingClient';
import { PARTNER_DEVICE_IDS, PARTNER_IDENTITIES } from './partner-identity';

type PairingInvite = {
  version: 1;
  homeserver: string;
  partner_user_id: string;
  room_id: string;
  token: string;
  expires_at: number;
};

type RedeemedInvite = Omit<PairingInvite, 'token' | 'expires_at' | 'version'> & {
  login_token: string;
  expires_in_ms: number;
};

type DeviceReplacementInvite = {
  version: 1;
  flow: 'device-replacement';
  homeserver: string;
  user_id: string;
  device_id: string;
  previous_device_id: string;
  room_id: string;
  login_token: string;
  expires_at: number;
};

type DeviceReplacementResponse = {
  user_id: string;
  device_id: string;
  previous_device_id: string;
  room_id: string;
  login_token: string;
  expires_in_ms: number;
};

type PendingReplacementSession = {
  invite: DeviceReplacementInvite;
  session: { user_id: string; device_id: string; access_token: string };
};

interface PairingPanelProps {
  role: 'partner-a' | 'partner-b' | 'replace-device';
  credentials: MatrixConnection;
  client: MatrixMessagingClient | null;
  onEnrolled(connection: MatrixConnection): void;
  onActivationPending(pending: boolean): void;
  onClose(): void;
}

function isPairingInvite(value: unknown): value is PairingInvite {
  if (!value || typeof value !== 'object') return false;
  const invite = value as Partial<PairingInvite>;
  if (
    invite.version !== 1 ||
    typeof invite.homeserver !== 'string' ||
    typeof invite.partner_user_id !== 'string' ||
    typeof invite.room_id !== 'string' ||
    typeof invite.token !== 'string' ||
    typeof invite.expires_at !== 'number'
  ) return false;
  try {
    const url = new URL(invite.homeserver);
    const androidUsbReverseDevelopment = Capacitor.getPlatform() === 'android' &&
      import.meta.env.MODE === 'android' &&
      url.protocol === 'http:' &&
      url.hostname === 'localhost';
    const browserDevelopment = import.meta.env.DEV &&
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname);
    return (
      url.protocol === 'https:' ||
      androidUsbReverseDevelopment ||
      browserDevelopment
    ) && invite.expires_at > Date.now() &&
      invite.token.length >= 40 && invite.partner_user_id === PARTNER_IDENTITIES.partnerB &&
      invite.room_id.startsWith('!');
  } catch {
    return false;
  }
}

function isDeviceReplacementInvite(value: unknown): value is DeviceReplacementInvite {
  if (!value || typeof value !== 'object') return false;
  const invite = value as Partial<DeviceReplacementInvite>;
  if (
    invite.version !== 1 ||
    invite.flow !== 'device-replacement' ||
    typeof invite.homeserver !== 'string' ||
    typeof invite.user_id !== 'string' ||
    typeof invite.device_id !== 'string' ||
    typeof invite.previous_device_id !== 'string' ||
    typeof invite.room_id !== 'string' ||
    typeof invite.login_token !== 'string' ||
    typeof invite.expires_at !== 'number'
  ) return false;
  try {
    const url = new URL(invite.homeserver);
    const androidUsbReverseDevelopment = Capacitor.getPlatform() === 'android' &&
      import.meta.env.MODE === 'android' &&
      url.protocol === 'http:' &&
      url.hostname === 'localhost';
    const browserDevelopment = import.meta.env.DEV &&
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname);
    return (
      url.protocol === 'https:' ||
      androidUsbReverseDevelopment ||
      browserDevelopment
    ) && invite.login_token.length > 0 &&
    invite.room_id.startsWith('!') &&
    [PARTNER_IDENTITIES.partnerA, PARTNER_IDENTITIES.partnerB].includes(invite.user_id) &&
      invite.device_id !== invite.previous_device_id;
  } catch {
    return false;
  }
}

async function postJson<T>(url: string, body: unknown, accessToken?: string): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
    const error = typeof payload?.error === 'string' ? payload.error : `Request failed (${response.status}).`;
    throw new Error(error);
  }
  return response.json() as Promise<T>;
}

export function PairingPanel({
  role,
  credentials,
  client,
  onEnrolled,
  onActivationPending,
  onClose,
}: PairingPanelProps) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [expiresAt, setExpiresAt] = useState<number>();
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [pairingStatus, setPairingStatus] = useState('Preparing private invitation…');
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [replacementInvite, setReplacementInvite] = useState<DeviceReplacementInvite | null>(null);
  const [replacementPassword, setReplacementPassword] = useState('');
  const [pendingReplacementSession, setPendingReplacementSession] = useState<PendingReplacementSession | null>(null);
  const [pendingActivation, setPendingActivation] = useState<MatrixConnection | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<IScannerControls | null>(null);
  const disposedRef = useRef(false);
  const processingRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      scannerRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    if (!expiresAt) return;
    const update = () => setSecondsLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  useEffect(() => {
    if (role !== 'partner-a' || !expiresAt || secondsLeft === 0 || !credentials.accessToken) return;
    let active = true;
    const poll = async () => {
      try {
        const status = await postJson<{ pairing_status?: string }>(
          `${new URL(credentials.homeserver).origin}/_synapse/client/nymph/pairing/status`,
          {},
          credentials.accessToken,
        );
        if (active && status.pairing_status === 'redeemed') {
          setPairingStatus('Invitation redeemed. Your partner’s device is connecting; verification is still required.');
        } else if (active && status.pairing_status === 'expired') {
          setPairingStatus('This invitation expired. Generate a new QR code.');
          setSecondsLeft(0);
        } else if (active && status.pairing_status === 'cancelled') {
          setPairingStatus('Invitation cancelled.');
          setSecondsLeft(0);
        }
      } catch {
        if (active) setPairingStatus('Could not check the invitation status. Keep this screen open and try again.');
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [credentials.accessToken, credentials.homeserver, expiresAt, role]);

  async function createInvitation() {
    if (role === 'replace-device') {
      await createDeviceReplacement();
      return;
    }
    if (!client || credentials.userId !== PARTNER_IDENTITIES.partnerA || !credentials.accessToken || !credentials.roomId) {
      setError('Connect as Partner 1 to the private Matrix room before creating an invitation.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const base = new URL(credentials.homeserver).origin;
      const serverInvitation = await postJson<PairingInvite>(
        `${base}/_synapse/client/nymph/pairing/create`,
        { room_id: credentials.roomId },
        credentials.accessToken,
      );
      const invitation = { ...serverInvitation, homeserver: credentials.homeserver };
      if (!isPairingInvite(invitation)) {
        throw new Error('The server returned an invalid or expired pairing invitation.');
      }
      const dataUrl = await QRCode.toDataURL(JSON.stringify(invitation), {
        errorCorrectionLevel: 'Q',
        margin: 2,
        width: 280,
        color: { dark: '#2a1019', light: '#fff8fa' },
      });
      if (disposedRef.current) return;
      setQrDataUrl(dataUrl);
      setExpiresAt(invitation.expires_at);
      setPairingStatus('Waiting for Partner 2 to scan this one-time invitation.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not create the pairing invitation.');
    } finally {
      setBusy(false);
    }
  }

  async function createDeviceReplacement() {
    if (!credentials.accessToken || !credentials.deviceId || !credentials.homeserver) {
      setError('Connect the active partner device before replacing it.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const deviceId = crypto.randomUUID();
      const response = await postJson<DeviceReplacementResponse>(
        `${new URL(credentials.homeserver).origin}/_synapse/client/nymph/device/replace`,
        { device_id: deviceId },
        credentials.accessToken,
      );
      if (
        response.user_id !== credentials.userId ||
        response.device_id !== deviceId ||
        response.previous_device_id !== credentials.deviceId ||
        typeof response.room_id !== 'string' ||
        !response.room_id.startsWith('!') ||
        typeof response.login_token !== 'string' ||
        response.expires_in_ms <= 0
      ) throw new Error('The server returned an invalid device replacement authorization.');

      const invite: DeviceReplacementInvite = {
        version: 1,
        flow: 'device-replacement',
        homeserver: credentials.homeserver,
        user_id: response.user_id,
        device_id: response.device_id,
        previous_device_id: response.previous_device_id,
        room_id: response.room_id,
        login_token: response.login_token,
        expires_at: Date.now() + response.expires_in_ms,
      };
      const dataUrl = await QRCode.toDataURL(JSON.stringify(invite), {
        errorCorrectionLevel: 'Q',
        margin: 2,
        width: 280,
        color: { dark: '#2a1019', light: '#fff8fa' },
      });
      if (disposedRef.current) return;
      setQrDataUrl(dataUrl);
      setExpiresAt(invite.expires_at);
      setPairingStatus('Scan this one-time code on the replacement device. It expires shortly.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not authorize the replacement device.');
    } finally {
      setBusy(false);
    }
  }

  async function redeemInvitation(raw: string) {
    if (processingRef.current) return;
    processingRef.current = true;
    setBusy(true);
    setError('');
    try {
      const invite: unknown = JSON.parse(raw);
      if (isDeviceReplacementInvite(invite)) {
        if (invite.expires_at <= Date.now()) throw new Error('This device replacement code has expired.');
        if (credentials.homeserver && new URL(credentials.homeserver).origin !== new URL(invite.homeserver).origin) {
          throw new Error('The replacement code is for a different homeserver.');
        }
        setReplacementInvite(invite);
        setPairingStatus('Enter this account’s password to revoke the previous device and finish replacement.');
        return;
      }
      if (!isPairingInvite(invite)) throw new Error('This is not a valid NYMPH pairing QR.');
      if (invite.expires_at <= Date.now()) throw new Error('This one-time invitation has expired.');
      if (credentials.homeserver && new URL(credentials.homeserver).origin !== new URL(invite.homeserver).origin) {
        throw new Error('The QR code is for a different homeserver than the one configured on this device.');
      }
      const redeemed = await postJson<RedeemedInvite>(
        `${new URL(invite.homeserver).origin}/_synapse/client/nymph/pairing/redeem`,
        { token: invite.token },
      );
      if (
        redeemed.partner_user_id !== PARTNER_IDENTITIES.partnerB ||
        redeemed.room_id !== invite.room_id ||
        typeof redeemed.login_token !== 'string' ||
        redeemed.expires_in_ms <= 0
      ) throw new Error('The server returned an unexpected enrollment response.');

      const { createClient } = await import('matrix-js-sdk');
      const loginClient = createClient({ baseUrl: new URL(invite.homeserver).origin });
      const session = await loginClient.login('m.login.token', {
        token: redeemed.login_token,
        initial_device_display_name: 'NYMPH Partner 2',
        device_id: localStorage.getItem(`nymph.matrix.device.v1.${encodeURIComponent(PARTNER_IDENTITIES.partnerB)}`) ||
          PARTNER_DEVICE_IDS.partnerB ||
          crypto.randomUUID(),
      });
      loginClient.stopClient();
      if (session.user_id !== redeemed.partner_user_id) {
        throw new Error('The invitation did not authenticate the configured Partner 2 identity.');
      }
      if (session.device_id) {
        localStorage.setItem(
          `nymph.matrix.device.v1.${encodeURIComponent(session.user_id)}`,
          session.device_id,
        );
      }
      const connection: MatrixConnection = {
        homeserver: invite.homeserver,
        userId: session.user_id,
        partnerUserId: PARTNER_IDENTITIES.partnerA,
        accessToken: session.access_token,
        roomId: redeemed.room_id,
        deviceId: session.device_id,
      };
      setPairingStatus('Invitation accepted. Connecting to the encrypted room…');
      if (!disposedRef.current) onEnrolled(connection);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not redeem the pairing invitation.');
    } finally {
      processingRef.current = false;
      setBusy(false);
    }
  }

  async function confirmDeviceReplacement() {
    const invite = pendingReplacementSession?.invite ?? replacementInvite;
    if (!invite || !replacementPassword || busy) return;
    setError('');
    setBusy(true);
    let loginClient: import('matrix-js-sdk').MatrixClient | undefined;
    let session: { user_id: string; device_id: string; access_token: string } | undefined;
    let previousDeviceRevoked = false;
    try {
      const { createClient } = await import('matrix-js-sdk');
      if (pendingReplacementSession) {
        session = pendingReplacementSession.session;
        loginClient = createClient({
          baseUrl: new URL(invite.homeserver).origin,
          accessToken: session.access_token,
          userId: session.user_id,
          deviceId: session.device_id,
        });
      } else {
        loginClient = createClient({ baseUrl: new URL(invite.homeserver).origin });
        session = await loginClient.login('m.login.token', {
          token: invite.login_token,
          device_id: invite.device_id,
          initial_device_display_name: 'NYMPH replacement device',
        });
      }
      if (session.user_id !== invite.user_id || session.device_id !== invite.device_id) {
        throw new Error('The replacement token authenticated an unexpected device.');
      }

      try {
        await loginClient.deleteDevice(invite.previous_device_id, {
          type: 'm.login.password',
          user: invite.user_id,
          password: replacementPassword,
        });
      } catch (deleteError) {
        let devices: Awaited<ReturnType<typeof loginClient.getDevices>>;
        try {
          devices = await loginClient.getDevices();
        } catch {
          setPendingReplacementSession({ invite, session });
          onActivationPending(true);
          setError('The old device’s revocation status could not be checked. Keep this screen open and retry; encrypted sync has not started.');
          return;
        }
        if (devices.devices.some((device) => device.device_id === invite.previous_device_id)) {
          throw deleteError;
        }
      }
      previousDeviceRevoked = true;
      setPendingReplacementSession(null);
      setReplacementPassword('');

      const replacementConnection: MatrixConnection = {
        homeserver: invite.homeserver,
        userId: session.user_id,
        partnerUserId: session.user_id === PARTNER_IDENTITIES.partnerA
          ? PARTNER_IDENTITIES.partnerB
          : PARTNER_IDENTITIES.partnerA,
        accessToken: session.access_token,
        roomId: invite.room_id,
        deviceId: session.device_id,
      };
      setPendingActivation(replacementConnection);
      await activateReplacement(replacementConnection);
      localStorage.setItem(
        `nymph.matrix.device.v1.${encodeURIComponent(session.user_id)}`,
        session.device_id,
      );
      setReplacementPassword('');
      setReplacementInvite(null);
      onActivationPending(false);
      onEnrolled(replacementConnection);
    } catch (requestError) {
      if (previousDeviceRevoked && session) {
        const replacementConnection: MatrixConnection = {
          homeserver: invite.homeserver,
          userId: session.user_id,
          partnerUserId: session.user_id === PARTNER_IDENTITIES.partnerA
            ? PARTNER_IDENTITIES.partnerB
            : PARTNER_IDENTITIES.partnerA,
          accessToken: session.access_token,
          roomId: invite.room_id,
          deviceId: session.device_id,
        };
        setPendingActivation(replacementConnection);
        setPendingReplacementSession(null);
        onActivationPending(true);
        setError('The previous device was revoked, but server activation is not confirmed. Retry activation before connecting.');
        return;
      }
      if (session?.access_token && !previousDeviceRevoked) {
        try {
        const cancel = await fetch(`${new URL(invite.homeserver).origin}/_synapse/client/nymph/device/cancel`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
          cache: 'no-store',
        });
        if (!cancel.ok) {
          setError('Replacement could not be completed or rolled back. Keep the existing device and contact the development administrator.');
          await loginClient?.logout();
          return;
        }
        await loginClient?.logout();
        setPendingReplacementSession(null);
        onActivationPending(false);
        } catch {
          setError('Replacement could not be completed or rolled back. The temporary device may remain active; review the Matrix device list.');
          return;
        }
      }
      setError(requestError instanceof Error ? requestError.message : 'Could not replace the active device.');
    } finally {
      loginClient?.stopClient();
      setBusy(false);
    }
  }

  async function activateReplacement(connection: MatrixConnection) {
    const response = await fetch(`${new URL(connection.homeserver).origin}/_synapse/client/nymph/device/activate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connection.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Could not activate the replacement device (${response.status}).`);
    localStorage.setItem(
      `nymph.matrix.device.v1.${encodeURIComponent(connection.userId)}`,
      connection.deviceId ?? '',
    );
    setPendingActivation(null);
  }

  async function retryDeviceActivation() {
    if (!pendingActivation || busy) return;
    setError('');
    setBusy(true);
    try {
      await activateReplacement(pendingActivation);
      onActivationPending(false);
      onEnrolled(pendingActivation);
    } catch (activationError) {
      setError(activationError instanceof Error ? activationError.message : 'Could not activate the replacement device.');
    } finally {
      setBusy(false);
    }
  }
  async function startScanner() {
    if (!videoRef.current || busy || processingRef.current) return;
    setError('');
    setScanning(true);
    try {
      const reader = new BrowserQRCodeReader();
      scannerRef.current = await reader.decodeFromVideoDevice(undefined, videoRef.current, async (result) => {
        if (!result || processingRef.current) return;
        scannerRef.current?.stop();
        scannerRef.current = null;
        setScanning(false);
        await redeemInvitation(result.getText());
      });
    } catch (scanError) {
      setScanning(false);
      setError(scanError instanceof Error ? scanError.message : 'Camera access is unavailable.');
    }
  }

  async function cancelInvitation() {
    if (!credentials.accessToken || !credentials.homeserver) return;
    try {
      const endpoint = role === 'replace-device' ? 'device/cancel' : 'pairing/cancel';
      await postJson(
        `${new URL(credentials.homeserver).origin}/_synapse/client/nymph/${endpoint}`,
        {},
        credentials.accessToken,
      );
      setPairingStatus('Invitation cancelled.');
      setSecondsLeft(0);
      setQrDataUrl('');
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : 'Could not cancel this invitation.');
    }
  }

  const isCreator = role === 'partner-a' || role === 'replace-device';

  return (
    <div className="dialog-backdrop pairing-backdrop">
      <section className="dialog pairing-dialog" role="dialog" aria-modal="true" aria-labelledby="pairing-title">
        <button
          className="close-button pairing-close"
          aria-label="Close pairing"
          disabled={Boolean(pendingActivation)}
          onClick={() => { if (!pendingActivation) onClose(); }}
        >×</button>
        <div className="dialog-symbol">♡</div>
        <div className="eyebrow">JUST THE TWO OF YOU</div>
        <h2 id="pairing-title">{role === 'partner-a'
          ? 'Create our private room'
          : role === 'replace-device' ? 'Replace this active device' : 'Join our private room'}</h2>
        <p>{role === 'partner-a'
          ? 'Create a short-lived invitation for Partner 2. The QR contains no permanent Matrix credentials.'
          : role === 'replace-device'
            ? 'Authorize one replacement device. Its one-time login will revoke this device before encrypted sync starts.'
            : 'Scan a partner invitation or a one-time device replacement code.'}</p>
        {isCreator ? (
          <>
            {qrDataUrl && <div className="pairing-qr"><img src={qrDataUrl} alt="One-time NYMPH pairing invitation QR code" /></div>}
            <div className="pairing-countdown">{expiresAt && secondsLeft > 0 ? `Expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}` : 'Invitation not active'}</div>
            <p className="pairing-status" role="status">{pairingStatus}</p>
            {!qrDataUrl || secondsLeft === 0
              ? <button className="primary full-button" disabled={busy} onClick={() => void createInvitation()}>{busy ? 'Creating…' : role === 'replace-device' ? 'Authorize replacement device' : 'Generate pairing QR'}</button>
              : role === 'partner-a' && pairingStatus.startsWith('Invitation redeemed')
                ? <button className="secondary full-button" disabled>Invitation redeemed · continue to device verification</button>
                : <button className="secondary full-button" disabled={busy} onClick={() => void cancelInvitation()}>{role === 'replace-device' ? 'Cancel device replacement' : 'Cancel invitation'}</button>}
          </>
        ) : (
          <>
            {!replacementInvite && (
              <>
                <video ref={videoRef} className={`pairing-camera ${scanning ? 'active' : ''}`} muted playsInline />
                <p className="pairing-status" role="status">{pairingStatus}</p>
                <button className="primary full-button" disabled={busy || scanning} onClick={() => void startScanner()}>
                  {busy ? 'Enrolling device…' : scanning ? 'Camera is open…' : 'Scan partner QR'}
                </button>
                {scanning && <button className="secondary full-button" onClick={() => { scannerRef.current?.stop(); scannerRef.current = null; setScanning(false); }}>Stop camera</button>}
              </>
            )}
            {replacementInvite && (
              <div className="recovery-key">
                <b>Confirm device replacement</b>
                <p>The previous device will be revoked before the new client starts encrypted sync.</p>
                <label className="field-label">Matrix account password
                  <input type="password" autoComplete="current-password" value={replacementPassword} onChange={(event) => setReplacementPassword(event.target.value)} />
                </label>
                <button className="primary full-button" disabled={busy || !replacementPassword} onClick={() => void confirmDeviceReplacement()}>
                  {busy ? 'Replacing device…' : pendingReplacementSession ? 'Retry device revocation check' : 'Revoke old device and continue'}
                </button>
              </div>
            )}
            {pendingActivation && (
              <button className="primary full-button" disabled={busy} onClick={() => void retryDeviceActivation()}>
                {busy ? 'Activating…' : 'Retry replacement activation'}
              </button>
            )}
          </>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="discreet-note">QR enrollment is separate from Matrix device verification. Do not send private messages until both partners confirm verification.</div>
        <button className="secondary full-button" onClick={onClose}>Back</button>
      </section>
    </div>
  );
}
