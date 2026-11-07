import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RecoveryExportPassphraseSession,
  type RecoveryExportPassphrasePurpose,
} from './recovery-export-session.ts';
import type { RecoveryExportContents } from './recovery-export.ts';

const partnerA = '@partner-a:example.test';
const partnerB = '@partner-b:example.test';
const mockPassphraseA = 'mock-partner-a-passphrase';
const mockPassphraseB = 'mock-partner-b-passphrase';
const encryptedExportA = 'encrypted-export-a';
const encryptedExportB = 'encrypted-export-b';

function makeCrypto(
  passphrases: Map<string, string>,
  decryptCalls: string[] = [],
) {
  const generatedExports = new Map<string, RecoveryExportContents>();
  return {
    async decrypt(serialized: string, passphrase: string): Promise<RecoveryExportContents> {
      decryptCalls.push(serialized);
      const generatedExport = generatedExports.get(serialized);
      const owner = generatedExport?.account ?? (serialized === encryptedExportA ? partnerA : partnerB);
      if (passphrases.get(owner) !== passphrase) throw new Error('Authentication failed.');
      return generatedExport
        ? { ...generatedExport }
        : { account: owner, keyId: `key-${owner}`, recoveryKey: `mock-key-${owner}` };
    },
    async encrypt(contents: RecoveryExportContents, passphrase: string): Promise<string> {
      passphrases.set(contents.account, passphrase);
      const serialized = `encrypted-${contents.account}`;
      generatedExports.set(serialized, { ...contents });
      return serialized;
    },
  };
}

function assertAccount(contents: RecoveryExportContents, account: string): void {
  assert.equal(contents.account, account);
}

function makeRequest(
  requested: Array<{ account: string; purpose: RecoveryExportPassphrasePurpose }>,
  passphrases: Map<string, string>,
) {
  return (account: string, purpose: RecoveryExportPassphrasePurpose) => {
    requested.push({ account, purpose });
    const passphrase = passphrases.get(account);
    if (!passphrase) throw new Error(`No mock credential for ${account}.`);
    return passphrase;
  };
}

test('requests Partner A passphrase once and reuses it for later recovery operations', async () => {
  const credentials = new Map([[partnerA, mockPassphraseA]]);
  const requested: Array<{ account: string; purpose: RecoveryExportPassphrasePurpose }> = [];
  const session = new RecoveryExportPassphraseSession(makeRequest(requested, credentials), {
    ...makeCrypto(credentials),
  });

  const first = await session.decryptExport(partnerA, encryptedExportA, (contents) =>
    assertAccount(contents, partnerA),
  );
  first.recoveryKey = '';
  const second = await session.decryptExport(partnerA, encryptedExportA, (contents) =>
    assertAccount(contents, partnerA),
  );

  assert.equal(second.account, partnerA);
  assert.deepEqual(requested, [{ account: partnerA, purpose: 'existing' }]);
  session.finish();
});

test('requests Partner B passphrase once and reuses it only for Partner B', async () => {
  const credentials = new Map([[partnerB, mockPassphraseB]]);
  const requested: Array<{ account: string; purpose: RecoveryExportPassphrasePurpose }> = [];
  const session = new RecoveryExportPassphraseSession(makeRequest(requested, credentials), {
    ...makeCrypto(credentials),
  });

  await session.decryptExport(partnerB, encryptedExportB, (contents) => assertAccount(contents, partnerB));
  await session.decryptExport(partnerB, encryptedExportB, (contents) => assertAccount(contents, partnerB));

  assert.deepEqual(requested, [{ account: partnerB, purpose: 'existing' }]);
  session.finish();
});

test('keeps Partner A and Partner B passphrases isolated', async () => {
  const credentials = new Map([
    [partnerA, mockPassphraseA],
    [partnerB, mockPassphraseB],
  ]);
  const requested: Array<{ account: string; purpose: RecoveryExportPassphrasePurpose }> = [];
  const session = new RecoveryExportPassphraseSession(makeRequest(requested, credentials), {
    ...makeCrypto(credentials),
  });

  await session.decryptExport(partnerA, encryptedExportA, (contents) => assertAccount(contents, partnerA));
  await session.decryptExport(partnerB, encryptedExportB, (contents) => assertAccount(contents, partnerB));
  await session.decryptExport(partnerA, encryptedExportA, (contents) => assertAccount(contents, partnerA));

  assert.deepEqual(requested, [
    { account: partnerA, purpose: 'existing' },
    { account: partnerB, purpose: 'existing' },
  ]);
  session.finish();
});

test('does not cache a passphrase until decrypt and account validation succeed', async () => {
  const credentials = new Map([[partnerA, mockPassphraseA]]);
  const requested: Array<{ account: string; purpose: RecoveryExportPassphrasePurpose }> = [];
  const session = new RecoveryExportPassphraseSession(makeRequest(requested, credentials), {
    ...makeCrypto(credentials),
  });

  await assert.rejects(
    session.decryptExport(partnerA, encryptedExportA, () => {
      throw new Error('The export belongs to another account.');
    }),
    /another account/,
  );
  await session.decryptExport(partnerA, encryptedExportA, (contents) => assertAccount(contents, partnerA));

  assert.equal(requested.length, 2);
  session.finish();
});

test('stops once with a clear error on incorrect passphrase and does not retry decryption', async () => {
  const requested: Array<{ account: string; purpose: RecoveryExportPassphrasePurpose }> = [];
  let decryptCalls = 0;
  const session = new RecoveryExportPassphraseSession(
    () => {
      requested.push({ account: partnerA, purpose: 'existing' });
      return 'mock-incorrect-passphrase';
    },
    {
      async decrypt() {
        decryptCalls += 1;
        throw new Error('Authentication failed.');
      },
      async encrypt() {
        throw new Error('Unexpected encryption.');
      },
    },
  );

  await assert.rejects(
    session.decryptExport(partnerA, encryptedExportA, (contents) => assertAccount(contents, partnerA)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /supplied recovery-export passphrase did not unlock @partner-a:example\.test's export/);
      assert.match(error.message, /original passphrase saved separately/);
      assert.doesNotMatch(error.message, /mock-incorrect-passphrase/);
      return true;
    },
  );
  assert.equal(decryptCalls, 1);
  assert.equal(requested.length, 1);
  session.finish();
});

test('does not prompt or retry after a cached passphrase cannot unlock another export', async () => {
  const credentials = new Map([[partnerA, mockPassphraseA]]);
  const requested: Array<{ account: string; purpose: RecoveryExportPassphrasePurpose }> = [];
  let decryptCalls = 0;
  const crypto = makeCrypto(credentials, []);
  const session = new RecoveryExportPassphraseSession(makeRequest(requested, credentials), {
    ...crypto,
    async decrypt(serialized, passphrase) {
      decryptCalls += 1;
      if (serialized === 'tampered-export') throw new Error('Authentication failed.');
      return crypto.decrypt(serialized, passphrase);
    },
  });

  await session.decryptExport(partnerA, encryptedExportA, (contents) => assertAccount(contents, partnerA));
  await assert.rejects(
    session.decryptExport(partnerA, 'tampered-export', (contents) => assertAccount(contents, partnerA)),
    /supplied recovery-export passphrase did not unlock @partner-a:example\.test's export/,
  );
  assert.equal(decryptCalls, 2);
  assert.equal(requested.length, 1);
  session.finish();
});

test('clears cached references after cancellation', async () => {
  const credentials = new Map([[partnerA, mockPassphraseA]]);
  const requested: Array<{ account: string; purpose: RecoveryExportPassphrasePurpose }> = [];
  const session = new RecoveryExportPassphraseSession(makeRequest(requested, credentials), {
    ...makeCrypto(credentials),
  });
  await session.decryptExport(partnerA, encryptedExportA, (contents) => assertAccount(contents, partnerA));

  session.cancel();
  await assert.rejects(
    session.decryptExport(partnerA, encryptedExportA, (contents) => assertAccount(contents, partnerA)),
    /session has ended/,
  );
  assert.equal(requested.length, 1);
});

test('clears cached references after successful recovery completion', async () => {
  const credentials = new Map([[partnerA, mockPassphraseA]]);
  const requested: Array<{ account: string; purpose: RecoveryExportPassphrasePurpose }> = [];
  const session = new RecoveryExportPassphraseSession(makeRequest(requested, credentials), {
    ...makeCrypto(credentials),
  });
  await session.decryptExport(partnerA, encryptedExportA, (contents) => assertAccount(contents, partnerA));

  session.finish();
  await assert.rejects(
    session.decryptExport(partnerA, encryptedExportA, (contents) => assertAccount(contents, partnerA)),
    /session has ended/,
  );
  assert.equal(requested.length, 1);
});

test('clears cached references on logout', async () => {
  const credentials = new Map([[partnerA, mockPassphraseA]]);
  const requested: Array<{ account: string; purpose: RecoveryExportPassphrasePurpose }> = [];
  const session = new RecoveryExportPassphraseSession(makeRequest(requested, credentials), {
    ...makeCrypto(credentials),
  });
  await session.decryptExport(partnerA, encryptedExportA, (contents) => assertAccount(contents, partnerA));

  session.logout();
  await assert.rejects(
    session.decryptExport(partnerA, encryptedExportA, (contents) => assertAccount(contents, partnerA)),
    /session has ended/,
  );
  assert.equal(requested.length, 1);
});

test('a fresh independent session requests the account passphrase again', async () => {
  const credentials = new Map([[partnerA, mockPassphraseA]]);
  const requested: Array<{ account: string; purpose: RecoveryExportPassphrasePurpose }> = [];
  const makeSession = () => new RecoveryExportPassphraseSession(makeRequest(requested, credentials), {
    ...makeCrypto(credentials),
  });

  const firstSession = makeSession();
  await firstSession.decryptExport(partnerA, encryptedExportA, (contents) => assertAccount(contents, partnerA));
  firstSession.finish();
  const nextSession = makeSession();
  await nextSession.decryptExport(partnerA, encryptedExportA, (contents) => assertAccount(contents, partnerA));

  assert.equal(requested.length, 2);
  nextSession.finish();
});

test('repeated recovery calls in one UI render lifecycle do not reopen the dialog', async () => {
  const credentials = new Map([[partnerA, mockPassphraseA]]);
  const requested: Array<{ account: string; purpose: RecoveryExportPassphrasePurpose }> = [];
  const session = new RecoveryExportPassphraseSession(makeRequest(requested, credentials), {
    ...makeCrypto(credentials),
  });

  for (let render = 0; render < 5; render += 1) {
    await session.decryptExport(partnerA, encryptedExportA, (contents) => assertAccount(contents, partnerA));
  }

  assert.equal(requested.length, 1);
  session.finish();
});

test('coalesces duplicate concurrent recovery handlers into one prompt', async () => {
  const credentials = new Map([[partnerA, mockPassphraseA]]);
  const requested: Array<{ account: string; purpose: RecoveryExportPassphrasePurpose }> = [];
  const session = new RecoveryExportPassphraseSession(makeRequest(requested, credentials), {
    ...makeCrypto(credentials),
  });
  const validate = (contents: RecoveryExportContents) => assertAccount(contents, partnerA);

  await Promise.all([
    session.decryptExport(partnerA, encryptedExportA, validate),
    session.decryptExport(partnerA, encryptedExportA, validate),
  ]);

  assert.equal(requested.length, 1);
  session.finish();
});

test('prompts lazily only for an export that is actually processed', async () => {
  const credentials = new Map([[partnerA, mockPassphraseA]]);
  const requested: Array<{ account: string; purpose: RecoveryExportPassphrasePurpose }> = [];
  const session = new RecoveryExportPassphraseSession(makeRequest(requested, credentials), {
    ...makeCrypto(credentials),
  });

  await session.decryptExport(partnerA, encryptedExportA, (contents) => assertAccount(contents, partnerA));

  assert.deepEqual(requested, [{ account: partnerA, purpose: 'existing' }]);
  session.finish();
});

test('validates a new export before caching its new passphrase', async () => {
  const credentials = new Map([[partnerB, mockPassphraseB]]);
  const requested: Array<{ account: string; purpose: RecoveryExportPassphrasePurpose }> = [];
  const session = new RecoveryExportPassphraseSession(makeRequest(requested, credentials), {
    ...makeCrypto(credentials),
  });

  const serialized = await session.createEncryptedExport(
    partnerB,
    { account: partnerB, keyId: 'key-b', recoveryKey: 'mock-key-b' },
    (contents) => {
      assert.equal(contents.account, partnerB);
      assert.equal(contents.keyId, 'key-b');
    },
  );
  const contents = await session.decryptExport(partnerB, serialized, (value) => assertAccount(value, partnerB));

  assert.equal(contents.recoveryKey, 'mock-key-b');
  assert.deepEqual(requested, [{ account: partnerB, purpose: 'new' }]);
  session.finish();
});
