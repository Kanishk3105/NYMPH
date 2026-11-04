import {
  connectMatrix,
  type MatrixConnection,
  type MatrixMessagingClient,
  type MatrixVerification,
  type NymphEnvelope,
  type ReceivedNymphEvent,
} from '../../src/matrix/MessagingClient';
import { decryptRecoveryExport, encryptRecoveryExport } from '../../src/matrix/recovery-export';

type HarnessSession = MatrixConnection;
type HarnessState = {
  client: MatrixMessagingClient | null;
  events: ReceivedNymphEvent[];
  verifications: MatrixVerification[];
  security: unknown;
  typing: boolean;
  readEventIds: string[];
  preparedRecoveryKey: string;
  connect(connection: HarnessSession, storageKey?: number[]): Promise<void>;
  disconnect(): void;
  passwordLogin(userId: string, password: string, deviceName: string, deviceId?: string): Promise<HarnessSession>;
  roomStatus(connection: HarnessSession): Promise<{ room_id: string }>;
  createInvitation(connection: HarnessSession): Promise<unknown>;
  redeemInvitation(invite: unknown, deviceId?: string): Promise<HarnessSession>;
  replayInvitation(invite: unknown): Promise<number>;
  unlockExistingSecretStorage(recoveryKey: string, password: string): Promise<string>;
  prepareRecoveryExport(passphrase: string): Promise<{ keyId: string; encryptedExport: string }>;
  finishRecoverySetup(password: string): Promise<string[]>;
  restoreRecoveryExport(encryptedExport: string, passphrase: string, password: string): Promise<string[]>;
  verifyRecoveryOnSeparateDevice(recoveryKey: string, password: string): Promise<string>;
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
  createDeviceReplacement(connection: HarnessSession, deviceId: string): Promise<{
    user_id: string;
    device_id: string;
    previous_device_id: string;
    room_id: string;
    login_token: string;
  }>;
  loginReplacement(homeserver: string, authorization: {
    user_id: string;
    device_id: string;
    room_id: string;
    login_token: string;
  }): Promise<HarnessSession>;
  deleteDevice(session: HarnessSession, deviceId: string, password: string): Promise<void>;
  activateReplacement(session: HarnessSession): Promise<void>;
  cancelReplacement(session: HarnessSession): Promise<void>;
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

const apiBase = 'http://127.0.0.1:8008';
const partnerPairs = [
  ['@partner1:localhost', '@partner2:localhost'],
  ['@partner1-dev:localhost', '@partner2-dev:localhost'],
] as const;
const state: HarnessState = {
  client: null,
  events: [],
  verifications: [],
  security: null,
  typing: false,
  readEventIds: [],
  preparedRecoveryKey: '',
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
    this.preparedRecoveryKey = '';
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
    return postJson('/_synapse/client/nymph/pairing/create', { room_id: connection.roomId }, connection.accessToken);
  },
  async redeemInvitation(invite, deviceId) {
    const invitation = invite as { token: string; room_id: string; partner_user_id: string };
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
  async prepareRecoveryExport(passphrase) {
    if (!this.client) throw new Error('Connect a Matrix client before preparing recovery.');
    const recoveryKey = await this.client.prepareSecretStorageSetup();
    this.preparedRecoveryKey = recoveryKey;
    try {
      const keyId = await this.client.commitSecretStorageSetup(recoveryKey);
      const encryptedExport = await encryptRecoveryExport({
        account: this.client.userId,
        keyId,
        recoveryKey,
      }, passphrase);
      return { keyId, encryptedExport };
    } catch (error) {
      this.client.discardPendingSecretStorageKey();
      this.preparedRecoveryKey = '';
      throw error;
    }
  },
  async finishRecoverySetup(password) {
    if (!this.client || !this.preparedRecoveryKey) {
      throw new Error('Prepare the partner recovery export before completing security setup.');
    }
    const recoveryKey = this.preparedRecoveryKey;
    try {
      await this.client.bootstrapSecurity(password);
      await this.client.verifyRecoveryOnSeparateDevice(recoveryKey, password);
      const identityIds = await this.client.getCrossSigningIdentityIds();
      if (identityIds.length !== 3) {
        throw new Error('The restored cross-signing identity is incomplete.');
      }
      return identityIds;
    } finally {
      this.preparedRecoveryKey = '';
    }
  },
  async restoreRecoveryExport(encryptedExport, passphrase, password) {
    if (!this.client) throw new Error('Connect a Matrix client before restoring recovery.');
    const contents = await decryptRecoveryExport(encryptedExport, passphrase);
    if (contents.account !== this.client.userId) {
      throw new Error('The encrypted recovery export belongs to a different Matrix account.');
    }
    const security = await this.client.getSecurityState();
    if (!security.defaultSecretStorageKeyId || contents.keyId !== security.defaultSecretStorageKeyId) {
      throw new Error('The encrypted recovery export does not match the account default Secret Storage key.');
    }
    try {
      await this.client.unlockExistingSecretStorage(contents.recoveryKey, password);
      await this.client.verifyRecoveryOnSeparateDevice(contents.recoveryKey, password);
      const identityIds = await this.client.getCrossSigningIdentityIds();
      if (identityIds.length !== 3) {
        throw new Error('The restored cross-signing identity is incomplete.');
      }
      return identityIds;
    } finally {
      contents.recoveryKey = '';
    }
  },
  async verifyRecoveryOnSeparateDevice(recoveryKey, password) {
    if (!this.client) throw new Error('Connect a Matrix client before verifying recovery.');
    return this.client.verifyRecoveryOnSeparateDevice(recoveryKey, password);
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
  async createDeviceReplacement(connection, deviceId) {
    return postJson('/_synapse/client/nymph/device/replace', { device_id: deviceId }, connection.accessToken);
  },
  async loginReplacement(homeserver, authorization) {
    const { createClient } = await import('matrix-js-sdk');
    const loginClient = createClient({ baseUrl: homeserver });
    try {
      const session = await loginClient.login('m.login.token', {
        token: authorization.login_token,
        device_id: authorization.device_id,
        initial_device_display_name: 'NYMPH replacement acceptance test',
      });
      if (session.user_id !== authorization.user_id || session.device_id !== authorization.device_id) {
        throw new Error('The replacement token authenticated an unexpected Matrix device.');
      }
      return {
        homeserver,
        userId: session.user_id,
        partnerUserId: session.user_id === '@partner1-dev:localhost'
          ? '@partner2-dev:localhost'
          : '@partner1-dev:localhost',
        accessToken: session.access_token,
        roomId: authorization.room_id,
        deviceId: session.device_id,
      };
    } finally {
      loginClient.stopClient();
    }
  },
  async deleteDevice(session, deviceId, password) {
    const { createClient } = await import('matrix-js-sdk');
    const client = createClient({
      baseUrl: session.homeserver,
      accessToken: session.accessToken,
      userId: session.userId,
      ...(session.deviceId ? { deviceId: session.deviceId } : {}),
    });
    try {
      await client.deleteDevice(deviceId, {
        type: 'm.login.password',
        user: session.userId,
        password,
      });
    } finally {
      client.stopClient();
    }
  },
  async activateReplacement(session) {
    await postJson('/_synapse/client/nymph/device/activate', {}, session.accessToken);
  },
  async cancelReplacement(session) {
    await postJson('/_synapse/client/nymph/device/cancel', {}, session.accessToken);
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
