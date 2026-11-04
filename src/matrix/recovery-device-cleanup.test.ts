import assert from 'node:assert/strict';
import test from 'node:test';
import { revokeRecoveryVerifier, writeRecoveryMarkerAfterCleanup } from './recovery-device-cleanup.ts';

function clients(deviceIds: string[]) {
  const calls: string[] = [];
  return {
    calls,
    deviceIds,
    primary: {
      async getDevices() {
        calls.push('getDevices');
        return { devices: deviceIds.map((device_id) => ({ device_id })) };
      },
      async deleteDevice(deviceId: string) {
        calls.push(`delete:${deviceId}`);
        const index = deviceIds.indexOf(deviceId);
        if (index >= 0) deviceIds.splice(index, 1);
      },
    },
    temporary: {
      async logout() {
        calls.push('logout');
      },
      stopClient() {
        calls.push('stopClient');
      },
    },
  };
}

const identity = {
  userId: '@partner1-dev:nymph-dev.localhost',
  primaryDeviceId: 'primary',
  temporaryDeviceId: 'verifier',
  password: 'account-password',
};

test('revokes only the temporary verifier and confirms every cleanup condition', async () => {
  const setup = clients(['primary', 'verifier']);
  const checks = {
    async cancelAuthorization() { setup.calls.push('cancelAuthorization'); },
    async isAccessTokenRejected() { setup.calls.push('tokenRejected'); return true; },
    async isNewLoginRejected() { setup.calls.push('newLoginRejected'); return true; },
  };

  await revokeRecoveryVerifier(setup.primary, setup.temporary, identity, checks);

  assert.deepEqual(setup.calls, [
    'cancelAuthorization',
    'logout',
    'stopClient',
    'delete:verifier',
    'tokenRejected',
    'newLoginRejected',
    'getDevices',
  ]);
  assert.deepEqual(setup.deviceIds, ['primary']);
});

test('does not revoke the primary device when the verifier ID matches it', async () => {
  const setup = clients(['primary']);
  await assert.rejects(
    revokeRecoveryVerifier(
      setup.primary,
      setup.temporary,
      { ...identity, temporaryDeviceId: identity.primaryDeviceId },
      {
        async cancelAuthorization() {},
        async isAccessTokenRejected() { return true; },
        async isNewLoginRejected() { return true; },
      },
    ),
    /invalid or primary-device identifier/,
  );
  assert.deepEqual(setup.calls, []);
});

test('fails closed when any verifier cleanup confirmation fails', async () => {
  const setup = clients(['primary', 'verifier']);
  await assert.rejects(
    revokeRecoveryVerifier(setup.primary, setup.temporary, identity, {
      async cancelAuthorization() {},
      async isAccessTokenRejected() { return true; },
      async isNewLoginRejected() { return false; },
    }),
    /newLoginRejected=failed/,
  );
  assert.deepEqual(setup.deviceIds, ['primary']);
});

test('does not write the recovery marker when verifier cleanup is incomplete', async () => {
  let markerWritten = false;
  await assert.rejects(
    writeRecoveryMarkerAfterCleanup(
      async () => {
        throw new Error('device revocation was not confirmed');
      },
      async () => {
        markerWritten = true;
      },
    ),
    /device revocation was not confirmed/,
  );
  assert.equal(markerWritten, false);
});
