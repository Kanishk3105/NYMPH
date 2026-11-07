import type { NymphMode, StickerSync } from './matrix/MessagingClient.ts';

export const MAX_STICKER_BYTES = 512 * 1024;
export const MAX_STICKER_LIBRARY_BYTES = 2 * 1024 * 1024;
export const MAX_STICKER_PACK_NAME_LENGTH = 32;

type StickerPackMembership = {
  id: string;
  adult: boolean;
  stickers: readonly { id: string }[];
};

export interface StickerFileDetails {
  name: string;
  type: string;
  size: number;
}

const supportedStickerTypes = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export function getStickerSyncMode(
  sync: StickerSync,
  packs: readonly StickerPackMembership[],
  currentMode: NymphMode,
  adultStickerIds: readonly string[],
): NymphMode {
  if (sync.operation === 'pack-upsert') return sync.adult ? 'kinky' : currentMode;
  if (sync.operation === 'pack-delete') {
    return packs.find((pack) => pack.id === sync.packId)?.adult ? 'kinky' : currentMode;
  }
  const isAdultPackSticker = packs.some(
    (pack) => pack.adult && pack.stickers.some((sticker) => sticker.id === sync.stickerId),
  );
  return isAdultPackSticker || adultStickerIds.includes(sync.stickerId) ? 'kinky' : currentMode;
}

export function normalizeStickerPackName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, MAX_STICKER_PACK_NAME_LENGTH);
}

export function getStickerPackNameError(name: string, existingNames: string[]): string | undefined {
  const normalizedName = normalizeStickerPackName(name);
  if (!normalizedName) {
    return 'Enter a name for this sticker pack.';
  }
  if (existingNames.some((existingName) => normalizeStickerPackName(existingName).toLocaleLowerCase() === normalizedName.toLocaleLowerCase())) {
    return 'A sticker pack with this name already exists in this collection.';
  }
  return undefined;
}

export function getStickerImportError(
  file: StickerFileDetails,
  storedCharacters: number,
  packName: string,
): string | undefined {
  const packNameError = getStickerPackNameError(packName, []);
  if (packNameError) return packNameError;
  if (!supportedStickerTypes.has(file.type.toLowerCase())) {
    return 'Choose a GIF, JPEG, PNG, or WebP sticker.';
  }
  if (file.size <= 0 || file.size > MAX_STICKER_BYTES) {
    return 'Each sticker must be smaller than 512 KB.';
  }
  const encodedCharacters = Math.ceil(file.size / 3) * 4;
  if (storedCharacters + encodedCharacters > MAX_STICKER_LIBRARY_BYTES) {
    return 'Your device-local sticker library is full. Remove a pack before importing more.';
  }
  return undefined;
}

export async function encodeStickerFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${file.type};base64,${btoa(binary)}`;
}
