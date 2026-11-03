import assert from 'node:assert/strict';
import test from 'node:test';
import { getDefaultHomeserver } from './homeserver.ts';

test('uses the explicitly configured homeserver when provided', () => {
  assert.equal(getDefaultHomeserver({
    configured: 'https://matrix.example.test',
    mode: 'production',
    platform: 'android',
    development: false,
  }), 'https://matrix.example.test');
});

test('uses localhost only for the Android debug mode', () => {
  assert.equal(getDefaultHomeserver({
    mode: 'android',
    platform: 'android',
    development: false,
  }), 'http://localhost:8008');
});

test('uses loopback for desktop development', () => {
  assert.equal(getDefaultHomeserver({
    mode: 'development',
    platform: 'web',
    development: true,
  }), 'http://127.0.0.1:8008');
});

test('does not silently configure a production build to use localhost', () => {
  assert.equal(getDefaultHomeserver({
    mode: 'production',
    platform: 'android',
    development: false,
  }), '');
});
