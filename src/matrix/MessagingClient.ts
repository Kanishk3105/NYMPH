import type {
  Device,
  MatrixClient,
  MatrixEvent,
  Room,
} from 'matrix-js-sdk';
import { Capacitor } from '@capacitor/core';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api/CryptoEvent.js';
import { CrossSigningKey, OnlySignedDevicesIsolationMode } from 'matrix-js-sdk/lib/crypto-api/index.js';
import type { GeneratedSecretStorageKey } from 'matrix-js-sdk/lib/crypto-api/index.js';
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/recovery-key.js';
import {
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
} from 'matrix-js-sdk/lib/crypto-api/verification.js';
import type {
  ShowSasCallbacks,
  VerificationRequest,
  Verifier,
} from 'matrix-js-sdk/lib/crypto-api/verification';
import { MsgType, RelationType } from 'matrix-js-sdk/lib/@types/event.js';
import type { ReactionEventContent, RoomMessageEventContent } from 'matrix-js-sdk/lib/@types/events.js';
import type { EncryptedFile } from 'matrix-js-sdk/lib/@types/media.js';
import { MatrixEventEvent } from 'matrix-js-sdk/lib/models/event.js';
import { RoomMemberEvent } from 'matrix-js-sdk/lib/models/room-member.js';
import { revokeRecoveryVerifier, writeRecoveryMarkerAfterCleanup } from './recovery-device-cleanup.ts';
import { decryptAttachment, encryptAttachment, isEncryptedAttachment } from './encrypted-attachment.ts';

export type NymphMode = 'romantic' | 'flirty' | 'spicy' | 'kinky';
export type NymphEventKind = 'text' | 'mood' | 'sticker' | 'media' | 'reaction';
export type StickerSync = {
  operation: 'pack-upsert';
  packId: string;
  packName: string;
  adult: boolean;
  description: string;
  categories: string[];
  coverStickerId?: string;
  stickerId?: string;
  stickerName?: string;
  stickerType?: string;
} | {
  operation: 'pack-delete';
  packId: string;
} | {
  operation: 'favorite' | 'recent';
  stickerId: string;
  active?: boolean;
};

export interface MatrixConnection {
  homeserver: string;
  userId: string;
  partnerUserId: string;
  accessToken: string;
  roomId: string;
  deviceId?: string;
  storageKey?: Uint8Array;
}

export interface NymphEnvelope {
  version: 1;
  id: string;
  mode: NymphMode;
  kind: NymphEventKind;
  text: string;
  sentAt: number;
  replyTo?: string;
  replyToEventId?: string;
  reactionTo?: string;
  attachment?: EncryptedFile;
  thumbnailAttachment?: EncryptedFile;
  mediaType?: string;
  mediaName?: string;
  durationMs?: number;
  waveform?: number[];
  viewOnceSeconds?: number;
  viewOncePendingExpiresAt?: number;
  viewOnceReceipt?: { messageId: string; expiresAt: number };
  retentionPolicy?: { seconds: number | null };
  stickerSync?: StickerSync;
}

export interface ReceivedNymphEvent extends NymphEnvelope {
  sender: string;
  eventId: string;
  sentAt: number;
}

export interface MatrixDeviceSummary {
  deviceId: string;
  displayName: string;
  verified: boolean;
  current: boolean;
}

export interface MatrixVerification {
  id: string;
  userId: string;
  deviceId?: string;
  initiatedByMe: boolean;
  localInitiator: boolean;
  phase: string;
  sas?: {
    emoji?: [string, string][];
    decimal?: [number, number, number];
  };
  qrBytes?: Uint8Array;
  confirmQrScan?: boolean;
  error?: string;
}

export interface MatrixSecurityState {
  userId: string;
  ownDeviceId: string;
  partnerVerified: boolean;
  identityChanged: boolean;
  crossSigningReady: boolean;
  secretStorageReady: boolean;
  defaultSecretStorageKeyId: string | null;
  publicCrossSigningKeysPresent: boolean;
  privateCrossSigningSecretsStored: boolean;
  privateCrossSigningKeysCachedLocally: boolean;
  keyBackupVersion: string | null;
  recoverySetupVerified: boolean;
  partnerDevices: MatrixDeviceSummary[];
  ownDevices: MatrixDeviceSummary[];
}

export interface MatrixMessagingClient {
  readonly userId: string;
  readonly deviceId: string;
  send(envelope: NymphEnvelope): Promise<string>;
  sendAttachment(
    file: File,
    envelope: NymphEnvelope,
    options?: {
      thumbnail?: File;
      signal?: AbortSignal;
      onProgress?: (progress: number) => void;
      pendingExpirySeconds?: number;
    },
  ): Promise<{
    eventId: string;
    attachment: EncryptedFile;
    thumbnailAttachment?: EncryptedFile;
    viewOncePendingExpiresAt?: number;
  }>;
  downloadAttachment(
    file: EncryptedFile,
    mediaType: string,
    options?: { signal?: AbortSignal; onProgress?: (progress: number) => void },
  ): Promise<Blob>;
  openEphemeralMedia(file: EncryptedFile): Promise<number>;
  getRetentionPolicy(): Promise<{ seconds: number | null; eventTimestamp: number | null; eventId: string | null }>;
  reconcileExpiredMessages(eventIds: string[]): Promise<string[]>;
  synchronizeRetentionPolicy(seconds: number | null, eventId: string): Promise<{
    seconds: number | null;
    eventTimestamp: number;
    eventId: string;
    applied: boolean;
  }>;
  registerMessageRelation(childEventId: string, parentEventId: string): Promise<void>;
  markRead(eventId: string): Promise<void>;
  setTyping(isTyping: boolean): Promise<void>;
  getSecurityState(): Promise<MatrixSecurityState>;
  getCrossSigningIdentityIds(): Promise<string[]>;
  unlockExistingSecretStorage(recoveryKey: string, password: string): Promise<string>;
  prepareSecretStorageSetup(): Promise<string>;
  commitSecretStorageSetup(confirmation: string): Promise<string>;
  verifyRecoveryOnSeparateDevice(recoveryKey: string, password: string): Promise<string>;
  discardPendingSecretStorageKey(): void;
  bootstrapSecurity(password: string): Promise<void>;
  requestPartnerVerification(deviceId: string): Promise<void>;
  acceptVerification(id: string): Promise<void>;
  startSasVerification(id: string): Promise<void>;
  startQrVerification(id: string): Promise<Uint8Array>;
  scanQrVerification(id: string, bytes: Uint8Array): Promise<void>;
  confirmSas(id: string): Promise<void>;
  mismatchSas(id: string): Promise<void>;
  confirmQrScan(id: string): Promise<void>;
  cancelVerification(id: string): Promise<void>;
  revokeDevice(deviceId: string, password: string): Promise<void>;
  close(): void;
}

type EventListener = (message: ReceivedNymphEvent) => void;
type StatusListener = (status: string) => void;
type TypingListener = (typing: boolean) => void;
type VerificationListener = (verification: MatrixVerification | null) => void;
type SecurityListener = (state: MatrixSecurityState) => void;
type ReadListener = (eventId: string) => void;
type RedactionListener = (eventId: string) => void;
const ENVELOPE_PREFIX = 'nymph.v1:';
const RECOVERY_VERIFICATION_EVENT = 'org.nymph.security.recovery_verification';

function normalizeMediaType(mediaType: string | undefined): string {
  if (!mediaType) return 'application/octet-stream';
  const normalized = mediaType.split(';', 1)[0]?.trim().toLowerCase();
  return normalized || 'application/octet-stream';
}

function isMode(value: unknown): value is NymphMode {
  return value === 'romantic' || value === 'flirty' || value === 'spicy' || value === 'kinky';
}

function isStickerSync(value: unknown): value is StickerSync {
  if (!value || typeof value !== 'object') return false;
  const sync = value as Record<string, unknown>;
  if (sync.operation === 'pack-delete') return typeof sync.packId === 'string';
  if (sync.operation === 'favorite' || sync.operation === 'recent') {
    return typeof sync.stickerId === 'string' &&
      (sync.operation === 'recent' || sync.active === undefined || typeof sync.active === 'boolean');
  }
  return sync.operation === 'pack-upsert' &&
    typeof sync.packId === 'string' &&
    typeof sync.packName === 'string' &&
    typeof sync.adult === 'boolean' &&
    typeof sync.description === 'string' &&
    Array.isArray(sync.categories) &&
    sync.categories.every((category) => typeof category === 'string') &&
    (sync.coverStickerId === undefined || typeof sync.coverStickerId === 'string') &&
    (sync.stickerId === undefined || typeof sync.stickerId === 'string') &&
    (sync.stickerName === undefined || typeof sync.stickerName === 'string') &&
    (sync.stickerType === undefined || typeof sync.stickerType === 'string');
}

export function encodeEnvelope(envelope: NymphEnvelope): string {
  return `${ENVELOPE_PREFIX}${JSON.stringify(envelope)}`;
}

export function decodeEnvelopeBody(
  body: string,
  sender: string,
  eventId: string,
  eventTimestamp: number,
): ReceivedNymphEvent | undefined {
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
      (payload.attachment !== undefined &&
        (!isEncryptedAttachment(payload.attachment) ||
          typeof payload.mediaType !== 'string' ||
          typeof payload.mediaName !== 'string')) ||
      (payload.durationMs !== undefined &&
        (typeof payload.durationMs !== 'number' || !Number.isFinite(payload.durationMs) || payload.durationMs < 0)) ||
      (payload.viewOnceSeconds !== undefined &&
        (payload.kind !== 'media' ||
          !payload.attachment ||
          typeof payload.viewOnceSeconds !== 'number' ||
          !Number.isInteger(payload.viewOnceSeconds) ||
          payload.viewOnceSeconds < 1 ||
          payload.viewOnceSeconds > 86_400)) ||
      (payload.viewOncePendingExpiresAt !== undefined &&
        (typeof payload.viewOncePendingExpiresAt !== 'number' ||
          !Number.isFinite(payload.viewOncePendingExpiresAt))) ||
      (payload.viewOnceReceipt !== undefined &&
        (payload.kind !== 'text' ||
          !payload.viewOnceReceipt ||
          typeof payload.viewOnceReceipt.messageId !== 'string' ||
          typeof payload.viewOnceReceipt.expiresAt !== 'number' ||
          !Number.isFinite(payload.viewOnceReceipt.expiresAt))) ||
      (payload.retentionPolicy !== undefined &&
        (!payload.retentionPolicy ||
          (payload.retentionPolicy.seconds !== null &&
            (typeof payload.retentionPolicy.seconds !== 'number' ||
              !Number.isInteger(payload.retentionPolicy.seconds) ||
              payload.retentionPolicy.seconds < 1 ||
              payload.retentionPolicy.seconds > 31_536_000)))) ||
      (payload.waveform !== undefined &&
        (!Array.isArray(payload.waveform) ||
          payload.waveform.length > 64 ||
          payload.waveform.some((sample) => typeof sample !== 'number' || !Number.isFinite(sample) || sample < 0 || sample > 1))) ||
      (payload.stickerSync !== undefined && !isStickerSync(payload.stickerSync)) ||
      (payload.thumbnailAttachment !== undefined &&
        (!isEncryptedAttachment(payload.thumbnailAttachment) || !isEncryptedAttachment(payload.attachment)))
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

function decodeEnvelope(event: MatrixEvent): ReceivedNymphEvent | undefined {
  if (event.isDecryptionFailure()) return undefined;
  const content = event.getContent();
  if (event.getType() === 'm.reaction') {
    const relation = content['m.relates_to'];
    if (
      relation?.rel_type !== 'm.annotation' ||
      typeof relation.event_id !== 'string' ||
      typeof relation.key !== 'string'
    ) return undefined;
    return {
      version: 1,
      id: event.getId() ?? crypto.randomUUID(),
      kind: 'reaction',
      text: relation.key,
      reactionTo: relation.event_id,
      mode: isMode(content['org.nymph.mode']) ? content['org.nymph.mode'] : 'romantic',
      sentAt: event.getTs(),
      sender: event.getSender() ?? '',
      eventId: event.getId() ?? '',
    };
  }
  if (typeof content.body !== 'string') return undefined;
  return decodeEnvelopeBody(
    content.body,
    event.getSender() ?? '',
    event.getId() ?? '',
    event.getTs(),
  );
}

function waitForInitialSync(
  client: MatrixClient,
  syncEvent: typeof import('matrix-js-sdk').ClientEvent.Sync,
  initialSyncLimit = 50,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Timed out waiting for the homeserver sync.')), 90_000);
    const onSync = (state: string) => {
      if (state === 'PREPARED' || state === 'SYNCING') {
        window.clearTimeout(timeout);
        client.removeListener(syncEvent, onSync);
        resolve();
      } else if (state === 'ERROR' || state === 'STOPPED') {
        window.clearTimeout(timeout);
        client.removeListener(syncEvent, onSync);
        reject(new Error(`Homeserver sync ended in state ${state}.`));
      }
    };
    client.on(syncEvent, onSync);
    void client.startClient({ initialSyncLimit }).catch((error: unknown) => {
      window.clearTimeout(timeout);
      client.removeListener(syncEvent, onSync);
      reject(error);
    });
  });
}

async function waitForRoomEncryption(checkEncryption: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await checkEncryption()) return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
  }
  throw new Error('The configured Matrix room is not end-to-end encrypted. Refusing to send messages.');
}

async function assertPairMembership(client: MatrixClient, credentials: MatrixConnection): Promise<void> {
  const joinedIds = Object.keys((await client.getJoinedRoomMembers(credentials.roomId)).joined);
  const room = client.getRoom(credentials.roomId);
  const partnerMembership = room?.getMember(credentials.partnerUserId)?.membership;
  const creatorCanStartBeforePairing =
    joinedIds.length === 1 &&
    joinedIds[0] === credentials.userId &&
    partnerMembership === 'invite';
  if (
    (!creatorCanStartBeforePairing && joinedIds.length !== 2) ||
    !joinedIds.includes(credentials.userId) ||
    !joinedIds.includes(credentials.partnerUserId) && !creatorCanStartBeforePairing ||
    joinedIds.some((userId) => userId !== credentials.userId && userId !== credentials.partnerUserId)
  ) {
    throw new Error('Room membership changed. Refusing to send outside the configured two-person room.');
  }
}

export async function connectMatrix(
  credentials: MatrixConnection,
  onMessage: EventListener,
  onStatus: StatusListener,
  onVerification: VerificationListener = () => undefined,
  onSecurityChange: SecurityListener = () => undefined,
  onTyping: TypingListener = () => undefined,
  onRead: ReadListener = () => undefined,
  onRedaction: RedactionListener = () => undefined,
): Promise<MatrixMessagingClient> {
  const sdk = await import('matrix-js-sdk');
  const homeserver = new URL(credentials.homeserver);
  const usbReverseDevelopment = Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === 'android' &&
    import.meta.env.MODE === 'android' &&
    homeserver.protocol === 'http:' &&
    homeserver.hostname === 'localhost';
  const browserDevelopment = import.meta.env.DEV &&
    homeserver.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(homeserver.hostname);
  if (
    homeserver.protocol !== 'https:' &&
    !browserDevelopment &&
    !usbReverseDevelopment
  ) {
    throw new Error('Use HTTPS for the homeserver, except for local development.');
  }
  if (!credentials.userId.startsWith('@') || !credentials.partnerUserId.startsWith('@') || credentials.userId === credentials.partnerUserId || !credentials.roomId.startsWith('!')) {
    throw new Error('Enter the two distinct partner user IDs and encrypted room ID.');
  }

  const secretStorageKeys = new Map<string, Uint8Array<ArrayBuffer>>();
  let pendingSecretStorageKey: GeneratedSecretStorageKey | undefined;
  const clearSecretStorageKeyMaterial = () => {
    for (const key of secretStorageKeys.values()) key.fill(0);
    secretStorageKeys.clear();
    pendingSecretStorageKey?.privateKey.fill(0);
    pendingSecretStorageKey = undefined;
  };
  const client = sdk.createClient({
    baseUrl: homeserver.origin,
    accessToken: credentials.accessToken,
    userId: credentials.userId,
    ...(credentials.deviceId ? { deviceId: credentials.deviceId } : {}),
    timelineSupport: true,
    cryptoCallbacks: {
      cacheSecretStorageKey: (keyId, _keyInfo, key) => {
        secretStorageKeys.get(keyId)?.fill(0);
        secretStorageKeys.set(keyId, new Uint8Array(key));
      },
      getSecretStorageKey: async ({ keys }) => {
        const keyId = await client.secretStorage.getDefaultKeyId();
        if (!keyId || !Object.hasOwn(keys, keyId)) return null;
        if (keys[keyId].algorithm !== 'm.secret_storage.v1.aes-hmac-sha2') {
          throw new Error('The account default Secret Storage key uses an unsupported algorithm.');
        }
        const cached = secretStorageKeys.get(keyId);
        if (cached) return [keyId, cached];
        return null;
      },
    },
  });

  const verificationRequests = new Map<string, VerificationRequest>();
  const verifiers = new Map<string, Verifier>();
  const sasCallbacks = new Map<string, ShowSasCallbacks>();
  const verificationKeys = new WeakMap<VerificationRequest, string>();
  const locallyInitiatedVerifications = new WeakSet<VerificationRequest>();
  let previousPartnerDeviceIds: Set<string> | undefined;
  const publishVerification = (request: VerificationRequest, extra: Partial<MatrixVerification> = {}) => {
    const id = request.transactionId ?? verificationKeys.get(request) ?? crypto.randomUUID();
    verificationKeys.set(request, id);
    verificationRequests.set(id, request);
    onVerification({
      id,
      userId: request.otherUserId,
      deviceId: request.otherDeviceId,
      initiatedByMe: request.initiatedByMe,
      localInitiator: locallyInitiatedVerifications.has(request),
      phase: VerificationPhase[request.phase],
      ...extra,
    });
  };
  const attachVerifier = (id: string, verifier: Verifier) => {
    if (verifiers.has(id)) return;
    verifiers.set(id, verifier);
    verifier.on(VerifierEvent.ShowSas, (sas) => {
      sasCallbacks.set(id, sas);
      const request = verificationRequests.get(id);
      if (request) publishVerification(request, { sas: sas.sas });
    });
    verifier.on(VerifierEvent.ShowReciprocateQr, (qr) => {
      const request = verificationRequests.get(id);
      if (request) publishVerification(request, { confirmQrScan: true });
      void qr;
    });
    verifier.on(VerifierEvent.Cancel, (error) => {
      const request = verificationRequests.get(id);
      if (request) publishVerification(request, { error: error instanceof Error ? error.message : 'Verification was cancelled.' });
    });
    void verifier.verify().then(() => refreshSecurity()).catch((error: unknown) => {
      const request = verificationRequests.get(id);
      if (request) publishVerification(request, { error: error instanceof Error ? error.message : 'Verification failed.' });
    });
  };

  let securityListener = onSecurityChange;
  const refreshSecurity = async (): Promise<MatrixSecurityState> => {
    const cryptoApi = client.getCrypto();
    if (!cryptoApi) throw new Error('Matrix encryption is not available on this device.');
    const deviceMap = await cryptoApi.getUserDeviceInfo([credentials.partnerUserId], true);
    const partnerDevices = await Promise.all(
      [...(deviceMap.get(credentials.partnerUserId)?.values() ?? [])].map(async (device: Device) => ({
        deviceId: device.deviceId,
        displayName: device.displayName ?? 'Unnamed device',
        verified: (await cryptoApi.getDeviceVerificationStatus(credentials.partnerUserId, device.deviceId))?.isVerified() ?? false,
        current: false,
      })),
    );
    const partnerDeviceIds = new Set(partnerDevices.map((device) => device.deviceId));
    if (
      previousPartnerDeviceIds &&
      (partnerDeviceIds.size !== previousPartnerDeviceIds.size ||
        [...partnerDeviceIds].some((deviceId) => !previousPartnerDeviceIds?.has(deviceId)))
    ) {
      onStatus('Partner device list changed. Review device verification before sending.');
    }
    previousPartnerDeviceIds = partnerDeviceIds;
    const ownDevices = await Promise.all((await client.getDevices()).devices.map(async (device) => ({
      deviceId: device.device_id,
      displayName: device.display_name ?? 'Unnamed device',
      verified: (await cryptoApi.getDeviceVerificationStatus(credentials.userId, device.device_id))?.isVerified() ?? false,
      current: device.device_id === client.getDeviceId(),
    })));
    const [
      partnerIdentity,
      crossSigningReady,
      secretStorageStatus,
      crossSigningStatus,
      publicCrossSigningKeysPresent,
      keyBackupInfo,
    ] = await Promise.all([
      cryptoApi.getUserVerificationStatus(credentials.partnerUserId),
      cryptoApi.isCrossSigningReady(),
      cryptoApi.getSecretStorageStatus(),
      cryptoApi.getCrossSigningStatus(),
      cryptoApi.userHasCrossSigningKeys(credentials.userId, true),
      cryptoApi.getKeyBackupInfo(),
    ]);
    const recoveryVerification = client.getAccountData(RECOVERY_VERIFICATION_EVENT)?.getContent();
    const publishedSigningKeys = await cryptoApi.getUserCrossSigningKeys(credentials.userId);
    const publishedSigningKeyIds = {
      master_key: publishedSigningKeys?.[CrossSigningKey.Master]
        ? Object.values(publishedSigningKeys[CrossSigningKey.Master].keys)[0]
        : undefined,
      self_signing_key: publishedSigningKeys?.[CrossSigningKey.SelfSigning]
        ? Object.values(publishedSigningKeys[CrossSigningKey.SelfSigning].keys)[0]
        : undefined,
      user_signing_key: publishedSigningKeys?.[CrossSigningKey.UserSigning]
        ? Object.values(publishedSigningKeys[CrossSigningKey.UserSigning].keys)[0]
        : undefined,
    };
    const verifiedSigningIds = recoveryVerification?.cross_signing_key_ids;
    const state: MatrixSecurityState = {
      userId: credentials.userId,
      ownDeviceId: client.getDeviceId() ?? '',
      partnerVerified: partnerIdentity.isCrossSigningVerified(),
      identityChanged: partnerIdentity.needsUserApproval,
      crossSigningReady,
      secretStorageReady: secretStorageStatus.ready,
      defaultSecretStorageKeyId: secretStorageStatus.defaultKeyId,
      publicCrossSigningKeysPresent,
      privateCrossSigningSecretsStored: crossSigningStatus.privateKeysInSecretStorage,
      privateCrossSigningKeysCachedLocally: Object.values(crossSigningStatus.privateKeysCachedLocally).every(Boolean),
      keyBackupVersion: keyBackupInfo?.version ?? null,
      recoverySetupVerified:
        recoveryVerification?.key_id === secretStorageStatus.defaultKeyId &&
        typeof recoveryVerification?.verified_at === 'number' &&
        verifiedSigningIds?.master_key === publishedSigningKeyIds.master_key &&
        verifiedSigningIds?.self_signing_key === publishedSigningKeyIds.self_signing_key &&
        verifiedSigningIds?.user_signing_key === publishedSigningKeyIds.user_signing_key,
      partnerDevices,
      ownDevices,
    };
    securityListener(state);
    return state;
  };
  const refreshSecuritySafely = () => {
    void refreshSecurity().catch(() => {
      onStatus('Could not refresh Matrix device trust.');
    });
  };

  const onVerificationRequest = (request: VerificationRequest) => {
    publishVerification(request);
    request.on(VerificationRequestEvent.Change, () => {
      publishVerification(request);
      const id = verificationKeys.get(request);
      const verifier = request.verifier;
      if (id && verifier) attachVerifier(id, verifier);
    });
  };
  const onUserTrustChanged = (userId: string) => {
    if (userId === credentials.partnerUserId) refreshSecuritySafely();
  };
  const onDevicesUpdated = (userIds: string[]) => {
    if (userIds.includes(credentials.partnerUserId)) refreshSecuritySafely();
  };

  try {
    await client.initRustCrypto({
      useIndexedDB: true,
      cryptoDatabasePrefix: `nymph-${encodeURIComponent(credentials.userId)}-${encodeURIComponent(client.getDeviceId() ?? 'unassigned')}`,
      ...(credentials.storageKey ? { storageKey: credentials.storageKey } : {}),
    });

    const cryptoApi = client.getCrypto();
    if (!cryptoApi) throw new Error('The Matrix Rust crypto backend failed to initialize.');
    cryptoApi.setDeviceIsolationMode(new OnlySignedDevicesIsolationMode());
    cryptoApi.setTrustCrossSignedDevices(true);

    client.on(sdk.ClientEvent.Sync, (state: string) => onStatus(state));
    client.on(CryptoEvent.VerificationRequestReceived, onVerificationRequest);
    client.on(CryptoEvent.UserTrustStatusChanged, onUserTrustChanged);
    client.on(CryptoEvent.DevicesUpdated, onDevicesUpdated);
    client.on(CryptoEvent.KeysChanged, refreshSecuritySafely);
    await waitForInitialSync(client, sdk.ClientEvent.Sync);

    let room: Room | null = client.getRoom(credentials.roomId);
    if (!room) throw new Error('This device is not invited to the configured private room.');
    if (room.getMyMembership() !== 'join') {
      await client.joinRoom(credentials.roomId);
      room = client.getRoom(credentials.roomId);
    }
    if (!room) throw new Error('Could not open the configured private room.');
    await assertPairMembership(client, credentials);
    await waitForRoomEncryption(() => cryptoApi.isEncryptionEnabledInRoom(credentials.roomId));

    const policyRequest = async <T>(path: string, body?: unknown): Promise<T> => {
      const response = await fetch(new URL(path, homeserver), {
        method: 'POST',
        credentials: 'omit',
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body ?? {}),
        cache: 'no-store',
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`The server-side retention request failed (HTTP ${response.status}).`);
      return response.json() as Promise<T>;
    };
    const synchronizeRetentionPolicy = async (seconds: number | null, eventId: string) => {
      if (
        (seconds !== null &&
          (!Number.isInteger(seconds) || seconds < 1 || seconds > 31_536_000)) ||
        typeof eventId !== 'string' ||
        !/^\$[A-Za-z0-9._=:-]{1,255}$/.test(eventId)
      ) {
        throw new Error('The encrypted retention policy is invalid.');
      }
      let lastError: unknown;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const result = await policyRequest<{
            seconds: number | null;
            event_timestamp: number;
            event_id: string;
            applied: boolean;
          }>('/_synapse/client/nymph/retention/set', { seconds, event_id: eventId });
          if (
            (result.seconds !== null &&
              (!Number.isInteger(result.seconds) || result.seconds < 1 || result.seconds > 31_536_000)) ||
            !Number.isSafeInteger(result.event_timestamp) ||
            typeof result.event_id !== 'string' ||
            typeof result.applied !== 'boolean'
          ) throw new Error('The server returned an invalid retention policy.');
          return {
            seconds: result.seconds,
            eventTimestamp: result.event_timestamp,
            eventId: result.event_id,
            applied: result.applied,
          };
        } catch (error) {
          lastError = error;
          if (!(error instanceof Error) || !error.message.includes('HTTP 404') || attempt === 4) break;
          await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
        }
      }
      throw lastError instanceof Error ? lastError : new Error('Server-side message retention could not be synchronized.');
    };
    const registerMessageRelation = async (childEventId: string, parentEventId: string) => {
      if (
        !/^\$[A-Za-z0-9._=:-]{1,255}$/.test(childEventId) ||
        !/^\$[A-Za-z0-9._=:-]{1,255}$/.test(parentEventId)
      ) throw new Error('The message relation is invalid.');
      let lastError: unknown;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          await policyRequest('/_synapse/client/nymph/retention/relation', {
            child_event_id: childEventId,
            parent_event_id: parentEventId,
          });
          return;
        } catch (error) {
          lastError = error;
          if (!(error instanceof Error) || !error.message.includes('HTTP 404') || attempt === 19) break;
          await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        }
      }
      throw lastError instanceof Error ? lastError : new Error('The message relation could not be synchronized.');
    };
    const reconcileExpiredMessages = async (eventIds: string[]) => {
      if (!Array.isArray(eventIds) || eventIds.some((eventId) =>
        typeof eventId !== 'string' || !/^\$[A-Za-z0-9._=:-]{1,255}$/.test(eventId)
      )) {
        throw new Error('The message-expiry reconciliation request is invalid.');
      }
      const uniqueEventIds = [...new Set(eventIds)];
      const expiredEventIds = new Set<string>();
      for (let offset = 0; offset < uniqueEventIds.length; offset += 100) {
        const batch = uniqueEventIds.slice(offset, offset + 100);
        const result = await policyRequest<{ expired_event_ids: string[] }>(
          '/_synapse/client/nymph/retention/reconcile',
          { event_ids: batch },
        );
        if (
          !result ||
          typeof result !== 'object' ||
          !Array.isArray(result.expired_event_ids) ||
          result.expired_event_ids.some((eventId) =>
            typeof eventId !== 'string' || !batch.includes(eventId)
          )
        ) {
          throw new Error('The server returned an invalid expired-message reconciliation result.');
        }
        for (const eventId of result.expired_event_ids) expiredEventIds.add(eventId);
      }
      return [...expiredEventIds];
    };
    const handleDecodedMessage = (message: ReceivedNymphEvent) => {
      if (message.retentionPolicy) {
        void synchronizeRetentionPolicy(message.retentionPolicy.seconds, message.eventId)
          .then((policy) => onMessage({
            ...message,
            retentionPolicy: { seconds: policy.seconds },
          }))
          .catch((error: unknown) => {
            onStatus(error instanceof Error ? error.message : 'Server-side message retention could not be synchronized.');
            onMessage(message);
          });
        return;
      }
      const parentEventId = message.replyToEventId ?? message.reactionTo;
      if (parentEventId) {
        void registerMessageRelation(message.eventId, parentEventId).catch((error: unknown) => {
          onStatus(error instanceof Error ? error.message : 'The reply or reaction expiry could not be synchronized.');
        });
      }
      onMessage(message);
    };
    const receive = (event: MatrixEvent, eventRoom: Room | undefined, toStartOfTimeline?: boolean, removed?: boolean) => {
      if (removed || toStartOfTimeline || eventRoom?.roomId !== credentials.roomId) return;
      const sender = event.getSender();
      if (sender !== credentials.partnerUserId && sender !== credentials.userId) return;
      if (event.getType() === sdk.EventType.RoomRedaction) {
        const redactedEventId = event.event.redacts;
        if (typeof redactedEventId === 'string') onRedaction(redactedEventId);
        return;
      }
      if (event.getType() !== sdk.EventType.RoomMessage && event.getType() !== sdk.EventType.Reaction) return;
      const message = decodeEnvelope(event);
      if (message) handleDecodedMessage(message);
    };
    const onTypingEvent = (_event: MatrixEvent, member: { userId: string; typing: boolean }) => {
      if (member.userId === credentials.partnerUserId) onTyping(member.typing);
    };
    const onReceiptEvent = (_event: MatrixEvent, eventRoom: Room) => {
      if (eventRoom.roomId !== credentials.roomId) return;
      for (const event of eventRoom.getLiveTimeline().getEvents()) {
        const eventId = event.getId();
        if (
          eventId &&
          event.getSender() === credentials.userId &&
          eventRoom.getReceiptsForEvent(event).some((receipt) =>
            receipt.userId === credentials.partnerUserId && receipt.type === 'm.read'
          )
        ) onRead(eventId);
      }
    };
    const onDecryptedEvent = (event: MatrixEvent, error?: Error) => {
      if (error) return;
      const eventRoomId = event.getRoomId();
      if (!eventRoomId) return;
      const eventRoom = client.getRoom(eventRoomId);
      if (!eventRoom) return;
      receive(event, eventRoom, false, false);
    };
    client.on(sdk.RoomEvent.Timeline, receive);
    client.on(MatrixEventEvent.Decrypted, onDecryptedEvent);
    client.on(RoomMemberEvent.Typing, onTypingEvent);
    client.on(sdk.RoomEvent.Receipt, onReceiptEvent);

    for (const event of room.getLiveTimeline().getEvents()) {
      const sender = event.getSender();
      if (sender !== credentials.partnerUserId && sender !== credentials.userId) continue;
      if (event.getType() === sdk.EventType.RoomRedaction) {
        const redactedEventId = event.event.redacts;
        if (typeof redactedEventId === 'string') onRedaction(redactedEventId);
        continue;
      }
      if (event.getType() !== sdk.EventType.RoomMessage && event.getType() !== sdk.EventType.Reaction) continue;
      const message = decodeEnvelope(event);
      if (message) handleDecodedMessage(message);
    }
    const initialRoomEventIds = room.getLiveTimeline().getEvents()
      .filter((event) =>
        (event.getSender() === credentials.partnerUserId || event.getSender() === credentials.userId) &&
        (event.getType() === sdk.EventType.RoomMessage || event.getType() === sdk.EventType.Reaction)
      )
      .map((event) => event.getId())
      .filter((eventId): eventId is string => typeof eventId === 'string');
    for (const eventId of await reconcileExpiredMessages(initialRoomEventIds)) {
      onRedaction(eventId);
    }
    await refreshSecurity();

    const requireVerifiedPartner = async () => {
      const security = await refreshSecurity();
      if (security.identityChanged) {
        throw new Error('Your partner’s Matrix identity changed. Verify the new identity before sending.');
      }
      if (!security.partnerVerified) {
        throw new Error('Verify your partner’s Matrix identity on both devices before sending encrypted messages.');
      }
    };

    return {
      userId: credentials.userId,
      deviceId: client.getDeviceId() ?? '',
      async getRetentionPolicy() {
        const result = await policyRequest<{
          seconds: number | null;
          event_timestamp: number | null;
          event_id: string | null;
        }>('/_synapse/client/nymph/retention/status');
        if (
          (result.seconds !== null &&
            (!Number.isInteger(result.seconds) || result.seconds < 1 || result.seconds > 31_536_000)) ||
          (result.event_timestamp !== null && !Number.isSafeInteger(result.event_timestamp)) ||
          (result.event_id !== null && typeof result.event_id !== 'string')
        ) throw new Error('The server returned an invalid current retention policy.');
        return {
          seconds: result.seconds,
          eventTimestamp: result.event_timestamp,
          eventId: result.event_id,
        };
      },
      synchronizeRetentionPolicy,
      reconcileExpiredMessages,
      registerMessageRelation,
      async send(envelope) {
        await assertPairMembership(client, credentials);
        await requireVerifiedPartner();
        if (envelope.kind === 'reaction') {
          if (!envelope.reactionTo) throw new Error('A reaction must reference a room event.');
          const reactionContent: ReactionEventContent & { 'org.nymph.mode': NymphMode } = {
            'm.relates_to': {
              event_id: envelope.reactionTo,
              key: envelope.text,
              rel_type: RelationType.Annotation,
            },
            'org.nymph.mode': envelope.mode,
          };
          const result = await client.sendEvent(credentials.roomId, sdk.EventType.Reaction, reactionContent);
          await registerMessageRelation(result.event_id, envelope.reactionTo);
          return result.event_id;
        }
        const content: RoomMessageEventContent = {
          msgtype: MsgType.Text,
          body: encodeEnvelope(envelope),
        };
        if (envelope.replyToEventId) {
          content['m.relates_to'] = {
            'm.in_reply_to': { event_id: envelope.replyToEventId },
          };
        }
        const result = await client.sendMessage(credentials.roomId, content);
        if (envelope.replyToEventId) {
          await registerMessageRelation(result.event_id, envelope.replyToEventId);
        }
        if (envelope.retentionPolicy) {
          await synchronizeRetentionPolicy(envelope.retentionPolicy.seconds, result.event_id);
        }
        return result.event_id;
      },
      async sendAttachment(file, envelope, options = {}) {
        if (!['media', 'sticker'].includes(envelope.kind) || file.size <= 0) {
          throw new Error('Choose a non-empty photo, video, or voice recording to send.');
        }
        const normalizedMimeType = normalizeMediaType(envelope.mediaType || file.type);
        if (
          typeof envelope.mediaType !== 'string' ||
          (!normalizedMimeType.startsWith('image/') &&
            !normalizedMimeType.startsWith('video/') &&
            !normalizedMimeType.startsWith('audio/')) ||
          typeof envelope.mediaName !== 'string'
        ) {
          throw new Error('Encrypted media is missing its content type or display name.');
        }
        if (file.size > 40 * 1024 * 1024) {
          throw new Error('Encrypted media is limited to 40 MB on this device.');
        }
        if (options.thumbnail && options.thumbnail.size > 2 * 1024 * 1024) {
          throw new Error('The encrypted media preview exceeds the 2 MB limit.');
        }
        await assertPairMembership(client, credentials);
        await requireVerifiedPartner();
        const signal = options.signal;
        if (
          options.pendingExpirySeconds !== undefined &&
          (!Number.isInteger(options.pendingExpirySeconds) ||
            options.pendingExpirySeconds < 1 ||
            options.pendingExpirySeconds > 2_592_000)
        ) {
          throw new Error('Unopened-media expiry must be between 1 second and 30 days.');
        }
        const assertNotAborted = () => {
          if (signal?.aborted) throw new DOMException('Media transfer cancelled.', 'AbortError');
        };
        const uploadController = new AbortController();
        const abortUpload = () => uploadController.abort();
        if (signal?.aborted) abortUpload();
        else signal?.addEventListener('abort', abortUpload, { once: true });
        try {
          assertNotAborted();
          const thumbnailEncrypted = options.thumbnail
            ? await encryptAttachment(await options.thumbnail.arrayBuffer())
            : undefined;
          assertNotAborted();
          const mediaEncrypted = await encryptAttachment(await file.arrayBuffer());
          assertNotAborted();
          const thumbnailSize = thumbnailEncrypted?.ciphertext.byteLength ?? 0;
          const totalSize = thumbnailSize + mediaEncrypted.ciphertext.byteLength;
          let uploaded = 0;
          const uploadEncrypted = async (ciphertext: ArrayBuffer, offset: number) => client.uploadContent(
            new Blob([ciphertext], { type: 'application/octet-stream' }),
            {
              type: 'application/octet-stream',
              includeFilename: false,
              abortController: uploadController,
              progressHandler: ({ loaded }) => {
                options.onProgress?.(
                  totalSize
                    ? Math.min(99, Math.round(((offset + Math.min(loaded, ciphertext.byteLength)) / totalSize) * 100))
                    : 0,
                );
              },
            },
          );
          let thumbnailAttachment: EncryptedFile | undefined;
          if (thumbnailEncrypted) {
            const thumbnailUpload = await uploadEncrypted(thumbnailEncrypted.ciphertext, 0);
            thumbnailAttachment = { ...thumbnailEncrypted.file, url: thumbnailUpload.content_uri };
            uploaded = thumbnailEncrypted.ciphertext.byteLength;
          }
          assertNotAborted();
          const mediaUpload = await uploadEncrypted(mediaEncrypted.ciphertext, uploaded);
          assertNotAborted();
          const normalizedMediaType = normalizeMediaType(file.type || envelope.mediaType);
          let attachment: EncryptedFile = { ...mediaEncrypted.file, url: mediaUpload.content_uri };
          let viewOncePendingExpiresAt: number | undefined;
          if (envelope.viewOnceSeconds !== undefined) {
            if (envelope.kind !== 'media' || !Number.isInteger(envelope.viewOnceSeconds) ||
              envelope.viewOnceSeconds < 1 || envelope.viewOnceSeconds > 86_400 || thumbnailEncrypted) {
              throw new Error('View-once media requires a valid viewing timer and no thumbnail.');
            }
            const mxcReference = mediaUpload.content_uri.match(/^mxc:\/\/([^/]+)\/([A-Za-z0-9._=-]{1,255})$/);
            const matrixServerName = credentials.userId.slice(credentials.userId.indexOf(':') + 1);
            if (
              !mxcReference ||
              (mxcReference[1] !== matrixServerName && mxcReference[1] !== homeserver.host)
            ) {
              throw new Error('The homeserver returned an invalid expiring-media upload reference.');
            }
            const mediaId = mxcReference[2];
            const accessToken = client.getAccessToken();
            if (!accessToken) throw new Error('The Matrix session is no longer authorized to register expiring media.');
            const registration = await fetch(new URL('/_synapse/client/nymph/media/register', homeserver), {
              method: 'POST',
              credentials: 'omit',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                media_id: mediaId,
                room_id: credentials.roomId,
                duration_seconds: envelope.viewOnceSeconds,
                ...(options.pendingExpirySeconds === undefined
                  ? {}
                  : { pending_ttl_seconds: options.pendingExpirySeconds }),
              }),
              signal,
              redirect: 'error',
            });
            if (!registration.ok) {
              throw new Error(`The server could not register expiring media (HTTP ${registration.status}).`);
            }
            const registrationResult: unknown = await registration.json();
            if (
              !registrationResult || typeof registrationResult !== 'object' ||
              typeof (registrationResult as { pending_expires_at?: unknown }).pending_expires_at !== 'number' ||
              !Number.isFinite((registrationResult as { pending_expires_at: number }).pending_expires_at)
            ) {
              throw new Error('The server returned an invalid pending media-expiration time.');
            }
            viewOncePendingExpiresAt = (registrationResult as { pending_expires_at: number }).pending_expires_at;
            attachment = {
              ...attachment,
              url: new URL(`/_synapse/client/nymph/media/content/${mediaId}`, homeserver).href,
            };
          }
          const content: RoomMessageEventContent = {
            msgtype: MsgType.Text,
            body: encodeEnvelope({
              ...envelope,
              ...(viewOncePendingExpiresAt === undefined ? {} : { viewOncePendingExpiresAt }),
              attachment,
              thumbnailAttachment,
              mediaType: normalizedMediaType,
              mediaName: file.name,
            }),
          };
          const result = await client.sendMessage(credentials.roomId, content);
          options.onProgress?.(100);
          return {
            eventId: result.event_id,
            attachment,
            ...(thumbnailAttachment ? { thumbnailAttachment } : {}),
            ...(viewOncePendingExpiresAt === undefined ? {} : { viewOncePendingExpiresAt }),
          };
        } finally {
          signal?.removeEventListener('abort', abortUpload);
        }
      },
      async downloadAttachment(file, mediaType, options = {}) {
        if (!isEncryptedAttachment(file)) throw new Error('The encrypted media reference is invalid.');
        const normalizedMediaType = normalizeMediaType(mediaType);
        await assertPairMembership(client, credentials);
        await requireVerifiedPartner();
        let downloadUrl: string | null;
        if (file.url.startsWith('mxc://')) {
          downloadUrl = client.mxcUrlToHttp(file.url, undefined, undefined, undefined, false, false, true);
        } else {
          const ephemeralUrl = new URL(file.url);
          if (
            ephemeralUrl.origin !== homeserver.origin ||
            !/^\/_synapse\/client\/nymph\/media\/content\/[A-Za-z0-9._=-]{1,255}$/.test(ephemeralUrl.pathname)
          ) {
            throw new Error('The expiring media reference is not from this homeserver.');
          }
          downloadUrl = ephemeralUrl.href;
        }
        if (!downloadUrl) throw new Error('The homeserver returned an invalid encrypted media URL.');
        const accessToken = client.getAccessToken();
        if (!accessToken) throw new Error('The Matrix session is no longer authorized to download media.');
        const response = await fetch(downloadUrl, {
          credentials: 'omit',
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: options.signal,
          redirect: 'error',
        });
        if (!response.ok) throw new Error(`Encrypted media download failed with HTTP ${response.status}.`);
        const total = Number(response.headers.get('Content-Length')) || 0;
        const reader = response.body?.getReader();
        if (!reader) throw new Error('The encrypted media response could not be streamed.');
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            loaded += value.byteLength;
            options.onProgress?.(total ? Math.min(99, Math.round((loaded / total) * 100)) : 0);
          }
        }
        const ciphertext = new Uint8Array(loaded);
        let offset = 0;
        for (const chunk of chunks) {
          ciphertext.set(chunk, offset);
          offset += chunk.byteLength;
        }
        try {
          const plaintext = await decryptAttachment(ciphertext, file);
          try {
            const blob = new Blob([plaintext], { type: normalizedMediaType });
            options.onProgress?.(100);
            return blob;
          } finally {
            new Uint8Array(plaintext).fill(0);
          }
        } finally {
          ciphertext.fill(0);
        }
      },
      async openEphemeralMedia(file) {
        if (!isEncryptedAttachment(file) || file.url.startsWith('mxc://')) {
          throw new Error('The expiring media reference is invalid.');
        }
        await assertPairMembership(client, credentials);
        await requireVerifiedPartner();
        const mediaUrl = new URL(file.url);
        if (mediaUrl.origin !== homeserver.origin) {
          throw new Error('The expiring media reference is not from this homeserver.');
        }
        const match = mediaUrl.pathname.match(/^\/_synapse\/client\/nymph\/media\/content\/([A-Za-z0-9._=-]{1,255})$/);
        if (!match) throw new Error('The expiring media reference is invalid.');
        const accessToken = client.getAccessToken();
        if (!accessToken) throw new Error('The Matrix session is no longer authorized to open media.');
        const response = await fetch(new URL('/_synapse/client/nymph/media/open', homeserver), {
          method: 'POST',
          credentials: 'omit',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ media_id: match[1] }),
          redirect: 'error',
        });
        if (!response.ok) {
          throw new Error(`This expiring media could not be opened (HTTP ${response.status}).`);
        }
        const result: unknown = await response.json();
        if (
          !result || typeof result !== 'object' ||
          typeof (result as { expires_at?: unknown }).expires_at !== 'number' ||
          !Number.isFinite((result as { expires_at: number }).expires_at)
        ) {
          throw new Error('The server returned an invalid media-expiration status.');
        }
        return (result as { expires_at: number }).expires_at;
      },
      async markRead(eventId) {
        const event = client.getRoom(credentials.roomId)?.findEventById(eventId);
        if (event) await client.sendReadReceipt(event);
      },
      async setTyping(isTyping) {
        await client.sendTyping(credentials.roomId, isTyping, isTyping ? 10_000 : 0);
      },
      async getSecurityState() {
        return refreshSecurity();
      },
      async getCrossSigningIdentityIds() {
        const keys = await cryptoApi.getUserCrossSigningKeys(credentials.userId);
        const ids = [
          CrossSigningKey.Master,
          CrossSigningKey.SelfSigning,
          CrossSigningKey.UserSigning,
        ].map((type) => {
          const key = keys?.[type];
          return key ? Object.keys(key.keys)[0] : undefined;
        });
        if (ids.some((id) => !id)) {
          throw new Error(`The published cross-signing identity is incomplete for ${credentials.userId}.`);
        }
        return ids.map((id) => {
          if (!id) throw new Error(`The published cross-signing identity is incomplete for ${credentials.userId}.`);
          return id;
        });
      },
      async unlockExistingSecretStorage(recoveryKey, password) {
        const keyId = await client.secretStorage.getDefaultKeyId();
        if (!keyId) {
          throw new Error(`No existing default Secret Storage key is configured for ${credentials.userId}.`);
        }
        const keyInfo = await client.secretStorage.getKey(keyId);
        if (!keyInfo || keyInfo[1].algorithm !== 'm.secret_storage.v1.aes-hmac-sha2') {
          throw new Error(`The existing default Secret Storage key for ${credentials.userId} is unavailable or unsupported.`);
        }

        let decoded: Uint8Array<ArrayBuffer>;
        try {
          decoded = decodeRecoveryKey(recoveryKey);
        } catch {
          throw new Error(`The recovery key provided for ${credentials.userId} is invalid.`);
        }
        if (!(await client.secretStorage.checkKey(decoded, keyInfo[1]))) {
          decoded.fill(0);
          throw new Error(`The recovery key does not match ${credentials.userId}'s default Secret Storage key.`);
        }
        secretStorageKeys.get(keyId)?.fill(0);
        secretStorageKeys.set(keyId, new Uint8Array(decoded));
        decoded.fill(0);

        const hasPublicKeys = await cryptoApi.userHasCrossSigningKeys(credentials.userId, true);
        const privateSecrets = await Promise.all([
          client.secretStorage.get('m.cross_signing.master'),
          client.secretStorage.get('m.cross_signing.self_signing'),
          client.secretStorage.get('m.cross_signing.user_signing'),
        ]);
        if (!hasPublicKeys || privateSecrets.some((secret) => !secret)) {
          throw new Error(
            `Existing cross-signing keys are incomplete for ${credentials.userId}; ` +
            'recovery stopped without creating or replacing keys.',
          );
        }
        if (!password) throw new Error('Enter this Matrix account password to restore cross-signing on this device.');

        const crossSigningTypes = [
          CrossSigningKey.Master,
          CrossSigningKey.SelfSigning,
          CrossSigningKey.UserSigning,
        ];
        const publishedKeys = await cryptoApi.getUserCrossSigningKeys(credentials.userId);
        const publishedKeyIds = crossSigningTypes.map((type) => {
          const key = publishedKeys?.[type];
          return key ? Object.values(key.keys)[0] : undefined;
        });
        if (publishedKeyIds.some((id) => !id)) {
          throw new Error(`The published cross-signing identity is incomplete for ${credentials.userId}.`);
        }
        const localStatus = await cryptoApi.getCrossSigningStatus();
        if (Object.values(localStatus.privateKeysCachedLocally).every(Boolean)) {
          const cachedKeyIds = await Promise.all(
            crossSigningTypes.map((type) => cryptoApi.getCrossSigningKeyId(type)),
          );
          if (cachedKeyIds.some((id, index) => id !== publishedKeyIds[index])) {
            throw new Error(
              `The cached cross-signing identity does not match the published identity for ${credentials.userId}. ` +
              'Recovery stopped without changing either identity.',
            );
          }
        }
        await cryptoApi.bootstrapCrossSigning({
          authUploadDeviceSigningKeys: async (makeRequest) => makeRequest({
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: credentials.userId },
            password,
          }),
        });
        const restoredKeyIds = await Promise.all(
          crossSigningTypes.map((type) => cryptoApi.getCrossSigningKeyId(type)),
        );
        if (
          !(await cryptoApi.isCrossSigningReady()) ||
          restoredKeyIds.some((id, index) => id !== publishedKeyIds[index])
        ) {
          throw new Error(`Existing cross-signing keys could not be restored for ${credentials.userId}.`);
        }
        await refreshSecurity();
        return keyId;
      },
      async prepareSecretStorageSetup() {
        if (pendingSecretStorageKey) {
          pendingSecretStorageKey.privateKey.fill(0);
          pendingSecretStorageKey = undefined;
        }
        const status = await cryptoApi.getSecretStorageStatus();
        if (status.defaultKeyId) {
          throw new Error(
            `Secret Storage is already configured for ${credentials.userId}; unlock it instead of creating a replacement key.`,
          );
        }
        const crossSigningStatus = await cryptoApi.getCrossSigningStatus();
        const publicKeysPresent = await cryptoApi.userHasCrossSigningKeys(credentials.userId, true);
        const allLocalPrivateKeys = Object.values(crossSigningStatus.privateKeysCachedLocally).every(Boolean);
        if (publicKeysPresent && !allLocalPrivateKeys) {
          throw new Error(
            `An existing cross-signing identity is published for ${credentials.userId}, but its private keys are not available locally. ` +
            'Recovery is required; a replacement will not be generated.',
          );
        }
        const generated = await cryptoApi.createRecoveryKeyFromPassphrase();
        if (!generated.encodedPrivateKey) {
          generated.privateKey.fill(0);
          throw new Error('The Matrix SDK did not return an encoded recovery key.');
        }
        pendingSecretStorageKey = generated;
        return generated.encodedPrivateKey;
      },
      async commitSecretStorageSetup(confirmation) {
        const generated = pendingSecretStorageKey;
        if (!generated?.encodedPrivateKey) {
          throw new Error('Generate a new recovery key before confirming Secret Storage setup.');
        }
        if (confirmation !== generated.encodedPrivateKey) {
          throw new Error('The confirmation does not match the displayed recovery key.');
        }
        let keyId = await client.secretStorage.getDefaultKeyId();
        if (!keyId) {
          await cryptoApi.bootstrapSecretStorage({
            createSecretStorageKey: async () => generated,
          });
          keyId = await client.secretStorage.getDefaultKeyId();
        }
        if (!keyId) throw new Error('Secret Storage setup completed without a default key ID.');
        const storedKey = await client.secretStorage.getKey(keyId);
        if (!storedKey || !(await client.secretStorage.checkKey(generated.privateKey, storedKey[1]))) {
          throw new Error(
            `The account default key changed during setup for ${credentials.userId}; ` +
            'the generated recovery key was not accepted as the default.',
          );
        }
        generated.privateKey.fill(0);
        if (pendingSecretStorageKey === generated) pendingSecretStorageKey = undefined;
        await refreshSecurity();
        return keyId;
      },
      async verifyRecoveryOnSeparateDevice(recoveryKey, password) {
        if (!password) throw new Error('Enter this Matrix account password to verify recovery on a separate device.');
        await client.setAccountData(RECOVERY_VERIFICATION_EVENT, {
          key_id: '',
          verified_at: 0,
          cross_signing_key_ids: {
            master_key: '',
            self_signing_key: '',
            user_signing_key: '',
          },
        });
        await refreshSecurity();
        const keyId = await client.secretStorage.getDefaultKeyId();
        if (!keyId) throw new Error(`No default Secret Storage key is configured for ${credentials.userId}.`);
        const keyInfo = await client.secretStorage.getKey(keyId);
        if (!keyInfo || keyInfo[1].algorithm !== 'm.secret_storage.v1.aes-hmac-sha2') {
          throw new Error(`The default Secret Storage key for ${credentials.userId} is unavailable or unsupported.`);
        }

        let recoveryKeyBytes: Uint8Array<ArrayBuffer>;
        try {
          recoveryKeyBytes = decodeRecoveryKey(recoveryKey);
        } catch {
          throw new Error('The recovery key is invalid.');
        }
        try {
          if (!(await client.secretStorage.checkKey(recoveryKeyBytes, keyInfo[1]))) {
            throw new Error(`The recovery key does not match ${credentials.userId}'s default Secret Storage key.`);
          }
          secretStorageKeys.get(keyId)?.fill(0);
          secretStorageKeys.set(keyId, new Uint8Array(recoveryKeyBytes));

          const signingTypes = [
            CrossSigningKey.Master,
            CrossSigningKey.SelfSigning,
            CrossSigningKey.UserSigning,
          ];
          const publishedKeys = await cryptoApi.getUserCrossSigningKeys(credentials.userId);
          const masterKeyId = publishedKeys?.[CrossSigningKey.Master]
            ? Object.values(publishedKeys[CrossSigningKey.Master].keys)[0]
            : undefined;
          const selfSigningKeyId = publishedKeys?.[CrossSigningKey.SelfSigning]
            ? Object.values(publishedKeys[CrossSigningKey.SelfSigning].keys)[0]
            : undefined;
          const userSigningKeyId = publishedKeys?.[CrossSigningKey.UserSigning]
            ? Object.values(publishedKeys[CrossSigningKey.UserSigning].keys)[0]
            : undefined;
          if (!masterKeyId || !selfSigningKeyId || !userSigningKeyId) {
            throw new Error(`The published cross-signing identity is incomplete for ${credentials.userId}.`);
          }
          const publishedKeyIds = [masterKeyId, selfSigningKeyId, userSigningKeyId];
          const storedSecrets = await Promise.all([
            client.secretStorage.get('m.cross_signing.master'),
            client.secretStorage.get('m.cross_signing.self_signing'),
            client.secretStorage.get('m.cross_signing.user_signing'),
          ]);
          const publishedKeysComplete = publishedKeyIds.every(Boolean);
          const storedSecretsPresent = storedSecrets.every(Boolean);
          const crossSigningReady = await cryptoApi.isCrossSigningReady();
          if (
            !publishedKeysComplete ||
            !storedSecretsPresent ||
            !crossSigningReady
          ) {
            throw new Error(
              `Secret Storage and cross-signing are not ready for ${credentials.userId} ` +
                `(publishedKeysComplete=${publishedKeysComplete}; ` +
                `storedSecretsPresent=${storedSecretsPresent}; ` +
                `crossSigningReady=${crossSigningReady}).`,
            );
          }

          const verificationKey = new Uint8Array(recoveryKeyBytes);
          let temporaryDeviceId: string | undefined;
          let verificationClient: MatrixClient | undefined;
          let loginClient: MatrixClient | undefined;
          let recoveryAuthorization: { userId: string; deviceId: string } | undefined;
          let temporaryAccessToken: string | undefined;
          let verificationFailure: unknown;
          let cleanupFailed = false;
          try {
            loginClient = sdk.createClient({ baseUrl: homeserver.origin });
            let session: Awaited<ReturnType<typeof loginClient.login>>;
            if (homeserver.hostname === 'localhost' || homeserver.hostname === '127.0.0.1') {
              const deviceId = `NYMPH_RECOVERY_${crypto.randomUUID().replaceAll('-', '')}`;
              const authorizationResponse = await fetch(
                `${homeserver.origin}/_synapse/client/nymph/device/recovery-check`,
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${credentials.accessToken}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({ device_id: deviceId }),
                  cache: 'no-store',
                },
              );
              if (!authorizationResponse.ok) {
                throw new Error(`The active development device could not authorize recovery verification (${authorizationResponse.status}).`);
              }
              recoveryAuthorization = { userId: credentials.userId, deviceId };
              const authorization = await authorizationResponse.json() as {
                user_id?: unknown;
                device_id?: unknown;
                login_token?: unknown;
                expires_in_ms?: unknown;
              };
              if (
                authorization.user_id !== credentials.userId ||
                authorization.device_id !== deviceId ||
                typeof authorization.login_token !== 'string' ||
                typeof authorization.expires_in_ms !== 'number' ||
                authorization.expires_in_ms <= 0
              ) {
                throw new Error('The server returned an invalid recovery-verification authorization.');
              }
              session = await loginClient.login('m.login.token', {
                token: authorization.login_token,
                device_id: deviceId,
                initial_device_display_name: 'NYMPH recovery verification',
              });
            } else {
              session = await loginClient.login('m.login.password', {
                identifier: { type: 'm.id.user', user: credentials.userId },
                password,
                initial_device_display_name: 'NYMPH recovery verification',
              });
            }
            if (session.user_id !== credentials.userId || !session.device_id) {
              throw new Error('The recovery verification login did not create an account device.');
            }
            temporaryDeviceId = session.device_id;
            temporaryAccessToken = session.access_token;
            if (recoveryAuthorization && temporaryDeviceId !== recoveryAuthorization.deviceId) {
              throw new Error('The recovery verifier did not use its authorized temporary device ID.');
            }
            if (!session.access_token || session.device_id === client.getDeviceId()) {
              throw new Error('The recovery verification login did not create an independent Matrix device.');
            }
            verificationClient = sdk.createClient({
              baseUrl: homeserver.origin,
              accessToken: session.access_token,
              userId: session.user_id,
              deviceId: session.device_id,
              cryptoCallbacks: {
                getSecretStorageKey: async ({ keys }) => {
                  if (!Object.hasOwn(keys, keyId)) return null;
                  if (keys[keyId].algorithm !== 'm.secret_storage.v1.aes-hmac-sha2') {
                    throw new Error('The recovery verification client encountered an unsupported key algorithm.');
                  }
                  return [keyId, new Uint8Array(verificationKey)];
                },
              },
            });
            await verificationClient.initRustCrypto({ useIndexedDB: false });
            await waitForInitialSync(verificationClient, sdk.ClientEvent.Sync, 0);

            const verificationCrypto = verificationClient.getCrypto();
            if (!verificationCrypto) throw new Error('The separate recovery client could not initialize Matrix encryption.');
            const verificationKeyId = await verificationClient.secretStorage.getDefaultKeyId();
            const verificationKeyInfo = verificationKeyId
              ? await verificationClient.secretStorage.getKey(verificationKeyId)
              : null;
            if (
              verificationKeyId !== keyId ||
              !verificationKeyInfo ||
              verificationKeyInfo[1].algorithm !== 'm.secret_storage.v1.aes-hmac-sha2' ||
              !(await verificationClient.secretStorage.checkKey(verificationKey, verificationKeyInfo[1]))
            ) {
              throw new Error('The separate recovery client could not validate this account’s Secret Storage key.');
            }

            const restoredSecrets = await Promise.all([
              verificationClient.secretStorage.get('m.cross_signing.master'),
              verificationClient.secretStorage.get('m.cross_signing.self_signing'),
              verificationClient.secretStorage.get('m.cross_signing.user_signing'),
            ]);
            if (restoredSecrets.some((secret) => !secret)) {
              throw new Error('The separate recovery client could not decrypt all cross-signing secrets.');
            }
            const hasSeparatePublishedKeys = await verificationCrypto.userHasCrossSigningKeys(
              credentials.userId,
              true,
            );
            const separatePublishedKeys = await verificationCrypto.getUserCrossSigningKeys(credentials.userId);
            const separatePublishedIds = signingTypes.map((type) => {
              const key = separatePublishedKeys?.[type];
              return key ? Object.values(key.keys)[0] : undefined;
            });
            if (
              separatePublishedIds.some((id, index) => !id || id !== publishedKeyIds[index]) ||
              !hasSeparatePublishedKeys
            ) {
              throw new Error('The separate recovery client did not find the existing published cross-signing identity.');
            }

            await verificationCrypto.bootstrapCrossSigning({
              authUploadDeviceSigningKeys: async () => {
                throw new Error('Recovery verification refused to upload replacement cross-signing keys.');
              },
            });
            const restoredKeyIds = await Promise.all(
              signingTypes.map((type) => verificationCrypto.getCrossSigningKeyId(type)),
            );
            const crossSigningReady = await verificationCrypto.isCrossSigningReady();
            const keyIdsAvailable = restoredKeyIds.every(Boolean);
            const keyIdsMatchPublished = restoredKeyIds.every(
              (id, index) => id === publishedKeyIds[index],
            );
            if (
              !crossSigningReady ||
              !keyIdsAvailable ||
              !keyIdsMatchPublished
            ) {
              throw new Error(
                'The separate recovery client did not restore the existing cross-signing identity ' +
                  `(ready=${crossSigningReady}; keyIdsAvailable=${keyIdsAvailable}; ` +
                  `keyIdsMatchPublished=${keyIdsMatchPublished}).`,
              );
            }

            const backupInfo = await verificationCrypto.getKeyBackupInfo();
            if (backupInfo) {
              await verificationCrypto.loadSessionBackupPrivateKeyFromSecretStorage();
              const backupCheck = await verificationCrypto.checkKeyBackupAndEnable();
              if (!backupCheck?.trustInfo.trusted || !backupCheck.trustInfo.matchesDecryptionKey) {
                throw new Error(
                  'The separate recovery client could not verify the existing room-key backup ' +
                    `(trusted=${backupCheck?.trustInfo.trusted ?? false}; ` +
                    `matchesDecryptionKey=${backupCheck?.trustInfo.matchesDecryptionKey ?? false}).`,
                );
              }
            }
          } catch (error) {
            verificationFailure = error;
          } finally {
            if (temporaryDeviceId && temporaryAccessToken && verificationClient) {
              try {
                await revokeRecoveryVerifier(
                  client,
                  verificationClient,
                  {
                    userId: credentials.userId,
                    primaryDeviceId: client.getDeviceId() ?? '',
                    temporaryDeviceId,
                    password,
                  },
                  {
                    cancelAuthorization: async () => {
                      if (!recoveryAuthorization) return;
                      const cancellation = await fetch(
                        `${homeserver.origin}/_synapse/client/nymph/device/cancel`,
                        {
                          method: 'POST',
                          headers: {
                            Authorization: `Bearer ${credentials.accessToken}`,
                            'Content-Type': 'application/json',
                          },
                          body: '{}',
                          cache: 'no-store',
                        },
                      );
                      await cancellation.arrayBuffer();
                      if (!cancellation.ok) throw new Error('Recovery authorization cancellation failed.');
                    },
                    isAccessTokenRejected: async () => {
                      const response = await fetch(
                        `${homeserver.origin}/_matrix/client/v3/account/whoami`,
                        {
                          headers: { Authorization: `Bearer ${temporaryAccessToken}` },
                          cache: 'no-store',
                        },
                      );
                      await response.arrayBuffer();
                      return response.status === 401;
                    },
                    isNewLoginRejected: async () => {
                      const verifierDeviceId = temporaryDeviceId;
                      if (!recoveryAuthorization || !verifierDeviceId) return true;
                      const verifierLogin = sdk.createClient({ baseUrl: homeserver.origin });
                      try {
                        await verifierLogin.login('m.login.password', {
                          identifier: { type: 'm.id.user', user: credentials.userId },
                          password,
                          device_id: verifierDeviceId,
                        });
                        await verifierLogin.logout(false);
                        await client.deleteDevice(verifierDeviceId, {
                          type: 'm.login.password',
                          user: credentials.userId,
                          password,
                        });
                        return false;
                      } catch (error) {
                        const loginError = error as { httpStatus?: number; errcode?: string };
                        return loginError.httpStatus === 403 && loginError.errcode === 'M_FORBIDDEN';
                      } finally {
                        verifierLogin.stopClient();
                      }
                    },
                  },
                );
                temporaryDeviceId = undefined;
                recoveryAuthorization = undefined;
                onStatus('Recovery verifier cleanup confirmed: authorization canceled, session terminated, device revoked, and reauthentication rejected.');
              } catch {
                cleanupFailed = true;
                onStatus('Recovery verifier cleanup failed; recovery setup remains incomplete.');
              }
            }
            verificationClient?.stopClient();
            loginClient?.stopClient();
            verificationKey.fill(0);
            if (temporaryDeviceId) {
              try {
                await client.deleteDevice(temporaryDeviceId, {
                  type: 'm.login.password',
                  user: credentials.userId,
                  password,
                });
              } catch {
                cleanupFailed = true;
              }
            }
            if (recoveryAuthorization) {
              try {
                const cancellation = await fetch(
                  `${homeserver.origin}/_synapse/client/nymph/device/cancel`,
                  {
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${credentials.accessToken}`,
                      'Content-Type': 'application/json',
                    },
                    body: '{}',
                    cache: 'no-store',
                  },
                );
                if (!cancellation.ok) cleanupFailed = true;
                await cancellation.arrayBuffer();
              } catch {
                cleanupFailed = true;
              }
            }
          }

          await writeRecoveryMarkerAfterCleanup(
            async () => {
              if (cleanupFailed) {
                throw new Error(
                  'The recovery test device could not be revoked. Remove the NYMPH recovery verification device from account settings before continuing.',
                );
              }
              if (verificationFailure) throw verificationFailure;
            },
            async () => {
              await client.setAccountData(RECOVERY_VERIFICATION_EVENT, {
                key_id: keyId,
                verified_at: Date.now(),
                cross_signing_key_ids: {
                  master_key: masterKeyId,
                  self_signing_key: selfSigningKeyId,
                  user_signing_key: userSigningKeyId,
                },
              });
            },
          );
          await refreshSecurity();
          return keyId;
        } finally {
          recoveryKeyBytes.fill(0);
        }
      },
      discardPendingSecretStorageKey() {
        pendingSecretStorageKey?.privateKey.fill(0);
        pendingSecretStorageKey = undefined;
      },
      async bootstrapSecurity(password) {
        if (!password) throw new Error('Enter this Matrix account’s password to authorize cross-signing setup.');
        const storageStatus = await cryptoApi.getSecretStorageStatus();
        if (!storageStatus.defaultKeyId) {
          throw new Error('Confirm a new Secret Storage recovery key before setting up cross-signing.');
        }
        const crossSigningStatus = await cryptoApi.getCrossSigningStatus();
        const publicKeysPresent = await cryptoApi.userHasCrossSigningKeys(credentials.userId, true);
        const hasPrivateKeys = Object.values(crossSigningStatus.privateKeysCachedLocally).every(Boolean) ||
          crossSigningStatus.privateKeysInSecretStorage;
        if (publicKeysPresent && !hasPrivateKeys) {
          throw new Error(
            `Existing cross-signing keys for ${credentials.userId} are unavailable. ` +
            'Unlock the original Secret Storage; key replacement is not allowed here.',
          );
        }
        await cryptoApi.bootstrapSecretStorage({});
        await cryptoApi.bootstrapCrossSigning({
          authUploadDeviceSigningKeys: async (makeRequest) => makeRequest({
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: credentials.userId },
            password,
          }),
        });
        if (!(await cryptoApi.isCrossSigningReady())) {
          throw new Error(`Cross-signing did not become ready for ${credentials.userId}.`);
        }
        const existingBackup = await cryptoApi.getKeyBackupInfo();
        if (existingBackup) {
          const backupCheck = await cryptoApi.checkKeyBackupAndEnable();
          if (!backupCheck?.trustInfo.trusted || !backupCheck.trustInfo.matchesDecryptionKey) {
            throw new Error(`The existing room-key backup could not be trusted for ${credentials.userId}; it was not replaced.`);
          }
        } else {
          await cryptoApi.resetKeyBackup();
          const createdBackup = await cryptoApi.getKeyBackupInfo();
          if (!createdBackup) {
            throw new Error(`Matrix did not create a room-key backup for ${credentials.userId}.`);
          }
          const backupTrust = await cryptoApi.isKeyBackupTrusted(createdBackup);
          if (!backupTrust.trusted || !backupTrust.matchesDecryptionKey) {
            throw new Error(`The new room-key backup could not be verified for ${credentials.userId}.`);
          }
        }
        await refreshSecurity();
      },
      async requestPartnerVerification(deviceId) {
        const deadline = Date.now() + 15_000;
        let deviceAvailable = false;
        while (Date.now() < deadline) {
          const devices = await cryptoApi.getUserDeviceInfo([credentials.partnerUserId], true);
          if (devices.get(credentials.partnerUserId)?.has(deviceId)) {
            deviceAvailable = true;
            break;
          }
          await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
        }
        if (!deviceAvailable) throw new Error('That partner device is no longer available.');
        const status = await cryptoApi.getDeviceVerificationStatus(credentials.partnerUserId, deviceId);
        if (status?.isVerified()) throw new Error('That partner device is already verified.');
        const request = await cryptoApi.requestDeviceVerification(credentials.partnerUserId, deviceId);
        locallyInitiatedVerifications.add(request);
        onVerificationRequest(request);
      },
      async acceptVerification(id) {
        const request = verificationRequests.get(id);
        if (!request) throw new Error('That verification request is no longer available.');
        await request.accept();
        publishVerification(request);
      },
      async startSasVerification(id) {
        const request = verificationRequests.get(id);
        if (!request) throw new Error('That verification request is no longer available.');
        if (!locallyInitiatedVerifications.has(request)) {
          const verifier = request.verifier;
          if (!verifier) {
            throw new Error('The partner who initiated this verification must start SAS first.');
          }
          attachVerifier(id, verifier);
          return;
        }
        const verifier = request.verifier ?? await request.startVerification('m.sas.v1');
        attachVerifier(id, verifier);
      },
      async startQrVerification(id) {
        const request = verificationRequests.get(id);
        if (!request) throw new Error('That verification request is no longer available.');
        const bytes = await request.generateQRCode();
        if (!bytes) throw new Error('QR verification is not ready or the other device does not support scanning.');
        return new Uint8Array(bytes);
      },
      async scanQrVerification(id, bytes) {
        const request = verificationRequests.get(id);
        if (!request) throw new Error('That verification request is no longer available.');
        const verifier = await request.scanQRCode(new Uint8ClampedArray(bytes));
        attachVerifier(id, verifier);
      },
      async confirmSas(id) {
        const sas = sasCallbacks.get(id);
        if (!sas) throw new Error('No SAS confirmation is waiting.');
        await sas.confirm();
        sasCallbacks.delete(id);
        await refreshSecurity();
      },
      async mismatchSas(id) {
        const sas = sasCallbacks.get(id);
        if (!sas) throw new Error('No SAS confirmation is waiting.');
        sas.mismatch();
        sasCallbacks.delete(id);
      },
      async confirmQrScan(id) {
        const verifier = verifiers.get(id);
        const qr = verifier?.getReciprocateQrCodeCallbacks();
        if (!qr) throw new Error('No QR scan confirmation is waiting.');
        qr.confirm();
        await refreshSecurity();
      },
      async cancelVerification(id) {
        const request = verificationRequests.get(id);
        const verifier = verifiers.get(id);
        if (verifier) verifier.cancel(new Error('Cancelled by user.'));
        else if (request?.pending) await request.cancel({ reason: 'Cancelled by user.' });
        verificationRequests.delete(id);
        verifiers.delete(id);
        sasCallbacks.delete(id);
        onVerification(null);
      },
      async revokeDevice(deviceId, password) {
        if (deviceId === client.getDeviceId()) {
          throw new Error('This device cannot revoke itself while it is the active session.');
        }
        await client.deleteDevice(deviceId, {
          type: 'm.login.password',
          user: credentials.userId,
          password,
        });
        await refreshSecurity();
      },
      close() {
        client.removeListener(sdk.RoomEvent.Timeline, receive);
        client.removeListener(MatrixEventEvent.Decrypted, onDecryptedEvent);
        client.removeListener(RoomMemberEvent.Typing, onTypingEvent);
        client.removeListener(sdk.RoomEvent.Receipt, onReceiptEvent);
        client.removeListener(CryptoEvent.VerificationRequestReceived, onVerificationRequest);
        client.removeListener(CryptoEvent.UserTrustStatusChanged, onUserTrustChanged);
        client.removeListener(CryptoEvent.DevicesUpdated, onDevicesUpdated);
        client.stopClient();
        clearSecretStorageKeyMaterial();
      },
    };
  } catch (error) {
    client.stopClient();
    clearSecretStorageKeyMaterial();
    throw error;
  }
}
