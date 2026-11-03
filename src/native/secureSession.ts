import { Capacitor } from '@capacitor/core';
import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage';
import type { MatrixConnection } from '../matrix/MessagingClient';

const STORAGE_PREFIX = 'nymph-private-room-v1';
const SESSION_KEY = 'matrix-session';
const CRYPTO_KEY_PREFIX = 'matrix-crypto-key:';

let storageReady: Promise<void> | undefined;

function assertAndroidSecureStorage(): void {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
    throw new Error('Persistent Matrix sessions are available only in the Android app.');
  }
}

async function initializeStorage(): Promise<void> {
  assertAndroidSecureStorage();
  storageReady ??= (async () => {
    await SecureStorage.setKeyPrefix(STORAGE_PREFIX);
    await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly);
  })();
  await storageReady;
}

export async function saveMatrixSession(connection: MatrixConnection): Promise<void> {
  await initializeStorage();
  await SecureStorage.set(SESSION_KEY, {
    homeserver: connection.homeserver,
    userId: connection.userId,
    partnerUserId: connection.partnerUserId,
    accessToken: connection.accessToken,
    roomId: connection.roomId,
    deviceId: connection.deviceId ?? '',
  });
}

export async function loadMatrixSession(): Promise<MatrixConnection | null> {
  await initializeStorage();
  const saved = await SecureStorage.get(SESSION_KEY);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
  const value = saved as Record<string, unknown>;
  if (
    typeof value.homeserver !== 'string' ||
    typeof value.userId !== 'string' ||
    typeof value.partnerUserId !== 'string' ||
    typeof value.accessToken !== 'string' ||
    typeof value.roomId !== 'string' ||
    typeof value.deviceId !== 'string' ||
    !value.deviceId
  ) {
    throw new Error('The saved Matrix session is incomplete. Re-pair this device.');
  }
  return {
    homeserver: value.homeserver,
    userId: value.userId,
    partnerUserId: value.partnerUserId,
    accessToken: value.accessToken,
    roomId: value.roomId,
    deviceId: value.deviceId,
  };
}

export async function removeMatrixSession(): Promise<void> {
  await initializeStorage();
  await SecureStorage.remove(SESSION_KEY);
}

export async function getMatrixCryptoStorageKey(userId: string, deviceId: string): Promise<Uint8Array> {
  await initializeStorage();
  const keyName = `${CRYPTO_KEY_PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(deviceId)}`;
  const stored = await SecureStorage.get(keyName);
  if (typeof stored === 'string') {
    const bytes = Uint8Array.from(atob(stored), (character) => character.charCodeAt(0));
    if (bytes.length !== 32) throw new Error('The secure Matrix storage key is invalid. Do not clear app data; contact support.');
    return bytes;
  }

  const key = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...key));
  await SecureStorage.set(keyName, encoded);
  return key;
}
