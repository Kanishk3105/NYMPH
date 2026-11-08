import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import { StatusBar, Style } from '@capacitor/status-bar';
import type { EncryptedFile } from 'matrix-js-sdk/lib/@types/media';
import { Preset, Visibility } from 'matrix-js-sdk/lib/@types/partials';
import type { MatrixConnection, MatrixMessagingClient, MatrixSecurityState, MatrixVerification, NymphEnvelope, ReceivedNymphEvent, StickerSync } from './matrix/MessagingClient';
import { getDefaultHomeserver } from './matrix/homeserver';
import { PARTNER_DEVICE_IDS, PARTNER_IDENTITIES } from './matrix/partner-identity';
import { DEMO_STATE_STORAGE_KEY, getMatrixDeviceStorageKey, getNymphStateStorageKey, readJsonState, writeJsonState } from './matrix/state-storage';
import { createMediaThumbnail } from './matrix/media-thumbnail';
import { getMatrixCryptoStorageKey, loadMatrixSession, removeMatrixSession, saveMatrixSession } from './native/secureSession';
import {
  MOOD_NOTIFICATION_DELIVERED_KEY,
  normalizeMoodNotificationPreferences,
  moodNotificationStorageKey,
  readDeliveredMoodEventIds,
  readMoodNotificationPreferences,
  recordDeliveredMoodEvent,
  shouldNotifyForMood,
  type MoodNotificationPreferences,
} from './notifications/mood-notifications';
import {
  deliverPrivateMoodNotification,
  getMoodNotificationPermission,
  requestMoodNotificationPermission,
} from './notifications/mood-notification-delivery';
import { encodeStickerFile, getStickerImportError, getStickerPackNameError, getStickerSyncMode, normalizeStickerPackName } from './sticker-library';
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
  replyToEventId?: string;
  reaction?: string;
  reactionEventId?: string;
  image?: string;
  thumbnailUrl?: string;
  mediaType?: string;
  durationMs?: number;
  waveform?: number[];
  transferProgress?: number;
  expiresAt?: number;
  pendingExpiresAt?: number;
  viewSeconds?: number;
  opened?: boolean;
  viewOnceSeconds?: number;
  transport?: 'local' | 'matrix';
  delivery?: 'sending' | 'sent' | 'read' | 'failed';
  remoteEventId?: string;
  reactionTo?: string;
  encryptedAttachment?: EncryptedFile;
  encryptedThumbnailAttachment?: EncryptedFile;
  mediaError?: string;
};
type Profile = { displayName: string; username: string; bio: string; avatar: string };
type CustomSticker = { id: string; name: string; dataUrl: string; type?: string };
type CustomStickerPack = { id: string; name: string; adult: boolean; description?: string; categories?: string[]; coverStickerId?: string; stickers: CustomSticker[] };
type LocalState = {
  messages: Message[];
  profile: Profile;
  partnerName: string;
  retention: string;
  retentionSeconds: number | null;
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
const moodOptions: [string, string][] = [
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
  retentionSeconds: 86_400,
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
    const parsed = readJsonState<Partial<LocalState>>(localStorage, storageKey);
    if (!parsed) return useDemoMessages ? defaultState : { ...defaultState, messages: [] };
    const savedRetentionSeconds = parsed.retentionSeconds !== undefined
      ? parsed.retentionSeconds
      : parsed.retention === 'Never' ? null
        : parsed.retention === '1 hour' ? 3_600
          : parsed.retention === '7 days' ? 604_800
            : parsed.retention === '30 days' ? 2_592_000
              : 86_400;
    return {
      ...defaultState,
      ...parsed,
      retentionSeconds: savedRetentionSeconds,
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

function formatDuration(durationMs?: number): string {
  const totalSeconds = Math.max(0, Math.floor((durationMs ?? 0) / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

async function createAudioWaveform(blob: Blob): Promise<number[]> {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    const samples = audio.getChannelData(0);
    const bucketCount = 28;
    const peaks = Array.from({ length: bucketCount }, (_, bucket) => {
      const start = Math.floor(bucket * samples.length / bucketCount);
      const end = Math.max(start + 1, Math.floor((bucket + 1) * samples.length / bucketCount));
      let sum = 0;
      for (let index = start; index < Math.min(end, samples.length); index += 1) sum += samples[index] ** 2;
      return Math.sqrt(sum / Math.max(1, end - start));
    });
    const maxPeak = Math.max(...peaks, 0.001);
    return peaks.map((peak) => Math.max(0.08, Math.min(1, peak / maxPeak)));
  } finally {
    await context.close();
  }
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
  const messagesRef = useRef(data.messages);
  messagesRef.current = data.messages;
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
  const [customPackDescription, setCustomPackDescription] = useState('');
  const [customPackCategories, setCustomPackCategories] = useState('');
  const [stickerSyncProgress, setStickerSyncProgress] = useState<number | null>(null);
  const [showGif, setShowGif] = useState(false);
  const [viewOnceSeconds, setViewOnceSeconds] = useState('Off');
  const [customViewOnceSeconds, setCustomViewOnceSeconds] = useState('10');
  const [customRetentionSeconds, setCustomRetentionSeconds] = useState(String(data.retentionSeconds ?? 86_400));
  const [clockNow, setClockNow] = useState(Date.now());
  const [preview, setPreview] = useState<{ url: string; name: string; type: string; file?: File; durationMs?: number; waveform?: number[] } | null>(null);
  const [preparingMedia, setPreparingMedia] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordingPaused, setRecordingPaused] = useState(false);
  const [moodCard, setMoodCard] = useState<{ label: string; emoji: string; messageId?: string; eventId?: string } | null>(null);
  const [stickerImportRequested, setStickerImportRequested] = useState(false);
  const [galleryFilter, setGalleryFilter] = useState('All');
  const [customMood, setCustomMood] = useState('');
  const [customMoodEmoji, setCustomMoodEmoji] = useState('♡');
  const [moodNotificationPreferences, setMoodNotificationPreferences] = useState<MoodNotificationPreferences>(
    () => readMoodNotificationPreferences(
      localStorage,
      moodNotificationStorageKey(DEMO_STATE_STORAGE_KEY),
    ),
  );
  const [moodNotificationPermission, setMoodNotificationPermission] = useState<NotificationPermission | 'unsupported' | 'unknown'>('unknown');
  const [profileDraft, setProfileDraft] = useState(data.profile);
  const [deleteAdult, setDeleteAdult] = useState(false);
  const [exitMode, setExitMode] = useState<Mode | null>(null);
  const [emojiTray, setEmojiTray] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const chatRef = useRef<HTMLDivElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recordingStream = useRef<MediaStream | null>(null);
  const recordingCancelled = useRef(false);
  const recordingElapsed = useRef(0);
  const recordingStartedAt = useRef(0);
  const matrixClient = useRef<MatrixMessagingClient | null>(null);
  const matrixConnecting = useRef(false);
  const appIsActive = useRef(true);
  const mediaPreparing = useRef(false);
  const typingTimer = useRef<number | undefined>(undefined);
  const pendingMatrixMedia = useRef<ReceivedNymphEvent[]>([]);
  const pendingStickerSync = useRef<ReceivedNymphEvent[]>([]);
  const downloadingMatrixMedia = useRef(new Set<string>());
  const mediaDownloadControllers = useRef(new Map<string, AbortController>());
  const mediaObjectUrls = useRef(new Set<string>());
  const deliveringMoodNotifications = useRef(new Set<string>());
  const mediaTransfers = useRef(new Map<string, {
    file: File;
    thumbnail?: File;
    envelope: NymphEnvelope;
    imageUrl: string;
    controller?: AbortController;
  }>());

  useEffect(() => {
    try {
      const persistent = {
      ...data,
      messages: data.messages.filter((message) => message.transport !== 'matrix' && message.kind !== 'media' && !(message.kind === 'sticker' && message.image)),
      };
      writeJsonState(localStorage, stateScope, persistent);
    } catch (error) {
      console.error('Could not save NYMPH demo state on this device.', error);
      setToast('Could not save local changes. Device storage may be full.');
    }
  }, [data, stateScope]);
  useEffect(() => () => {
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
    recordingStream.current?.getTracks().forEach((track) => track.stop());
    for (const transfer of mediaTransfers.current.values()) transfer.controller?.abort();
    mediaTransfers.current.clear();
    for (const controller of mediaDownloadControllers.current.values()) controller.abort();
    mediaDownloadControllers.current.clear();
    for (const url of mediaObjectUrls.current) URL.revokeObjectURL(url);
    mediaObjectUrls.current.clear();
    matrixClient.current?.close();
  }, []);
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
      appIsActive.current = isActive;
      if (!isActive && data.roomReady && data.pinHash) {
        lockPrivateView();
      }
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
  }, [data.roomReady, data.pinHash, pairingRole, panel, replacementActivationPending]);
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [mode, data.messages]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    setMoodNotificationPreferences(readMoodNotificationPreferences(
      localStorage,
      moodNotificationStorageKey(stateScope),
    ));
  }, [stateScope]);
  useEffect(() => {
    if (panel !== 'settings') return;
    let active = true;
    void getMoodNotificationPermission().then((permission) => {
      if (active) setMoodNotificationPermission(permission);
    }).catch((error: unknown) => {
      console.error('Could not check notification permission.', error);
      if (active) setMoodNotificationPermission('unsupported');
    });
    return () => { active = false; };
  }, [panel]);
  useEffect(() => {
    if (!recordingActive || recordingPaused) return;
    const timer = window.setInterval(() => {
      setRecordingSeconds(Math.floor((recordingElapsed.current + Date.now() - recordingStartedAt.current) / 1000));
    }, 250);
    return () => window.clearInterval(timer);
  }, [recordingActive, recordingPaused]);
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden' && data.roomReady && data.pinHash) {
        lockPrivateView();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [data.roomReady, data.pinHash]);
  useEffect(() => {
    if (locked || !matrixClient.current) return;
    for (const message of data.messages) {
      if (
        message.transport === 'matrix' &&
        message.encryptedAttachment &&
        message.mediaType &&
        !message.image &&
        !message.mediaError &&
        !message.viewOnceSeconds
      ) {
        retryMediaDownload(message);
      }
    }
  }, [locked, data.messages, matrixConnection]);
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
  useEffect(() => {
    if (!data.messages.some((message) => message.viewOnceSeconds && (message.expiresAt || message.pendingExpiresAt))) return;
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [data.messages]);
  useEffect(() => {
    setCustomRetentionSeconds(String(data.retentionSeconds ?? 86_400));
  }, [data.retentionSeconds]);
  useEffect(() => {
    const expiredUrls = data.messages
      .filter((message) => message.viewOnceSeconds && (message.expiresAt ?? message.pendingExpiresAt) && (message.expiresAt ?? message.pendingExpiresAt)! <= Date.now() && message.image)
      .map((message) => message.image!);
    if (expiredUrls.length === 0) return;
    for (const url of expiredUrls) {
      URL.revokeObjectURL(url);
      mediaObjectUrls.current.delete(url);
    }
    updateMessages((items) => items.map((message) =>
      message.viewOnceSeconds && (message.expiresAt ?? message.pendingExpiresAt) && (message.expiresAt ?? message.pendingExpiresAt)! <= Date.now()
        ? { ...message, image: undefined, thumbnailUrl: undefined, opened: true }
        : message,
    ));
  }, [clockNow, data.messages]);

  const activeMode = modes.find((item) => item.id === mode)!;
  const visibleMessages = useMemo(() => data.messages.filter((message) => message.mode === mode && ((message.expiresAt ?? message.pendingExpiresAt) === undefined || (message.expiresAt ?? message.pendingExpiresAt)! > clockNow) && (!matrixClient.current || message.transport === 'matrix')), [data.messages, mode, matrixStatus, clockNow]);
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
  const galleryMessages = data.messages.filter((item) => item.kind === 'media' && item.image && !item.viewOnceSeconds && !item.mediaType?.startsWith('audio/') && (
    galleryFilter === 'All' ||
    (galleryFilter === 'Photos' && item.mediaType?.startsWith('image/')) ||
    (galleryFilter === 'Videos' && item.mediaType?.startsWith('video/')) ||
    (galleryFilter === 'Favourites' && item.reaction === '♥') ||
    (galleryFilter === 'Expiring' && item.viewSeconds)
  ));

  function notify(message: string) { setToast(message); }
  function retentionLabel(seconds: number | null): string {
    if (seconds === null) return 'Never';
    return seconds === 3_600 ? '1 hour'
      : seconds === 86_400 ? '24 hours'
        : seconds === 604_800 ? '7 days'
          : seconds === 2_592_000 ? '30 days'
            : 'Custom';
  }
  function saveRetentionPreference(seconds: number | null) {
    if (seconds !== null && (!Number.isInteger(seconds) || seconds < 1 || seconds > 31_536_000)) {
      notify('Custom retention must be between 1 second and 365 days.');
      return;
    }
    const label = retentionLabel(seconds);
    setData((current) => ({ ...current, retention: label, retentionSeconds: seconds }));
    setCustomRetentionSeconds(String(seconds ?? 86_400));
    const client = matrixClient.current;
    if (!client) return;
    void client.send({
      version: 1,
      id: makeId(),
      mode: 'romantic',
      kind: 'text',
      text: '',
      sentAt: Date.now(),
      retentionPolicy: { seconds },
    }).then(async () => {
      const effectivePolicy = await client.getRetentionPolicy();
      setData((current) => ({
        ...current,
        retentionSeconds: effectivePolicy.seconds,
        retention: retentionLabel(effectivePolicy.seconds),
      }));
      setCustomRetentionSeconds(String(effectivePolicy.seconds ?? 86_400));
      notify(
        effectivePolicy.seconds === seconds
          ? 'Retention policy synchronized and enforced for new room events.'
          : 'A newer partner policy is active; the encrypted room setting was updated to match it.',
      );
    })
      .catch((error: unknown) => {
        console.error('Conversation retention preference synchronization failed.', error);
        notify('Retention policy was not confirmed by the server; timed expiry may not be active.');
      });
  }
  function updateMessages(updater: (items: Message[]) => Message[]) {
    setData((current) => ({ ...current, messages: updater(current.messages) }));
  }
  function removeExpiredMatrixMessages(eventIds: string[], knownMessages = messagesRef.current) {
    const expiredIds = new Set(eventIds);
    if (expiredIds.size === 0) return;
    const messages = [...new Set([...knownMessages, ...messagesRef.current])];
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const message of messages) {
        if (
          message.remoteEventId &&
          message.replyToEventId &&
          expiredIds.has(message.replyToEventId) &&
          !expiredIds.has(message.remoteEventId)
        ) {
          expiredIds.add(message.remoteEventId);
          expanded = true;
        }
      }
    }
    const removedMessages = messages.filter((message) =>
      expiredIds.has(message.remoteEventId ?? '') ||
      expiredIds.has(message.replyToEventId ?? ''),
    );
    for (const message of removedMessages) {
      mediaDownloadControllers.current.get(message.id)?.abort();
      mediaDownloadControllers.current.delete(message.id);
      for (const url of [message.image, message.thumbnailUrl]) {
        if (url?.startsWith('blob:') && mediaObjectUrls.current.delete(url)) URL.revokeObjectURL(url);
      }
    }
    setData((current) => ({
      ...current,
      messages: current.messages
        .filter((message) =>
          !expiredIds.has(message.remoteEventId ?? '') &&
          !expiredIds.has(message.replyToEventId ?? ''),
        )
        .map((message) =>
          expiredIds.has(message.reactionEventId ?? '')
            ? { ...message, reaction: undefined, reactionEventId: undefined }
            : message,
        ),
    }));
    setMoodCard((current) => current && current.eventId && expiredIds.has(current.eventId) ? null : current);
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
      replyToEventId: message.replyToEventId,
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
      const controller = new AbortController();
      downloadingMatrixMedia.current.add(event.id);
      mediaDownloadControllers.current.set(event.id, controller);
      const updateProgress = (progress: number) => updateMessages((items) => items.map((item) =>
        item.id === event.id ? { ...item, transferProgress: progress, mediaError: undefined } : item,
      ));
      void (async () => {
        if (event.thumbnailAttachment) {
          const thumbnail = await client.downloadAttachment(event.thumbnailAttachment, 'image/webp', {
            signal: controller.signal,
            onProgress: (progress) => updateProgress(Math.round(progress * 0.3)),
          });
          const thumbnailUrl = URL.createObjectURL(thumbnail);
          mediaObjectUrls.current.add(thumbnailUrl);
          updateMessages((items) => items.map((item) =>
            item.id === event.id ? { ...item, thumbnailUrl, mediaError: undefined } : item,
          ));
        }
        const blob = await client.downloadAttachment(event.attachment!, event.mediaType!, {
          signal: controller.signal,
          onProgress: (progress) => updateProgress(
            event.thumbnailAttachment ? 30 + Math.round(progress * 0.7) : progress,
          ),
        });
        const objectUrl = URL.createObjectURL(blob);
        mediaObjectUrls.current.add(objectUrl);
        const previousThumbnail = data.messages.find((item) => item.id === event.id)?.thumbnailUrl;
        if (previousThumbnail) {
          URL.revokeObjectURL(previousThumbnail);
          mediaObjectUrls.current.delete(previousThumbnail);
        }
        updateMessages((items) => items.map((item) =>
          item.id === event.id
            ? { ...item, image: objectUrl, thumbnailUrl: undefined, transferProgress: 100, mediaError: undefined }
            : item,
        ));
      })().catch(() => {
        if (controller.signal.aborted) {
          updateMessages((items) => items.map((item) =>
            item.id === event.id ? { ...item, transferProgress: undefined, mediaError: undefined } : item,
          ));
          return;
        }
        updateMessages((items) => items.map((item) =>
          item.id === event.id
            ? { ...item, mediaError: 'Encrypted media could not be downloaded or verified. Retry when connected.' }
            : item,
        ));
      }).finally(() => {
        downloadingMatrixMedia.current.delete(event.id);
        mediaDownloadControllers.current.delete(event.id);
      });
    }
  async function transmitAttachment(messageId: string) {
    const sender = matrixClient.current;
    const transfer = mediaTransfers.current.get(messageId);
    if (!sender || !transfer) return;
    const controller = new AbortController();
    transfer.controller = controller;
    updateMessages((items) => items.map((item) =>
      item.id === messageId ? { ...item, delivery: 'sending', transferProgress: 0, mediaError: undefined } : item,
    ));
    try {
      const result = await sender.sendAttachment(transfer.file, transfer.envelope, {
        ...(transfer.thumbnail ? { thumbnail: transfer.thumbnail } : {}),
        signal: controller.signal,
        onProgress: (transferProgress) => updateMessages((items) => items.map((item) =>
          item.id === messageId ? { ...item, transferProgress } : item,
        )),
      });
      if (mediaTransfers.current.get(messageId) !== transfer) return;
      mediaTransfers.current.delete(messageId);
      updateMessages((items) => items.map((item) =>
        item.id === messageId
          ? {
              ...item,
              delivery: 'sent',
              transferProgress: 100,
              remoteEventId: result.eventId,
              encryptedAttachment: result.attachment,
              encryptedThumbnailAttachment: result.thumbnailAttachment,
              pendingExpiresAt: result.viewOncePendingExpiresAt,
            }
          : item,
      ));
    } catch (error) {
      if (mediaTransfers.current.get(messageId) !== transfer) return;
      transfer.controller = undefined;
      updateMessages((items) => items.map((item) =>
        item.id === messageId
          ? { ...item, delivery: 'failed', mediaError: error instanceof Error ? error.message : 'Encrypted media was not sent.' }
          : item,
      ));
      notify('Encrypted media was not sent. Retry or remove the draft.');
    }
  }
  async function applyStickerSync(event: ReceivedNymphEvent) {
    const sync = event.stickerSync;
    if (!sync) return;
    if (sync.operation === 'pack-delete') {
      setData((current) => {
        const removedStickerIds = current.customStickerPacks.find((pack) => pack.id === sync.packId)?.stickers.map((sticker) => sticker.id) ?? [];
        return {
          ...current,
          customStickerPacks: current.customStickerPacks.filter((pack) => pack.id !== sync.packId),
          favoriteCustomStickerIds: current.favoriteCustomStickerIds.filter((id) => !removedStickerIds.includes(id)),
          recentCustomStickerIds: current.recentCustomStickerIds.filter((id) => !removedStickerIds.includes(id)),
        };
      });
      return;
    }
    if (sync.operation === 'favorite') {
      setData((current) => ({
        ...current,
        favoriteCustomStickerIds: sync.active
          ? [...new Set([...current.favoriteCustomStickerIds, sync.stickerId])]
          : current.favoriteCustomStickerIds.filter((id) => id !== sync.stickerId),
      }));
      return;
    }
    if (sync.operation === 'recent') {
      setData((current) => ({
        ...current,
        recentCustomStickerIds: [sync.stickerId, ...current.recentCustomStickerIds.filter((id) => id !== sync.stickerId)].slice(0, 12),
      }));
      return;
    }

    if (sync.operation !== 'pack-upsert') return;
    const packSync = sync;
    const upsertPack = (sticker?: CustomSticker) => setData((current) => {
      const existing = current.customStickerPacks.find((pack) => pack.id === packSync.packId);
      const stickers = sticker && existing
        ? [...existing.stickers.filter((item) => item.id !== sticker.id), sticker]
        : existing?.stickers ?? [];
      const nextPack: CustomStickerPack = {
        id: packSync.packId,
        name: packSync.packName,
        adult: packSync.adult,
        description: packSync.description,
        categories: packSync.categories,
        coverStickerId: packSync.coverStickerId,
        stickers,
      };
      return {
        ...current,
        customStickerPacks: existing
          ? current.customStickerPacks.map((pack) => pack.id === packSync.packId ? nextPack : pack)
          : [...current.customStickerPacks, nextPack],
      };
    });
    upsertPack();
    if (!packSync.stickerId || !event.attachment) return;
    const client = matrixClient.current;
    if (!client) {
      pendingStickerSync.current.push(event);
      return;
    }
    try {
      const type = packSync.stickerType ?? event.mediaType ?? 'image/png';
      const blob = await client.downloadAttachment(event.attachment, type);
      const file = new File([blob], packSync.stickerName ?? `${packSync.stickerId}.sticker`, { type });
      const dataUrl = await encodeStickerFile(file);
      upsertPack({
        id: packSync.stickerId,
        name: packSync.stickerName ?? 'Sticker',
        type,
        dataUrl,
      });
    } catch (error) {
      console.error('Could not decrypt a synchronized sticker.', error);
      notify('A private sticker could not be downloaded or verified. Reopen the sticker pack to retry sharing.');
    }
  }
  function stickerSyncEnvelope(stickerSync: StickerSync): NymphEnvelope {
    return {
      version: 1,
      id: makeId(),
      mode: getStickerSyncMode(
        stickerSync,
        data.customStickerPacks,
        mode,
        packData['After dark'],
      ),
      kind: 'sticker',
      text: '',
      sentAt: Date.now(),
      stickerSync,
    };
  }
  async function sendStickerSync(stickerSync: StickerSync, file?: File) {
    const client = matrixClient.current;
    if (!client) return;
    const envelope = stickerSyncEnvelope(stickerSync);
    if (!file) {
      await client.send(envelope);
      return;
    }
    await client.sendAttachment(file, {
      ...envelope,
      mediaType: file.type,
      mediaName: file.name,
    }, {
      onProgress: setStickerSyncProgress,
    });
  }
  function currentStickerSync(pack: CustomStickerPack, sticker?: CustomSticker): StickerSync {
    return {
      operation: 'pack-upsert',
      packId: pack.id,
      packName: pack.name,
      adult: pack.adult,
      description: pack.description ?? '',
      categories: pack.categories ?? [],
      ...(pack.coverStickerId ? { coverStickerId: pack.coverStickerId } : {}),
      ...(sticker ? {
        stickerId: sticker.id,
        stickerName: sticker.name,
        stickerType: sticker.type ?? 'image/png',
      } : {}),
    };
  }
  async function shareStickerPack(pack: CustomStickerPack) {
    if (!matrixClient.current) {
      notify('Connect the encrypted room before sharing this pack.');
      return;
    }
    setStickerSyncProgress(0);
    try {
      await sendStickerSync(currentStickerSync(pack));
      for (const sticker of pack.stickers) {
        const response = await fetch(sticker.dataUrl);
        if (!response.ok) throw new Error(`Could not read ${sticker.name} from this device.`);
        const file = new File([await response.blob()], `${sticker.id}.${sticker.type?.split('/')[1] ?? 'png'}`, {
          type: sticker.type ?? 'image/png',
        });
        await sendStickerSync(currentStickerSync(pack, sticker), file);
      }
      notify('Sticker pack synchronized privately with your partner.');
    } catch (error) {
      console.error('Private sticker-pack synchronization failed.', error);
      notify(error instanceof Error ? error.message : 'The private sticker pack could not be synchronized.');
    } finally {
      setStickerSyncProgress(null);
    }
  }
  function sendEncryptedAttachment(
    file: File,
    thumbnail: File | undefined,
    text: string,
    contentMode: Mode,
    image: string,
    kind: 'media' | 'sticker' = 'media',
    durationMs?: number,
    waveform?: number[],
    viewSeconds?: number,
  ): void {
    const sender = matrixClient.current;
    if (!sender) return;
    const messageId = makeId();
    const sentAt = Date.now();
    const mediaType = file.type || 'application/octet-stream';
    const envelope: NymphEnvelope = {
      version: 1,
      id: messageId,
      mode: contentMode,
      kind,
      text,
      sentAt,
      mediaType,
      mediaName: file.name,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(waveform ? { waveform } : {}),
      ...(viewSeconds === undefined ? {} : { viewOnceSeconds: viewSeconds }),
    };
    mediaTransfers.current.set(messageId, { file, ...(thumbnail ? { thumbnail } : {}), envelope, imageUrl: image });
    if (viewSeconds === undefined) mediaObjectUrls.current.add(image);
    else if (image.startsWith('blob:')) URL.revokeObjectURL(image);
    updateMessages((items) => [...items, {
      id: messageId,
      mode: contentMode,
      sender: 'me',
      kind,
      text,
      time: sentAt,
      mediaType,
      durationMs,
      waveform,
      image: viewSeconds === undefined ? image : undefined,
      viewOnceSeconds: viewSeconds,
      transport: 'matrix',
      delivery: 'sending',
      transferProgress: 0,
    }]);
    void transmitAttachment(messageId);
  }
  function cancelMediaTransfer(messageId: string) {
    const transfer = mediaTransfers.current.get(messageId);
    if (!transfer) return;
    transfer.controller?.abort();
    mediaTransfers.current.delete(messageId);
    if (transfer.imageUrl.startsWith('blob:')) URL.revokeObjectURL(transfer.imageUrl);
    mediaObjectUrls.current.delete(transfer.imageUrl);
    updateMessages((items) => items.filter((item) => item.id !== messageId));
  }
  function closeMediaPreview() {
    const currentPreview = previewRef.current;
    if (currentPreview && !mediaObjectUrls.current.has(currentPreview.url)) URL.revokeObjectURL(currentPreview.url);
    previewRef.current = null;
    setPreview(null);
  }
  function lockPrivateView() {
    finishVoiceRecording(true);
    recordingStream.current?.getTracks().forEach((track) => track.stop());
    recordingStream.current = null;
    const revokedUrls = new Set(mediaObjectUrls.current);
    for (const url of revokedUrls) URL.revokeObjectURL(url);
    mediaObjectUrls.current.clear();

    const cancelledTransferIds = new Set(mediaTransfers.current.keys());
    for (const transfer of mediaTransfers.current.values()) {
      transfer.controller?.abort();
      if (transfer.imageUrl.startsWith('blob:')) URL.revokeObjectURL(transfer.imageUrl);
    }
    mediaTransfers.current.clear();
    for (const controller of mediaDownloadControllers.current.values()) controller.abort();
    mediaDownloadControllers.current.clear();
    downloadingMatrixMedia.current.clear();
    closeMediaPreview();
    updateMessages((items) => items
      .filter((message) => !cancelledTransferIds.has(message.id))
      .map((message) => ({
        ...message,
        ...(message.image && revokedUrls.has(message.image) ? { image: undefined } : {}),
        ...(message.thumbnailUrl && revokedUrls.has(message.thumbnailUrl) ? { thumbnailUrl: undefined } : {}),
        ...(message.encryptedAttachment && !message.viewOnceSeconds
          ? { transferProgress: undefined, mediaError: undefined }
          : {}),
      })));
    setLocked(true);
  }
  function retryMediaDownload(message: Message) {
    if (!message.encryptedAttachment || !message.mediaType) return;
    hydrateMatrixMedia({
      version: 1,
      id: message.id,
      mode: message.mode,
      kind: 'media',
      text: message.text,
      sentAt: message.time,
      sender: message.sender === 'me' ? matrixConnection.userId : matrixConnection.partnerUserId,
      eventId: message.remoteEventId ?? '',
      attachment: message.encryptedAttachment,
      thumbnailAttachment: message.encryptedThumbnailAttachment,
      mediaType: message.mediaType,
      mediaName: message.text,
    });
  }
  async function openViewOnceMedia(message: Message) {
    const client = matrixClient.current;
    if (!client || !message.encryptedAttachment || !message.viewOnceSeconds || message.sender !== 'partner') return;
    try {
      if (message.expiresAt !== undefined && message.expiresAt <= Date.now()) {
        throw new Error('This expiring media is no longer available.');
      }
      const expiresAt = message.opened && message.expiresAt
        ? message.expiresAt
        : await client.openEphemeralMedia(message.encryptedAttachment);
      if (!message.opened) {
        updateMessages((items) => items.map((item) =>
          item.id === message.id ? { ...item, opened: true, expiresAt, mediaError: undefined } : item,
        ));
        const receipt: NymphEnvelope = {
          version: 1,
          id: makeId(),
          mode: message.mode,
          kind: 'text',
          text: '',
          sentAt: Date.now(),
          viewOnceReceipt: { messageId: message.id, expiresAt },
        };
        void client.send(receipt).catch((error: unknown) => {
          console.error('The view-once receipt could not be synchronized.', error);
          notify('Media opened, but its expiry status could not be synchronized yet.');
        });
      }
      hydrateMatrixMedia({
        version: 1,
        id: message.id,
        mode: message.mode,
        kind: 'media',
        text: message.text,
        sentAt: message.time,
        sender: 'partner',
        eventId: message.remoteEventId ?? message.id,
        attachment: message.encryptedAttachment,
        mediaType: message.mediaType,
        viewOnceSeconds: message.viewOnceSeconds,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'This expiring media could not be opened.';
      updateMessages((items) => items.map((item) =>
        item.id === message.id ? { ...item, mediaError: reason } : item,
      ));
    }
  }
  function cancelMediaDownload(messageId: string) {
    mediaDownloadControllers.current.get(messageId)?.abort();
  }
  async function connectPrivateRoom(connection: MatrixConnection = matrixConnection, internalHandoff = false) {
    if (matrixConnecting.current && !internalHandoff) return;
    if (matrixClient.current) {
      finishVoiceRecording(true);
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
        let roomId = typeof status.room_id === 'string' && status.room_id.startsWith('!')
          ? status.room_id
          : undefined;
        if (!roomId) {
          const created = await loginClient.createRoom({
            visibility: Visibility.Private,
            preset: Preset.PrivateChat,
            invite: [PARTNER_IDENTITIES.partnerB],
            is_direct: true,
            creation_content: { 'm.federate': false },
            initial_state: [
              {
                type: 'm.room.encryption',
                state_key: '',
                content: { algorithm: 'm.megolm.v1.aes-sha2' },
              },
              {
                type: 'm.room.join_rules',
                state_key: '',
                content: { join_rule: 'invite' },
              },
              {
                type: 'm.room.history_visibility',
                state_key: '',
                content: { history_visibility: 'joined' },
              },
            ],
          });
          if (typeof created.room_id !== 'string' || !created.room_id.startsWith('!')) {
            throw new Error('The homeserver returned an invalid private room ID.');
          }
          roomId = created.room_id;
        }
        const connection: MatrixConnection = {
          homeserver: homeserver.origin,
          userId: session.user_id,
          partnerUserId: PARTNER_IDENTITIES.partnerB,
          accessToken,
          roomId,
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
      const previousMessages = messagesRef.current;
      const restoredState = readState(accountScope, false);
      setStateScope(accountScope);
      messagesRef.current = restoredState.messages;
      setData(restoredState);
      const { connectMatrix } = await import('./matrix/MessagingClient');
      const connected = await connectMatrix(
        persistentConnection,
        (event) => {
        if (event.retentionPolicy) {
          setData((current) => ({
            ...current,
            retentionSeconds: event.retentionPolicy!.seconds,
            retention: retentionLabel(event.retentionPolicy!.seconds),
          }));
          setCustomRetentionSeconds(String(event.retentionPolicy.seconds ?? 86_400));
          return;
        }
        if (event.viewOnceReceipt) {
          updateMessages((items) => items.map((item) =>
            item.id === event.viewOnceReceipt?.messageId && item.sender === 'me'
              ? { ...item, opened: true, expiresAt: event.viewOnceReceipt.expiresAt }
              : item,
          ));
          return;
        }
        if (event.kind === 'reaction' && event.reactionTo) {
          setData((current) => ({
            ...current,
            messages: current.messages.map((item) => item.remoteEventId === event.reactionTo
              ? { ...item, reaction: event.text, reactionEventId: event.eventId }
              : item),
          }));
          return;
        }
        if (event.stickerSync) {
          void applyStickerSync(event);
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
          replyToEventId: event.replyToEventId,
          transport: 'matrix',
          delivery: 'sent',
          remoteEventId: event.eventId,
          encryptedAttachment: event.attachment,
          encryptedThumbnailAttachment: event.thumbnailAttachment,
          mediaType: event.mediaType,
          durationMs: event.durationMs,
          waveform: event.waveform,
          viewOnceSeconds: event.viewOnceSeconds,
          pendingExpiresAt: event.viewOncePendingExpiresAt,
        };
        const isNewIncomingEvent = event.sender === connection.partnerUserId &&
          !messagesRef.current.some((item) =>
            item.id === event.id || item.remoteEventId === event.eventId
          );
        setData((current) => current.messages.some((item) => item.id === received.id) ? current : { ...current, messages: [...current.messages, received] });
        if (event.kind === 'mood' && isNewIncomingEvent) {
          const separator = event.text.indexOf(' ');
          setMoodCard({
            emoji: separator > 0 ? event.text.slice(0, separator) : '♡',
            label: separator > 0 ? event.text.slice(separator + 1) : event.text,
            messageId: event.id,
            eventId: event.eventId,
          });
          notify('A private mood ping arrived.');
          void notifyForIncomingMood(event, connection.userId);
        }
        if (event.attachment) {
          if (event.viewOnceSeconds) {
            if (!matrixClient.current) pendingMatrixMedia.current.push(event);
          } else if (matrixClient.current) hydrateMatrixMedia(event);
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
        (eventId) => removeExpiredMatrixMessages([eventId]),
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
      try {
        const knownEventIds = [
          ...new Set([
            ...previousMessages,
            ...restoredState.messages,
          ].map((message) => message.remoteEventId).filter((eventId): eventId is string => Boolean(eventId))),
        ];
        const expiredEventIds = await connected.reconcileExpiredMessages(knownEventIds);
        removeExpiredMatrixMessages(expiredEventIds, [...previousMessages, ...restoredState.messages]);
      } catch (error) {
        connected.close();
        matrixClient.current = null;
        throw error;
      }
      try {
        const retention = await connected.getRetentionPolicy();
        setData((current) => ({
          ...current,
          retentionSeconds: retention.seconds,
          retention: retentionLabel(retention.seconds),
        }));
        setCustomRetentionSeconds(String(retention.seconds ?? 86_400));
      } catch (error) {
        setMatrixSync('Server-side message retention could not be verified.');
        console.error('Could not read the server-side retention policy.', error);
        notify('The encrypted room connected, but server-side message expiry could not be verified.');
      }
      for (const event of pendingMatrixMedia.current.splice(0)) {
        if (!event.viewOnceSeconds) hydrateMatrixMedia(event);
      }
      for (const event of pendingStickerSync.current.splice(0)) void applyStickerSync(event);
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
    appendOutgoing({
      mode,
      kind: 'text',
      text: content,
      reply: reply?.text,
      replyToEventId: reply?.remoteEventId,
    });
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
    appendOutgoing({ mode: packTab === 'adult' ? 'kinky' : mode, kind: 'sticker', text: sticker });
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
    const stickerPack = data.customStickerPacks.find((pack) => pack.stickers.some((item) => item.id === sticker.id));
    const stickerMode = stickerPack?.adult ? 'kinky' : mode;
    if (matrixClient.current) {
      try {
        const response = await fetch(sticker.dataUrl);
        if (!response.ok) throw new Error('Could not read the imported sticker.');
        const file = new File([await response.blob()], `${sticker.name}.sticker`, { type: sticker.type ?? 'image/png' });
        sendEncryptedAttachment(file, undefined, sticker.name, stickerMode, sticker.dataUrl, 'sticker');
      } catch {
        notify('This custom sticker could not be prepared for encrypted sending.');
        return;
      }
    } else {
      addMessage({ mode: stickerMode, sender: 'me', kind: 'sticker', text: sticker.name, image: sticker.dataUrl });
      notify('Sticker saved locally only — no encrypted room is connected.');
    }
    setData((current) => ({
      ...current,
      recentCustomStickerIds: [sticker.id, ...current.recentCustomStickerIds.filter((id) => id !== sticker.id)].slice(0, 12),
    }));
    void matrixClient.current?.send(stickerSyncEnvelope({ operation: 'recent', stickerId: sticker.id }))
      .catch((error: unknown) => notify(error instanceof Error ? error.message : 'Sticker use could not be synchronized.'));
    setPanel(null);
  }
  function toggleCustomStickerFavourite(stickerId: string) {
    const active = !data.favoriteCustomStickerIds.includes(stickerId);
    setData((current) => ({
      ...current,
      favoriteCustomStickerIds: active
        ? [...current.favoriteCustomStickerIds, stickerId]
        : current.favoriteCustomStickerIds.filter((id) => id !== stickerId),
    }));
    void matrixClient.current?.send(stickerSyncEnvelope({ operation: 'favorite', stickerId, active }))
      .catch((error: unknown) => notify(error instanceof Error ? error.message : 'Sticker favourite could not be synchronized.'));
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
        const pack = existingPack
          ? {
              ...existingPack,
              coverStickerId: existingPack.coverStickerId ?? sticker.id,
              stickers: [...existingPack.stickers, sticker],
            }
          : {
              id: packId,
              name: packName,
              adult: packTab === 'adult',
              description: customPackDescription.trim(),
              categories: customPackCategories.split(',').map((category) => category.trim()).filter(Boolean),
              coverStickerId: sticker.id,
              stickers: [sticker],
            };
        setData((current) => {
          const currentPack = current.customStickerPacks.find((pack) => pack.id === packId);
          const customStickerPacks = currentPack
            ? current.customStickerPacks.map((currentPackItem) => currentPackItem.id === packId ? { ...pack, stickers: [...currentPackItem.stickers, sticker] } : currentPackItem)
            : [...current.customStickerPacks, pack];
          return { ...current, customStickerPacks };
        });
        setSelectedPack(`custom:${packId}`);
        if (matrixClient.current) {
          setStickerSyncProgress(0);
          void sendStickerSync(currentStickerSync(pack, sticker), file)
            .then(() => notify('Sticker encrypted and synchronized with your partner.'))
            .catch((error: unknown) => {
              console.error('Could not synchronize the imported private sticker.', error);
              notify(error instanceof Error ? error.message : 'The sticker was saved locally but could not be synchronized.');
            })
            .finally(() => setStickerSyncProgress(null));
        } else {
          notify('Sticker saved in a device-local pack. Connect the encrypted room to share it privately.');
        }
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
    const removedStickerIds = selectedCustomPack.stickers.map((sticker) => sticker.id);
    setData((current) => ({
      ...current,
      customStickerPacks: current.customStickerPacks.filter((pack) => pack.id !== selectedCustomPack.id),
      favoriteCustomStickerIds: current.favoriteCustomStickerIds.filter((id) => !removedStickerIds.includes(id)),
      recentCustomStickerIds: current.recentCustomStickerIds.filter((id) => !removedStickerIds.includes(id)),
    }));
    if (matrixClient.current) {
      void sendStickerSync({ operation: 'pack-delete', packId: selectedCustomPack.id })
        .catch((error: unknown) => notify(error instanceof Error ? error.message : 'Pack deletion could not be synchronized.'));
    }
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
    const pack: CustomStickerPack = {
      id,
      name,
      adult: packTab === 'adult',
      description: customPackDescription.trim(),
      categories: customPackCategories.split(',').map((category) => category.trim()).filter(Boolean),
      stickers: [],
    };
    setData((current) => ({
      ...current,
      customStickerPacks: [...current.customStickerPacks, pack],
    }));
    setSelectedPack(`custom:${id}`);
    setCustomPackName(name);
    setCustomPackDescription(pack.description ?? '');
    setCustomPackCategories(pack.categories?.join(', ') ?? '');
    if (matrixClient.current) {
      void sendStickerSync(currentStickerSync(pack))
        .then(() => notify('Private sticker pack created and synchronized.'))
        .catch((error: unknown) => notify(error instanceof Error ? error.message : 'Pack was created locally but could not be synchronized.'));
    } else {
      notify('Empty sticker pack created on this device.');
    }
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
    const renamedPack = {
      ...selectedCustomPack,
      name,
      description: customPackDescription.trim(),
      categories: customPackCategories.split(',').map((category) => category.trim()).filter(Boolean),
    };
    setData((current) => ({
      ...current,
      customStickerPacks: current.customStickerPacks.map((pack) =>
        pack.id === selectedCustomPack.id ? renamedPack : pack,
      ),
    }));
    if (matrixClient.current) {
      void sendStickerSync(currentStickerSync(renamedPack))
        .then(() => notify('Sticker pack renamed and synchronized privately.'))
        .catch((error: unknown) => notify(error instanceof Error ? error.message : 'Pack rename could not be synchronized.'));
    } else {
      notify('Sticker pack renamed on this device.');
    }
  }
  function switchStickerCollection() {
    const nextTab = packTab === 'everyday' ? 'adult' : 'everyday';
    setPackTab(nextTab);
    setSelectedPack(nextTab === 'adult' ? adultPacks[0] : everydayPacks[0]);
  }
  async function sendMedia() {
    if (!preview || mediaPreparing.current) return;
    const selectedPreview = preview;
    const sender = matrixClient.current;
    const viewSeconds = viewOnceSeconds === 'Off'
      ? undefined
      : viewOnceSeconds === 'Custom' ? Number(customViewOnceSeconds) : Number(viewOnceSeconds);
    if (viewOnceSeconds !== 'Off' && !sender) {
      notify('Connect the verified encrypted room before sending expiring media.');
      return;
    }
    if (viewSeconds !== undefined && (!Number.isInteger(viewSeconds) || viewSeconds < 1 || viewSeconds > 86_400)) {
      notify('Choose a viewing time between 1 second and 24 hours.');
      return;
    }
    if (viewSeconds !== undefined && !selectedPreview.type.startsWith('image/') && !selectedPreview.type.startsWith('video/')) {
      notify('View-once mode is available for photos and videos, not voice messages.');
      return;
    }
    if (sender && !selectedPreview.file) {
      notify('Select the original photo or video file again before sending.');
      return;
    }
    if (sender && selectedPreview.file) {
      mediaPreparing.current = true;
      setPreparingMedia(true);
      try {
        if (selectedPreview.file.type.startsWith('image/') || selectedPreview.file.type.startsWith('video/')) {
          const thumbnail = viewSeconds === undefined ? await createMediaThumbnail(selectedPreview.file) : undefined;
          sendEncryptedAttachment(selectedPreview.file, thumbnail, selectedPreview.name, mode, selectedPreview.url, 'media', undefined, undefined, viewSeconds);
        } else if (selectedPreview.file.type.startsWith('audio/')) {
          sendEncryptedAttachment(
            selectedPreview.file,
            undefined,
            selectedPreview.name,
            mode,
            selectedPreview.url,
            'media',
            selectedPreview.durationMs,
            selectedPreview.waveform,
          );
        } else {
          notify('Choose a photo or video to send privately.');
          return;
        }
        setPreview(null);
        setViewOnceSeconds('Off');
        setPanel(null);
        return;
      } catch (error) {
        notify(error instanceof Error ? error.message : 'The private media preview could not be prepared.');
        return;
      } finally {
        mediaPreparing.current = false;
        setPreparingMedia(false);
      }
    }
    addMessage({
      mode, sender: 'me', kind: 'media', text: preview.name, image: preview.url,
      mediaType: preview.type,
    });
    setPreview(null);
    setViewOnceSeconds('Off');
    setPanel(null);
    if (!sender) notify('Saved locally only — no encrypted room is connected.');
  }
  function sendMood(label: string, emoji: string) {
    const moodMessage = appendOutgoing({ mode, kind: 'mood', text: `${emoji} ${label}` });
    setPanel(null);
    if (moodMessage.transport === 'matrix') {
      notify('Private mood ping sent through the encrypted room.');
    } else {
      notify('Mood saved locally only. Connect the verified encrypted room to send it to your partner.');
    }
    setCustomMood('');
  }
  function saveMoodNotificationPreferences(
    update: (current: MoodNotificationPreferences) => MoodNotificationPreferences,
  ) {
    try {
      const next = normalizeMoodNotificationPreferences(update(moodNotificationPreferences));
      localStorage.setItem(
        moodNotificationStorageKey(stateScope),
        JSON.stringify(next),
      );
      setMoodNotificationPreferences(next);
    } catch (error) {
      console.error('Could not save private notification preferences.', error);
      notify('Notification preferences could not be saved on this device.');
    }
  }
  async function enableMoodNotifications() {
    try {
      const permission = await requestMoodNotificationPermission();
      setMoodNotificationPermission(permission);
      if (permission !== 'granted') {
        notify(permission === 'unsupported'
          ? 'Notifications are not supported in this app environment.'
          : 'Notification permission was not granted.');
        return;
      }
      saveMoodNotificationPreferences((current) => ({ ...current, enabled: true }));
      notify('Private mood notifications are on.');
    } catch (error) {
      console.error('Could not request notification permission.', error);
      notify('Notification permission could not be requested.');
    }
  }
  async function notifyForIncomingMood(event: ReceivedNymphEvent, localUserId: string) {
    const notificationScope = getNymphStateStorageKey(localUserId);
    const deliveredKey = moodNotificationStorageKey(notificationScope, MOOD_NOTIFICATION_DELIVERED_KEY);
    if (deliveringMoodNotifications.current.has(event.eventId)) return;
    const delivered = readDeliveredMoodEventIds(localStorage, deliveredKey);
    if (!shouldNotifyForMood(event, {
      localUserId,
      preferences: readMoodNotificationPreferences(
        localStorage,
        moodNotificationStorageKey(notificationScope),
      ),
      deliveredEventIds: delivered,
      now: Date.now(),
      retentionSeconds: data.retentionSeconds,
    })) return;

    deliveringMoodNotifications.current.add(event.eventId);
    try {
      if (await deliverPrivateMoodNotification(
        event.eventId,
        appIsActive.current && document.visibilityState === 'visible',
      )) {
        recordDeliveredMoodEvent(localStorage, deliveredKey, event.eventId);
      }
    } catch (error) {
      console.error('Could not deliver a private mood notification.', error);
      notify('A private mood notification could not be shown.');
    } finally {
      deliveringMoodNotifications.current.delete(event.eventId);
    }
  }
  async function toggleVoiceRecording() {
    if (recordingActive) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      notify('Voice recording is not supported in this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordingStream.current = stream;
      const supportedTypes = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
        .filter((type) => MediaRecorder.isTypeSupported(type));
      const voiceRecorder = new MediaRecorder(stream, supportedTypes.length ? { mimeType: supportedTypes[0] } : undefined);
      recorder.current = voiceRecorder;
      recordingCancelled.current = false;
      recordingElapsed.current = 0;
      recordingStartedAt.current = Date.now();
      setRecordingSeconds(0);
      setRecordingPaused(false);
      setRecordingActive(true);
      const chunks: Blob[] = [];
      voiceRecorder.addEventListener('dataavailable', (event) => {
        if (event.data.size) chunks.push(event.data);
      });
      voiceRecorder.addEventListener('stop', () => {
        const durationMs = recordingElapsed.current;
        const cancelled = recordingCancelled.current;
        recordingStream.current?.getTracks().forEach((track) => track.stop());
        recordingStream.current = null;
        recorder.current = null;
        setRecordingActive(false);
        setRecordingPaused(false);
        if (cancelled) {
          chunks.length = 0;
          setRecordingSeconds(0);
          return;
        }
        const voiceNote = new Blob(chunks, { type: voiceRecorder.mimeType || 'audio/webm' });
        const extension = voiceNote.type.includes('ogg') ? 'ogg' : voiceNote.type.includes('mp4') ? 'm4a' : 'webm';
        const file = new File([voiceNote], `voice-note.${extension}`, { type: voiceNote.type });
        const url = URL.createObjectURL(voiceNote);
        void createAudioWaveform(voiceNote).catch(() => []).then((waveform) => {
          setPreview({
            url,
            name: 'Voice note',
            type: voiceNote.type,
            file,
            durationMs: Math.max(0, Math.round(durationMs)),
            waveform,
          });
          notify('Voice note ready to preview. Tap send to continue.');
        });
      }, { once: true });
      voiceRecorder.addEventListener('error', () => {
        recordingStream.current?.getTracks().forEach((track) => track.stop());
        recordingStream.current = null;
        recorder.current = null;
        setRecordingActive(false);
        notify('The voice recording could not be completed.');
      }, { once: true });
      voiceRecorder.start(250);
      notify('Recording privately on this device.');
    } catch (error) {
      recordingStream.current?.getTracks().forEach((track) => track.stop());
      recordingStream.current = null;
      setRecordingActive(false);
      console.error('Could not access the microphone.', error);
      notify('Microphone access was not available.');
    }
  }
  function pauseOrResumeVoiceRecording() {
    const activeRecorder = recorder.current;
    if (!activeRecorder) return;
    if (activeRecorder.state === 'recording') {
      recordingElapsed.current += Date.now() - recordingStartedAt.current;
      setRecordingSeconds(Math.floor(recordingElapsed.current / 1000));
      activeRecorder.pause();
      setRecordingPaused(true);
    } else if (activeRecorder.state === 'paused') {
      recordingStartedAt.current = Date.now();
      activeRecorder.resume();
      setRecordingPaused(false);
    }
  }
  function finishVoiceRecording(cancelled: boolean) {
    const activeRecorder = recorder.current;
    if (!activeRecorder) return;
    recordingCancelled.current = cancelled;
    if (activeRecorder.state === 'recording') {
      recordingElapsed.current += Date.now() - recordingStartedAt.current;
    }
    if (activeRecorder.state !== 'inactive') activeRecorder.stop();
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
            <button className="icon-button" aria-label="Lock app" onClick={lockPrivateView}>⌑</button>
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
                  {message.kind === 'media' ? <div className="media-message">
                    {message.viewOnceSeconds
                      ? <div className="view-once-media">
                          {message.image
                            ? <button className="sent-media" onClick={() => setPreview({ url: message.image!, name: message.text, type: message.mediaType ?? 'image/*' })}>
                                {message.mediaType?.startsWith('video/') ? <video src={message.image} muted playsInline /> : <img src={message.image} alt="View-once private media" />}
                              </button>
                            : message.sender === 'partner' && !message.opened
                              ? <button className="secondary" onClick={() => void openViewOnceMedia(message)} disabled={downloadingMatrixMedia.current.has(message.id)}>
                                  {message.opened ? 'Open again' : 'View once · open'}
                                </button>
                              : <span>{message.opened ? 'Opened on recipient device' : 'View-once media sent'}</span>}
                          {(message.expiresAt || message.pendingExpiresAt) && <strong aria-label="View-once countdown">
                            {Math.max(0, Math.ceil(((message.expiresAt ?? message.pendingExpiresAt)! - clockNow) / 1000))}s {message.expiresAt ? 'remaining' : 'until unopened media expires'}
                          </strong>}
                          <small>Server deletes the encrypted object at expiry. Screenshots, recordings, and saved copies cannot be prevented.</small>
                        </div>
                      : message.image && message.mediaType?.startsWith('audio/')
                      ? <div className="voice-note">
                          <span className="voice-note-icon" aria-hidden="true">♫</span>
                          <div className="voice-note-content">
                            <div className="voice-waveform" aria-hidden="true">{(message.waveform?.length ? message.waveform : Array.from({ length: 28 }, (_, index) => 0.2 + ((index * 17 + message.id.charCodeAt(index % message.id.length)) % 75) / 100)).map((peak, index) => <i key={index} style={{ '--wave-height': `${Math.max(8, peak * 100)}%` } as React.CSSProperties} />)}</div>
                            <div className="voice-controls"><span>{formatDuration(message.durationMs)}</span><audio controls src={message.image} aria-label={`Voice message from ${message.sender === 'me' ? 'you' : data.partnerName}`} /><label>Speed<select aria-label="Voice playback speed" defaultValue="1" onChange={(event) => {
                              const audio = event.currentTarget.closest('.voice-note')?.querySelector('audio');
                              if (audio) audio.playbackRate = Number(event.currentTarget.value);
                            }}><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label></div>
                          </div>
                        </div>
                      : message.image
                        ? <button className="sent-media" onClick={() => setPreview({ url: message.image!, name: message.text, type: message.mediaType ?? 'image/*' })}>
                            {message.mediaType?.startsWith('video/') ? <video src={message.image} muted playsInline /> : <img src={message.image} alt="Shared privately" />}
                          </button>
                        : message.thumbnailUrl
                          ? <div className="sent-media"><img src={message.thumbnailUrl} alt="Encrypted media preview" /></div>
                          : null}
                    {message.delivery === 'sending' && <div className="media-transfer-controls">
                      <progress max={100} value={message.transferProgress ?? 0} aria-label="Encrypted media upload progress" />
                      <span>Encrypting & sending · {message.transferProgress ?? 0}%</span>
                      {message.sender === 'me' && <button className="text-action" disabled={(message.transferProgress ?? 0) >= 99} onClick={() => cancelMediaTransfer(message.id)}>{(message.transferProgress ?? 0) >= 99 ? 'Sending…' : 'Cancel'}</button>}
                    </div>}
                    {message.mediaError && <div className="media-transfer-controls" role="status">
                      <span>{message.mediaError}</span>
                      {message.viewOnceSeconds && message.sender === 'partner' && !message.image
                        ? <button className="text-action" onClick={() => void openViewOnceMedia(message)}>Retry open</button>
                        : message.sender === 'me' && mediaTransfers.current.has(message.id)
                        ? <button className="text-action" onClick={() => void transmitAttachment(message.id)}>Retry upload</button>
                        : message.encryptedAttachment
                          ? <button className="text-action" onClick={() => retryMediaDownload(message)}>Retry download</button>
                          : null}
                    </div>}
                    {!message.mediaError && message.delivery !== 'sending' && message.transferProgress !== undefined &&
                      message.transferProgress < 100 && <div className="media-transfer-controls" role="status">
                        <progress max={100} value={message.transferProgress} aria-label="Encrypted media download progress" />
                        <span>Decrypting privately · {message.transferProgress}%</span>
                        {downloadingMatrixMedia.current.has(message.id) &&
                          <button className="text-action" onClick={() => cancelMediaDownload(message.id)}>Cancel</button>}
                      </div>}
                    {!message.image && !message.thumbnailUrl && !message.mediaError && message.delivery !== 'sending' &&
                      <div className="media-transfer-controls" role="status">Encrypted media is loading…</div>}
                  </div> : message.kind === 'sticker' ? message.image ? <img className="sticker-image" src={message.image} alt={message.text} /> : message.encryptedAttachment ? <div className="media-transfer-state" role="status">Decrypting personal sticker…</div> : <div className="sticker-message">{message.text}</div> : message.kind === 'mood' ? <button className="mood-message" onClick={() => {
                    const separator = message.text.indexOf(' ');
                    setMoodCard({
                      emoji: separator > 0 ? message.text.slice(0, separator) : '♡',
                      label: separator > 0 ? message.text.slice(separator + 1) : message.text,
                      messageId: message.id,
                      eventId: message.remoteEventId,
                    });
                  }}><span>{message.text.split(' ')[0]}</span><div><small>MOOD PING · {modes.find((item) => item.id === message.mode)?.label.toUpperCase()}</small><strong>{message.text.substring(message.text.indexOf(' ') + 1)}</strong></div></button> : <div className="bubble-text">{message.text}</div>}
                  <div className="bubble-meta"><time>{formatTime(message.time)}</time>{message.sender === 'me' && <span>{message.delivery === 'failed' ? '!' : message.delivery === 'sending' ? '…' : message.delivery === 'read' ? '✓✓' : '✓'}</span>}{message.reaction && <b className="reaction">{message.reaction}</b>}</div>
                </div>
                <div className="message-tools"><button aria-label="Reply" onClick={() => { setReply(message); document.querySelector<HTMLTextAreaElement>('#message-input')?.focus(); }}>↩</button><button className={message.reaction === '❤️' ? 'is-reacted' : ''} aria-label={message.reaction === '❤️' ? 'Heart reaction added' : 'React with heart'} aria-pressed={message.reaction === '❤️'} onClick={() => reactToMessage(message)}>{message.reaction === '❤️' ? '♥' : '♡'}</button></div>
              </article>)}
              {partnerTyping && <div className="typing-indicator"><span>{data.partnerName} is writing</span><i /><i /><i /></div>}
            </div>
            <div className="composer-wrap">
              {recordingActive && <div className={`voice-recording ${recordingPaused ? 'paused' : ''}`} role="status" aria-live="polite">
                <span className="recording-dot" />
                <div className="recording-waveform" aria-hidden="true">{Array.from({ length: 24 }, (_, index) => <i key={index} style={{ '--wave-height': `${20 + ((index * 29) % 76)}%`, animationDelay: `-${(index % 8) * 0.09}s` } as React.CSSProperties} />)}</div>
                <time>{formatDuration(recordingSeconds * 1000)}</time>
                <button className="text-action" onClick={pauseOrResumeVoiceRecording}>{recordingPaused ? 'Resume' : 'Pause'}</button>
                <button className="text-action" onClick={() => finishVoiceRecording(false)}>Finish</button>
                <button className="text-danger" onClick={() => finishVoiceRecording(true)}>Cancel</button>
              </div>}
              {reply && <div className="reply-bar"><span>Replying to <b>{reply.sender === 'me' ? 'your note' : data.partnerName}</b><small>{reply.text}</small></span><button aria-label="Cancel reply" onClick={() => setReply(null)}>×</button></div>}
              <div className="composer">
                <div className="composer-tools">
                  <button className={`tool-button ${recordingActive ? 'recording' : ''}`} aria-label={recordingActive ? 'Voice recording in progress' : 'Record voice message'} title="Record voice message" disabled={recordingActive} onClick={() => void toggleVoiceRecording()}>♫</button>
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
            <div className="local-warning"><span>⌑</span><p>{matrixClient.current ? <>Encrypted text, photo, video and voice transfers use this verified room. Sticker and GIF packs synchronize privately.</> : <>This is a <b>local demonstration</b>. Messages stay in this browser and are not sent to your partner.</>}</p></div>
          </aside>
        </div>
        <nav className="mobile-nav"><button className="selected" onClick={() => setPanel(null)}>◌<span>Room</span></button><button onClick={() => setPanel('gallery')}>▧<span>Gallery</span></button><button onClick={() => setPanel('mood')}>♡<span>Mood</span></button><button onClick={() => setPanel('settings')}>⚙<span>Settings</span></button></nav>
      </main>
      {panel === 'stickers' && <div className="sheet-backdrop" onClick={() => setPanel(null)}><section className="sheet sticker-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" /><div className="sheet-title"><div><div className="eyebrow">A LITTLE EXTRA</div><h2>Stickers & more</h2></div><button className="close-button" onClick={() => setPanel(null)}>×</button></div>
        <div className="picker-tabs"><button className={!showGif ? 'active' : ''} onClick={() => setShowGif(false)}>Stickers</button><button className={showGif ? 'active' : ''} onClick={() => setShowGif(true)}>GIFs</button><button onClick={() => { setEmojiTray(!emojiTray); setShowGif(false); }}>Emoji</button><button className="picker-import" onClick={() => { setStickerImportRequested(true); fileInput.current?.click(); }}>Import +</button></div>
        <div className="sticker-pack-manager">
          <div><label htmlFor="custom-sticker-pack-name">Pack name</label><input id="custom-sticker-pack-name" maxLength={32} value={customPackName} onChange={(event) => setCustomPackName(event.target.value)} /></div>
          <div><label htmlFor="custom-sticker-pack-description">Description</label><input id="custom-sticker-pack-description" maxLength={120} value={customPackDescription} onChange={(event) => setCustomPackDescription(event.target.value)} placeholder="A little collection for us" /></div>
          <div><label htmlFor="custom-sticker-pack-categories">Categories</label><input id="custom-sticker-pack-categories" maxLength={120} value={customPackCategories} onChange={(event) => setCustomPackCategories(event.target.value)} placeholder="Love, Kisses" /></div>
          <button className="secondary" onClick={createStickerPack}>Create pack</button>
          {selectedCustomPack && <button className="secondary" onClick={renameSelectedStickerPack}>Save pack details</button>}
          <button className="secondary" onClick={() => { setStickerImportRequested(true); fileInput.current?.click(); }}>Add file</button>
          {selectedCustomPack && <button className="secondary" disabled={!matrixClient.current || stickerSyncProgress !== null} onClick={() => void shareStickerPack(selectedCustomPack)}>Share pack privately</button>}
          {selectedCustomPack && <button className="text-danger" onClick={deleteSelectedStickerPack}>Delete pack</button>}
          {selectedCustomPack && selectedCustomPack.stickers.length > 0 && <label className="field-label pack-cover-select">Pack cover
            <select value={selectedCustomPack.coverStickerId ?? ''} onChange={(event) => {
              const updatedPack = { ...selectedCustomPack, coverStickerId: event.target.value || undefined };
              setData((current) => ({ ...current, customStickerPacks: current.customStickerPacks.map((pack) => pack.id === updatedPack.id ? updatedPack : pack) }));
              if (matrixClient.current) void sendStickerSync(currentStickerSync(updatedPack)).catch((error: unknown) => notify(error instanceof Error ? error.message : 'Pack cover could not be synchronized.'));
            }}><option value="">No cover</option>{selectedCustomPack.stickers.map((sticker) => <option key={sticker.id} value={sticker.id}>{sticker.name}</option>)}</select>
          </label>}
          {selectedCustomPack?.description && <p className="sticker-pack-description">{selectedCustomPack.description} {selectedCustomPack.categories?.length ? `· ${selectedCustomPack.categories.join(', ')}` : ''}</p>}
          {stickerSyncProgress !== null && <div className="sticker-sync-progress" role="status"><progress max={100} value={stickerSyncProgress} /> <span>Encrypting & synchronizing · {stickerSyncProgress}%</span></div>}
          <p>{matrixClient.current ? 'Pack contents are encrypted before upload and shared only in your verified Matrix room.' : 'Saved on this device. Connect the encrypted room to synchronize privately with your partner.'}</p>
        </div>
        {showGif ? <div className="gif-empty"><div>✧</div><h3>Your GIF collection, your way.</h3><p>Import GIFs from your device. Nothing is pulled from a public library.</p>{importedGifs.length > 0 && <div className="imported-gif-grid">{importedGifs.map((sticker) => <button key={sticker.id} title={`${sticker.name} · ${sticker.packName}`} onClick={() => useCustomSticker(sticker)}><img src={sticker.dataUrl} alt={sticker.name} /></button>)}</div>}</div> : <>
          <div className="pack-tabs">{packNames.map((pack) => {
            const customPack = visibleCustomPacks.find((item) => `custom:${item.id}` === pack);
            return <button className={selectedPack === pack ? 'active' : ''} key={pack} onClick={() => {
              setSelectedPack(pack);
              if (customPack) {
                setCustomPackName(customPack.name);
                setCustomPackDescription(customPack.description ?? '');
                setCustomPackCategories(customPack.categories?.join(', ') ?? '');
              }
            }}>{customPack?.coverStickerId && customPack.stickers.find((sticker) => sticker.id === customPack.coverStickerId)?.dataUrl && <img className="pack-cover" src={customPack.stickers.find((sticker) => sticker.id === customPack.coverStickerId)?.dataUrl} alt="" />}{customPack?.name ?? pack}</button>;
          })}</div>
          <div className="picker-toolbar"><div className="picker-search"><span>⌕</span><input aria-label="Search stickers" placeholder="Search this collection" value={search} onChange={(event) => setSearch(event.target.value)} /></div><button onClick={switchStickerCollection}>{packTab === 'everyday' ? '18+ collection' : 'Everyday collection'}</button></div>
          {emojiTray && <div className="emoji-tray">{'😀 😍 🥰 😘 😉 😏 🥺 🫂 💋 ❤️ 💕 🔥 😈 ✨ 🫶'.split(' ').map((emoji) => <button key={emoji} onClick={() => addSticker(emoji)}>{emoji}</button>)}</div>}
          <div className="sticker-grid">{stickers.map((sticker) => <div key={`${selectedPack}-${sticker}`} className="sticker-cell"><button className="sticker-select" onClick={() => addSticker(sticker)}>{sticker}</button><button className={`favorite-toggle ${data.favourites.includes(sticker) ? 'favorited' : ''}`} aria-label="Favorite sticker" onClick={() => toggleFavourite(sticker)}>{data.favourites.includes(sticker) ? '♥' : '♡'}</button></div>)}{customPackStickers.map((sticker) => <div key={sticker.id} className="sticker-cell"><button className="sticker-select custom-sticker" title={sticker.name} onClick={() => useCustomSticker(sticker)}><img src={sticker.dataUrl} alt={sticker.name} /></button><button className={`favorite-toggle ${data.favoriteCustomStickerIds.includes(sticker.id) ? 'favorited' : ''}`} aria-label={`Favorite ${sticker.name}`} onClick={() => toggleCustomStickerFavourite(sticker.id)}>{data.favoriteCustomStickerIds.includes(sticker.id) ? '♥' : '♡'}</button></div>)}{(selectedCustomPack || selectedPack === 'Favorites' || selectedPack === 'Recent') && customPackStickers.length === 0 && stickers.length === 0 && <p className="sticker-pack-empty">{selectedPack === 'Favorites' ? 'Favorite a sticker to keep it here.' : selectedPack === 'Recent' ? 'Your personal sticker history will appear here.' : 'No matching stickers in this pack yet.'}</p>}</div>
          <div className="sticker-foot"><span>Recently used</span><div>{(data.recent.length ? data.recent : ['♡', '💋', '🥺', '✨']).map((item, index) => <button key={`${item}-${index}`} onClick={() => addSticker(item)}>{item}</button>)}</div></div>
        </>}
        <div className="sticker-sheet-bottom"><button className="adult-toggle" onClick={switchStickerCollection}>{packTab === 'everyday' ? '◉ Everyday' : '◉ Adults only · 18+'}</button><button className="import-link" onClick={() => { setStickerImportRequested(true); fileInput.current?.click(); }}>＋ Import personal stickers / GIFs</button></div>
      </section></div>}
      {panel === 'mood' && <div className="sheet-backdrop" onClick={() => setPanel(null)}><section className="sheet mood-sheet" onClick={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><div className="eyebrow">A QUIET LITTLE SIGNAL</div><h2>How are you feeling right now?</h2></div><button className="close-button" onClick={() => setPanel(null)}>×</button></div><p className="sheet-intro">Choose a mood. Your partner can reply with a note, a reaction, or a mood of their own.</p><div className="mood-mode-tabs" role="group" aria-label="Mood mode">{modes.map((item) => <button key={item.id} className={mode === item.id ? 'active' : ''} onClick={() => changeMode(item.id)}>{item.icon} {item.label}</button>)}</div><div className="mood-grid">{moodOptions.map(([label, emoji]) => <button key={`${label}${emoji}`} className="mood-option" onClick={() => sendMood(label, emoji)}><span>{emoji}</span><b>{label}</b></button>)}</div><div className="custom-mood"><input aria-label="Custom mood emoji" className="custom-mood-emoji" maxLength={8} value={customMoodEmoji} onChange={(event) => setCustomMoodEmoji(event.target.value)} /><input aria-label="Custom mood label" placeholder="Add your own mood…" maxLength={80} value={customMood} onChange={(event) => setCustomMood(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && customMood.trim() && sendMood(customMood.trim(), customMoodEmoji.trim() || '♡')} /><button onClick={() => customMood.trim() && sendMood(customMood.trim(), customMoodEmoji.trim() || '♡')}>Send mood</button></div><div className="discreet-note">Mood details are sent only inside the verified encrypted room. Notifications use generic text and never show the mood itself.</div></section></div>}
      {panel === 'profile' && <div className="sheet-backdrop" onClick={() => setPanel(null)}><section className="sheet detail-sheet" onClick={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><div className="eyebrow">YOUR PRIVATE PROFILE</div><h2>A little about you</h2></div><button className="close-button" onClick={() => setPanel(null)}>×</button></div><div className="profile-cover"><div className="profile-avatar-big">{profileDraft.avatar}</div><span>Just between the two of you</span></div><label className="field-label">Display name<input value={profileDraft.displayName} onChange={(event) => setProfileDraft({ ...profileDraft, displayName: event.target.value })} /></label><label className="field-label">Username<input value={profileDraft.username} onChange={(event) => setProfileDraft({ ...profileDraft, username: event.target.value })} /></label><label className="field-label">Bio<textarea value={profileDraft.bio} onChange={(event) => setProfileDraft({ ...profileDraft, bio: event.target.value })} /></label><label className="field-label">Avatar initials<input maxLength={2} value={profileDraft.avatar} onChange={(event) => setProfileDraft({ ...profileDraft, avatar: event.target.value.toUpperCase() })} /></label><div className="partner-info">Paired partner <b>{data.partnerName}</b><span>Private room · two identities</span></div><button className="primary full-button" onClick={() => { setData((current) => ({ ...current, profile: profileDraft })); setPanel(null); notify('Profile saved on this device.'); }}>Save profile</button></section></div>}
      {panel === 'settings' && <div className="sheet-backdrop" onClick={() => setPanel(null)}>
        <section className="sheet detail-sheet" onClick={(event) => event.stopPropagation()}>
          <div className="sheet-handle" />
          <div className="sheet-title"><div><div className="eyebrow">YOUR ROOM, YOUR RULES</div><h2>Privacy & settings</h2></div><button className="close-button" onClick={() => setPanel(null)}>×</button></div>
          <button className="matrix-connect-card" onClick={() => setPanel('matrix')}><span className="matrix-lock">⌑</span><span><b>{matrixClient.current ? 'Encrypted room connected' : 'Connect an encrypted room'}</b><small>{matrixClient.current ? matrixStatus : 'Self-hosted Matrix · Rust-backed E2EE'}</small></span><i>↗</i></button>
          <div className="notification-preferences">
            <div className="eyebrow">PRIVATE NOTIFICATIONS</div>
            <label className="setting-control"><span><b>Private mood notifications</b><span>Generic alerts only; mood text and emoji stay in the encrypted room.</span></span><input aria-label="Enable private mood notifications" type="checkbox" checked={moodNotificationPreferences.enabled} onChange={(event) => {
              if (event.target.checked) void enableMoodNotifications();
              else saveMoodNotificationPreferences((current) => ({ ...current, enabled: false }));
            }} /></label>
            <div className="notification-permission" role="status">Permission: {moodNotificationPermission === 'unknown' ? 'checking' : moodNotificationPermission}</div>
            <label className="setting-control"><span><b>Quiet hours</b><span>Suppress device alerts during your local quiet window.</span></span><input aria-label="Enable quiet hours" type="checkbox" checked={moodNotificationPreferences.quietHoursEnabled} onChange={(event) => saveMoodNotificationPreferences((current) => ({ ...current, quietHoursEnabled: event.target.checked }))} /></label>
            {moodNotificationPreferences.quietHoursEnabled && <div className="quiet-hours-fields"><label>From<input aria-label="Quiet hours start" type="time" value={moodNotificationPreferences.quietHoursStart} onChange={(event) => saveMoodNotificationPreferences((current) => ({ ...current, quietHoursStart: event.target.value }))} /></label><label>Until<input aria-label="Quiet hours end" type="time" value={moodNotificationPreferences.quietHoursEnd} onChange={(event) => saveMoodNotificationPreferences((current) => ({ ...current, quietHoursEnd: event.target.value }))} /></label></div>}
            <div className="discreet-note">This device can alert only after it receives an encrypted event. Remote push while NYMPH is stopped needs a private push gateway and provider configuration; none is configured.</div>
          </div>
          <label className="field-label">Message retention preference
            <select aria-label="Message retention preference" value={data.retention} onChange={(event) => {
              const value = event.target.value;
              if (value === 'Custom') {
                setData((current) => ({ ...current, retention: value }));
                setCustomRetentionSeconds(String(data.retentionSeconds ?? 86_400));
                return;
              }
              const seconds: Record<string, number | null> = {
                Never: null,
                '1 hour': 3_600,
                '24 hours': 86_400,
                '7 days': 604_800,
                '30 days': 2_592_000,
              };
              saveRetentionPreference(seconds[value]);
            }}>{['Never', '1 hour', '24 hours', '7 days', '30 days', 'Custom'].map((value) => <option key={value}>{value}</option>)}</select>
          </label>
          {data.retention === 'Custom' && <>
            <label className="field-label">Custom retention in seconds<input aria-label="Custom retention in seconds" type="number" min="1" max="31536000" step="1" value={customRetentionSeconds} onChange={(event) => setCustomRetentionSeconds(event.target.value)} /></label>
            <button className="secondary" onClick={() => saveRetentionPreference(Number(customRetentionSeconds))}>Save retention preference</button>
          </>}
          <div className="discreet-note">When connected, new encrypted room events are redacted by the server at expiry. Earlier messages are not changed retroactively. Redaction does not guarantee erasure of server backups or encrypted attachment objects.</div>
          <div className="setting-control"><div><b>View-once media timer</b><span>Server-side encrypted-object expiry; unopened items expire after 30 days.</span></div><select aria-label="View-once media timer" value={viewOnceSeconds} onChange={(event) => setViewOnceSeconds(event.target.value)}>{['Off', '5', '10', '15', '30', '60', 'Custom'].map((value) => <option key={value} value={value}>{value === 'Off' ? 'Off' : value === 'Custom' ? value : `${value} seconds`}</option>)}</select></div>
          {viewOnceSeconds === 'Custom' && <label className="field-label">Custom viewing duration in seconds<input aria-label="Custom viewing duration in seconds" type="number" min="1" max="86400" step="1" value={customViewOnceSeconds} onChange={(event) => setCustomViewOnceSeconds(event.target.value)} /></label>}
          <div className="setting-control"><div><b>Hide adult timeline when leaving Kinky</b><span>Adult messages stay in their own mode.</span></div><span className="enabled-pill">On</span></div>
          <div className="setting-control"><div><b>Lock on background</b><span>Requires PIN again when you return.</span></div><span className="enabled-pill">On</span></div>
          <div className="discreet-note">View-once does not prevent screenshots, screen recording, or copies made outside NYMPH. Server expiration cannot revoke media already downloaded or decrypted.</div>
          <button className="secondary full-button" onClick={() => { setPanel(null); lockPrivateView(); }}>Lock this device now</button>
          <button className="text-danger" onClick={() => { if (window.confirm('Delete all local data for this account from this browser?')) { localStorage.removeItem(stateScope); location.reload(); } }}>Delete local data for this account</button>
        </section>
      </div>}
      {panel === 'gallery' && <div className="sheet-backdrop" onClick={() => setPanel(null)}><section className="sheet gallery-sheet" onClick={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><div className="eyebrow">ONLY YOUR SHARED MOMENTS</div><h2>Private gallery</h2></div><button className="close-button" onClick={() => setPanel(null)}>×</button></div><div className="gallery-tabs">{['All', 'Photos', 'Videos', 'Favourites', 'Expiring'].map((filter) => <button key={filter} className={galleryFilter === filter ? 'active' : ''} onClick={() => setGalleryFilter(filter)}>{filter}</button>)}</div><div className="gallery-grid">{galleryMessages.map((item) => <button key={item.id} className="gallery-item" onClick={() => item.image && setPreview({ url: item.image, name: item.text, type: item.mediaType ?? 'image/*' })}>{item.mediaType?.startsWith('video/') ? <video src={item.image} /> : <img src={item.image} alt="Shared media" />}{item.viewSeconds && <span>VIEW ONCE · {item.viewSeconds}s</span>}</button>)}</div>{galleryMessages.length === 0 && <div className="gallery-empty large"><span>✧</span><h3>Moments, kept close.</h3><p>Photos and videos you share will appear here. Your imports stay on this device in this demo.</p><button className="secondary" onClick={() => fileInput.current?.click()}>Choose a photo or video</button></div>}</section></div>}
      {preview && <div className="viewer-backdrop" onClick={() => !preparingMedia && closeMediaPreview()}><div className="viewer" onClick={(event) => event.stopPropagation()}><button className="close-button viewer-close" disabled={preparingMedia} onClick={closeMediaPreview}>×</button>{preview.type.startsWith('video/') ? <video src={preview.url} controls autoPlay /> : preview.type.startsWith('audio/') ? <audio className="voice-preview" src={preview.url} controls autoPlay /> : <img src={preview.url} alt="Media preview" />}<div className="viewer-footer"><span>{preview.name}{preparingMedia ? ' · Preparing encrypted preview…' : ''}</span><label>View once<select aria-label="View-once duration" value={viewOnceSeconds} disabled={Boolean(matrixClient.current)} onChange={(event) => setViewOnceSeconds(event.target.value)}>{['Off', '5', '10', '15', '30', '60', 'Custom'].map((value) => <option key={value} value={value}>{value === 'Off' || value === 'Custom' ? value : `${value} seconds`}</option>)}</select></label>{viewOnceSeconds === 'Custom' && <label>Custom seconds<input aria-label="Custom viewing duration in seconds" type="number" min="1" max="86400" step="1" value={customViewOnceSeconds} onChange={(event) => setCustomViewOnceSeconds(event.target.value)} /></label>}<button className="primary" disabled={preparingMedia} onClick={() => void sendMedia()}>{preparingMedia ? 'Preparing…' : 'Send privately ↗'}</button><button className="secondary" disabled={preparingMedia} onClick={closeMediaPreview}>Cancel</button></div></div></div>}
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
      {moodCard && <div className="dialog-backdrop" onClick={() => setMoodCard(null)}><section className="mood-received-card" onClick={(event) => event.stopPropagation()}><button className="close-button" onClick={() => setMoodCard(null)}>×</button><div className="mood-received-emoji">{moodCard.emoji}</div><div className="eyebrow">A LITTLE SIGNAL FROM {data.partnerName.toUpperCase()}</div><h2>{moodCard.label}</h2><p>This mood arrived through your verified encrypted room. You can respond here without exposing its contents to notification services.</p><div className="mood-reply-actions"><button className="secondary" onClick={() => { const moodMessage = data.messages.find((item) => item.id === moodCard.messageId); if (moodMessage) reactToMessage(moodMessage); else notify('This mood is no longer available to react to.'); setMoodCard(null); }}>React ❤️</button><button className="secondary" onClick={() => { setMoodCard(null); setPanel('mood'); }}>Reply with a mood</button><button className="primary" onClick={() => { setMoodCard(null); setPanel(null); }}>Open chat</button></div></section></div>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
