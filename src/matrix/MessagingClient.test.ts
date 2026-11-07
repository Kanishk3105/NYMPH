import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeEnvelopeBody, encodeEnvelope, type NymphEnvelope } from './MessagingClient.ts';
import { encryptAttachment } from './encrypted-attachment.ts';

test('encodes the conversation mode and reply inside the event body', () => {
  const envelope: NymphEnvelope = {
    version: 1,
    id: 'event-1',
    mode: 'kinky',
    kind: 'text',
    text: 'A private note',
    sentAt: 1_800_000_000_000,
    replyTo: 'A previous note',
  };

  const decoded = decodeEnvelopeBody(encodeEnvelope(envelope), '@partner-a:example.test', '$event', 1_800_000_000_100);

  assert.deepEqual(decoded, {
    ...envelope,
    sender: '@partner-a:example.test',
    eventId: '$event',
    sentAt: 1_800_000_000_100,
  });
});

test('rejects events outside the NYMPH envelope format', () => {
  assert.equal(decodeEnvelopeBody('{"body":"plain text"}', '@partner:example.test', '$id', 10), undefined);
  assert.equal(
    decodeEnvelopeBody('nymph.v1:{"version":1,"id":"x","mode":"public","kind":"text","text":"x","sentAt":1}', '@partner:example.test', '$id', 10),
    undefined,
  );
});

test('keeps romantic, flirty, spicy, and kinky mode identifiers valid', () => {
  for (const mode of ['romantic', 'flirty', 'spicy', 'kinky'] as const) {
    const body = encodeEnvelope({ version: 1, id: mode, mode, kind: 'text', text: 'hello', sentAt: 20 });
    assert.equal(decodeEnvelopeBody(body, '@partner:example.test', `$${mode}`, 20)?.mode, mode);
  }
});

test('encodes and decodes custom mood pings with their encrypted-room mode context', () => {
  const mood: NymphEnvelope = {
    version: 1,
    id: 'mood-event',
    mode: 'spicy',
    kind: 'mood',
    text: '🌙 Dreaming of home',
    sentAt: 1_800_000_000_000,
  };
  assert.deepEqual(
    decodeEnvelopeBody(encodeEnvelope(mood), '@partner-b:example.test', '$mood-event', mood.sentAt),
    {
      ...mood,
      sender: '@partner-b:example.test',
      eventId: '$mood-event',
    },
  );
});

test('accepts a media envelope only when it contains a valid encrypted attachment reference', () => {
  const media: NymphEnvelope = {
    version: 1,
    id: 'media-1',
    mode: 'romantic',
    kind: 'media',
    text: 'photo.jpg',
    sentAt: 20,
    mediaName: 'photo.jpg',
    mediaType: 'image/jpeg',
    attachment: {
      v: 'v2',
      url: 'mxc://example.test/opaque-id',
      key: { alg: 'A256CTR', ext: true, k: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', key_ops: ['encrypt', 'decrypt'], kty: 'oct' },
      iv: 'AAAAAAAAAAAAAAAAAAAAAA==',
      hashes: { sha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    },
  };
  const decoded = decodeEnvelopeBody(encodeEnvelope(media), '@partner:example.test', '$media', 20);

  assert.equal(decoded?.kind, 'media');
  assert.equal(decoded?.attachment?.url, media.attachment?.url);
  assert.equal(
    decodeEnvelopeBody(
      'nymph.v1:{"version":1,"id":"x","mode":"romantic","kind":"media","text":"photo.jpg","sentAt":1}',
      '@partner:example.test',
      '$invalid-media',
      1,
    ),
    undefined,
  );
});

test('keeps encrypted media and thumbnail metadata inside the validated room envelope', async () => {
  const encrypted = await encryptAttachment(new TextEncoder().encode('generated media bytes'));
  const attachment = { ...encrypted.file, url: 'mxc://nymph-dev.localhost/private-media' };
  const envelope: NymphEnvelope = {
    version: 1,
    id: 'media-envelope',
    mode: 'romantic',
    kind: 'media',
    text: 'private photo',
    sentAt: 20,
    mediaType: 'image/png',
    mediaName: 'private.png',
    attachment,
    thumbnailAttachment: attachment,
  };

  const decoded = decodeEnvelopeBody(encodeEnvelope(envelope), '@partner:example.test', '$media', 20);
  assert.equal(decoded?.attachment?.url, attachment.url);
  assert.equal(decoded?.thumbnailAttachment?.url, attachment.url);
  assert.equal(
    decodeEnvelopeBody(
      `nymph.v1:${JSON.stringify({ ...envelope, attachment: undefined })}`,
      '@partner:example.test',
      '$invalid-thumbnail',
      20,
    ),
    undefined,
  );
});

test('preserves voice duration inside an encrypted media event envelope', () => {
  const voice: NymphEnvelope = {
    version: 1,
    id: 'voice-message',
    mode: 'flirty',
    kind: 'media',
    text: 'Voice message',
    sentAt: 20,
    mediaType: 'audio/webm;codecs=opus',
    mediaName: 'voice-note.webm',
    durationMs: 2345,
    waveform: [0.2, 0.6, 1],
    attachment: {
      v: 'v2',
      url: 'mxc://example.test/voice',
      key: { alg: 'A256CTR', ext: true, k: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', key_ops: ['encrypt', 'decrypt'], kty: 'oct' },
      iv: 'AAAAAAAAAAAAAAAAAAAAAA==',
      hashes: { sha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    },
  };
  assert.equal(
    decodeEnvelopeBody(encodeEnvelope(voice), '@partner:example.test', '$voice', 20)?.durationMs,
    voice.durationMs,
  );
  assert.deepEqual(
    decodeEnvelopeBody(encodeEnvelope(voice), '@partner:example.test', '$voice', 20)?.waveform,
    voice.waveform,
  );
  assert.equal(
    decodeEnvelopeBody(`nymph.v1:${JSON.stringify({ ...voice, durationMs: -1 })}`, '@partner:example.test', '$bad-duration', 20),
    undefined,
  );
  assert.equal(
    decodeEnvelopeBody(`nymph.v1:${JSON.stringify({ ...voice, waveform: [1.5] })}`, '@partner:example.test', '$bad-waveform', 20),
    undefined,
  );
});

test('preserves view-once timers and synchronized opening receipts', async () => {
  const encrypted = await encryptAttachment(new TextEncoder().encode('private view-once image'));
  const attachment = {
    ...encrypted.file,
    url: 'http://127.0.0.1:18008/_synapse/client/nymph/media/content/media-id',
  };
  const media: NymphEnvelope = {
    version: 1,
    id: 'one-view-media',
    mode: 'romantic',
    kind: 'media',
    text: 'one-view.png',
    sentAt: 20,
    mediaType: 'image/png',
    mediaName: 'one-view.png',
    attachment,
    viewOnceSeconds: 10,
    viewOncePendingExpiresAt: 30_000,
  };
  const opened: NymphEnvelope = {
    version: 1,
    id: 'open-receipt',
    mode: 'romantic',
    kind: 'text',
    text: '',
    sentAt: 30,
    viewOnceReceipt: { messageId: 'one-view-media', expiresAt: 10_030 },
  };
  const retention: NymphEnvelope = {
    version: 1,
    id: 'retention-update',
    mode: 'romantic',
    kind: 'text',
    text: '',
    sentAt: 40,
    retentionPolicy: { seconds: 604_800 },
  };

  const decodedMedia = decodeEnvelopeBody(encodeEnvelope(media), '@partner:example.test', '$media', 20);
  assert.equal(decodedMedia?.viewOnceSeconds, 10);
  assert.equal(decodedMedia?.viewOncePendingExpiresAt, 30_000);
  assert.deepEqual(
    decodeEnvelopeBody(encodeEnvelope(opened), '@partner:example.test', '$receipt', 30)?.viewOnceReceipt,
    { messageId: 'one-view-media', expiresAt: 10_030 },
  );
  assert.deepEqual(
    decodeEnvelopeBody(encodeEnvelope(retention), '@partner:example.test', '$retention', 40)?.retentionPolicy,
    { seconds: 604_800 },
  );
  assert.equal(
    decodeEnvelopeBody(
      `nymph.v1:${JSON.stringify({ ...media, kind: 'sticker' })}`,
      '@partner:example.test',
      '$invalid-timer',
      20,
    ),
    undefined,
  );
});

test('validates private sticker-pack sync metadata and adult context', () => {
  const pack: NymphEnvelope = {
    version: 1,
    id: 'pack-sync',
    mode: 'kinky',
    kind: 'sticker',
    text: '',
    sentAt: 20,
    stickerSync: {
      operation: 'pack-upsert',
      packId: 'private-pack',
      packName: 'After dark',
      adult: true,
      description: 'Private collection',
      categories: ['Fantasy'],
      coverStickerId: 'cover',
      stickerId: 'sticker-1',
      stickerName: 'Moon',
      stickerType: 'image/gif',
    },
  };
  assert.deepEqual(
    decodeEnvelopeBody(encodeEnvelope(pack), '@partner:example.test', '$pack', 20)?.stickerSync,
    pack.stickerSync,
  );
  assert.equal(
    decodeEnvelopeBody(
      `nymph.v1:${JSON.stringify({ ...pack, stickerSync: { operation: 'pack-upsert', packId: 5 } })}`,
      '@partner:example.test',
      '$invalid-pack',
      20,
    ),
    undefined,
  );
});
