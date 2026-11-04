import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeEnvelopeBody, encodeEnvelope, type NymphEnvelope } from './MessagingClient.ts';

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
