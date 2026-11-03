import type {
  Device,
  MatrixClient,
  MatrixEvent,
  Room,
} from 'matrix-js-sdk';
import { Capacitor } from '@capacitor/core';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api/CryptoEvent.js';
import { OnlySignedDevicesIsolationMode } from 'matrix-js-sdk/lib/crypto-api/index.js';
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
  ownDeviceId: string;
  partnerVerified: boolean;
  identityChanged: boolean;
  crossSigningReady: boolean;
  secretStorageReady: boolean;
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
  bootstrapSecurity(password: string): Promise<string>;
  requestPartnerVerification(): Promise<void>;
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
    void client.startClient({ initialSyncLimit: 50 }).catch((error: unknown) => {
      window.clearTimeout(timeout);
      client.removeListener(syncEvent, onSync);
      reject(error);
    });
  });
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
  const client = sdk.createClient({
    baseUrl: homeserver.origin,
    accessToken: credentials.accessToken,
    userId: credentials.userId,
    ...(credentials.deviceId ? { deviceId: credentials.deviceId } : {}),
    timelineSupport: true,
    cryptoCallbacks: {
      cacheSecretStorageKey: (keyId, _keyInfo, key) => {
        secretStorageKeys.set(keyId, key);
      },
      getSecretStorageKey: async ({ keys }) => {
        for (const [keyId] of Object.entries(keys)) {
          const cached = secretStorageKeys.get(keyId);
          if (cached) return [keyId, cached];
        }
        const keyIds = Object.keys(keys);
        const recoveryKey = window.prompt('Enter your Matrix recovery key to unlock encrypted account secrets.');
        if (recoveryKey) {
          for (const keyId of keyIds) {
            try {
              const decoded = decodeRecoveryKey(recoveryKey);
              secretStorageKeys.set(keyId, decoded);
              return [keyId, decoded];
            } catch {
              break;
            }
          }
        }
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
    const [partnerIdentity, crossSigningReady, secretStorageReady] = await Promise.all([
      cryptoApi.getUserVerificationStatus(credentials.partnerUserId),
      cryptoApi.isCrossSigningReady(),
      cryptoApi.isSecretStorageReady(),
    ]);
    const state: MatrixSecurityState = {
      ownDeviceId: client.getDeviceId() ?? '',
      partnerVerified: partnerIdentity.isCrossSigningVerified(),
      identityChanged: partnerIdentity.needsUserApproval,
      crossSigningReady,
      secretStorageReady,
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
    if (!(await cryptoApi.isEncryptionEnabledInRoom(credentials.roomId))) {
      throw new Error('The configured Matrix room is not end-to-end encrypted. Refusing to send messages.');
    }

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
      async bootstrapSecurity(password) {
        if (!password) throw new Error('Enter this Matrix account’s password to authorize cross-signing setup.');
        const storageStatus = await cryptoApi.getSecretStorageStatus();
        let recoveryKey = '';
        if (!storageStatus.defaultKeyId) {
          const generated = await cryptoApi.createRecoveryKeyFromPassphrase();
          await cryptoApi.bootstrapSecretStorage({
            createSecretStorageKey: async () => generated,
          });
          recoveryKey = generated.encodedPrivateKey ?? '';
        } else {
          await cryptoApi.bootstrapSecretStorage({});
        }
        await cryptoApi.bootstrapCrossSigning({
          authUploadDeviceSigningKeys: async (makeRequest) => makeRequest({
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: credentials.userId },
            password,
          }),
        });
        await refreshSecurity();
        return recoveryKey;
      },
      async requestPartnerVerification() {
        const request = await cryptoApi.requestVerificationDM(credentials.partnerUserId, credentials.roomId);
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
        secretStorageKeys.clear();
      },
    };
  } catch (error) {
    client.stopClient();
    secretStorageKeys.clear();
    throw error;
  }
}
