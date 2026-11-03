import { BrowserQRCodeReader } from '@zxing/browser';
import type { IScannerControls } from '@zxing/browser';
import { Capacitor } from '@capacitor/core';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { MatrixConnection, MatrixMessagingClient } from './MessagingClient';

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

interface PairingPanelProps {
  role: 'partner-a' | 'partner-b';
  credentials: MatrixConnection;
  client: MatrixMessagingClient | null;
  onEnrolled(connection: MatrixConnection): void;
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
    ) && invite.token.length >= 40 && invite.partner_user_id === '@partner2:localhost' &&
      invite.room_id.startsWith('!');
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
  onClose,
}: PairingPanelProps) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [expiresAt, setExpiresAt] = useState<number>();
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [pairingStatus, setPairingStatus] = useState('Preparing private invitation…');
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
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
    if (!client || credentials.userId !== '@partner1:localhost' || !credentials.accessToken || !credentials.roomId) {
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
      if (!isPairingInvite(invitation)) throw new Error('The server returned an invalid pairing invitation.');
      const dataUrl = await QRCode.toDataURL(JSON.stringify(invitation), {
        errorCorrectionLevel: 'Q',
        margin: 2,
        width: 280,
        color: { dark: '#2a1019', light: '#fff8fa' },
      });
      setQrDataUrl(dataUrl);
      setExpiresAt(invitation.expires_at);
      setPairingStatus('Waiting for Partner 2 to scan this one-time invitation.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not create the pairing invitation.');
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
        redeemed.partner_user_id !== '@partner2:localhost' ||
        redeemed.room_id !== invite.room_id ||
        typeof redeemed.login_token !== 'string' ||
        redeemed.expires_in_ms <= 0
      ) throw new Error('The server returned an unexpected enrollment response.');

      const { createClient } = await import('matrix-js-sdk');
      const loginClient = createClient({ baseUrl: new URL(invite.homeserver).origin });
      const session = await loginClient.login('m.login.token', {
        token: redeemed.login_token,
        initial_device_display_name: 'NYMPH Partner 2',
      });
      loginClient.stopClient();
      if (session.user_id !== redeemed.partner_user_id) {
        throw new Error('The invitation did not authenticate the configured Partner 2 identity.');
      }
      const connection: MatrixConnection = {
        homeserver: invite.homeserver,
        userId: session.user_id,
        partnerUserId: '@partner1:localhost',
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
      await postJson(
        `${new URL(credentials.homeserver).origin}/_synapse/client/nymph/pairing/cancel`,
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

  return (
    <div className="dialog-backdrop pairing-backdrop">
      <section className="dialog pairing-dialog" role="dialog" aria-modal="true" aria-labelledby="pairing-title">
        <button className="close-button pairing-close" aria-label="Close pairing" onClick={onClose}>×</button>
        <div className="dialog-symbol">♡</div>
        <div className="eyebrow">JUST THE TWO OF YOU</div>
        <h2 id="pairing-title">{role === 'partner-a' ? 'Create our private room' : 'Join our private room'}</h2>
        <p>{role === 'partner-a'
          ? 'Create a short-lived invitation for Partner 2. The QR contains no permanent Matrix credentials.'
          : 'Scan Partner 1’s one-time QR invitation. You will be enrolled as the configured second partner.'}</p>
        {role === 'partner-a' ? (
          <>
            {qrDataUrl && <div className="pairing-qr"><img src={qrDataUrl} alt="One-time NYMPH pairing invitation QR code" /></div>}
            <div className="pairing-countdown">{expiresAt && secondsLeft > 0 ? `Expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}` : 'Invitation not active'}</div>
            <p className="pairing-status" role="status">{pairingStatus}</p>
            {!qrDataUrl || secondsLeft === 0
              ? <button className="primary full-button" disabled={busy} onClick={() => void createInvitation()}>{busy ? 'Creating…' : 'Generate pairing QR'}</button>
              : pairingStatus.startsWith('Invitation redeemed')
                ? <button className="secondary full-button" disabled>Invitation redeemed · continue to device verification</button>
                : <button className="secondary full-button" disabled={busy} onClick={() => void cancelInvitation()}>Cancel invitation</button>}
          </>
        ) : (
          <>
            <video ref={videoRef} className={`pairing-camera ${scanning ? 'active' : ''}`} muted playsInline />
            <p className="pairing-status" role="status">{pairingStatus}</p>
            <button className="primary full-button" disabled={busy || scanning} onClick={() => void startScanner()}>
              {busy ? 'Enrolling device…' : scanning ? 'Camera is open…' : 'Scan pairing QR'}
            </button>
            {scanning && <button className="secondary full-button" onClick={() => { scannerRef.current?.stop(); scannerRef.current = null; setScanning(false); }}>Stop camera</button>}
          </>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="discreet-note">QR enrollment is separate from Matrix device verification. Do not send private messages until both partners confirm verification.</div>
        <button className="secondary full-button" onClick={onClose}>Back</button>
      </section>
    </div>
  );
}
