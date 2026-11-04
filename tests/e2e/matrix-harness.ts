import {
  connectMatrix,
  type MatrixConnection,
  type MatrixMessagingClient,
  type MatrixVerification,
  type NymphEnvelope,
  type ReceivedNymphEvent,
} from '../../src/matrix/MessagingClient';
import { decryptRecoveryExport } from '../../src/matrix/recovery-export';
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
  validateRecoveryExport(
    encryptedExport: string,
    passphrase: string,
    recoveryKey: string,
    expectedUserId: string,
  ): Promise<void>;
  verifyRecoveryOnSeparateDevice(recoveryKey: string, password: string): Promise<string>;
  requestPartnerVerification(deviceId: string): Promise<void>;
  acceptVerification(id: string): Promise<void>;
  startSasVerification(id: string): Promise<void>;
  confirmSas(id: string): Promise<void>;
  cancelVerification(id: string): Promise<void>;
  send(envelope: NymphEnvelope): Promise<string>;
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
  },
  async passwordLogin(userId, password, deviceName, deviceId) {
    const pair = partnerPairs.find(([partnerA, partnerB]) => userId === partnerA || userId === partnerB);
    if (!pair) throw new Error('The requested login is not a configured NYMPH partner account.');
    const [partnerA, partnerB] = pair;
    const { createClient } = await import('matrix-js-sdk');
    const loginClient = createClient({ baseUrl: apiBase });
    try {
      const session = await loginClient.login('m.login.password', {
        identifier: { type: 'm.id.user', user: userId },
        password,
        initial_device_display_name: deviceName,
        device_id: deviceId ?? crypto.randomUUID(),
      });
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
  async validateRecoveryExport(encryptedExport, passphrase, recoveryKey, expectedUserId) {
    const contents = await decryptRecoveryExport(encryptedExport, passphrase);
    try {
      if (contents.account !== expectedUserId || contents.recoveryKey !== recoveryKey) {
        throw new Error('The local encrypted recovery export does not match the supplied partner credentials.');
      }
    } finally {
      contents.recoveryKey = '';
    }
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
  },
  async send(envelope) {
    if (!this.client) throw new Error('Connect a Matrix client before sending.');
    return this.client.send(envelope);
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
        headers: { Authorization: `****** },
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
