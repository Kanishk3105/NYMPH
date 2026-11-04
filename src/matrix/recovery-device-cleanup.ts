export interface RecoveryCleanupDeviceClient {
  getDevices(): Promise<{ devices: Array<{ device_id: string }> }>;
  deleteDevice(
    deviceId: string,
    auth: { type: 'm.login.password'; user: string; password: string },
  ): Promise<unknown>;
}

export interface RecoveryCleanupSessionClient {
  logout(stopClient?: boolean): Promise<unknown>;
  stopClient(): void;
}

export interface RecoveryCleanupChecks {
  cancelAuthorization(): Promise<void>;
  isAccessTokenRejected(): Promise<boolean>;
  isNewLoginRejected(): Promise<boolean>;
}

export async function writeRecoveryMarkerAfterCleanup(
  assertCleanupComplete: () => Promise<void>,
  writeMarker: () => Promise<void>,
): Promise<void> {
  await assertCleanupComplete();
  await writeMarker();
}

export async function revokeRecoveryVerifier(
  primaryDevice: RecoveryCleanupDeviceClient,
  temporarySession: RecoveryCleanupSessionClient,
  input: {
    userId: string;
    primaryDeviceId: string;
    temporaryDeviceId: string;
    password: string;
  },
  checks: RecoveryCleanupChecks,
): Promise<void> {
  if (
    !input.userId ||
    !input.password ||
    !input.primaryDeviceId ||
    !input.temporaryDeviceId ||
    input.primaryDeviceId === input.temporaryDeviceId
  ) {
    throw new Error('Recovery verifier cleanup refused an invalid or primary-device identifier.');
  }

  const results = {
    authorizationCancelled: false,
    sessionTerminated: false,
    deviceRevoked: false,
    deviceAbsent: false,
    tokenRejected: false,
    newLoginRejected: false,
  };
  try {
    await checks.cancelAuthorization();
    results.authorizationCancelled = true;
  } catch {
    // Continue attempting independent revocation steps before reporting failure.
  }
  try {
    await temporarySession.logout(false);
    results.sessionTerminated = true;
  } catch {
    // Device deletion below also revokes all access tokens for this device.
  } finally {
    temporarySession.stopClient();
  }
  try {
    await primaryDevice.deleteDevice(input.temporaryDeviceId, {
      type: 'm.login.password',
      user: input.userId,
      password: input.password,
    });
    results.deviceRevoked = true;
  } catch {
    // Still verify server state and the old access token before failing closed.
  }
  try {
    results.tokenRejected = await checks.isAccessTokenRejected();
  } catch {
    // A failed authorization check is not proof of revocation.
  }
  try {
    results.newLoginRejected = await checks.isNewLoginRejected();
  } catch {
    // A failed login check is not proof of revocation.
  }
  try {
    const devices = await primaryDevice.getDevices();
    results.deviceAbsent = !devices.devices.some((device) => device.device_id === input.temporaryDeviceId);
  } catch {
    // A failed device-list query is not proof of revocation.
  }

  if (Object.values(results).some((result) => !result)) {
    throw new Error(
      'Recovery verifier cleanup was not confirmed; recovery remains incomplete. ' +
      `Cleanup status: ${Object.entries(results).map(([operation, succeeded]) => `${operation}=${succeeded ? 'confirmed' : 'failed'}`).join(', ')}.`,
    );
  }
}
