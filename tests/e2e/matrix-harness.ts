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
const ENVELOPE_PREFIX = 'nymph.v1:';

function isMode(value: unknown): value is 'romantic' | 'flirty' | 'spicy' | 'kinky' {
  return value === 'romantic' || value === 'flirty' || value === 'spicy' || value === 'kinky';
}

function isEncryptedAttachment(value: unknown): value is NonNullable<ReceivedNymphEvent['attachment']> {
  if (!value || typeof value !== 'object') return false;
  const file = value as Record<string, unknown>;
  const url = file.url;
  const isMxcUrl = typeof url === 'string' && url.startsWith('mxc://');
  const isNymphEphemeralUrl = typeof url === 'string' && /^https?:\/\/[^/]+\/_synapse\/client\/nymph\/media\/content\/[A-Za-z0-9._=-]{1,255}$/.test(url);
  return file.v === 'v2' && (isMxcUrl || isNymphEphemeralUrl) &&
    file.key && typeof file.key === 'object' &&
    (file.key as { alg?: unknown }).alg === 'A256CTR' &&
    (file.key as { kty?: unknown }).kty === 'oct' &&
    (file.key as { ext?: unknown }).ext === true &&
    Array.isArray((file.key as { key_ops?: unknown[] }).key_ops) &&
    ((file.key as { key_ops: string[] }).key_ops as string[]).includes('decrypt') &&
    typeof (file.key as { k?: unknown }).k === 'string' &&
    typeof file.iv === 'string' &&
    typeof (file.hashes as { sha256?: unknown } | undefined)?.sha256 === 'string';
}

function decodeHarvesterEnvelopeBody(body: string, sender: string, eventId: string, eventTimestamp: number): ReceivedNymphEvent | undefined {
  if (!body.startsWith(ENVELOPE_PREFIX)) return undefined;
  try {
    const parsed: unknown = JSON.parse(body.slice(ENVELOPE_PREFIX.length));
    if (!parsed || typeof parsed !== 'object') return undefined;
    const payload = parsed as Partial<NymphEnvelope>;
    if (
      payload.version !== 1 ||
      typeof payload.id !== 'string' ||
      !isMode(payload.mode) ||
      !['text', 'mood', 'sticker', 'media', 'reaction'].includes(String(payload.kind)) ||
      typeof payload.text !== 'string' ||
      typeof payload.sentAt !== 'number'
    ) return undefined;
    if (
      (payload.kind === 'media' && !isEncryptedAttachment(payload.attachment)) ||
      (payload.attachment !== undefined && (!isEncryptedAttachment(payload.attachment) || typeof payload.mediaType !== 'string' || typeof payload.mediaName !== 'string')) ||
      (payload.durationMs !== undefined && (typeof payload.durationMs !== 'number' || !Number.isFinite(payload.durationMs) || payload.durationMs < 0)) ||
      (payload.viewOnceSeconds !== undefined && (payload.kind !== 'media' || !payload.attachment || typeof payload.viewOnceSeconds !== 'number' || !Number.isInteger(payload.viewOnceSeconds) || payload.viewOnceSeconds < 1 || payload.viewOnceSeconds > 86_400)) ||
      (payload.viewOncePendingExpiresAt !== undefined && (typeof payload.viewOncePendingExpiresAt !== 'number' || !Number.isFinite(payload.viewOncePendingExpiresAt))) ||
      (payload.viewOnceReceipt !== undefined && (payload.kind !== 'text' || !payload.viewOnceReceipt || typeof payload.viewOnceReceipt.messageId !== 'string' || typeof payload.viewOnceReceipt.expiresAt !== 'number' || !Number.isFinite(payload.viewOnceReceipt.expiresAt))) ||
      (payload.retentionPolicy !== undefined && (!payload.retentionPolicy || (payload.retentionPolicy.seconds !== null && (typeof payload.retentionPolicy.seconds !== 'number' || !Number.isInteger(payload.retentionPolicy.seconds) || payload.retentionPolicy.seconds < 1 || payload.retentionPolicy.seconds > 31_536_000)))) ||
      (payload.waveform !== undefined && (!Array.isArray(payload.waveform) || payload.waveform.length > 64 || payload.waveform.some((sample) => typeof sample !== 'number' || !Number.isFinite(sample) || sample < 0 || sample > 1))) ||
      (payload.stickerSync !== undefined && !('operation' in (payload.stickerSync ?? {}))) ||
      (payload.thumbnailAttachment !== undefined && (!isEncryptedAttachment(payload.thumbnailAttachment) || !isEncryptedAttachment(payload.attachment)))
    ) return undefined;

    return {
      ...payload as NymphEnvelope,
      sender,
      eventId: eventId || payload.id,
      sentAt: eventTimestamp || payload.sentAt,
    };
  } catch {
    return undefined;
  }
}

function decodeRawMatrixEvent(rawEvent: { getType(): string; getContent(): { body?: unknown }; getSender(): string | null; getId(): string | null; getTs(): number; } | null | undefined): ReceivedNymphEvent | undefined {
  if (!rawEvent || (rawEvent.getType() !== 'm.room.message' && rawEvent.getType() !== 'm.reaction')) return undefined;
  const content = rawEvent.getContent();
  if (typeof content.body !== 'string') return undefined;
  return decodeHarvesterEnvelopeBody(content.body, rawEvent.getSender() ?? '', rawEvent.getId() ?? crypto.randomUUID(), rawEvent.getTs());
}

function findRoomEventById(eventId: string): ReceivedNymphEvent | undefined {
  if (!activeConnection) return undefined;
  const room = state.client?.getRoom(activeConnection.roomId);
  return room?.getLiveTimeline().getEvents()
    .map((matrixEvent) => decodeRawMatrixEvent(matrixEvent))
    .find((candidate) => candidate?.eventId === eventId);
}

type HarnessState = {
  client: MatrixMessagingClient | null;
  events: ReceivedNymphEvent[];
  verifications: MatrixVerification[];
  security: unknown;
  typing: boolean;
  readEventIds: string[];
  redactedEventIds: string[];
  connect(connection: HarnessSession, storageKey?: number[]): Promise<void>;
  disconnect(): void;
  passwordLogin(
    userId: string,
    password: string,
    deviceName: string,
    deviceId?: string,
    allowRateLimitRetries?: boolean,
  ): Promise<HarnessSession>;
  roomStatus(connection: HarnessSession): Promise<{ room_id: string }>;
  createRoom(connection: HarnessSession): Promise<{ room_id: string }>;
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
  downloadAttachmentReference(
    attachment: NonNullable<ReceivedNymphEvent['attachment']>,
    mediaType: string,
  ): Promise<number[]>;
  openEphemeralMedia(eventId: string): Promise<number>;
  openEphemeralMediaReference(attachment: NonNullable<ReceivedNymphEvent['attachment']>): Promise<number>;
  mediaStoreStatus(mediaId: string): Promise<{ state: string; expires_at: number; media_exists: boolean }>;
  getRetentionPolicy(): Promise<{ seconds: number | null; eventTimestamp: number | null; eventId: string | null }>;
  messageExpiryStatus(eventId: string): Promise<{ state: string; expires_at: number | null; redaction_event_id: string | null }>;
  redactedContentKeys(eventId: string): Promise<string[]>;
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
  encryptionEvidence(eventId: string): Promise<{ eventType: string; hasCiphertext: boolean; algorithm?: string }>;
  relationEvidence(eventId: string): Promise<{ eventType: string; relationType?: string; parentEventId?: string; reactionKey?: string; body?: string }>;
  crossSigningIdentityIds(): Promise<string[]>;
  getEvents(): ReceivedNymphEvent[];
  getVerifications(): MatrixVerification[];
  getSecurity(): unknown;
  getTyping(): boolean;
  getReadEventIds(): string[];
  getRedactedEventIds(): string[];
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
  !/^http:\/\/127\.0\.0\.1:\d+$/.test(matrixConfig.homeserverUrl) ||
  matrixConfig.serverName !== 'nymph-dev.localhost' ||
  !/^@[A-Za-z0-9._=-]+:nymph-dev\.localhost$/.test(matrixConfig.partnerA) ||
  !/^@[A-Za-z0-9._=-]+:nymph-dev\.localhost$/.test(matrixConfig.partnerB) ||
  matrixConfig.partnerA === matrixConfig.partnerB
) {
  throw new Error('Matrix test harness requires the isolated local homeserver and distinct participant identities.');
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
  redactedEventIds: [],
  async connect(connection, storageKey) {
    this.disconnect();
    activeConnection = connection;
    this.events = [];
    this.verifications = [];
    this.security = null;
    this.typing = false;
    this.readEventIds = [];
    this.redactedEventIds = [];
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
      (eventId) => { this.redactedEventIds.push(eventId); },
    );
  },
  disconnect() {
    this.client?.close();
    this.client = null;
    activeConnection = null;
  },
  async passwordLogin(userId, password, deviceName, deviceId, allowRateLimitRetries = true) {
    const pair = partnerPairs.find(([partnerA, partnerB]) => userId === partnerA || userId === partnerB);
    if (!pair) throw new Error('The requested login is not a configured NYMPH partner account.');
    const [partnerA, partnerB] = pair;
    const { createClient } = await import('matrix-js-sdk');
    const loginClient = createClient({ baseUrl: apiBase });
    try {
      const login = () => loginClient.login('m.login.password', {
      identifier: { type: 'm.id.user', user: userId },
      password,
      initial_device_display_name: deviceName,
      device_id: deviceId ?? crypto.randomUUID(),
    });
      const session = allowRateLimitRetries
        ? await loginWithRateLimitRetry(login)
        : await login();
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
  async createRoom(connection) {
    const response = await fetch(`${apiBase}/_matrix/client/v3/createRoom`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visibility: 'private',
        preset: 'private_chat',
        invite: [connection.partnerUserId],
        creation_content: { 'm.federate': false },
        initial_state: [
          { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
          { type: 'm.room.join_rules', state_key: '', content: { join_rule: 'invite' } },
          { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
          {
            type: 'm.room.power_levels',
            state_key: '',
            content: {
              users: { [connection.partnerUserId]: 0 },
              users_default: 0,
              events_default: 0,
              state_default: 100,
              invite: 100,
              kick: 100,
              ban: 100,
              redact: 100,
            },
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Room creation failed (${response.status}).`);
    const body = await response.json() as { room_id?: unknown };
    if (typeof body.room_id !== 'string') throw new Error('Room creation returned no room ID.');
    const inviteResponse = await fetch(
      `${apiBase}/_matrix/client/v3/rooms/${encodeURIComponent(body.room_id)}/invite`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ user_id: connection.partnerUserId }),
      },
    );
    if (!inviteResponse.ok) {
      const detail = (await inviteResponse.text()).slice(0, 240);
      throw new Error(`The disposable partner invite failed (${inviteResponse.status}): ${detail}`);
    }
    const roomPath = encodeURIComponent(body.room_id);
    let lastMembershipStatus = 0;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const membershipResponse = await fetch(
        `${apiBase}/_matrix/client/v3/rooms/${roomPath}/state/m.room.member/${encodeURIComponent(connection.partnerUserId)}`,
        { headers: { Authorization: 'Bearer ' + connection.accessToken }, cache: 'no-store' },
      );
      lastMembershipStatus = membershipResponse.status;
      if (membershipResponse.ok) {
        const membership = await membershipResponse.json() as { membership?: unknown };
        if (membership.membership === 'invite' || membership.membership === 'join') return { room_id: body.room_id };
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    throw new Error(`The disposable partner invitation was not persisted before QR redemption (HTTP ${lastMembershipStatus}).`);
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
      errorCorrectionLevel: 'M',
      margin: 4,
      width: 512,
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
    const event = this.events.find((item) => item.eventId === eventId) ?? findRoomEventById(eventId);
    const file = thumbnail ? event?.thumbnailAttachment : event?.attachment;
    const mediaType = thumbnail ? 'image/webp' : event?.mediaType;
    if (!file || !mediaType) throw new Error('The requested encrypted media event is unavailable.');
    if (event && !this.events.some((item) => item.eventId === event.eventId)) this.events.push(event);
    return this.downloadAttachmentReference(file, mediaType);
  },
  async downloadAttachmentReference(attachment, mediaType) {
    if (!this.client) throw new Error('Connect a Matrix client before downloading encrypted media.');
    const blob = await this.client.downloadAttachment(attachment, mediaType);
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  },
  async openEphemeralMedia(eventId) {
    if (!this.client) throw new Error('Connect a Matrix client before opening expiring media.');
    const event = this.events.find((item) => item.eventId === eventId) ?? findRoomEventById(eventId);
    if (!event?.attachment) throw new Error('The expiring media event is unavailable.');
    if (!this.events.some((item) => item.eventId === event.eventId)) this.events.push(event);
    return this.openEphemeralMediaReference(event.attachment);
  },
  async openEphemeralMediaReference(attachment) {
    if (!this.client) throw new Error('Connect a Matrix client before opening expiring media.');
    return this.client.openEphemeralMedia(attachment);
  },
  async mediaStoreStatus(mediaId) {
    if (!activeConnection) throw new Error('Connect a Matrix client before checking media expiration.');
    if (!/^[A-Za-z0-9._=-]{1,255}$/.test(mediaId)) throw new Error('The expiring-media ID is invalid.');
    return postJson(
      '/_synapse/client/nymph/media/status',
      { media_id: mediaId },
      activeConnection.accessToken,
    ) as Promise<{ state: string; expires_at: number; media_exists: boolean }>;
  },
  async getRetentionPolicy() {
    if (!this.client) throw new Error('Connect a Matrix client before checking conversation retention.');
    return this.client.getRetentionPolicy();
  },
  async messageExpiryStatus(eventId) {
    if (!activeConnection) throw new Error('Connect a Matrix client before checking message expiry.');
    return postJson(
      '/_synapse/client/nymph/retention/message-status',
      { event_id: eventId },
      activeConnection.accessToken,
    ) as Promise<{ state: string; expires_at: number | null; redaction_event_id: string | null }>;
  },
  async redactedContentKeys(eventId) {
    if (!activeConnection) throw new Error('Connect a Matrix client before checking a redacted event.');
    const response = await fetch(
      `${apiBase}/_matrix/client/v3/rooms/${encodeURIComponent(activeConnection.roomId)}/event/${encodeURIComponent(eventId)}`,
      {
        headers: { Authorization: 'Bearer ' + activeConnection.accessToken },
        cache: 'no-store',
        redirect: 'error',
      },
    );
    if (!response.ok) throw new Error(`Could not inspect the redacted room event (${response.status}).`);
    const event: unknown = await response.json();
    if (
      !event ||
      typeof event !== 'object' ||
      !('content' in event) ||
      !event.content ||
      typeof event.content !== 'object'
    ) {
      throw new Error('The server returned an invalid redacted room event.');
    }
    return Object.keys(event.content);
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
  async encryptionEvidence(eventId) {
    if (!activeConnection || !this.client) throw new Error('Connect a Matrix client before inspecting encryption evidence.');
    const response = await fetch(
      `${apiBase}/_matrix/client/v3/rooms/${encodeURIComponent(activeConnection.roomId)}/event/${encodeURIComponent(eventId)}`,
      { headers: { Authorization: `Bearer ${activeConnection.accessToken}` }, cache: 'no-store' },
    );
    if (!response.ok) throw new Error(`The encrypted event could not be inspected (${response.status}).`);
    const event = await response.json() as { type?: unknown; content?: { algorithm?: unknown; ciphertext?: unknown } };
    const content = event.content ?? {};
    return {
      eventType: typeof event.type === 'string' ? event.type : '',
      hasCiphertext: typeof content.ciphertext === 'string' && content.ciphertext.length > 0,
      algorithm: typeof content.algorithm === 'string' ? content.algorithm : undefined,
    };
  },
  async relationEvidence(eventId) {
    if (!activeConnection || !this.client) throw new Error('Connect a Matrix client before inspecting relation evidence.');
    const evidence = this.client.inspectRelationEvent(eventId);
    if (!evidence) throw new Error('The relation event was not available in the authenticated client timeline.');
    return evidence;
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
  getRedactedEventIds() { return this.redactedEventIds; },
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
