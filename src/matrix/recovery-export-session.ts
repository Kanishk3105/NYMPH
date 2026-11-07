import {
  decryptRecoveryExport,
  encryptRecoveryExport,
  type RecoveryExportContents,
} from './recovery-export.ts';

export type RecoveryExportPassphrasePurpose = 'existing' | 'new';
export type RecoveryExportPassphraseRequest = (
  account: string,
  purpose: RecoveryExportPassphrasePurpose,
) => Promise<string> | string;
export type RecoveryExportValidator = (contents: RecoveryExportContents) => void;

export interface RecoveryExportSessionCrypto {
  decrypt(serialized: string, passphrase: string): Promise<RecoveryExportContents>;
  encrypt(contents: RecoveryExportContents, passphrase: string): Promise<string>;
}

const recoveryExportError = (account: string) =>
  new Error(
    `The supplied recovery-export passphrase did not unlock ${account}'s export. ` +
      'Use the original passphrase saved separately when the export was created, not the Matrix login password, ' +
      'Secret Storage recovery key, or NYMPH app PIN; also verify the encrypted export file.',
  );

export class RecoveryExportPassphraseSession {
  private readonly passphrases = new Map<string, string>();
  private readonly pending = new Map<string, Promise<void>>();
  private active = true;
  private readonly requestPassphrase: RecoveryExportPassphraseRequest;
  private readonly crypto: RecoveryExportSessionCrypto;

  public constructor(
    requestPassphrase: RecoveryExportPassphraseRequest,
    crypto: RecoveryExportSessionCrypto = {
      decrypt: decryptRecoveryExport,
      encrypt: encryptRecoveryExport,
    },
  ) {
    this.requestPassphrase = requestPassphrase;
    this.crypto = crypto;
  }

  public async decryptExport(
    account: string,
    serialized: string,
    validate: RecoveryExportValidator,
  ): Promise<RecoveryExportContents> {
    this.assertActive();
    const cachedPassphrase = this.passphrases.get(account);
    if (cachedPassphrase !== undefined) {
      return this.decryptAndValidate(account, serialized, cachedPassphrase, validate, true);
    }

    const pending = this.pending.get(account);
    if (pending) {
      await pending;
      this.assertActive();
      const validatedPassphrase = this.passphrases.get(account);
      if (validatedPassphrase === undefined) {
        throw new Error(`No validated recovery-export passphrase is available for ${account}.`);
      }
      return this.decryptAndValidate(account, serialized, validatedPassphrase, validate, true);
    }

    const operation = this.unlockExistingExport(account, serialized, validate);
    return this.runPending(account, operation);
  }

  public async createEncryptedExport(
    account: string,
    contents: RecoveryExportContents,
    validate: RecoveryExportValidator,
  ): Promise<string> {
    this.assertActive();
    const cachedPassphrase = this.passphrases.get(account);
    if (cachedPassphrase !== undefined) {
      return this.encryptAndValidate(account, contents, cachedPassphrase, validate, true);
    }

    const pending = this.pending.get(account);
    if (pending) {
      await pending;
      this.assertActive();
      const validatedPassphrase = this.passphrases.get(account);
      if (validatedPassphrase === undefined) {
        throw new Error(`No validated recovery-export passphrase is available for ${account}.`);
      }
      return this.encryptAndValidate(account, contents, validatedPassphrase, validate, true);
    }

    const operation = this.createAndValidateExport(account, contents, validate);
    return this.runPending(account, operation);
  }

  public clearAccount(account: string): void {
    this.passphrases.delete(account);
  }

  public finish(): void {
    this.active = false;
    this.passphrases.clear();
  }

  public cancel(): void {
    this.finish();
  }

  public logout(): void {
    this.finish();
  }

  private async unlockExistingExport(
    account: string,
    serialized: string,
    validate: RecoveryExportValidator,
  ): Promise<RecoveryExportContents> {
    const passphrase = await this.requestPassphrase(account, 'existing');
    this.assertActive();
    return this.decryptAndValidate(account, serialized, passphrase, validate, false);
  }

  private async createAndValidateExport(
    account: string,
    contents: RecoveryExportContents,
    validate: RecoveryExportValidator,
  ): Promise<string> {
    const passphrase = await this.requestPassphrase(account, 'new');
    this.assertActive();
    return this.encryptAndValidate(account, contents, passphrase, validate, false);
  }

  private async decryptAndValidate(
    account: string,
    serialized: string,
    passphrase: string,
    validate: RecoveryExportValidator,
    cached: boolean,
  ): Promise<RecoveryExportContents> {
    let contents: RecoveryExportContents;
    try {
      contents = await this.crypto.decrypt(serialized, passphrase);
    } catch {
      if (cached) this.clearAccount(account);
      throw recoveryExportError(account);
    }

    try {
      validate(contents);
      if (!cached) this.passphrases.set(account, passphrase);
      return contents;
    } catch (error) {
      contents.recoveryKey = '';
      throw error;
    }
  }

  private async encryptAndValidate(
    account: string,
    contents: RecoveryExportContents,
    passphrase: string,
    validate: RecoveryExportValidator,
    cached: boolean,
  ): Promise<string> {
    const serialized = await this.crypto.encrypt(contents, passphrase);
    const validated = await this.decryptAndValidate(account, serialized, passphrase, validate, cached);
    validated.recoveryKey = '';
    return serialized;
  }

  private async runPending<T>(account: string, operation: Promise<T>): Promise<T> {
    const completion = operation.then(() => undefined);
    void completion.catch(() => undefined);
    this.pending.set(account, completion);
    try {
      return await operation;
    } finally {
      if (this.pending.get(account) === completion) this.pending.delete(account);
    }
  }

  private assertActive(): void {
    if (!this.active) throw new Error('The recovery-export passphrase session has ended.');
  }
}
