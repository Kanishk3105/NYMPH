import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_STICKER_BYTES,
  MAX_STICKER_LIBRARY_BYTES,
  getStickerImportError,
  getStickerPackNameError,
  normalizeStickerPackName,
} from './sticker-library.ts';

test('normalizes and limits imported sticker pack names', () => {
  assert.equal(normalizeStickerPackName('  My   little pack  '), 'My little pack');
  assert.equal(normalizeStickerPackName('x'.repeat(40)).length, 32);
  assert.equal(normalizeStickerPackName('   '), '');
});

test('accepts supported small image and animated GIF formats', () => {
  for (const type of ['image/gif', 'image/jpeg', 'image/png', 'image/webp']) {
    assert.equal(getStickerImportError({ name: 'sticker', type, size: 1024 }, 0, 'Pack'), undefined);
  }
});

test('rejects unsafe or unsupported file types and oversized stickers', () => {
  assert.match(
    getStickerImportError({ name: 'svg', type: 'image/svg+xml', size: 128 }, 0, 'Pack') ?? '',
    /GIF, JPEG, PNG, or WebP/,
  );
  assert.match(
    getStickerImportError({ name: 'large', type: 'image/png', size: MAX_STICKER_BYTES + 1 }, 0, 'Pack') ?? '',
    /512 KB/,
  );
  assert.match(
    getStickerImportError({ name: 'empty', type: 'image/png', size: 0 }, 0, 'Pack') ?? '',
    /512 KB/,
  );
});

test('keeps the encoded sticker library within the local storage budget', () => {
  assert.match(
    getStickerImportError({ name: 'sticker', type: 'image/png', size: 1024 }, MAX_STICKER_LIBRARY_BYTES, 'Pack') ?? '',
    /library is full/,
  );
});

test('requires a non-empty pack name', () => {
  assert.match(
    getStickerImportError({ name: 'sticker', type: 'image/png', size: 1024 }, 0, '  ') ?? '',
    /name for this sticker pack/,
  );
});

test('rejects duplicate pack names without treating case or whitespace as distinct', () => {
  assert.match(getStickerPackNameError('  My   Pack ', ['my pack']) ?? '', /already exists/);
  assert.equal(getStickerPackNameError('New pack', ['my pack']), undefined);
});
