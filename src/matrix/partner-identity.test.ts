import assert from 'node:assert/strict';
import test from 'node:test';
import { getPartnerIdentities } from './partner-identity.ts';

test('defaults local development to the isolated development accounts', () => {
  assert.deepEqual(getPartnerIdentities({
    mode: 'development',
    development: true,
  }), {
    partnerA: '@partner1-dev:localhost',
    partnerB: '@partner2-dev:localhost',
  });
});

test('uses explicitly configured identities for the selected environment', () => {
  assert.deepEqual(getPartnerIdentities({
    partnerA: '@a:matrix.example',
    partnerB: '@b:matrix.example',
    mode: 'production',
    development: false,
  }), {
    partnerA: '@a:matrix.example',
    partnerB: '@b:matrix.example',
  });
});

test('does not silently select local development identities in production', () => {
  assert.deepEqual(getPartnerIdentities({
    mode: 'production',
    development: false,
  }), {
    partnerA: '',
    partnerB: '',
  });
});
