import {
  connectMatrix,
  type MatrixConnection,
  type MatrixMessagingClient,
  type MatrixVerification,
  type NymphEnvelope,
  type ReceivedNymphEvent,
} from '../../src/matrix/MessagingClient';

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
  redeemInvitation(invite: unknown, deviceId?: string): Promise<HarnessSession>;
  replayInvitation(invite: unknown): Promise<number>;
  unlockExistingSecretStorage(recoveryKey: string, password: string): Promise<string>;
  prepareSecretStorageSetup(): Promise<string>;
  commitSecretStorageSetup(confirmation: string): Promise<string>;
  discardPendingSecretStorageKey(): void;
  bootstrapSecurity(password: string): Promise<void>;
  requestPartnerVerification(deviceId: string): Promise<void>;
  acceptVerification(id: string): Promise<void>;
  startSasVerification(id: string): Promise<void>;
  confirmSas(id: string): Promise<void>;
  send(envelope: NymphEnvelope): Promise<string>;
  setTyping(isTyping: boolean): Promise<void>;
  markRead(eventId: string): Promise<void>;
  refreshSecurity(): Promise<unknown>;
  revokeDevice(deviceId: string, password: string): Promise<void>;
  getEvents(): ReceivedNymphEvent[];
  getVerifications(): MatrixVerification[];
  getSecurity(): unknown;
  getTyping(): boolean;
  getReadEventIds(): string[];
};

const apiBase = 'http://127.0.0.1:8008';
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
    const { createClient } = await import('matrix-js-sdk');
    const loginClient = createClient({ baseUrl: apiBase });
    try {
      const session = await loginClient.login('m.login.password', {
        identifier: { type: 'm.id.user', user: userId },
        password,
        initial_device_display_name: deviceName,
        ...(deviceId ? { device_id: deviceId } : {}),
      });
      return {
        homeserver: apiBase,
        userId: session.user_id,
        partnerUserId: userId === '@partner1:localhost' ? '@partner2:localhost' : '@partner1:localhost',
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
    return postJson('/_synapse/client/nymph/pairing/create', { room_id: connection.roomId }, connection.accessToken);
  },
  async redeemInvitation(invite, deviceId) {
    const invitation = invite as { token: string; room_id: string };
    const redeemed = await postJson<{
      partner_user_id: string;
      room_id: string;
      login_token: string;
    }>('/_synapse/client/nymph/pairing/redeem', { token: invitation.token });
    if (redeemed.partner_user_id !== '@partner2:localhost' || redeemed.room_id !== invitation.room_id) {
      throw new Error('Pairing returned an unexpected partner identity or room.');
    }
    const { createClient } = await import('matrix-js-sdk');
    const loginClient = createClient({ baseUrl: apiBase });
    try {
      const session = await loginClient.login('m.login.token', {
        token: redeemed.login_token,
        initial_device_display_name: 'NYMPH automated Partner 2',
        ...(deviceId ? { device_id: deviceId } : {}),
      });
      if (session.user_id !== '@partner2:localhost') throw new Error('Pairing did not authenticate Partner 2.');
      return {
        homeserver: apiBase,
        userId: session.user_id,
        partnerUserId: '@partner1:localhost',
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
  discardPendingSecretStorageKey() {
    this.client?.discardPendingSecretStorageKey();
  },
  async bootstrapSecurity(password) {
    if (!this.client) throw new Error('Connect a Matrix client before bootstrapping security.');
    return this.client.bootstrapSecurity(password);
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
  async refreshSecurity() {
    if (!this.client) throw new Error('Connect a Matrix client before checking security.');
    return this.client.getSecurityState();
  },
  async revokeDevice(deviceId, password) {
    if (!this.client) throw new Error('Connect a Matrix client before revoking a device.');
    await this.client.revokeDevice(deviceId, password);
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
