import assert from 'node:assert/strict';
import test from 'node:test';
import { getThumbnailDimensions } from './media-thumbnail.ts';

test('scales wide and tall media previews without enlarging small sources', () => {
  assert.deepEqual(getThumbnailDimensions(1920, 1080), { width: 480, height: 270 });
  assert.deepEqual(getThumbnailDimensions(600, 1200), { width: 240, height: 480 });
  assert.deepEqual(getThumbnailDimensions(320, 180), { width: 320, height: 180 });
});

test('rejects invalid media dimensions', () => {
  assert.throws(() => getThumbnailDimensions(0, 12), /positive finite values/);
  assert.throws(() => getThumbnailDimensions(12, Number.NaN), /positive finite values/);
});
