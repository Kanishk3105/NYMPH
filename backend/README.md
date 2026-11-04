# NYMPH Matrix deployment

This directory contains a pinned Synapse/PostgreSQL deployment for an always-on Linux host, plus a separate loopback-only SQLite development setup. The homeserver administrator remains a trusted infrastructure operator and can access server data, account controls, and backups. End-to-end encryption protects message contents from the homeserver, not metadata or the infrastructure operator.

## Production host

Use a supported, always-on Linux server with a stable public DNS name. Point the `A`/`AAAA` records for `MATRIX_SERVER_NAME` at that host and allow inbound TCP ports 80 and 443 (and UDP 443 for HTTP/3). Do not expose Synapse port 8008, PostgreSQL, or the Synapse Admin API directly. `Caddy` is the only service with published ports; it obtains and renews HTTPS certificates.

The Compose file pins Synapse `v1.164.2`, PostgreSQL `16.10-alpine`, and Caddy `2.10.2-alpine`. Before creating accounts or rooms:

1. Copy `.env.example` to `.env` and set `MATRIX_SERVER_NAME` to the permanent DNS hostname (hostname only, not a URL). The Matrix server name cannot be changed after accounts and rooms exist.
2. Create the secrets directory and two high-entropy secret files on the host. Do not commit these files or paste their contents into the app:

   ```sh
   umask 077
   mkdir -p secrets
   openssl rand -hex 32 > secrets/postgres_password
   openssl rand -hex 32 > secrets/registration_shared_secret
   chmod 600 secrets/postgres_password secrets/registration_shared_secret
   ```

3. Generate Synapse's initial signing key and configuration:

   ```sh
   docker compose --profile init run --rm synapse-generate
   ```

4. Start the production services:

   ```sh
   docker compose up -d
   docker compose ps
   docker compose logs --tail=100 synapse caddy
   ```

The PostgreSQL service initializes with UTF-8 encoding and `C` collation as required by Synapse. The Synapse startup configurator converts the generated database configuration to PostgreSQL, disables registration and guest access, prevents non-admin invitations, disables public-room publication, empties the federation allowlist, and removes the federation API from the listener. It writes the resulting configuration with owner-only permissions. Do not publish the registration shared secret; use it only from a local administrator session to provision accounts.

The Caddy proxy returns 404 for the complete `/_synapse/admin` path (including the informational `server_version` endpoint), Matrix client admin paths, and public room creation. The Synapse and PostgreSQL services have no host-published ports. This is network-layer hardening, not a substitute for Synapse-side authorization, and a Docker/server administrator can still access internal services. Synapse itself may return version metadata from `GET /_synapse/admin/v1/server_version` without authentication; this response is informational, not proof of administrative access. Representative user- and room-management routes and an administrative POST operation reject unauthenticated requests with 401.

## Local development

The original local-only environment uses `@partner1:localhost` and `@partner2:localhost`. For the Stage 3H additive migration these are the archived identities, not the new development pair. `start-dev.ps1` is the legacy environment bootstrapper; do not run it as part of the additive migration. `localhost` is a development-only server name: it is not publicly resolvable, must not be used for production, and cannot later be renamed without migrating/recreating the Matrix identities and room.

Run the PowerShell setup script from the repository root:

```powershell
.\backend\start-dev.ps1
```

It creates random local-only passwords and a registration secret under the ignored `backend/dev-secrets/` directory, generates the Synapse config if needed, starts the pinned SQLite service, disables public registration, guests, room discovery and federation, and provisions exactly the two regular partner accounts. It creates no administrator account. To let the one-time local bootstrap invite partner B, `block_non_admin_invites` is disabled only in this development config; the server-side policy module restricts invites to partner A inviting partner B. The local-only login throttle allows a small burst of repeated test logins while remaining enabled; production Synapse rate limits are not changed. The production scaffold keeps non-admin invites disabled. The password files stay on this machine and are never printed by the script. Keep the directory private and never copy these credentials to production.

The base service binds only to `127.0.0.1:8008`. Synapse's development policy module permits one private, non-federatable, invite-only encrypted room, one invite from partner1 to partner2, and no other room members. It also exposes a short-lived, single-use pairing invitation endpoint. Redeeming an invitation yields a Synapse `m.login.token` that is itself one-time and short-lived; the QR payload never contains a permanent access token. This is local development code, not a production-ready invitation store or Android credential store.

### Stage 3I isolated Matrix browser acceptance test

The canonical Playwright configuration is `playwright.matrix.config.ts`; both `npm run test:matrix:live` and the compatibility alias `npm run test:matrix:dev-live` select only `tests/e2e/matrix-dev-live.spec.ts`. The legacy archived-account spec is skipped and excluded by the canonical config. Do not run `start-dev.ps1` for this suite.

The test configuration and browser harness read only `backend/.env.dev.isolated` and require this exact deployment:

- Homeserver URL: `http://127.0.0.1:18008`
- Matrix server name: `nymph-dev.localhost`
- Partner A: `@partner1-dev:nymph-dev.localhost`
- Partner B: `@partner2-dev:nymph-dev.localhost`

Missing or mismatched isolated settings fail closed; there is no legacy endpoint or identity fallback. Configuration validation and Playwright discovery do not require credentials and do not contact Synapse.

After the isolated partner accounts, private room, Secret Storage, cross-signing, and encrypted recovery exports already exist, an explicitly authorized live run needs process-local variables:

- `NYMPH_E2E_PARTNER1_PASSWORD`, `NYMPH_E2E_PARTNER2_PASSWORD`
- `NYMPH_E2E_PARTNER1_RECOVERY_KEY`, `NYMPH_E2E_PARTNER2_RECOVERY_KEY`
- `NYMPH_E2E_PARTNER1_RECOVERY_EXPORT_PASSPHRASE`, `NYMPH_E2E_PARTNER2_RECOVERY_EXPORT_PASSPHRASE`

Matrix recovery keys and encrypted-export passphrases are different credential types. Each encrypted export is read from the isolated secrets directory, decrypted with its own passphrase, and checked against its account and supplied recovery key. The acceptance test never generates keys, bootstraps a missing identity, reads legacy credentials, or prints secret values. Supply credentials through the local process environment only; do not put them in source, environment files, shell command text, or chat history.

Each partner uses a distinct persistent Chrome user-data directory, device ID, IndexedDB database, and encrypted Rust crypto store under `.matrix-e2e/isolated-stage-3i/`. Those directories must be preserved for restart-persistence validation. The test runs serially with one worker, waits up to 120 seconds for Matrix operations, and disables traces, screenshots, and video. It validates existing recovery and cross-signing state, invitation replay rejection, SAS comparison and confirmation, device trust, encrypted messages in all four modes, restart recovery, and revocation of a test-only device. The device-revocation check does not revoke either configured partner device.

Code-only checks:

```powershell
npm run validate:matrix-e2e-config
npm run test:matrix:live -- --list
```

These are safe without Matrix credentials. The live acceptance test itself is intentionally not run as part of code review or ordinary validation; it performs authenticated Matrix operations and requires separate explicit authorization.

Android debug builds use `http://localhost:8008` only in Vite's `android` mode by default, with cleartext allowed only for `localhost` in the debug Network Security Config. Stage 3H.1 app-local configuration overrides this with the isolated endpoint on port 18008. Release networking denies cleartext. The Capacitor WebView origin is `https://localhost`; the custom pairing endpoint's development allowlist includes that exact origin. The isolated browser integration harness uses `http://127.0.0.1:5174`, which is separately allowlisted for local testing. Synapse 1.164.2's built-in Matrix API uses a wildcard CORS response; CORS is not an authentication boundary.

For production, set `VITE_MATRIX_HOMESERVER` to the eventual deployed HTTPS URL and run `npm run android:release`. The release command rejects an unset or loopback URL. No permanent hostname, signing key, or hosting credentials are supplied here; release APK signing still requires the owner's signing configuration.

Run the local server-policy tests inside the pinned Synapse image with `docker exec nymph-local-dev-synapse-1 python -m unittest discover -s /tests`. They cover room creation constraints, server-side membership/invite checks, and expired or reused pairing invitations.

Room creation and membership enforcement must be tested before using private content. The setup script provisions only the local accounts; the live browser integration suite exercises two independent Matrix clients, but not physical devices.

## Two-partner policy and enrollment status

The legacy local development setup provisions only `@partner1:localhost`, `@partner2:localhost`, and their archived private encrypted room. The production deployment scaffold is not a completed private two-person service. The app has a development Partner 1 password sign-in, a one-time QR invitation flow for Partner 2, and Matrix SDK device-verification/cross-signing controls. The archived-account Playwright suite is disabled and excluded from the canonical config; do not run it against the legacy service. Physical Android UI and storage behavior also remain untested. No production partner credentials are embedded in the frontend.

### Stage 3H.1 isolated development environment (prepared, not provisioned)

The original SQLite Synapse instance, its `@partner1:localhost` / `@partner2:localhost` identities, encrypted room, policy state, backups, and browser profiles are the archived environment. The Stage 3H.1 deployment uses a distinct Synapse server name (`nymph-dev.localhost`), client URL (`http://127.0.0.1:18008`), Compose project (`nymph-stage3h1-dev`), PostgreSQL database, policy database, secrets directory (`backend/dev-isolated/secrets`), and persistent Docker volumes (`nymph-stage3h1-dev-postgres-data` and `nymph-stage3h1-dev-synapse-data`). It uses an internal database network and a separate API bridge; federation, registration, and public room discovery are disabled. The dev-only policy omits archived account IDs and uses a separate policy table/database.

The isolated environment files are [`compose.dev.isolated.yaml`](./compose.dev.isolated.yaml), [`.env.dev.isolated.example`](./.env.dev.isolated.example), and [`configure_isolated_dev_synapse.py`](./configure_isolated_dev_synapse.py). `start-isolated-dev.ps1` can prepare/start only this separate deployment; it does not provision Matrix accounts, rooms, or recovery keys. Stage 3H.1 runtime validation has started only the isolated Synapse and PostgreSQL services. Both are healthy; no development partner accounts, rooms, or recovery keys have been created. Synapse's tested room-management Admin API route rejects unauthenticated access; the server-version metadata route is unauthenticated, and the homeserver is published only on loopback.

The Stage 3H.1 provisioner is [`provision-dev-partners.ps1`](./provision-dev-partners.ps1). It has not been run. Its `-WhatIf` path only prints a plan; actual provisioning additionally requires `-ConfirmProvisioning`, typing exactly `PROVISION ISOLATED NYMPH DEV MATRIX`, and accepting each `ShouldProcess` confirmation. The plan includes the encrypted pre-provision backup, two account reconciliations, one encrypted invite-only room, app-local configuration, and an external operation journal. Existing development accounts are not password-reset; inconsistent existing room state causes a stop rather than room recreation. Failure reporting scopes rollback only to explicitly journaled development resources and never to the archived environment.

The backup utility, [`backup-isolated-dev.ps1`](./backup-isolated-dev.ps1), encrypts a staged backup with Node's scrypt-derived AES-256-GCM implementation, authenticates the ciphertext without writing a decrypted verification copy, and verifies a per-file SHA-256 manifest. Before changing resources, it presents one complete `ShouldProcess` confirmation; declining it exits without mutations. Its passphrase is entered twice for confirmation in a local Windows Forms dialog with a masked, paste-enabled field, and must be at least 12 characters. Nothing is stored in Credential Manager. The utility does not set PowerShell aliases; running with `-NoProfile` also avoids unrelated alias prompts from a caller's PowerShell profile. The restore test runs `pg_amcheck`, validates the restored schema, and confirms that the pre-provision database still has zero accounts and rooms. The commands below assume the backup file is `C:\Users\kanis\NYMPH-Backups\nymph-stage3h1-dev-runtime.enc`; run **only one matching pair**, and do not run RestoreTest unless Create completed successfully.

From the repository root (`C:\NYMPH`):

```powershell
powershell.exe -NoProfile -File .\backend\backup-isolated-dev.ps1 -Mode Create -BackupPath "$HOME\NYMPH-Backups\nymph-stage3h1-dev-runtime.enc"
powershell.exe -NoProfile -File .\backend\backup-isolated-dev.ps1 -Mode RestoreTest -BackupPath "$HOME\NYMPH-Backups\nymph-stage3h1-dev-runtime.enc"
```

From the backend directory (`C:\NYMPH\backend`):

```powershell
powershell.exe -NoProfile -File .\backup-isolated-dev.ps1 -Mode Create -BackupPath "$HOME\NYMPH-Backups\nymph-stage3h1-dev-runtime.enc"
powershell.exe -NoProfile -File .\backup-isolated-dev.ps1 -Mode RestoreTest -BackupPath "$HOME\NYMPH-Backups\nymph-stage3h1-dev-runtime.enc"
```

The passphrase must be entered directly into the masked Windows dialog; it is never passed in command arguments, written to a file, or printed. Create asks twice to catch entry mistakes; RestoreTest asks for the same passphrase again. The resulting encrypted file ACL is restricted to the current Windows user and SYSTEM. `-WhatIf` prints the plan; a normal run has one approval prompt for the complete operation rather than one prompt per step. RestoreTest uses newly generated disposable containers and volumes only; it never uses the original development storage or legacy resources. It installs PostgreSQL's `amcheck` extension only in the disposable restored database before checking it. Disposable resources are removed unconditionally if created, and cleanup failures identify only those unique resource names. Staging files are overwritten and deletion is verified, but Windows filesystems, SSD wear-leveling, snapshots, and copy-on-write storage do not guarantee secure erasure. Closed crypto profiles are included when the isolated profile directory exists; the encrypted inventory records if none existed. Keep encrypted backups outside the repository and retain the passphrase offline.

To inspect the deployment plan without side effects:

```powershell
.\backend\start-isolated-dev.ps1 -WhatIf
.\backend\provision-dev-partners.ps1 -WhatIf
.\backend\backup-isolated-dev.ps1 -Mode RestoreTest -BackupPath 'E:\NYMPH-Backups\backup.enc' -WhatIf
```

For later use only, after reviewing the deployment and receiving explicit approval, start the isolated infrastructure and then run the separately approved provisioner. No production hosting or account migration is part of this development setup.

The isolated Matrix browser acceptance suite is documented above under “Stage 3I isolated Matrix browser acceptance test.” Its credentials come only from the named process environment variables; it does not read local partner passwords or automatically provision accounts. Keep the live command disabled until the separate runtime authorization is given.

`block_non_admin_invites`, a private room, and a client-side member check are not enough to enforce an exact two-person allowlist. The local development module uses Synapse's supported spam-checker callbacks `user_may_create_room`, `user_may_invite`, `user_may_join_room`, and `check_event_for_spam`; the API is present in pinned Synapse 1.164.2. Its `on_new_event` callback records the newly created room ID after Synapse persists the validated creation event, so later membership checks are bound to that room. It also uses `ModuleApi.create_login_token` (available since 1.69.0) for the second, one-time login credential. The module limits its local policy state to one created room and checks private/invite-only/encrypted room settings. The more generic third-party `check_event_allowed` callback is documented as very experimental and is not used.

In local development, `block_non_admin_invites` is disabled only because the bootstrap client must invite partner B; the module restricts that action to partner A inviting partner B. The production scaffold keeps non-admin invitations disabled. Policy unit tests cover invite/join restrictions and pairing-token expiry/reuse, and local API checks confirmed both accounts can log in, the room is encrypted and invite-only, a third-user invite is rejected, and partner B cannot create another room. An actual join attempt by a separately provisioned unauthorized account and a federation join have not been tested. The administrator remains trusted and can override any room policy. Registration remains disabled; account creation must be performed by an administrator through the local Synapse provisioning process, never by exposing admin credentials to either phone.

Synapse device verification is distinct from app invitation redemption. The local pairing endpoint is not a replacement for Matrix device verification. The app uses the SDK's `VerificationRequest` flow for SAS emoji/decimal or QR verification, explicit confirmation, cross-signing bootstrap, key-change status, and device revocation controls. The Stage 3I PC live suite is prepared to validate SAS and cross-signing between isolated browser profiles but has not been run. On Android, the app stores the Matrix session and a random 32-byte Rust crypto-store key in `@aparajita/capacitor-secure-storage`, which encrypts values with an Android Keystore-generated AES-GCM key. The Rust crypto store itself remains in persistent IndexedDB and uses that random key for its SDK-supported encrypted storage. The six-digit app PIN is not used as the crypto-store key. Device IDs are saved and passed back to the SDK so the same device identity and per-device store are restored after restart. Android persistence still requires physical-device restart-and-decrypt validation.

The app also uses native biometrics/device credentials for the app lock, a native `FLAG_SECURE` window, and background relocking. These protections are not substitutes for verifying device identity. The development policy uses Synapse 1.164.2's `check_login_for_spam` callback to admit only each dev account's first device or explicitly authorized replacement. It stores one active device ID per dev account; after the new device authenticates and deletes the old Matrix device, an authenticated activation switches the server-side active ID. The old device's existing access tokens are revoked by Synapse device deletion, and subsequent logins with its ID are rejected. This design is local-development only and has not been validated against a running Synapse in this workspace; do not use it as production enforcement.

The recovery-verification marker is account data containing only the default Secret Storage key ID, verification time, and the three public cross-signing key IDs. It is written only after the separate-device restore succeeds and the temporary test device is revoked. A changed default key or cross-signing identity invalidates the displayed verified status. Recovery keys, decrypted secrets, and export passphrases are never put in account data.

## Backups and recovery

Back up PostgreSQL consistently, the Synapse data volume (signing key, media, and config), the Caddy data volume (ACME state), and both secret files. A basic database dump can be made with `docker compose exec -T postgres pg_dump -U synapse -d synapse > synapse.sql`; use a volume-aware backup tool for the named volumes. Encrypt backups and keep them off-host. Test restoration to an isolated host before relying on them. Never rotate or lose the Synapse signing key without following Synapse's documented key-rotation/recovery procedure. Database snapshots alone do not include media or signing keys.

Before any Matrix recovery operation, preserve the Synapse persistent data and each browser profile's IndexedDB crypto store. The Stage 3F metadata audit created an ignored, local snapshot under `backend/dev-backups/recovery-audit-*`; its SQLite copy passed `PRAGMA integrity_check`, and the copied Synapse/profile file counts were verified. This is a local safeguard, not an encrypted off-host backup or a tested restore.

## Current limitations

- The production scaffold has not been started against a real public hostname or an always-on server; it is separate from the local Stage 3H.1 policy deployment.
- The legacy live test still targets only the archived accounts and requires their original recovery keys; do not use it for the dev migration. The Stage 3H.1 scripts and acceptance-test configuration are prepared but have not provisioned accounts or a room. Docker Engine is unavailable, so no services were started, no encrypted environment backup/restore was performed, and the Synapse policy tests or real Matrix acceptance test could not run. Static Compose validation, eight Pester safety tests, 21 Node tests, and the production frontend build pass. Server-side room/device policy, new recovery setup, SAS, encrypted message exchange, restart persistence, and device revocation remain runtime-unverified.
- Android debug packaging was previously built, but this is not physical-device validation. Per the current testing strategy, no phone, USB, ADB-reverse, or emulator testing is being performed; native UI, biometric, Keystore persistence, background locking, and screenshot protection still require later device validation.
- The one-active-device and recovery-verifier admission policy has focused unit tests, but they still need to run in the pinned Synapse container before the server-side enforcement can be treated as verified.
- Photo/video/voice transfer, push notifications, server-side retention, and media deletion remain unimplemented. Push configuration and production signing credentials also require owner-provided deployment details.

Do not present NYMPH as ready for daily two-phone use until the above security controls and real-device tests pass.
