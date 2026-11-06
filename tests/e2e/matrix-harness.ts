import {
  connectMatrix,
  type MatrixConnection,
  type MatrixMessagingClient,
  type MatrixVerification,
  type NymphEnvelope,
  type ReceivedNymphEvent,
} from '../../src/matrix/MessagingClient';
import { revokeRecoveryVerifier } from '../../src/matrix/recovery-device-cleanup';
import QRCode from 'qrcode';
import { BrowserQRCodeReader } from '@zxing/browser';

type HarnessSession = MatrixConnection;
type HarnessState = {
  client: MatrixMessagingClient | null;
  events: ReceivedNymphEvent[];
  verifications: MatrixVerification[];
  security: unknown;
  typing: boolean;
  readEventIds: string[];
  connect(connection: HarnessSession, storageKey?: number[]): Promise<void>;
  disconnect(): void;
  passwordLogin(userId: string, password: string, deviceName: string, deviceId?: string): Promise<HarnessSession>;
  roomStatus(connection: HarnessSession): Promise<{ room_id: string }>;
  createInvitation(connection: HarnessSession): Promise<unknown>;
  encodeInvitationQr(invite: unknown): Promise<string>;
  redeemInvitation(invite: unknown, deviceId?: string): Promise<HarnessSession>;
  replayInvitation(invite: unknown): Promise<number>;
  unlockExistingSecretStorage(recoveryKey: string, password: string): Promise<string>;
  prepareSecretStorageSetup(): Promise<string>;
  commitSecretStorageSetup(confirmation: string): Promise<string>;
  bootstrapSecurity(password: string): Promise<void>;
  verifyRecoveryOnSeparateDevice(recoveryKey: string, password: string): Promise<string>;
  requestPartnerVerification(deviceId: string): Promise<void>;
  acceptVerification(id: string): Promise<void>;
  startSasVerification(id: string): Promise<void>;
  confirmSas(id: string): Promise<void>;
  cancelVerification(id: string): Promise<void>;
  send(envelope: NymphEnvelope): Promise<string>;
  sendAttachment(
    envelope: NymphEnvelope,
    fileBytes: number[],
    mediaType: string,
    fileName: string,
    thumbnailBytes?: number[],
    pendingExpirySeconds?: number,
  ): Promise<{ eventId: string; attachment: NonNullable<ReceivedNymphEvent['attachment']>; thumbnailAttachment?: NonNullable<ReceivedNymphEvent['thumbnailAttachment']> }>;
  downloadAttachment(eventId: string, thumbnail?: boolean): Promise<number[]>;
  openEphemeralMedia(eventId: string): Promise<number>;
  mediaStoreStatus(eventId: string): Promise<{ state: string; expires_at: number; media_exists: boolean }>;
  cancelAttachmentDuringUpload(
    envelope: NymphEnvelope,
    fileBytes: number[],
    mediaType: string,
    fileName: string,
    thumbnailBytes?: number[],
  ): Promise<boolean>;
  rejectsCorruptedAttachment(eventId: string): Promise<boolean>;
  downloadStoredCiphertext(mxcUrl: string): Promise<number[]>;
  unauthenticatedMediaStatus(mxcUrl: string): Promise<number>;
  revokeAuthorizedTemporaryDevice(password: string): Promise<void>;
  setTyping(isTyping: boolean): Promise<void>;
  markRead(eventId: string): Promise<void>;
  joinedMembers(session: HarnessSession, roomId: string): Promise<string[]>;
  revokeDevice(deviceId: string, password: string): Promise<void>;
  refreshSecurity(): Promise<unknown>;
  logout(session: HarnessSession): Promise<void>;
  whoamiStatus(session: HarnessSession): Promise<number>;
  inviteStatus(session: HarnessSession, roomId: string, userId: string): Promise<number>;
  crossSigningIdentityIds(): Promise<string[]>;
  getEvents(): ReceivedNymphEvent[];
  getVerifications(): MatrixVerification[];
  getSecurity(): unknown;
  getTyping(): boolean;
  getReadEventIds(): string[];
};

async function loginWithRateLimitRetry<T>(login: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await login();
    } catch (error) {
      if (
        error === null ||
        typeof error !== 'object' ||
        !('errcode' in error) ||
        error.errcode !== 'M_LIMIT_EXCEEDED' ||
        !('getRetryAfterMs' in error) ||
        typeof error.getRetryAfterMs !== 'function' ||
        attempt >= 2
      ) {
        throw error;
      }
      const delay = error.getRetryAfterMs();
      if (typeof delay !== 'number' || !Number.isSafeInteger(delay) || delay < 0 || delay > 90_000) {
        throw error;
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
    }
  }
}

const matrixConfig = {
  homeserverUrl: import.meta.env.VITE_MATRIX_HOMESERVER,
  serverName: import.meta.env.VITE_MATRIX_SERVER_NAME,
  partnerA: import.meta.env.VITE_MATRIX_PARTNER_A_USER_ID,
  partnerB: import.meta.env.VITE_MATRIX_PARTNER_B_USER_ID,
};
if (
  matrixConfig.homeserverUrl !== 'http://127.0.0.1:18008' ||
  matrixConfig.serverName !== 'nymph-dev.localhost' ||
  matrixConfig.partnerA !== '@partner1-dev:nymph-dev.localhost' ||
  matrixConfig.partnerB !== '@partner2-dev:nymph-dev.localhost'
) {
  throw new Error('Matrix test harness requires the exact isolated Stage 3H development configuration.');
}
const apiBase = matrixConfig.homeserverUrl;
let activeConnection: HarnessSession | null = null;
const partnerPairs = [[matrixConfig.partnerA, matrixConfig.partnerB]] as const;
const state: HarnessState = {
  client: null,
  events: [],
  verifications: [],
  security: null,
  typing: false,
  readEventIds: [],
  async connect(connection, storageKey) {
    this.disconnect();
    activeConnection = connection;
    this.events = [];
    this.verifications = [];
    this.security = null;
    this.typing = false;
    this.readEventIds = [];
    this.client = await connectMatrix(
      storageKey ? { ...connection, storageKey: Uint8Array.from(storageKey) } : connection,
      (event) => this.events.push(event),
      () => undefined,
      (verification) => {
        if (!verification) return;
        const index = this.verifications.findIndex((item) => item.id === verification.id);
        if (index === -1) this.verifications.push(verification);
        else this.verifications[index] = verification;
      },
      (security) => { this.security = security; },
      (typing) => { this.typing = typing; },
      (eventId) => { this.readEventIds.push(eventId); },
    );
  },
  disconnect() {
    this.client?.close();
    this.client = null;
    activeConnection = null;
  },
  async passwordLogin(userId, password, deviceName, deviceId) {
    const pair = partnerPairs.find(([partnerA, partnerB]) => userId === partnerA || userId === partnerB);
    if (!pair) throw new Error('The requested login is not a configured NYMPH partner account.');
    const [partnerA, partnerB] = pair;
    const { createClient } = await import('matrix-js-sdk');
    const loginClient = createClient({ baseUrl: apiBase });
    try {
      const session = await loginWithRateLimitRetry(() => loginClient.login('m.login.password', {
          identifier: { type: 'm.id.user', user: userId },
          password,
          initial_device_display_name: deviceName,
          device_id: deviceId ?? crypto.randomUUID(),
        }));
      return {
        homeserver: apiBase,
        userId: session.user_id,
        partnerUserId: userId === partnerA ? partnerB : partnerA,
        accessToken: session.access_token,
        roomId: '',
        deviceId: session.device_id,
      };
    } finally {
      loginClient.stopClient();
    }
  },
  async roomStatus(connection) {
    const response = await fetch(`${apiBase}/_synapse/client/nymph/pairing/status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.accessToken}`, 'Content-Type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Room status request failed (${response.status}).`);
    const body = await response.json() as { room_id?: unknown };
    if (typeof body.room_id !== 'string') throw new Error('The local server has no existing NYMPH room.');
    return { room_id: body.room_id };
  },
  async createInvitation(connection) {
    const invitation = await postJson<Record<string, unknown>>(
      '/_synapse/client/nymph/pairing/create',
      { room_id: connection.roomId },
      connection.accessToken,
    );
    return { ...invitation, homeserver: matrixConfig.homeserverUrl };
  },
  async encodeInvitationQr(invite) {
    const dataUrl = await QRCode.toDataURL(JSON.stringify(invite), {
      errorCorrectionLevel: 'Q',
      margin: 2,
      width: 320,
    });
    const decoded = await new BrowserQRCodeReader().decodeFromImageUrl(dataUrl);
    return decoded.getText();
  },
  async redeemInvitation(invite, deviceId) {
    const invitation = (
      typeof invite === 'string' ? JSON.parse(invite) : invite
    ) as { token: string; homeserver: string; room_id: string; partner_user_id: string };
    if (invitation.homeserver !== matrixConfig.homeserverUrl) {
      throw new Error('The pairing QR does not target the isolated NYMPH homeserver.');
    }
    const pair = partnerPairs.find(([, partnerB]) => partnerB === invitation.partner_user_id);
    if (!pair) throw new Error('The pairing invitation targets an unconfigured NYMPH partner.');
    const [partnerA, partnerB] = pair;
    const redeemed = await postJson<{
      partner_user_id: string;
      room_id: string;
      login_token: string;
    }>('/_synapse/client/nymph/pairing/redeem', { token: invitation.token });
    if (redeemed.partner_user_id !== partnerB || redeemed.room_id !== invitation.room_id) {
      throw new Error('Pairing returned an unexpected partner identity or room.');
    }
    const { createClient } = await import('matrix-js-sdk');
    const loginClient = createClient({ baseUrl: apiBase });
    try {
      const session = await loginClient.login('m.login.token', {
        token: redeemed.login_token,
        initial_device_display_name: 'NYMPH automated Partner 2',
        device_id: deviceId ?? crypto.randomUUID(),
      });
      if (session.user_id !== partnerB) throw new Error('Pairing did not authenticate Partner 2.');
      return {
        homeserver: apiBase,
        userId: session.user_id,
        partnerUserId: partnerA,
        accessToken: session.access_token,
        roomId: redeemed.room_id,
        deviceId: session.device_id,
      };
    } finally {
      loginClient.stopClient();
    }
  },
  async replayInvitation(invite) {
    const invitation = invite as { token: string };
    const response = await fetch(`${apiBase}/_synapse/client/nymph/pairing/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: invitation.token }),
      cache: 'no-store',
    });
    return response.status;
  },
  async unlockExistingSecretStorage(recoveryKey, password) {
    if (!this.client) throw new Error('Connect a Matrix client before unlocking Secret Storage.');
    return this.client.unlockExistingSecretStorage(recoveryKey, password);
  },
  async prepareSecretStorageSetup() {
    if (!this.client) throw new Error('Connect a Matrix client before preparing Secret Storage.');
    return this.client.prepareSecretStorageSetup();
  },
  async commitSecretStorageSetup(confirmation) {
    if (!this.client) throw new Error('Connect a Matrix client before confirming Secret Storage.');
    return this.client.commitSecretStorageSetup(confirmation);
  },
  async bootstrapSecurity(password) {
    if (!this.client) throw new Error('Connect a Matrix client before bootstrapping security.');
    await this.client.bootstrapSecurity(password);
  },
  async verifyRecoveryOnSeparateDevice(recoveryKey, password) {
    if (!this.client) throw new Error('Connect a Matrix client before verifying recovery.');
    return this.client.verifyRecoveryOnSeparateDevice(recoveryKey, password);
  },
  async requestPartnerVerification(deviceId) {
    if (!this.client) throw new Error('Connect a Matrix client before requesting verification.');
    await this.client.requestPartnerVerification(deviceId);
  },
  async acceptVerification(id) {
    if (!this.client) throw new Error('Connect a Matrix client before accepting verification.');
    await this.client.acceptVerification(id);
  },
  async startSasVerification(id) {
    if (!this.client) throw new Error('Connect a Matrix client before starting SAS.');
    await this.client.startSasVerification(id);
  },
  async confirmSas(id) {
    if (!this.client) throw new Error('Connect a Matrix client before confirming SAS.');
    await this.client.confirmSas(id);
  },
  async cancelVerification(id) {
    if (!this.client) throw new Error('Connect a Matrix client before cancelling verification.');
    await this.client.cancelVerification(id);
    const index = this.verifications.findIndex((item) => item.id === id);
    if (index >= 0) this.verifications[index] = { ...this.verifications[index], phase: 'Cancelled' };
  },
  async send(envelope) {
    if (!this.client) throw new Error('Connect a Matrix client before sending.');
    return this.client.send(envelope);
  },
  async sendAttachment(envelope, fileBytes, mediaType, fileName, thumbnailBytes, pendingExpirySeconds) {
    if (!this.client) throw new Error('Connect a Matrix client before sending encrypted media.');
    const file = new File([Uint8Array.from(fileBytes)], fileName, { type: mediaType });
    const thumbnail = thumbnailBytes
      ? new File([Uint8Array.from(thumbnailBytes)], 'preview.webp', { type: 'image/webp' })
      : undefined;
    return this.client.sendAttachment(file, envelope, {
      ...(thumbnail ? { thumbnail } : {}),
      ...(pendingExpirySeconds === undefined ? {} : { pendingExpirySeconds }),
    });
  },
  async downloadAttachment(eventId, thumbnail = false) {
    if (!this.client) throw new Error('Connect a Matrix client before downloading encrypted media.');
    const event = this.events.find((item) => item.eventId === eventId);
    const file = thumbnail ? event?.thumbnailAttachment : event?.attachment;
    const mediaType = thumbnail ? 'image/webp' : event?.mediaType;
    if (!file || !mediaType) throw new Error('The requested encrypted media event is unavailable.');
    const blob = await this.client.downloadAttachment(file, mediaType);
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  },
  async openEphemeralMedia(eventId) {
    if (!this.client) throw new Error('Connect a Matrix client before opening expiring media.');
    const event = this.events.find((item) => item.eventId === eventId);
    if (!event?.attachment) throw new Error('The expiring media event is unavailable.');
    return this.client.openEphemeralMedia(event.attachment);
  },
  async mediaStoreStatus(eventId) {
    if (!activeConnection) throw new Error('Connect a Matrix client before checking media expiration.');
    const event = this.events.find((item) => item.eventId === eventId);
    if (!event?.attachment) throw new Error('The expiring media event is unavailable.');
    const mediaUrl = new URL(event.attachment.url);
    const match = mediaUrl.pathname.match(/^\/_synapse\/client\/nymph\/media\/content\/([A-Za-z0-9._=-]{1,255})$/);
    if (mediaUrl.origin !== new URL(apiBase).origin || !match) {
      throw new Error('The event does not reference registered view-once media.');
    }
    return postJson(
      '/_synapse/client/nymph/media/status',
      { media_id: match[1] },
      activeConnection.accessToken,
    ) as Promise<{ state: string; expires_at: number; media_exists: boolean }>;
  },
  async cancelAttachmentDuringUpload(envelope, fileBytes, mediaType, fileName, thumbnailBytes) {
    if (!this.client) throw new Error('Connect a Matrix client before testing upload cancellation.');
    const file = new File([Uint8Array.from(fileBytes)], fileName, { type: mediaType });
    const thumbnail = thumbnailBytes
      ? new File([Uint8Array.from(thumbnailBytes)], 'preview.webp', { type: 'image/webp' })
      : undefined;
    const controller = new AbortController();
    let interrupted = false;
    try {
      await this.client.sendAttachment(file, envelope, {
        ...(thumbnail ? { thumbnail } : {}),
        signal: controller.signal,
        onProgress: (progress) => {
          if (!interrupted && progress > 0) {
            interrupted = true;
            controller.abort();
          }
        },
      });
      return false;
    } catch (error) {
      if (interrupted && controller.signal.aborted) return true;
      throw error;
    }
  },
  async rejectsCorruptedAttachment(eventId) {
    if (!this.client) throw new Error('Connect a Matrix client before testing media integrity.');
    const event = this.events.find((item) => item.eventId === eventId);
    if (!event?.attachment || !event.mediaType) throw new Error('The encrypted media event is unavailable.');
    const tampered = {
      ...event.attachment,
      hashes: { ...event.attachment.hashes, sha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    };
    try {
      await this.client.downloadAttachment(tampered, event.mediaType);
      return false;
    } catch (error) {
      if (error instanceof Error && error.message.includes('integrity check failed')) return true;
      throw error;
    }
  },
  async downloadStoredCiphertext(mxcUrl) {
    if (!activeConnection) throw new Error('Connect a Matrix client before inspecting encrypted media storage.');
    const { createClient } = await import('matrix-js-sdk');
    const mediaClient = createClient({ baseUrl: apiBase });
    const url = mediaClient.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, false, false, true);
    mediaClient.stopClient();
    if (!url) throw new Error('The encrypted media URL is invalid.');
    const response = await fetch(url, {
      headers: { Authorization: 'Bearer ' + activeConnection.accessToken },
      credentials: 'omit',
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Could not inspect stored encrypted media (${response.status}).`);
    return Array.from(new Uint8Array(await response.arrayBuffer()));
  },
  async unauthenticatedMediaStatus(mxcUrl) {
    const { createClient } = await import('matrix-js-sdk');
    const mediaClient = createClient({ baseUrl: apiBase });
    const url = mediaClient.mxcUrlToHttp(mxcUrl);
    mediaClient.stopClient();
    if (!url) throw new Error('The encrypted media URL is invalid.');
    const response = await fetch(url, { credentials: 'omit', redirect: 'error' });
    await response.body?.cancel();
    return response.status;
  },
  async revokeAuthorizedTemporaryDevice(password) {
    if (!this.client || !activeConnection || !password) {
      throw new Error('Connect the active partner device before testing authorized device revocation.');
    }
    const { createClient, MatrixError } = await import('matrix-js-sdk');
    const temporaryDeviceId = `NYMPH_LIFECYCLE_${crypto.randomUUID().replaceAll('-', '')}`;
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.set('Authorization', 'Bearer ' + activeConnection.accessToken);
    const authorizationResponse = await fetch(`${apiBase}/_synapse/client/nymph/device/recovery-check`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ device_id: temporaryDeviceId }),
      cache: 'no-store',
    });
    if (!authorizationResponse.ok) {
      throw new Error(`The active partner device could not authorize lifecycle testing (${authorizationResponse.status}).`);
    }
    const authorization = await authorizationResponse.json() as {
      user_id?: unknown;
      device_id?: unknown;
      login_token?: unknown;
    };
    if (
      authorization.user_id !== activeConnection.userId ||
      authorization.device_id !== temporaryDeviceId ||
      typeof authorization.login_token !== 'string'
    ) {
      throw new Error('The server returned invalid temporary-device authorization.');
    }

    const loginClient = createClient({ baseUrl: apiBase });
    let verifierClient: ReturnType<typeof createClient> | undefined;
    let verifierSession: Awaited<ReturnType<typeof loginClient.login>> | undefined;
    try {
      verifierSession = await loginClient.login('m.login.token', {
        token: authorization.login_token,
        device_id: temporaryDeviceId,
        initial_device_display_name: 'NYMPH lifecycle verifier',
      });
      if (
        verifierSession.user_id !== activeConnection.userId ||
        verifierSession.device_id !== temporaryDeviceId
      ) {
        throw new Error('The server authenticated an unexpected temporary test device.');
      }
      verifierClient = createClient({
        baseUrl: apiBase,
        accessToken: verifierSession.access_token,
        userId: verifierSession.user_id,
        deviceId: verifierSession.device_id,
      });
    } finally {
      loginClient.stopClient();
    }
    if (!verifierClient || !verifierSession) throw new Error('The temporary verifier session was not created.');

    const cancellationHeaders = new Headers({ 'Content-Type': 'application/json' });
    cancellationHeaders.set('Authorization', 'Bearer ' + activeConnection.accessToken);
    await revokeRecoveryVerifier(
      {
        getDevices: async () => ({
          devices: (await this.client!.getSecurityState()).ownDevices.map(({ deviceId }) => ({
            device_id: deviceId,
          })),
        }),
        deleteDevice: async (deviceId, auth) => this.client!.revokeDevice(deviceId, auth.password),
      },
      {
        logout: async () => { await verifierClient!.logout(false); },
        stopClient: () => verifierClient!.stopClient(),
      },
      {
        userId: activeConnection.userId,
        primaryDeviceId: this.client.deviceId,
        temporaryDeviceId,
        password,
      },
      {
        cancelAuthorization: async () => {
          const response = await fetch(`${apiBase}/_synapse/client/nymph/device/cancel`, {
            method: 'POST',
            headers: cancellationHeaders,
            body: '{}',
            cache: 'no-store',
          });
          await response.arrayBuffer();
          if (!response.ok) throw new Error('Temporary-device authorization could not be cancelled.');
        },
        isAccessTokenRejected: async () => {
          const response = await fetch(`${apiBase}/_matrix/client/v3/account/whoami`, {
            headers: { Authorization: 'Bearer ' + verifierSession!.access_token },
            cache: 'no-store',
          });
          await response.arrayBuffer();
          return response.status === 401;
        },
        isNewLoginRejected: async () => {
          const attempt = createClient({ baseUrl: apiBase });
          try {
            await attempt.login('m.login.password', {
              identifier: { type: 'm.id.user', user: activeConnection!.userId },
              password,
              device_id: temporaryDeviceId,
            });
            await attempt.logout(false);
            return false;
          } catch (error) {
            return error instanceof MatrixError && error.httpStatus === 403 && error.errcode === 'M_FORBIDDEN';
          } finally {
            attempt.stopClient();
          }
        },
      },
    );
  },
  async setTyping(isTyping) {
    if (!this.client) throw new Error('Connect a Matrix client before setting typing state.');
    await this.client.setTyping(isTyping);
  },
  async markRead(eventId) {
    if (!this.client) throw new Error('Connect a Matrix client before marking a receipt.');
    await this.client.markRead(eventId);
  },
  async joinedMembers(session, roomId) {
    const response = await fetch(
      `${apiBase}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
      {
        headers: { Authorization: `Bearer ${session.accessToken}` },
        cache: 'no-store',
      },
    );
    if (!response.ok) throw new Error(`Room membership request failed (${response.status}).`);
    const body = await response.json() as { joined?: Record<string, unknown> };
    if (!body.joined || typeof body.joined !== 'object') {
      throw new Error('The homeserver returned invalid room membership data.');
    }
    return Object.keys(body.joined).sort();
  },
  async revokeDevice(deviceId, password) {
    if (!this.client) throw new Error('Connect a Matrix client before revoking a device.');
    await this.client.revokeDevice(deviceId, password);
  },
  async refreshSecurity() {
    if (!this.client) throw new Error('Connect a Matrix client before checking security.');
    return this.client.getSecurityState();
  },
  async logout(session) {
    const response = await fetch(`${apiBase}/_matrix/client/v3/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.accessToken}` },
      cache: 'no-store',
    });
    await response.arrayBuffer();
    if (!response.ok) throw new Error('Could not log out the temporary Matrix session.');
  },
  async whoamiStatus(session) {
    const response = await fetch(`${apiBase}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      cache: 'no-store',
    });
    await response.arrayBuffer();
    return response.status;
  },
  async inviteStatus(session, roomId, userId) {
    const response = await fetch(
      `${apiBase}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ user_id: userId }),
        cache: 'no-store',
      },
    );
    await response.arrayBuffer();
    return response.status;
  },
  async crossSigningIdentityIds() {
    if (!this.client) throw new Error('Connect a Matrix client before checking cross-signing.');
    return this.client.getCrossSigningIdentityIds();
  },
  getEvents() { return this.events; },
  getVerifications() { return this.verifications; },
  getSecurity() { return this.security; },
  getTyping() { return this.typing; },
  getReadEventIds() { return this.readEventIds; },
};

async function postJson<T>(path: string, body: unknown, accessToken?: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Pairing request failed (${response.status}).`);
  return response.json() as Promise<T>;
}

Object.defineProperty(window, 'prompt', {
  configurable: true,
  value: () => (window as Window & { __nymphRecoveryKey?: string }).__nymphRecoveryKey ?? null,
});
(window as Window & { nymphMatrixHarness?: HarnessState }).nymphMatrixHarness = state;
document.querySelector('#status')!.textContent = 'Isolated Matrix test client ready';
