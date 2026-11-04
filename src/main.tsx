import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import { StatusBar, Style } from '@capacitor/status-bar';
import type { EncryptedFile } from 'matrix-js-sdk/lib/@types/media';
import type { MatrixConnection, MatrixMessagingClient, MatrixSecurityState, MatrixVerification, NymphEnvelope, ReceivedNymphEvent } from './matrix/MessagingClient';
import { getDefaultHomeserver } from './matrix/homeserver';
import { PARTNER_DEVICE_IDS, PARTNER_IDENTITIES } from './matrix/partner-identity';
import { DEMO_STATE_STORAGE_KEY, getMatrixDeviceStorageKey, getNymphStateStorageKey } from './matrix/state-storage';
import { getMatrixCryptoStorageKey, loadMatrixSession, removeMatrixSession, saveMatrixSession } from './native/secureSession';
import { encodeStickerFile, getStickerImportError, getStickerPackNameError, normalizeStickerPackName } from './sticker-library';
import './styles.css';

const PairingPanel = lazy(() => import('./matrix/PairingPanel').then(({ PairingPanel: component }) => ({ default: component })));
const MatrixSecurityPanel = lazy(() => import('./matrix/MatrixSecurityPanel').then(({ MatrixSecurityPanel: component }) => ({ default: component })));

type Mode = 'romantic' | 'flirty' | 'spicy' | 'kinky';
type Panel = 'stickers' | 'mood' | 'profile' | 'settings' | 'gallery' | 'matrix' | null;
type Message = {
  id: string;
  mode: Mode;
  sender: 'me' | 'partner';
  kind: 'text' | 'sticker' | 'media' | 'mood' | 'reaction';
  text: string;
  time: number;
  reply?: string;
  reaction?: string;
  image?: string;
  mediaType?: string;
  expiresAt?: number;
  viewSeconds?: number;
  opened?: boolean;
  transport?: 'local' | 'matrix';
  delivery?: 'sending' | 'sent' | 'read' | 'failed';
  remoteEventId?: string;
  reactionTo?: string;
  encryptedAttachment?: EncryptedFile;
  mediaError?: string;
};
type Profile = { displayName: string; username: string; bio: string; avatar: string };
type CustomSticker = { id: string; name: string; dataUrl: string; type?: string };
type CustomStickerPack = { id: string; name: string; adult: boolean; stickers: CustomSticker[] };
type LocalState = {
  messages: Message[];
  profile: Profile;
  partnerName: string;
  retention: string;
  roomReady: boolean;
  pinSalt?: string;
  pinHash?: string;
  favourites: string[];
  recent: string[];
  favoriteCustomStickerIds: string[];
  recentCustomStickerIds: string[];
  customStickerPacks: CustomStickerPack[];
};

const DEFAULT_HOMESERVER = getDefaultHomeserver({
  configured: import.meta.env.VITE_MATRIX_HOMESERVER,
  mode: import.meta.env.MODE,
  platform: Capacitor.getPlatform(),
  development: import.meta.env.DEV,
});
const modes: { id: Mode; label: string; icon: string; subtitle: string }[] = [
  { id: 'romantic', label: 'Romantic', icon: '♡', subtitle: 'A little closer' },
  { id: 'flirty', label: 'Flirty', icon: '✳', subtitle: 'Playful sparks' },
  { id: 'spicy', label: 'Spicy', icon: '♨', subtitle: 'Just between us' },
  { id: 'kinky', label: 'Kinky · 18+', icon: '♠', subtitle: 'Private exploration' },
];
const packData: Record<string, string[]> = {
  'Love notes': ['💌', '💗', '💕', '💞', '💘', '🌹', '🫶', '🥰', '💋', '❤️‍🔥', '🕯️', '✨'],
  Kisses: ['💋', '😘', '😚', '😽', '💏', '🫦', '❤️', '🌙', '🫶', '💌', '🥀', '💕'],
  'Missing you': ['🥺', '🫂', '💭', '🌙', '🧸', '💌', '🫶', '🥹', '🕯️', '💗', '✨', '❤️'],
  'Flirty mood': ['😉', '😏', '🫦', '💌', '🍒', '🔥', '😘', '💃', '✨', '🖤', '💋', '🥀'],
  'After dark': ['😈', '🔥', '🖤', '🌶️', '💋', '🫦', '🍒', '♠️', '🥀', '✨', '❤️‍🔥', '🌙'],
};
const everydayPacks = ['Love notes', 'Kisses', 'Missing you', 'Flirty mood'];
const adultPacks = ['After dark'];
const moodOptions = [
  ['Loving', '❤️'], ['Missing you', '🥺'], ['Kinky', '😈'], ['Sexploring', '🔥'],
  ['Need affection', '💋'], ['Need pussy to eat', '🍑'], ['Cock sucking', '👅'],
  ['Wanting kisses', '💋'], ['Feeling naughty', '😏'], ['Wanting you close', '🫂'],
  ['Feeling playful', '😉'], ['Missing your touch', '🥵'],
];
const initialMessages: Message[] = [
  { id: 'm1', mode: 'romantic', sender: 'partner', kind: 'text', text: 'I keep replaying our last slow Sunday together.', time: Date.now() - 1000 * 60 * 18 },
  { id: 'm2', mode: 'romantic', sender: 'me', kind: 'text', text: 'Saving that smile for the next time I see you. 🤍', time: Date.now() - 1000 * 60 * 15, reaction: '🤍' },
  { id: 'm3', mode: 'flirty', sender: 'partner', kind: 'text', text: 'I have a little surprise waiting for you later…', time: Date.now() - 1000 * 60 * 9 },
  { id: 'm4', mode: 'spicy', sender: 'me', kind: 'text', text: 'Wish you were here. I have ideas. 🔥', time: Date.now() - 1000 * 60 * 4 },
  { id: 'm5', mode: 'kinky', sender: 'partner', kind: 'text', text: 'I want to hear more about the fantasy we talked about.', time: Date.now() - 1000 * 60 * 2 },
];
const defaultState: LocalState = {
  messages: initialMessages,
  profile: { displayName: 'Amelia', username: '@amelia', bio: 'A soft place to land.', avatar: 'A' },
  partnerName: 'Luca',
  retention: '24 hours',
  roomReady: false,
  favourites: [],
  recent: [],
  favoriteCustomStickerIds: [],
  recentCustomStickerIds: [],
  customStickerPacks: [],
};

function readState(
  storageKey = DEMO_STATE_STORAGE_KEY,
  useDemoMessages = storageKey === DEMO_STATE_STORAGE_KEY,
): LocalState {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return useDemoMessages ? defaultState : { ...defaultState, messages: [] };
    const parsed = JSON.parse(stored) as Partial<LocalState>;
    return {
      ...defaultState,
      ...parsed,
      favoriteCustomStickerIds: Array.isArray(parsed.favoriteCustomStickerIds) ? parsed.favoriteCustomStickerIds : [],
      recentCustomStickerIds: Array.isArray(parsed.recentCustomStickerIds) ? parsed.recentCustomStickerIds : [],
      customStickerPacks: Array.isArray(parsed.customStickerPacks) ? parsed.customStickerPacks : [],
    };
  } catch (error) {
    console.error('Could not restore local NYMPH demo state.', error);
    return defaultState;
  }
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(timestamp);
}

function makeId(): string {
  return crypto.randomUUID();
}

async function hashPin(pin: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, key, 256);
  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function decode(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function App() {
  const [data, setData] = useState<LocalState>(readState);
  const [stateScope, setStateScope] = useState(DEMO_STATE_STORAGE_KEY);
  const [mode, setMode] = useState<Mode>('romantic');
  const [panel, setPanel] = useState<Panel>(null);
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState<Message | null>(null);
  const [toast, setToast] = useState('');
  const [matrixConnection, setMatrixConnection] = useState<MatrixConnection>({ homeserver: DEFAULT_HOMESERVER, userId: '', partnerUserId: '', accessToken: '', roomId: '' });
  const [matrixPassword, setMatrixPassword] = useState('');
  const [matrixStatus, setMatrixStatus] = useState('Not connected');
  const [matrixSync, setMatrixSync] = useState('');
  const [matrixSecurity, setMatrixSecurity] = useState<MatrixSecurityState | null>(null);
  const [matrixVerification, setMatrixVerification] = useState<MatrixVerification | null>(null);
  const [pairingRole, setPairingRole] = useState<'partner-a' | 'partner-b' | 'replace-device' | null>(null);
  const [replacementActivationPending, setReplacementActivationPending] = useState(false);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [locked, setLocked] = useState(false);
  const [pinValue, setPinValue] = useState('');
  const [pinSetup, setPinSetup] = useState('');
  const [roomIntent, setRoomIntent] = useState(false);
  const [pinError, setPinError] = useState('');
  const [selectedPack, setSelectedPack] = useState('Love notes');
  const [packTab, setPackTab] = useState<'everyday' | 'adult'>('everyday');
  const [search, setSearch] = useState('');
  const [customPackName, setCustomPackName] = useState('My stickers');
  const [showGif, setShowGif] = useState(false);
  const [viewOnceSeconds, setViewOnceSeconds] = useState('Off');
  const [preview, setPreview] = useState<{ url: string; name: string; type: string; file?: File } | null>(null);
  const [moodCard, setMoodCard] = useState<{ label: string; emoji: string } | null>(null);
  const [stickerImportRequested, setStickerImportRequested] = useState(false);
  const [galleryFilter, setGalleryFilter] = useState('All');
  const [customMood, setCustomMood] = useState('');
  const [profileDraft, setProfileDraft] = useState(data.profile);
  const [deleteAdult, setDeleteAdult] = useState(false);
  const [exitMode, setExitMode] = useState<Mode | null>(null);
  const [emojiTray, setEmojiTray] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const matrixClient = useRef<MatrixMessagingClient | null>(null);
  const matrixConnecting = useRef(false);
  const typingTimer = useRef<number | undefined>(undefined);
  const pendingMatrixMedia = useRef<ReceivedNymphEvent[]>([]);
  const downloadingMatrixMedia = useRef(new Set<string>());

  useEffect(() => {
    try {
      const persistent = {
      ...data,
      messages: data.messages.filter((message) => message.transport !== 'matrix' && message.kind !== 'media' && !(message.kind === 'sticker' && message.image)),
      };
      localStorage.setItem(stateScope, JSON.stringify(persistent));
    } catch (error) {
      console.error('Could not save NYMPH demo state on this device.', error);
      setToast('Could not save local changes. Device storage may be full.');
    }
  }, [data, stateScope]);
  useEffect(() => () => matrixClient.current?.close(), []);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let active = true;
    void loadMatrixSession().then((session) => {
      if (active && session) {
        setMatrixConnection(session);
        void connectPrivateRoom(session);
      }
    }).catch((error: unknown) => {
      if (active) notify(error instanceof Error ? error.message : 'Could not restore the encrypted Matrix session.');
    });
    void StatusBar.setStyle({ style: Style.Dark }).catch((error: unknown) => notify(error instanceof Error ? error.message : 'Could not configure the status bar.'));
    void StatusBar.setBackgroundColor({ color: '#10090d' }).catch((error: unknown) => notify(error instanceof Error ? error.message : 'Could not configure the status bar.'));
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const appStateListener = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive && data.roomReady) setLocked(true);
    });
    const backButtonListener = CapacitorApp.addListener('backButton', () => {
      if (pairingRole && !replacementActivationPending) setPairingRole(null);
      else if (panel) setPanel(null);
      else void CapacitorApp.minimizeApp();
    });
    return () => {
      void appStateListener.then((listener) => listener.remove());
      void backButtonListener.then((listener) => listener.remove());
    };
  }, [data.roomReady, pairingRole, panel, replacementActivationPending]);
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [mode, data.messages]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden' && data.roomReady && data.pinHash) setLocked(true);
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [data.roomReady, data.pinHash]);
  useEffect(() => {
    if (!matrixClient.current) return;
    const isTyping = Boolean(draft.trim());
    void matrixClient.current.setTyping(isTyping).catch(() => setMatrixSync('Typing indicator unavailable'));
    if (!isTyping) return;
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => {
      void matrixClient.current?.setTyping(false).catch(() => setMatrixSync('Typing indicator unavailable'));
    }, 3500);
    return () => {
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
    };
  }, [draft]);

  const activeMode = modes.find((item) => item.id === mode)!;
  const visibleMessages = useMemo(() => data.messages.filter((message) => message.mode === mode && (!message.expiresAt || message.expiresAt > Date.now()) && (!matrixClient.current || message.transport === 'matrix')), [data.messages, mode, matrixStatus]);
  const visibleCustomPacks = data.customStickerPacks.filter((pack) => pack.adult === (packTab === 'adult'));
  const packNames = [
    ...(packTab === 'everyday' ? everydayPacks : adultPacks),
    ...visibleCustomPacks.map((pack) => `custom:${pack.id}`),
    'Favorites',
    'Recent',
  ];
  const selectedCustomPack = data.customStickerPacks.find((pack) => selectedPack === `custom:${pack.id}`);
  const collectionCustomStickers = visibleCustomPacks.flatMap((pack) => pack.stickers);
  const customStickerSource = selectedPack === 'Favorites'
    ? collectionCustomStickers.filter((sticker) => data.favoriteCustomStickerIds.includes(sticker.id))
    : selectedPack === 'Recent'
      ? data.recentCustomStickerIds
        .map((id) => collectionCustomStickers.find((sticker) => sticker.id === id))
        .filter((sticker): sticker is CustomSticker => Boolean(sticker))
      : selectedCustomPack?.stickers ?? [];
  const adultStickerSet = new Set(packData['After dark']);
  const stickerSource = selectedPack === 'Favorites'
    ? data.favourites.filter((item) => packTab === 'adult' ? adultStickerSet.has(item) : !adultStickerSet.has(item))
    : selectedPack === 'Recent'
      ? data.recent.filter((item) => packTab === 'adult' ? adultStickerSet.has(item) : !adultStickerSet.has(item))
      : selectedCustomPack ? [] : packData[selectedPack] ?? [];
  const stickers = stickerSource.filter((item) => item.toLowerCase().includes(search.toLowerCase()));
  const customPackStickers = customStickerSource.filter((sticker) => sticker.name.toLowerCase().includes(search.toLowerCase()));
  const importedGifs = data.customStickerPacks
    .filter((pack) => pack.adult === (packTab === 'adult'))
    .flatMap((pack) => pack.stickers.map((sticker) => ({ ...sticker, packName: pack.name })))
    .filter((sticker) => (sticker.type ?? sticker.dataUrl.slice(5, sticker.dataUrl.indexOf(';'))) === 'image/gif');
  const galleryMessages = data.messages.filter((item) => item.kind === 'media' && item.image && !item.mediaType?.startsWith('audio/') && (
    galleryFilter === 'All' ||
    (galleryFilter === 'Photos' && item.mediaType?.startsWith('image/')) ||
    (galleryFilter === 'Videos' && item.mediaType?.startsWith('video/')) ||
    (galleryFilter === 'Favourites' && item.reaction === '♥') ||
    (galleryFilter === 'Expiring' && item.viewSeconds)
  ));

  function notify(message: string) { setToast(message); }
  function updateMessages(updater: (items: Message[]) => Message[]) {
    setData((current) => ({ ...current, messages: updater(current.messages) }));
  }
  function addMessage(message: Omit<Message, 'id' | 'time'>) {
    updateMessages((items) => [...items, { ...message, id: makeId(), time: Date.now() }]);
  }
  function appendOutgoing(input: Omit<Message, 'id' | 'time' | 'sender'>) {
    const outgoing: Message = {
      ...input,
      id: makeId(),
      time: Date.now(),
      sender: 'me',
      transport: matrixClient.current && input.kind !== 'media' && !input.image ? 'matrix' : 'local',
      delivery: matrixClient.current && input.kind !== 'media' && !input.image ? 'sending' : undefined,
    };
    if (!(outgoing.kind === 'reaction' && outgoing.transport === 'matrix')) {
      updateMessages((items) => [...items, outgoing]);
    }
    if (outgoing.transport === 'matrix') void transmit(outgoing);
    else if (matrixClient.current) notify('Media files are not encrypted for Matrix transfer in this stage. Nothing was sent.');
    else notify('Saved locally only — no encrypted room is connected.');
    return outgoing;
  }
  function toMatrixEnvelope(message: Message): NymphEnvelope {
    return {
      version: 1,
      id: message.id,
      mode: message.mode,
      kind: message.kind === 'mood' || message.kind === 'sticker' || message.kind === 'reaction' ? message.kind : 'text',
      text: message.text,
      sentAt: message.time,
      replyTo: message.reply,
      replyToEventId: message.reply ? message.remoteEventId : undefined,
      reactionTo: message.reactionTo,
    };
  }
  async function transmit(message: Message) {
    const sender = matrixClient.current;
    if (!sender) return;
    updateMessages((items) => items.map((item) => item.id === message.id ? { ...item, transport: 'matrix', delivery: 'sending' } : item));
    try {
      const eventId = await sender.send(toMatrixEnvelope(message));
      updateMessages((items) => items.map((item) => item.id === message.id ? { ...item, transport: 'matrix', delivery: 'sent', remoteEventId: eventId } : item));
    } catch (error) {
      console.error('Encrypted Matrix message send failed.', error);
      updateMessages((items) => items.map((item) => item.id === message.id ? { ...item, transport: 'matrix', delivery: 'failed' } : item));
      notify('Encrypted send failed. This message was not delivered.');
    }
  }
  function hydrateMatrixMedia(event: ReceivedNymphEvent) {
      const client = matrixClient.current;
      if (!client || !event.attachment || !event.mediaType || downloadingMatrixMedia.current.has(event.id)) return;
      downloadingMatrixMedia.current.add(event.id);
      void client.downloadAttachment(event.attachment, event.mediaType).then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        updateMessages((items) => items.map((item) =>
          item.id === event.id ? { ...item, image: objectUrl, mediaError: undefined } : item,
        ));
      }).catch(() => {
        updateMessages((items) => items.map((item) =>
          item.id === event.id ? { ...item, mediaError: 'Encrypted media could not be downloaded or verified.' } : item,
        ));
      }).finally(() => {
        downloadingMatrixMedia.current.delete(event.id);
      });
    }
  function sendEncryptedAttachment(
      file: File,
      kind: 'media' | 'sticker',
      text: string,
      contentMode: Mode,
      image?: string,
    ): boolean {
      const sender = matrixClient.current;
      if (!sender) return false;
      const messageId = makeId();
      const sentAt = Date.now();
      const mediaType = file.type || 'application/octet-stream';
      const outgoing: Message = {
        id: messageId,
        mode: contentMode,
        sender: 'me',
        kind,
        text,
        time: sentAt,
        mediaType,
        image,
        transport: 'matrix',
        delivery: 'sending',
      };
      updateMessages((items) => [...items, outgoing]);
      const envelope: NymphEnvelope = {
        version: 1,
        id: messageId,
        mode: contentMode,
        kind,
        text,
        sentAt,
        mediaType,
        mediaName: file.name,
      };
      void sender.sendAttachment(file, envelope).then(({ eventId, attachment }) => {
        updateMessages((items) => items.map((item) =>
          item.id === messageId ? { ...item, delivery: 'sent', remoteEventId: eventId, encryptedAttachment: attachment } : item,
        ));
      }).catch(() => {
        updateMessages((items) => items.map((item) =>
          item.id === messageId ? { ...item, delivery: 'failed', mediaError: 'Encrypted media was not sent.' } : item,
        ));
        notify('Encrypted media was not sent. Verify the partner device and try again.');
      });
      return true;
  }
  async function connectPrivateRoom(connection: MatrixConnection = matrixConnection, internalHandoff = false) {
    if (matrixConnecting.current && !internalHandoff) return;
    if (matrixClient.current) {
      matrixClient.current.close();
      matrixClient.current = null;
      if (Capacitor.isNativePlatform()) {
        try {
          await removeMatrixSession();
        } catch (error) {
          notify(error instanceof Error ? error.message : 'Could not remove the saved Matrix session.');
        }
      }
      setMatrixStatus('Not connected');
      setMatrixSync('');
      setMatrixSecurity(null);
      setMatrixVerification(null);
      setPanel(null);
      notify('Disconnected from the encrypted room.');
      return;
    }
    async function connectAsPartnerA() {
      if (!matrixConnection.homeserver) {
        notify('This release has no Matrix homeserver configured. Set VITE_MATRIX_HOMESERVER and rebuild.');
        return;
      }
      if (!PARTNER_IDENTITIES.partnerA || !PARTNER_IDENTITIES.partnerB) {
        notify('This release has no Matrix partner identities configured.');
        return;
      }
      if (!matrixPassword) {
        notify('Enter the Partner 1 password.');
        return;
      }
      let loginClient: import('matrix-js-sdk').MatrixClient | undefined;
      let accessToken: string | undefined;
      try {
        const homeserver = new URL(matrixConnection.homeserver);
        const usbReverseDevelopment = Capacitor.isNativePlatform() &&
          Capacitor.getPlatform() === 'android' &&
          import.meta.env.MODE === 'android' &&
          homeserver.protocol === 'http:' &&
          homeserver.hostname === 'localhost';
        const browserDevelopment = import.meta.env.DEV &&
          homeserver.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(homeserver.hostname);
        if (homeserver.protocol !== 'https:' && !browserDevelopment && !usbReverseDevelopment) {
          throw new Error('Use HTTPS when connecting over Wi-Fi.');
        }
        const sdk = await import('matrix-js-sdk');
        loginClient = sdk.createClient({ baseUrl: homeserver.origin });
        const deviceId = localStorage.getItem(getMatrixDeviceStorageKey(PARTNER_IDENTITIES.partnerA)) ||
          PARTNER_DEVICE_IDS.partnerA ||
          crypto.randomUUID();
        const session = await loginClient.login('m.login.password', {
          identifier: { type: 'm.id.user', user: PARTNER_IDENTITIES.partnerA },
          password: matrixPassword,
          initial_device_display_name: 'NYMPH Partner 1',
          device_id: deviceId,
        });
        accessToken = session.access_token;
        loginClient.stopClient();
        if (session.user_id !== PARTNER_IDENTITIES.partnerA) throw new Error('This login is not the configured Partner 1 identity.');
        if (session.device_id) localStorage.setItem(getMatrixDeviceStorageKey(session.user_id), session.device_id);
        const statusResponse = await fetch(`${homeserver.origin}/_synapse/client/nymph/pairing/status`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: '{}',
          cache: 'no-store',
        });
        if (!statusResponse.ok) throw new Error(`Could not load the private-room configuration (${statusResponse.status}).`);
        const status = await statusResponse.json() as { room_id?: unknown };
        if (typeof status.room_id !== 'string' || !status.room_id.startsWith('!')) {
          throw new Error('The local homeserver has no configured NYMPH room.');
        }
        const connection: MatrixConnection = {
          homeserver: homeserver.origin,
          userId: session.user_id,
          partnerUserId: PARTNER_IDENTITIES.partnerB,
          accessToken,
          roomId: status.room_id,
          deviceId: session.device_id,
        };
        setMatrixPassword('');
        setMatrixConnection(connection);
        await connectPrivateRoom(connection, true);
      } catch (error) {
        if (accessToken) await loginClient?.logout().catch(() => undefined);
        notify(error instanceof Error ? error.message : 'Partner 1 could not connect.');
      } finally {
        setMatrixPassword('');
      }
    }
    if (!connection.homeserver || !connection.userId || !connection.partnerUserId || !connection.accessToken || !connection.roomId) {
      matrixConnecting.current = true;
      try {
        await connectAsPartnerA();
      } finally {
        matrixConnecting.current = false;
      }
      return;
    }
    matrixConnecting.current = true;
    setMatrixStatus('Connecting securely…');
    try {
      if (Capacitor.isNativePlatform() && !connection.deviceId) {
        throw new Error('This Android Matrix session has no device ID. Re-enroll this device.');
      }
      const deviceId = connection.deviceId ?? '';
      const storageKey = Capacitor.isNativePlatform()
        ? await getMatrixCryptoStorageKey(connection.userId, deviceId)
        : undefined;
      const persistentConnection: MatrixConnection = {
        ...connection,
        deviceId,
        ...(storageKey ? { storageKey } : {}),
      };
      const accountScope = getNymphStateStorageKey(connection.userId);
      setStateScope(accountScope);
      setData(readState(accountScope, false));
      const { connectMatrix } = await import('./matrix/MessagingClient');
      const connected = await connectMatrix(
        persistentConnection,
        (event) => {
        if (event.kind === 'reaction' && event.reactionTo) {
          setData((current) => ({
            ...current,
            messages: current.messages.map((item) => item.remoteEventId === event.reactionTo ? { ...item, reaction: event.text } : item),
          }));
          return;
        }
        const received: Message = {
          id: event.id,
          mode: event.mode,
          sender: event.sender === connection.userId ? 'me' : 'partner',
          kind: event.kind,
          text: event.text,
          time: event.sentAt,
          reply: event.replyTo,
          transport: 'matrix',
          delivery: 'sent',
          remoteEventId: event.eventId,
          encryptedAttachment: event.attachment,
          mediaType: event.mediaType,
        };
        setData((current) => current.messages.some((item) => item.id === received.id) ? current : { ...current, messages: [...current.messages, received] });
        if (event.attachment) {
          if (matrixClient.current) hydrateMatrixMedia(event);
          else pendingMatrixMedia.current.push(event);
        }
        if (received.sender === 'partner') void matrixClient.current?.markRead(event.eventId);
      },
        (status) => setMatrixSync(String(status)),
        (verification) => setMatrixVerification(verification),
        (security) => setMatrixSecurity(security),
        (typing) => setPartnerTyping(typing),
        (eventId) => updateMessages((items) => items.map((item) =>
          item.remoteEventId === eventId ? { ...item, delivery: 'read' } : item
        )),
      );
      if (Capacitor.isNativePlatform()) {
        try {
          await saveMatrixSession({ ...connection, deviceId });
        } catch (error) {
          connected.close();
          throw error;
        }
      }
      matrixClient.current = connected;
      for (const event of pendingMatrixMedia.current.splice(0)) hydrateMatrixMedia(event);
      setMatrixConnection({ ...connection, deviceId });
      setMatrixStatus(`Encrypted · ${connected.userId}`);
      setPanel(null);
      setPairingRole(null);
      notify('Connected to the encrypted Matrix room. Verification is required before sending.');
    } catch (error) {
      console.error('Could not establish an encrypted Matrix session.', error);
      setMatrixStatus('Connection failed');
      notify(error instanceof Error ? error.message : 'Could not connect to the encrypted room.');
    } finally {
      matrixConnecting.current = false;
    }
  }
  function sendText(text = draft) {
    const content = text.trim();
    if (!content) return;
    appendOutgoing({ mode, kind: 'text', text: content, reply: reply?.text });
    setDraft('');
    setReply(null);
  }
  function reactToMessage(message: Message) {
    if (matrixClient.current) {
      if (!message.remoteEventId) {
        notify('This message does not have a Matrix event ID to react to.');
        return;
      }
      if (message.reaction === '❤️') {
        notify('A heart reaction is already on this message.');
        return;
      }
      appendOutgoing({ mode: message.mode, kind: 'reaction', text: '❤️', reactionTo: message.remoteEventId });
      return;
    }
    updateMessages((items) => items.map((item) => item.id === message.id ? { ...item, reaction: item.reaction ? undefined : '❤️' } : item));
  }
  function changeMode(next: Mode) {
    if (mode === 'kinky' && next !== 'kinky') {
      setExitMode(next);
      return;
    }
    setMode(next);
  }
  function confirmExit(deleteSession: boolean) {
    if (deleteSession) updateMessages((items) => items.filter((item) => item.mode !== 'kinky'));
    setMode(exitMode ?? 'romantic');
    setExitMode(null);
    setDeleteAdult(false);
  }
  function addSticker(sticker: string) {
    appendOutgoing({ mode, kind: 'sticker', text: sticker });
    setData((current) => ({ ...current, recent: [sticker, ...current.recent.filter((item) => item !== sticker)].slice(0, 12) }));
    setPanel(null);
  }
  function toggleFavourite(sticker: string) {
    setData((current) => ({
      ...current,
      favourites: current.favourites.includes(sticker) ? current.favourites.filter((item) => item !== sticker) : [...current.favourites, sticker],
    }));
  }
  async function useCustomSticker(sticker: CustomSticker) {
    if (matrixClient.current) {
      try {
        const response = await fetch(sticker.dataUrl);
        if (!response.ok) throw new Error('Could not read the imported sticker.');
        const file = new File([await response.blob()], `${sticker.name}.sticker`, { type: sticker.type ?? 'image/png' });
        if (!sendEncryptedAttachment(file, 'sticker', sticker.name, mode)) return;
      } catch {
        notify('This custom sticker could not be prepared for encrypted sending.');
        return;
      }
    } else {
      addMessage({ mode, sender: 'me', kind: 'sticker', text: sticker.name, image: sticker.dataUrl });
      notify('Sticker saved locally only — no encrypted room is connected.');
    }
    setData((current) => ({
      ...current,
      recentCustomStickerIds: [sticker.id, ...current.recentCustomStickerIds.filter((id) => id !== sticker.id)].slice(0, 12),
    }));
    setPanel(null);
  }
  function toggleCustomStickerFavourite(stickerId: string) {
    setData((current) => ({
      ...current,
      favoriteCustomStickerIds: current.favoriteCustomStickerIds.includes(stickerId)
        ? current.favoriteCustomStickerIds.filter((id) => id !== stickerId)
        : [...current.favoriteCustomStickerIds, stickerId],
    }));
  }
  function onFile(file?: File) {
    if (!file) {
      setStickerImportRequested(false);
      return;
    }
    if (stickerImportRequested) {
      setStickerImportRequested(false);
      const packName = normalizeStickerPackName(customPackName);
      const storedCharacters = data.customStickerPacks.reduce(
        (total, pack) => total + pack.stickers.reduce((packTotal, sticker) => packTotal + sticker.dataUrl.length, 0),
        0,
      );
      const importError = getStickerImportError(file, storedCharacters, packName);
      if (importError) {
        notify(importError);
        return;
      }
      void encodeStickerFile(file).then((dataUrl) => {
        const existingPack = data.customStickerPacks.find(
          (pack) => pack.adult === (packTab === 'adult') && pack.name.toLocaleLowerCase() === packName.toLocaleLowerCase(),
        );
        const packId = existingPack?.id ?? makeId();
        const stickerName = file.name.replace(/\.[^.]+$/, '') || 'Sticker';
        const sticker = { id: makeId(), name: stickerName, dataUrl, type: file.type.toLowerCase() };
        setData((current) => {
          const currentPack = current.customStickerPacks.find((pack) => pack.id === packId);
          const customStickerPacks = currentPack
            ? current.customStickerPacks.map((pack) => pack.id === packId ? { ...pack, stickers: [...pack.stickers, sticker] } : pack)
            : [...current.customStickerPacks, { id: packId, name: packName, adult: packTab === 'adult', stickers: [sticker] }];
          return { ...current, customStickerPacks };
        });
        setSelectedPack(`custom:${packId}`);
        notify('Sticker saved in a device-local pack. It is not uploaded or end-to-end encrypted.');
      }).catch((error: unknown) => {
        console.error('Could not read the selected sticker file.', error);
        notify('Could not read this sticker file.');
      });
      return;
    }
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      notify('Choose an image or video file.');
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview({ url, name: file.name, type: file.type, file });
  }
  function deleteSelectedStickerPack() {
    if (!selectedCustomPack) return;
    if (!window.confirm(`Delete “${selectedCustomPack.name}” and its stickers from this device?`)) return;
    setData((current) => ({
      ...current,
      customStickerPacks: current.customStickerPacks.filter((pack) => pack.id !== selectedCustomPack.id),
    }));
    setSelectedPack(packTab === 'adult' ? adultPacks[0] : everydayPacks[0]);
    notify('Sticker pack deleted from this device.');
  }
  function createStickerPack() {
    const name = normalizeStickerPackName(customPackName);
    const nameError = getStickerPackNameError(name, visibleCustomPacks.map((pack) => pack.name));
    if (nameError) {
      notify(nameError);
      return;
    }
    const id = makeId();
    setData((current) => ({
      ...current,
      customStickerPacks: [...current.customStickerPacks, { id, name, adult: packTab === 'adult', stickers: [] }],
    }));
    setSelectedPack(`custom:${id}`);
    notify('Empty sticker pack created on this device.');
  }
  function renameSelectedStickerPack() {
    if (!selectedCustomPack) return;
    const name = normalizeStickerPackName(customPackName);
    const nameError = getStickerPackNameError(
      name,
      visibleCustomPacks.filter((pack) => pack.id !== selectedCustomPack.id).map((pack) => pack.name),
    );
    if (nameError) {
      notify(nameError);
      return;
    }
    setData((current) => ({
      ...current,
      customStickerPacks: current.customStickerPacks.map((pack) =>
        pack.id === selectedCustomPack.id ? { ...pack, name } : pack,
      ),
    }));
    notify('Sticker pack renamed on this device.');
  }
  function switchStickerCollection() {
    const nextTab = packTab === 'everyday' ? 'adult' : 'everyday';
    setPackTab(nextTab);
    setSelectedPack(nextTab === 'adult' ? adultPacks[0] : everydayPacks[0]);
  }
  function sendMedia() {
    if (!preview) return;
    const selectedPreview = preview;
    const sender = matrixClient.current;
    if (sender && viewOnceSeconds !== 'Off') {
      notify('Encrypted one-view media is not available yet. Turn the timer off to send this media.');
      return;
    }
    if (sender && !selectedPreview.file) {
      notify('Select the original photo or video file again before sending.');
      return;
    }
    if (selectedPreview.file && sendEncryptedAttachment(selectedPreview.file, 'media', selectedPreview.name, mode, selectedPreview.url)) {
      setPreview(null);
      setViewOnceSeconds('Off');
      setPanel(null);
      return;
    }
    const expiresAt = viewOnceSeconds === 'Off' ? undefined : Date.now() + Number(viewOnceSeconds) * 1000;
    addMessage({
      mode, sender: 'me', kind: 'media', text: preview.name, image: preview.url,
      mediaType: preview.type,
      expiresAt, viewSeconds: viewOnceSeconds === 'Off' ? undefined : Number(viewOnceSeconds),
    });
    setPreview(null);
    setViewOnceSeconds('Off');
    setPanel(null);
    if (!sender) notify('Saved locally only — no encrypted room is connected.');
  }
  function sendMood(label: string, emoji: string) {
    setMoodCard({ label, emoji });
    appendOutgoing({ mode, kind: 'mood', text: `${emoji} ${label}` });
    setPanel(null);
    notify('Mood saved to this device. Push delivery is not connected yet.');
  }
  async function toggleVoiceRecording() {
    if (recorder.current?.state === 'recording') {
      recorder.current.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      notify('Voice recording is not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const voiceRecorder = new MediaRecorder(stream);
      recorder.current = voiceRecorder;
      const chunks: Blob[] = [];
      voiceRecorder.addEventListener('dataavailable', (event) => {
        if (event.data.size) chunks.push(event.data);
      });
      voiceRecorder.addEventListener('stop', () => {
        const voiceNote = new Blob(chunks, { type: voiceRecorder.mimeType || 'audio/webm' });
        const file = new File([voiceNote], `voice-note.${voiceNote.type.includes('ogg') ? 'ogg' : 'webm'}`, { type: voiceNote.type });
        setPreview({ url: URL.createObjectURL(voiceNote), name: 'Voice note', type: voiceNote.type, file });
        stream.getTracks().forEach((track) => track.stop());
        recorder.current = null;
        notify('Voice note ready to preview. Tap send to continue.');
      }, { once: true });
      voiceRecorder.start();
      notify('Recording… tap the microphone again to finish.');
    } catch (error) {
      console.error('Could not access the microphone.', error);
      notify('Microphone access was not available.');
    }
  }
  function unlockOrSetup() {
    void (async () => {
      if (!data.pinHash) {
        if (!/^\d{6}$/.test(pinSetup)) { setPinError('Choose a six-digit PIN.'); return; }
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const digest = await hashPin(pinSetup, salt);
        setData((current) => ({ ...current, pinSalt: encode(salt), pinHash: digest, roomReady: true }));
        setPinSetup('');
        setPinError('');
        setLocked(false);
        notify('Private room created on this device only.');
        return;
      }
      if (!/^\d{6}$/.test(pinValue)) { setPinError('Enter your six-digit PIN.'); return; }
      const digest = await hashPin(pinValue, decode(data.pinSalt!));
      if (digest === data.pinHash) {
        setPinValue('');
        setPinError('');
        setLocked(false);
      } else {
        setPinValue('');
        setPinError('That PIN did not match.');
      }
    })().catch(() => setPinError('Could not verify the PIN in this browser.'));
  }
  async function unlockWithBiometrics() {
    try {
      const availability = await BiometricAuth.checkBiometry();
      if (!availability.isAvailable && !availability.strongBiometryIsAvailable) {
        notify('No enrolled biometric is available. Use this device’s PIN instead.');
        return;
      }
      await BiometricAuth.authenticate({
        reason: 'Unlock your private NYMPH room.',
        allowDeviceCredential: true,
        androidTitle: 'Unlock NYMPH',
        androidSubtitle: 'Private room',
      });
      setPinError('');
      setLocked(false);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Biometric unlock did not complete.');
    }
  }
  function setupRoom(joining: boolean) {
    setPairingRole(joining ? 'partner-b' : 'partner-a');
    setRoomIntent(true);
  }

  if (!data.roomReady || locked) {
    return (
      <div className="lock-page">
        <div className="lock-orb" />
        <section className="lock-card">
          <div className="brand-lock"><span className="brand-symbol">n</span><span className="eyebrow">YOUR PRIVATE ROOM</span></div>
          <h1>{data.roomReady ? 'Welcome back.' : 'Just the two of you.'}</h1>
          <p className="muted">{data.roomReady ? 'Unlock your room on this device.' : 'A private place for your little world.'}</p>
          {!data.roomReady && <div className="room-actions"><button className="primary" onClick={() => setupRoom(false)}>Create our private room <span>♡</span></button><button className="secondary" onClick={() => setupRoom(true)}>Join our private room <span>↗</span></button></div>}
          <label className="field-label" htmlFor="pin">{data.pinHash ? 'Six-digit device PIN' : 'Create a six-digit device PIN'}</label>
          <input id="pin" inputMode="numeric" autoComplete="one-time-code" maxLength={6} type="password" value={data.pinHash ? pinValue : pinSetup} onChange={(event) => data.pinHash ? setPinValue(event.target.value.replace(/\D/g, '')) : setPinSetup(event.target.value.replace(/\D/g, ''))} onKeyDown={(event) => event.key === 'Enter' && unlockOrSetup()} placeholder="••••••" className="pin-input" />
          {pinError && <p className="form-error">{pinError}</p>}
          <button className="primary unlock-button" disabled={!data.roomReady && !roomIntent} onClick={unlockOrSetup}>{data.pinHash ? 'Unlock room' : 'Set PIN & enter'}</button>
          {Capacitor.isNativePlatform() && data.pinHash && <button className="secondary full-button" onClick={() => void unlockWithBiometrics()}>Unlock with biometrics</button>}
          <p className="privacy-note">{data.pinHash ? 'The device PIN is for this local app lock. Android Matrix credentials and crypto-store keys are held separately in Android Keystore-protected storage.' : 'Choose a six-digit PIN for this local app lock. Android Matrix storage uses a separate Keystore-protected key.'}</p>
        </section>
      </div>
    );
  }

  return (
    <div className={`app mode-${mode}`}>
      <aside className="rail">
        <button className="rail-brand" aria-label="NYMPH home" onClick={() => { setPanel(null); setMode('romantic'); }}>n</button>
        <div className="rail-links">
          <button className="rail-button active" aria-label="Chat" onClick={() => setPanel(null)}>◌</button>
          <button className="rail-button" aria-label="Gallery" onClick={() => setPanel('gallery')}>▧</button>
          <button className="rail-button" aria-label="Settings" onClick={() => setPanel('settings')}>⚙</button>
        </div>
        <button className="rail-avatar" aria-label="Edit profile" onClick={() => { setProfileDraft(data.profile); setPanel('profile'); }}>{data.profile.avatar}</button>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="top-brand"><span className="brand-symbol">n</span><div><div className="eyebrow">A PRIVATE ROOM FOR TWO</div><div className="brand-name">NYMPH</div></div></div>
          <div className="top-actions">
            <span className="secure-label"><i className={matrixClient.current ? 'connected' : ''} /> {matrixClient.current ? matrixSecurity?.partnerVerified ? 'Verified encrypted' : 'Encrypted · verify first' : 'Local demo'}</span>
            <button className="icon-button" aria-label="Lock app" onClick={() => setLocked(true)}>⌑</button>
          </div>
        </header>
        <div className="main-grid">
          <section className="conversation">
            <header className="chat-header">
              <div className="partner">
                <div className="partner-avatar">{data.partnerName.slice(0, 1).toUpperCase()}<i /></div>
                <div><div className="partner-name">{data.partnerName}</div><div className="partner-status">here in your room</div></div>
              </div>
              <div className="header-actions">
                <span className={`active-mode-label ${mode}`}>{activeMode.icon} {activeMode.label}</span>
                <button className="icon-button" aria-label="Open gallery" onClick={() => setPanel('gallery')}>▧</button>
                <button className="icon-button" aria-label="Open profile" onClick={() => { setProfileDraft(data.profile); setPanel('profile'); }}>◉</button>
              </div>
            </header>
            <div className="mode-tabs" role="tablist" aria-label="Conversation modes">
              {modes.map((item) => <button key={item.id} role="tab" aria-selected={mode === item.id} className={`mode-tab ${mode === item.id ? 'selected' : ''} ${item.id}`} onClick={() => changeMode(item.id)}><span>{item.icon}</span><b>{item.label}</b></button>)}
            </div>
            <div className="mode-note"><span className={`mode-orbit ${mode}`}><i>{activeMode.icon}</i></span><div><strong>{activeMode.subtitle}</strong><span>{mode === 'kinky' ? 'Adults only · separate private timeline' : `${activeMode.label} · only messages from this mode`}</span></div><button className="tiny-action" onClick={() => setPanel('settings')}>Details</button></div>
            <div className="timeline" ref={chatRef} key={mode}>
              <div className="date-divider"><span>Today · just for us</span></div>
              {visibleMessages.length === 0 && <div className="empty-state"><div className="empty-icon">{activeMode.icon}</div><h2>A little room for this mood.</h2><p>Start your {activeMode.label.toLowerCase()} conversation. It stays separate from the other modes.</p><button className="quiet-button" onClick={() => setDraft(mode === 'kinky' ? 'I want to explore something with you…' : 'Thinking of you…')}>Write the first note</button></div>}
              {visibleMessages.map((message) => <article key={message.id} className={`message-row ${message.sender === 'me' ? 'mine' : ''}`}>
                {message.sender === 'partner' && <div className="message-avatar">{data.partnerName.slice(0, 1).toUpperCase()}</div>}
                <div className={`bubble ${message.sender === 'me' ? 'mine' : ''} ${message.kind}`}>
                  {message.reply && <div className="reply-quote">{message.reply}</div>}
                  {message.kind === 'media' ? message.image ? message.mediaType?.startsWith('audio/') ? <div className="voice-note"><span>♫</span><audio controls src={message.image} aria-label="Voice note" /></div> : <button className={`sent-media ${message.viewSeconds && !message.opened ? 'sealed' : ''}`} onClick={() => { if (message.expiresAt && message.expiresAt <= Date.now()) return; if (message.viewSeconds && !message.opened) { const expiresAt = Date.now() + message.viewSeconds * 1000; updateMessages((items) => items.map((item) => item.id === message.id ? { ...item, opened: true, expiresAt } : item)); window.setTimeout(() => { updateMessages((items) => items.filter((item) => item.id !== message.id)); setPreview((current) => current?.url === message.image ? null : current); URL.revokeObjectURL(message.image!); }, message.viewSeconds * 1000); } setPreview({ url: message.image!, name: message.text, type: message.mediaType ?? 'image/*' }); }}>{message.viewSeconds && !message.opened ? <div className="sealed-media"><span>♧</span><strong>Sealed just for you</strong><small>Tap to open · {message.viewSeconds}s</small></div> : message.mediaType?.startsWith('video/') ? <video src={message.image} /> : <img src={message.image} alt="Shared privately" />}{message.viewSeconds && message.opened && <span>VIEW ONCE · {message.viewSeconds}s</span>}</button> : <div className="media-transfer-state" role="status">{message.mediaError ?? (message.delivery === 'sending' ? 'Encrypting and sending…' : 'Encrypted media is loading…')}</div> : message.kind === 'sticker' ? message.image ? <img className="sticker-image" src={message.image} alt={message.text} /> : message.encryptedAttachment ? <div className="media-transfer-state" role="status">Decrypting personal sticker…</div> : <div className="sticker-message">{message.text}</div> : message.kind === 'mood' ? <div className="mood-message"><span>{message.text.split(' ')[0]}</span><div><small>MOOD PING</small><strong>{message.text.substring(message.text.indexOf(' ') + 1)}</strong></div></div> : <div className="bubble-text">{message.text}</div>}
                  <div className="bubble-meta"><time>{formatTime(message.time)}</time>{message.sender === 'me' && <span>{message.delivery === 'failed' ? '!' : message.delivery === 'sending' ? '…' : message.delivery === 'read' ? '✓✓' : '✓'}</span>}{message.reaction && <b className="reaction">{message.reaction}</b>}</div>
                </div>
                <div className="message-tools"><button aria-label="Reply" onClick={() => { setReply(message); document.querySelector<HTMLTextAreaElement>('#message-input')?.focus(); }}>↩</button><button className={message.reaction === '❤️' ? 'is-reacted' : ''} aria-label={message.reaction === '❤️' ? 'Heart reaction added' : 'React with heart'} aria-pressed={message.reaction === '❤️'} onClick={() => reactToMessage(message)}>{message.reaction === '❤️' ? '♥' : '♡'}</button></div>
              </article>)}
              {partnerTyping && <div className="typing-indicator"><span>{data.partnerName} is writing</span><i /><i /><i /></div>}
            </div>
            <div className="composer-wrap">
              {reply && <div className="reply-bar"><span>Replying to <b>{reply.sender === 'me' ? 'your note' : data.partnerName}</b><small>{reply.text}</small></span><button aria-label="Cancel reply" onClick={() => setReply(null)}>×</button></div>}
              <div className="composer">
                <div className="composer-tools">
                  <button className={`tool-button ${recorder.current?.state === 'recording' ? 'recording' : ''}`} title={recorder.current?.state === 'recording' ? 'Stop voice recording' : 'Record voice note'} onClick={() => void toggleVoiceRecording()}>{recorder.current?.state === 'recording' ? '■' : '♫'}</button>
                  <button className="tool-button" title="Stickers and GIFs" onClick={() => setPanel(panel === 'stickers' ? null : 'stickers')}>✧</button>
                  <button className="tool-button" title="Send a mood" onClick={() => setPanel('mood')}>♡</button>
                  <button className="tool-button" title="Attach photo or video" onClick={() => fileInput.current?.click()}>＋</button>
                  <input ref={fileInput} className="visually-hidden" type="file" accept="image/*,video/*,.gif" onChange={(event) => { onFile(event.target.files?.[0]); event.currentTarget.value = ''; }} />
                </div>
                <textarea id="message-input" rows={1} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendText(); } }} placeholder={mode === 'kinky' ? 'Only for this private mode…' : 'Write something just for them…'} />
                <button className="send-button" onClick={() => sendText()} aria-label="Send message">↑</button>
              </div>
              <div className="composer-foot"><span>Private mode · <b>{activeMode.label}</b></span><button onClick={() => setPanel('mood')}>How are you feeling? <b>♡</b></button><button onClick={() => setPanel('stickers')}>Stickers & GIFs <b>↗</b></button></div>
            </div>
          </section>
          <aside className="side-column">
            <div className="side-card couple-card"><div className="eyebrow">YOUR LITTLE WORLD</div><div className="couple-avatars"><span>{data.profile.avatar}</span><i>♡</i><span>{data.partnerName.slice(0, 1).toUpperCase()}</span></div><h2>{data.profile.displayName} <em>&</em> {data.partnerName}</h2><p>One room. Two hearts.</p><button onClick={() => { setProfileDraft(data.profile); setPanel('profile'); }}>Edit your profile <span>↗</span></button></div>
            <div className="side-card mood-shortcut"><div className="side-card-head"><div><div className="eyebrow">A LITTLE SIGNAL</div><h3>Send a mood</h3></div><span className="mood-heart">♡</span></div><p>Let them know what’s on your mind, without finding the words.</p><button className="mood-launch" onClick={() => setPanel('mood')}>How are you feeling right now? <b>→</b></button></div>
            <div className="side-card privacy-card"><div className="side-card-head"><div><div className="eyebrow">YOUR BOUNDARIES</div><h3>Privacy & rhythm</h3></div><button className="small-link" onClick={() => setPanel('settings')}>Manage</button></div><div className="setting-line"><span><i className="privacy-dot" /> Messages stay for</span><strong>{data.retention}</strong></div><div className="setting-line"><span><i className="privacy-dot blush" /> View once media</span><strong>{viewOnceSeconds === 'Off' ? 'Off' : `${viewOnceSeconds}s`}</strong></div><div className="setting-line"><span><i className="privacy-dot gold" /> Room</span><strong>Just two</strong></div></div>
            <div className="side-card collection-card"><div className="side-card-head"><div><div className="eyebrow">KEPT CLOSE</div><h3>Private gallery</h3></div><button className="small-link" onClick={() => setPanel('gallery')}>View all ↗</button></div><div className="gallery-teaser">{data.messages.filter((item) => item.kind === 'media' && item.image).slice(-3).map((item) => <img key={item.id} src={item.image} alt="Private media" onClick={() => setPanel('gallery')} />)}{!data.messages.some((item) => item.kind === 'media') && <div className="gallery-empty"><span>✧</span><p>Your favorite moments<br />will live here.</p></div>}</div></div>
            <div className="local-warning"><span>⌑</span><p>{matrixClient.current ? <>Encrypted text is live. <b>Photo, video and voice transfers are not yet encrypted or sent.</b></> : <>This is a <b>local demonstration</b>. Messages stay in this browser and are not sent to your partner.</>}</p></div>
          </aside>
        </div>
        <nav className="mobile-nav"><button className="selected" onClick={() => setPanel(null)}>◌<span>Room</span></button><button onClick={() => setPanel('gallery')}>▧<span>Gallery</span></button><button onClick={() => setPanel('mood')}>♡<span>Mood</span></button><button onClick={() => setPanel('settings')}>⚙<span>Settings</span></button></nav>
      </main>
      {panel === 'stickers' && <div className="sheet-backdrop" onClick={() => setPanel(null)}><section className="sheet sticker-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" /><div className="sheet-title"><div><div className="eyebrow">A LITTLE EXTRA</div><h2>Stickers & more</h2></div><button className="close-button" onClick={() => setPanel(null)}>×</button></div>
        <div className="picker-tabs"><button className={!showGif ? 'active' : ''} onClick={() => setShowGif(false)}>Stickers</button><button className={showGif ? 'active' : ''} onClick={() => setShowGif(true)}>GIFs</button><button onClick={() => { setEmojiTray(!emojiTray); setShowGif(false); }}>Emoji</button><button className="picker-import" onClick={() => { setStickerImportRequested(true); fileInput.current?.click(); }}>Import +</button></div>
        <div className="sticker-pack-manager">
          <div><label htmlFor="custom-sticker-pack-name">Pack name</label><input id="custom-sticker-pack-name" maxLength={32} value={customPackName} onChange={(event) => setCustomPackName(event.target.value)} /></div>
          <button className="secondary" onClick={createStickerPack}>Create pack</button>
          {selectedCustomPack && <button className="secondary" onClick={renameSelectedStickerPack}>Rename</button>}
          <button className="secondary" onClick={() => { setStickerImportRequested(true); fileInput.current?.click(); }}>Add file</button>
          {selectedCustomPack && <button className="text-danger" onClick={deleteSelectedStickerPack}>Delete pack</button>}
          <p>Stored in this browser only. Not uploaded, shared, or end-to-end encrypted.</p>
        </div>
        {showGif ? <div className="gif-empty"><div>✧</div><h3>Your GIF collection, your way.</h3><p>Import GIFs from your device. Nothing is pulled from a public library.</p>{importedGifs.length > 0 && <div className="imported-gif-grid">{importedGifs.map((sticker) => <button key={sticker.id} title={`${sticker.name} · ${sticker.packName}`} onClick={() => useCustomSticker(sticker)}><img src={sticker.dataUrl} alt={sticker.name} /></button>)}</div>}</div> : <>
          <div className="pack-tabs">{packNames.map((pack) => {
            const customPack = visibleCustomPacks.find((item) => `custom:${item.id}` === pack);
            return <button className={selectedPack === pack ? 'active' : ''} key={pack} onClick={() => { setSelectedPack(pack); if (customPack) setCustomPackName(customPack.name); }}>{customPack?.name ?? pack}</button>;
          })}</div>
          <div className="picker-toolbar"><div className="picker-search"><span>⌕</span><input aria-label="Search stickers" placeholder="Search this collection" value={search} onChange={(event) => setSearch(event.target.value)} /></div><button onClick={switchStickerCollection}>{packTab === 'everyday' ? '18+ collection' : 'Everyday collection'}</button></div>
          {emojiTray && <div className="emoji-tray">{'😀 😍 🥰 😘 😉 😏 🥺 🫂 💋 ❤️ 💕 🔥 😈 ✨ 🫶'.split(' ').map((emoji) => <button key={emoji} onClick={() => addSticker(emoji)}>{emoji}</button>)}</div>}
          <div className="sticker-grid">{stickers.map((sticker) => <div key={`${selectedPack}-${sticker}`} className="sticker-cell"><button className="sticker-select" onClick={() => addSticker(sticker)}>{sticker}</button><button className={`favorite-toggle ${data.favourites.includes(sticker) ? 'favorited' : ''}`} aria-label="Favorite sticker" onClick={() => toggleFavourite(sticker)}>{data.favourites.includes(sticker) ? '♥' : '♡'}</button></div>)}{customPackStickers.map((sticker) => <div key={sticker.id} className="sticker-cell"><button className="sticker-select custom-sticker" title={sticker.name} onClick={() => useCustomSticker(sticker)}><img src={sticker.dataUrl} alt={sticker.name} /></button><button className={`favorite-toggle ${data.favoriteCustomStickerIds.includes(sticker.id) ? 'favorited' : ''}`} aria-label={`Favorite ${sticker.name}`} onClick={() => toggleCustomStickerFavourite(sticker.id)}>{data.favoriteCustomStickerIds.includes(sticker.id) ? '♥' : '♡'}</button></div>)}{(selectedCustomPack || selectedPack === 'Favorites' || selectedPack === 'Recent') && customPackStickers.length === 0 && stickers.length === 0 && <p className="sticker-pack-empty">{selectedPack === 'Favorites' ? 'Favorite a sticker to keep it here.' : selectedPack === 'Recent' ? 'Your personal sticker history will appear here.' : 'No matching stickers in this pack yet.'}</p>}</div>
          <div className="sticker-foot"><span>Recently used</span><div>{(data.recent.length ? data.recent : ['♡', '💋', '🥺', '✨']).map((item, index) => <button key={`${item}-${index}`} onClick={() => addSticker(item)}>{item}</button>)}</div></div>
        </>}
        <div className="sticker-sheet-bottom"><button className="adult-toggle" onClick={switchStickerCollection}>{packTab === 'everyday' ? '◉ Everyday' : '◉ Adults only · 18+'}</button><button className="import-link" onClick={() => { setStickerImportRequested(true); fileInput.current?.click(); }}>＋ Import personal stickers / GIFs</button></div>
      </section></div>}
      {panel === 'mood' && <div className="sheet-backdrop" onClick={() => setPanel(null)}><section className="sheet mood-sheet" onClick={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><div className="eyebrow">A QUIET LITTLE SIGNAL</div><h2>How are you feeling right now?</h2></div><button className="close-button" onClick={() => setPanel(null)}>×</button></div><p className="sheet-intro">Choose a mood. Your partner can reply with a note, a reaction, or a mood of their own.</p><div className="mood-grid">{moodOptions.map(([label, emoji]) => <button key={`${label}${emoji}`} className="mood-option" onClick={() => sendMood(label, emoji)}><span>{emoji}</span><b>{label}</b></button>)}</div><div className="custom-mood"><input placeholder="Add your own mood…" value={customMood} onChange={(event) => setCustomMood(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && customMood.trim() && sendMood(customMood.trim(), '♡')} /><button onClick={() => customMood.trim() && sendMood(customMood.trim(), '♡')}>Send mood</button></div><div className="discreet-note">Lock-screen notifications are not configured in this local demo.</div></section></div>}
      {panel === 'profile' && <div className="sheet-backdrop" onClick={() => setPanel(null)}><section className="sheet detail-sheet" onClick={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><div className="eyebrow">YOUR PRIVATE PROFILE</div><h2>A little about you</h2></div><button className="close-button" onClick={() => setPanel(null)}>×</button></div><div className="profile-cover"><div className="profile-avatar-big">{profileDraft.avatar}</div><span>Just between the two of you</span></div><label className="field-label">Display name<input value={profileDraft.displayName} onChange={(event) => setProfileDraft({ ...profileDraft, displayName: event.target.value })} /></label><label className="field-label">Username<input value={profileDraft.username} onChange={(event) => setProfileDraft({ ...profileDraft, username: event.target.value })} /></label><label className="field-label">Bio<textarea value={profileDraft.bio} onChange={(event) => setProfileDraft({ ...profileDraft, bio: event.target.value })} /></label><label className="field-label">Avatar initials<input maxLength={2} value={profileDraft.avatar} onChange={(event) => setProfileDraft({ ...profileDraft, avatar: event.target.value.toUpperCase() })} /></label><div className="partner-info">Paired partner <b>{data.partnerName}</b><span>Private room · two identities</span></div><button className="primary full-button" onClick={() => { setData((current) => ({ ...current, profile: profileDraft })); setPanel(null); notify('Profile saved on this device.'); }}>Save profile</button></section></div>}
      {panel === 'settings' && <div className="sheet-backdrop" onClick={() => setPanel(null)}><section className="sheet detail-sheet" onClick={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><div className="eyebrow">YOUR ROOM, YOUR RULES</div><h2>Privacy & settings</h2></div><button className="close-button" onClick={() => setPanel(null)}>×</button></div><button className="matrix-connect-card" onClick={() => setPanel('matrix')}><span className="matrix-lock">⌑</span><span><b>{matrixClient.current ? 'Encrypted room connected' : 'Connect an encrypted room'}</b><small>{matrixClient.current ? matrixStatus : 'Self-hosted Matrix · Rust-backed E2EE'}</small></span><i>↗</i></button><label className="field-label">Message retention<select value={data.retention} onChange={(event) => setData((current) => ({ ...current, retention: event.target.value }))}>{['Never', '1 hour', '24 hours', '7 days', '30 days', 'Custom'].map((value) => <option key={value}>{value}</option>)}</select></label><div className="setting-control"><div><b>View once media timer</b><span>Local preview only; not secure expiration.</span></div><select value={viewOnceSeconds} onChange={(event) => setViewOnceSeconds(event.target.value)}>{['Off', '5', '10', '15', '30', '60'].map((value) => <option key={value} value={value}>{value === 'Off' ? 'Off' : `${value} seconds`}</option>)}</select></div><div className="setting-control"><div><b>Hide adult timeline when leaving Kinky</b><span>Adult messages stay in their own mode.</span></div><span className="enabled-pill">On</span></div><div className="setting-control"><div><b>Lock on background</b><span>Requires PIN again when you return.</span></div><span className="enabled-pill">On</span></div>      <div className="discreet-note">Screenshot protection, biometric unlock, push notifications, device revocation and server-side retention need native Android integration.</div><button className="secondary full-button" onClick={() => { setPanel(null); setLocked(true); }}>Lock this device now</button><button className="text-danger" onClick={() => { if (window.confirm('Delete all local data for this account from this browser?')) { localStorage.removeItem(stateScope); location.reload(); } }}>Delete local data for this account</button></section></div>}
      {panel === 'gallery' && <div className="sheet-backdrop" onClick={() => setPanel(null)}><section className="sheet gallery-sheet" onClick={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><div className="eyebrow">ONLY YOUR SHARED MOMENTS</div><h2>Private gallery</h2></div><button className="close-button" onClick={() => setPanel(null)}>×</button></div><div className="gallery-tabs">{['All', 'Photos', 'Videos', 'Favourites', 'Expiring'].map((filter) => <button key={filter} className={galleryFilter === filter ? 'active' : ''} onClick={() => setGalleryFilter(filter)}>{filter}</button>)}</div><div className="gallery-grid">{galleryMessages.map((item) => <button key={item.id} className="gallery-item" onClick={() => item.image && setPreview({ url: item.image, name: item.text, type: item.mediaType ?? 'image/*' })}>{item.mediaType?.startsWith('video/') ? <video src={item.image} /> : <img src={item.image} alt="Shared media" />}{item.viewSeconds && <span>VIEW ONCE · {item.viewSeconds}s</span>}</button>)}</div>{galleryMessages.length === 0 && <div className="gallery-empty large"><span>✧</span><h3>Moments, kept close.</h3><p>Photos and videos you share will appear here. Your imports stay on this device in this demo.</p><button className="secondary" onClick={() => fileInput.current?.click()}>Choose a photo or video</button></div>}</section></div>}
      {preview && <div className="viewer-backdrop" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null); }}><div className="viewer" onClick={(event) => event.stopPropagation()}><button className="close-button viewer-close" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null); }}>×</button>{preview.type.startsWith('video/') ? <video src={preview.url} controls autoPlay /> : preview.type.startsWith('audio/') ? <audio className="voice-preview" src={preview.url} controls autoPlay /> : <img src={preview.url} alt="Media preview" />}<div className="viewer-footer"><span>{preview.name}</span><label>View once<select value={viewOnceSeconds} disabled={Boolean(matrixClient.current)} onChange={(event) => setViewOnceSeconds(event.target.value)}>{['Off', '5', '10', '15', '30', '60'].map((value) => <option key={value}>{value === 'Off' ? 'Off' : `${value} seconds`}</option>)}</select></label><button className="primary" onClick={sendMedia}>Send privately ↗</button><button className="secondary" onClick={() => { URL.revokeObjectURL(preview.url); setPreview(null); }}>Cancel</button></div></div></div>}
      {exitMode && <div className="dialog-backdrop"><section className="dialog"><div className="dialog-symbol">♠</div><div className="eyebrow">LEAVING KINKY · 18+</div><h2>Back to your other room?</h2><p>Your adult conversation will be hidden from the normal timeline. It will still be here when you return.</p><label className="delete-option"><input type="checkbox" checked={deleteAdult} onChange={(event) => setDeleteAdult(event.target.checked)} /><span><b>Permanently delete this mode’s local messages</b><small>This is local demo data only. Remote media/key deletion is not available here.</small></span></label><div className="dialog-actions"><button className="secondary" onClick={() => setExitMode(null)}>Stay here</button><button className="primary" onClick={() => confirmExit(deleteAdult)}>Leave mode</button></div></section></div>}
      {panel === 'matrix' && <div className="sheet-backdrop" onClick={() => setPanel(null)}>
        <section className="sheet detail-sheet matrix-sheet" onClick={(event) => event.stopPropagation()}>
          <div className="sheet-handle" />
          <div className="sheet-title"><div><div className="eyebrow">PRIVATE MESSAGE RELAY</div><h2>Encrypted room</h2></div><button className="close-button" onClick={() => setPanel(null)}>×</button></div>
          <div className={`matrix-status ${matrixClient.current ? 'online' : ''}`}><i />{matrixStatus}<small> · {matrixSync}</small></div>
          <p className="matrix-explainer">Partner 1 signs in once; Partner 2 joins only by scanning the short-lived QR. The local development policy is designed for one active device per partner; replacement revokes the old device before encrypted sync starts. Android saves the Matrix session and an encrypted-store key in Keystore-protected storage. Browser sessions remain memory-only. Sending requires cross-signing trust.</p>
          <label className="field-label">Homeserver URL<input autoComplete="url" placeholder="https://matrix.example.com" value={matrixConnection.homeserver} onChange={(event) => setMatrixConnection({ ...matrixConnection, homeserver: event.target.value })} /></label>
          {matrixConnection.userId === PARTNER_IDENTITIES.partnerB && matrixConnection.accessToken
            ? <button className="primary full-button" onClick={() => void connectPrivateRoom()}>{matrixClient.current ? 'Disconnect encrypted room' : 'Reconnect this paired device'}</button>
            : <>
              <label className="field-label">Partner 1 password<input type="password" autoComplete="current-password" value={matrixPassword} onChange={(event) => setMatrixPassword(event.target.value)} /></label>
              <div className="discreet-note">This local development sign-in creates a device session for the already-provisioned Partner 1 account. No registration or public login is available. The password is not stored or included in the pairing QR.</div>
              <button className="primary full-button" onClick={() => void connectPrivateRoom()}>{matrixClient.current ? 'Disconnect encrypted room' : 'Sign in as Partner 1'}</button>
            </>}
          <div className="pairing-actions">
            <button className="secondary" disabled={!matrixClient.current || matrixConnection.userId !== PARTNER_IDENTITIES.partnerA} onClick={() => { setPairingRole('partner-a'); setPanel(null); }}>Create partner QR</button>
            <button className="secondary" onClick={() => { setPairingRole('partner-b'); setPanel(null); }}>Scan partner QR</button>
            <button
              className="secondary"
              disabled={!matrixClient.current || ![PARTNER_IDENTITIES.partnerA, PARTNER_IDENTITIES.partnerB].includes(matrixConnection.userId)}
              onClick={() => { setPairingRole('replace-device'); setPanel(null); }}
            >Authorize device replacement</button>
          </div>
          <Suspense fallback={<div className="matrix-panel-loading" role="status">Loading security controls…</div>}>
            <MatrixSecurityPanel
              client={matrixClient.current}
              security={matrixSecurity}
              verification={matrixVerification}
              onRefresh={() => {
                void matrixClient.current?.getSecurityState().then(setMatrixSecurity).catch((error: unknown) => notify(error instanceof Error ? error.message : 'Could not refresh device trust.'));
              }}
              onNotify={notify}
            />
          </Suspense>
          <button className="secondary full-button" onClick={() => setPanel('settings')}>Back to settings</button>
        </section>
      </div>}
      {pairingRole && <Suspense fallback={<div className="dialog-backdrop"><section className="dialog matrix-panel-loading" role="status">Loading secure pairing…</section></div>}><PairingPanel
        role={pairingRole}
        credentials={matrixConnection}
        client={matrixClient.current}
        onEnrolled={(connection) => {
          setReplacementActivationPending(false);
          setPairingRole(null);
          void connectPrivateRoom(connection);
        }}
        onActivationPending={setReplacementActivationPending}
        onClose={() => {
          if (!replacementActivationPending) setPairingRole(null);
        }}
      /></Suspense>}
      {toast && <div className="toast"><span>♡</span>{toast}</div>}
      {moodCard && <div className="dialog-backdrop" onClick={() => setMoodCard(null)}><section className="mood-received-card" onClick={(event) => event.stopPropagation()}><button className="close-button" onClick={() => setMoodCard(null)}>×</button><div className="mood-received-emoji">{moodCard.emoji}</div><div className="eyebrow">A LITTLE SIGNAL FROM YOU</div><h2>{moodCard.label}</h2><p>Your mood is saved in this device’s private room. A real partner notification needs the messaging backend.</p><div className="mood-reply-actions"><button className="secondary" onClick={() => { const latestMood = [...data.messages].reverse().find((item) => item.kind === 'mood' && item.text === `${moodCard.emoji} ${moodCard.label}`); if (latestMood) updateMessages((items) => items.map((item) => item.id === latestMood.id ? { ...item, reaction: '❤️' } : item)); setMoodCard(null); notify('Heart reaction added locally.'); }}>React ❤️</button><button className="secondary" onClick={() => { setMoodCard(null); setPanel('mood'); }}>Reply with a mood</button><button className="primary" onClick={() => { setMoodCard(null); setPanel(null); }}>Open chat</button></div></section></div>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
