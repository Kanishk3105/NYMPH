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
import { RoomMemberEvent } from 'matrix-js-sdk/lib/models/room-member.js';
import { revokeRecoveryVerifier, writeRecoveryMarkerAfterCleanup } from './recovery-device-cleanup.ts';

export type NymphMode = 'romantic' | 'flirty' | 'spicy' | 'kinky';
export type NymphEventKind = 'text' | 'mood' | 'sticker' | 'reaction';

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
const ENVELOPE_PREFIX = 'nymph.v1:';
const RECOVERY_VERIFICATION_EVENT = 'org.nymph.security.recovery_verification';

function isMode(value: unknown): value is NymphMode {
  return value === 'romantic' || value === 'flirty' || value === 'spicy' || value === 'kinky';
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
      !['text', 'mood', 'sticker', 'reaction'].includes(String(payload.kind)) ||
      typeof payload.text !== 'string' ||
      typeof payload.sentAt !== 'number'
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
    const timeout = window.setTimeout(() => reject(new Error('Timed out waiting for the homeserver sync.')), 30_000);
    const onSync = (state: string) => {
      if (state === 'PREPARED') {
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
  const creatorCanStartBeforePairing = credentials.userId === '@partner1:localhost' &&
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
      phase: VerificationPhase[request.phase],
      ...extra,
    });
  };
  const attachVerifier = (id: string, verifier: Verifier) => {
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
        ? Object.keys(publishedSigningKeys[CrossSigningKey.Master].keys)[0]
        : undefined,
      self_signing_key: publishedSigningKeys?.[CrossSigningKey.SelfSigning]
        ? Object.keys(publishedSigningKeys[CrossSigningKey.SelfSigning].keys)[0]
        : undefined,
      user_signing_key: publishedSigningKeys?.[CrossSigningKey.UserSigning]
        ? Object.keys(publishedSigningKeys[CrossSigningKey.UserSigning].keys)[0]
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
    request.on(VerificationRequestEvent.Change, () => publishVerification(request));
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

    const receive = (event: MatrixEvent, eventRoom: Room | undefined, toStartOfTimeline?: boolean, removed?: boolean) => {
      if (removed || toStartOfTimeline || eventRoom?.roomId !== credentials.roomId) return;
      const sender = event.getSender();
      if (sender !== credentials.partnerUserId && sender !== credentials.userId) return;
      if (event.getType() !== sdk.EventType.RoomMessage && event.getType() !== sdk.EventType.Reaction) return;
      const message = decodeEnvelope(event);
      if (message) onMessage(message);
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
    client.on(sdk.RoomEvent.Timeline, receive);
    client.on(RoomMemberEvent.Typing, onTypingEvent);
    client.on(sdk.RoomEvent.Receipt, onReceiptEvent);

    for (const event of room.getLiveTimeline().getEvents()) {
      const sender = event.getSender();
      if (sender !== credentials.partnerUserId && sender !== credentials.userId) continue;
      if (event.getType() !== sdk.EventType.RoomMessage && event.getType() !== sdk.EventType.Reaction) continue;
      const message = decodeEnvelope(event);
      if (message) onMessage(message);
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
        return result.event_id;
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
          return key ? Object.keys(key.keys)[0] : undefined;
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

          const signingTypes = [
            CrossSigningKey.Master,
            CrossSigningKey.SelfSigning,
            CrossSigningKey.UserSigning,
          ];
          const publishedKeys = await cryptoApi.getUserCrossSigningKeys(credentials.userId);
          const masterKeyId = publishedKeys?.[CrossSigningKey.Master]
            ? Object.keys(publishedKeys[CrossSigningKey.Master].keys)[0]
            : undefined;
          const selfSigningKeyId = publishedKeys?.[CrossSigningKey.SelfSigning]
            ? Object.keys(publishedKeys[CrossSigningKey.SelfSigning].keys)[0]
            : undefined;
          const userSigningKeyId = publishedKeys?.[CrossSigningKey.UserSigning]
            ? Object.keys(publishedKeys[CrossSigningKey.UserSigning].keys)[0]
            : undefined;
          if (!masterKeyId || !selfSigningKeyId || !userSigningKeyId) {
            throw new Error(`The published cross-signing identity is incomplete for ${credentials.userId}.`);
          }
          const publishedKeyIds = [masterKeyId, selfSigningKeyId, userSigningKeyId];
          const currentKeyIds = await Promise.all(
            signingTypes.map((type) => cryptoApi.getCrossSigningKeyId(type)),
          );
          const storedSecrets = await Promise.all([
            client.secretStorage.get('m.cross_signing.master'),
            client.secretStorage.get('m.cross_signing.self_signing'),
            client.secretStorage.get('m.cross_signing.user_signing'),
          ]);
          if (
            currentKeyIds.some((id, index) => !id || id !== publishedKeyIds[index]) ||
            storedSecrets.some((secret) => !secret) ||
            !(await cryptoApi.isCrossSigningReady())
          ) {
            throw new Error(
              `Secret Storage and the published cross-signing identity are not ready for ${credentials.userId}.`,
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
            const backupInfo = await verificationCrypto.getKeyBackupInfo();
            if (backupInfo) {
              await verificationCrypto.loadSessionBackupPrivateKeyFromSecretStorage();
              const backupCheck = await verificationCrypto.checkKeyBackupAndEnable();
              if (!backupCheck?.trustInfo.trusted || !backupCheck.trustInfo.matchesDecryptionKey) {
                throw new Error('The separate recovery client could not verify the existing room-key backup.');
              }
            }
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
            await verificationClient.downloadKeysForUsers([credentials.userId]);
            const separatePublishedKeys = await verificationCrypto.getUserCrossSigningKeys(credentials.userId);
            const separatePublishedIds = signingTypes.map((type) => {
              const key = separatePublishedKeys?.[type];
              return key ? Object.keys(key.keys)[0] : undefined;
            });
            if (
              separatePublishedIds.some((id, index) => !id || id !== publishedKeyIds[index]) ||
              !(await verificationCrypto.userHasCrossSigningKeys(credentials.userId, true))
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
            if (
              !(await verificationCrypto.isCrossSigningReady()) ||
              restoredKeyIds.some((id, index) => !id || id !== publishedKeyIds[index])
            ) {
              throw new Error('The separate recovery client did not restore the existing cross-signing identity.');
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
        const verifier = await request.startVerification('m.sas.v1');
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
