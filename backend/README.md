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

### Legacy archived-account live test (not for Stage 3H)

This legacy suite targets the archived `@partner1` / `@partner2` identities and their existing room. It launches two separate persistent Chrome profiles with independent Matrix device IDs and IndexedDB-backed Rust crypto stores. It does not use two tabs, share a browser profile, create another room, or reset Synapse data. Partner 1 authenticates with the local development credential and creates a real short-lived pairing invitation; Partner 2 redeems it and receives a one-time Matrix login token. Do not run this suite for the additive Stage 3H migration.

Start the existing local server, then run:

```powershell
.\backend\start-dev.ps1
npm test
npm run test:matrix:live
```

Chrome is required. Set `NYMPH_CHROME_PATH` if it is not installed at `C:\Program Files\Google\Chrome\Application\chrome.exe`. The test reads the two ignored local password files but never prints their contents. Separate browser profiles and encrypted IndexedDB stores persist under the ignored `.matrix-e2e/partner-a-live-2` and `.matrix-e2e/partner-b-live-2` directories so restart recovery can be exercised. Preserve these directories between runs; deleting them resets the local test clients' crypto state.

The test requires both original account recovery keys. It fails before login unless these process environment variables are non-empty:

- Partner A (`@partner1:localhost`): `NYMPH_E2E_PARTNER1_RECOVERY_KEY`
- Partner B (`@partner2:localhost`): `NYMPH_E2E_PARTNER2_RECOVERY_KEY`

The local account-provisioning script does not create client-side Secret Storage or recovery keys; it only creates the Synapse account passwords and registration secret. After an account's first sign-in, its security setup generates a unique recovery key only if that account has no default Secret Storage key. The key is held in memory, masked in the setup UI, and must be re-entered before upload. The UI offers copy and a passphrase-encrypted offline export (PBKDF2-SHA-256 and AES-256-GCM); the export passphrase is never stored. After Secret Storage and cross-signing are configured, the user must enter the recovery key again. A separate temporary Matrix device independently decrypts all three existing cross-signing secrets, restores them, and checks their IDs against the published identity. The test device is revoked before setup is marked verified in account data. If verification or revocation fails, setup is not marked complete. Ordinary login never replaces existing Secret Storage. If an existing recovery key was not saved elsewhere, do not generate a replacement or reset Secret Storage; recovery remains blocked until that key or a usable existing device is found.

To enter both values without putting them in command history, source files, or `.env` files, use a masked PowerShell prompt in the same PowerShell window that runs the test:

```powershell
$recoveryKeyVariables = @(
    @{ Name = 'NYMPH_E2E_PARTNER1_RECOVERY_KEY'; Prompt = 'Partner A original Matrix recovery key' },
    @{ Name = 'NYMPH_E2E_PARTNER2_RECOVERY_KEY'; Prompt = 'Partner B original Matrix recovery key' }
)
try {
    foreach ($item in $recoveryKeyVariables) {
        $secureValue = Read-Host $item.Prompt -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
        try {
            [Environment]::SetEnvironmentVariable(
                $item.Name,
                [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer),
                'Process'
            )
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
            $secureValue.Dispose()
        }
    }
    npm run test:matrix:live
} finally {
    Remove-Item Env:NYMPH_E2E_PARTNER1_RECOVERY_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:NYMPH_E2E_PARTNER2_RECOVERY_KEY -ErrorAction SilentlyContinue
}
```

The test reports only whether each variable is present and whether each account unlocked; it does not print recovery keys or decoded key material. Each key is supplied only to its corresponding independent browser context and validated against that account's default Secret Storage key metadata. The built harness uses `http://127.0.0.1:5174`, allowlisted separately from the desktop app origin.

The live test uses the production `connectMatrix` implementation and existing encrypted room. It checks each supplied recovery key against the corresponding default key ID, decrypts all three existing cross-signing secrets, confirms the public identity is already published, and only then asks the SDK to restore the existing identity. It stops before cross-signing if either account fails any check; it does not reset Secret Storage or generate replacement keys. The acceptance flow then exercises invitation replay rejection, SAS comparison and confirmation, pre-verification send rejection, encrypted messages in all four modes, replies, reactions, typing, read receipts, reconnection/offline delivery, browser-profile restart history recovery, and device revocation. Pairing, replay rejection, both clients' encrypted sync, and Partner B device-key visibility have passed. Neither existing Secret Storage has been unlocked in the live test, so cross-signing, SAS, encrypted message exchange, restart recovery, and revocation remain unverified. Synapse policy unit tests separately cover expired invitations and unauthorized membership. This is a PC/browser integration test, not Android Keystore or physical-device validation.

Android debug builds use `http://localhost:8008` only in Vite's `android` mode by default, with cleartext allowed only for `localhost` in the debug Network Security Config. Stage 3H.1 app-local configuration overrides this with the isolated endpoint on port 18008. Release networking denies cleartext. The Capacitor WebView origin is `https://localhost`; the custom pairing endpoint's development allowlist includes that exact origin. The isolated browser integration harness uses `http://127.0.0.1:5174`, which is separately allowlisted for local testing. Synapse 1.164.2's built-in Matrix API uses a wildcard CORS response; CORS is not an authentication boundary.

For production, set `VITE_MATRIX_HOMESERVER` to the eventual deployed HTTPS URL and run `npm run android:release`. The release command rejects an unset or loopback URL. No permanent hostname, signing key, or hosting credentials are supplied here; release APK signing still requires the owner's signing configuration.

Run the local server-policy tests inside the pinned Synapse image with `docker exec nymph-local-dev-synapse-1 python -m unittest discover -s /tests`. They cover room creation constraints, server-side membership/invite checks, and expired or reused pairing invitations.

Room creation and membership enforcement must be tested before using private content. The setup script provisions only the local accounts; the live browser integration suite exercises two independent Matrix clients, but not physical devices.

## Two-partner policy and enrollment status

The legacy local development setup provisions only `@partner1:localhost`, `@partner2:localhost`, and their archived private encrypted room. The production deployment scaffold is not a completed private two-person service. The app has a development Partner 1 password sign-in, a one-time QR invitation flow for Partner 2, and Matrix SDK device-verification/cross-signing controls. The legacy PC live suite has reached invitation redemption, both clients' encrypted sync, and device-key lookup, but has not unlocked the archived Secret Storage; do not treat it as the Stage 3H acceptance test. Physical Android UI and storage behavior also remain untested. No production partner credentials are embedded in the frontend.

### Stage 3H.1 isolated development environment (prepared, not provisioned)

The original SQLite Synapse instance, its `@partner1:localhost` / `@partner2:localhost` identities, encrypted room, policy state, backups, and browser profiles are the archived environment. The Stage 3H.1 deployment uses a distinct Synapse server name (`nymph-dev.localhost`), client URL (`http://127.0.0.1:18008`), Compose project (`nymph-stage3h1-dev`), PostgreSQL database, policy database, secrets directory (`backend/dev-isolated/secrets`), and persistent Docker volumes (`nymph-stage3h1-dev-postgres-data` and `nymph-stage3h1-dev-synapse-data`). It uses an internal database network and a separate API bridge; federation, registration, and public room discovery are disabled. The dev-only policy omits archived account IDs and uses a separate policy table/database.

The isolated environment files are [`compose.dev.isolated.yaml`](./compose.dev.isolated.yaml), [`.env.dev.isolated.example`](./.env.dev.isolated.example), and [`configure_isolated_dev_synapse.py`](./configure_isolated_dev_synapse.py). `start-isolated-dev.ps1` can prepare/start only this separate deployment; it does not provision Matrix accounts, rooms, or recovery keys. Stage 3H.1 runtime validation has started only the isolated Synapse and PostgreSQL services. Both are healthy; no development partner accounts, rooms, or recovery keys have been created. Synapse's tested room-management Admin API route rejects unauthenticated access; the server-version metadata route is unauthenticated, and the homeserver is published only on loopback.

The Stage 3H.1 provisioner is [`provision-dev-partners.ps1`](./provision-dev-partners.ps1). It has not been run. Its `-WhatIf` path only prints a plan; actual provisioning additionally requires `-ConfirmProvisioning`, typing exactly `PROVISION ISOLATED NYMPH DEV MATRIX`, and accepting each `ShouldProcess` confirmation. The plan includes the encrypted pre-provision backup, two account reconciliations, one encrypted invite-only room, app-local configuration, and an external operation journal. Existing development accounts are not password-reset; inconsistent existing room state causes a stop rather than room recreation. Failure reporting scopes rollback only to explicitly journaled development resources and never to the archived environment.

The backup utility, [`backup-isolated-dev.ps1`](./backup-isolated-dev.ps1), encrypts a staged backup with Node's scrypt-derived AES-256-GCM implementation, requires a passphrase entered at a masked prompt before any backup mutation, authenticates the encrypted file, and verifies a per-file SHA-256 manifest. Run it from an interactive PowerShell terminal; the passphrase must be at least 12 characters. For example:

```powershell
.\backend\backup-isolated-dev.ps1 -Mode Create -BackupPath "$HOME\NYMPH-Backups\nymph-stage3h1-dev-runtime.enc" -Confirm
.\backend\backup-isolated-dev.ps1 -Mode RestoreTest -BackupPath "$HOME\NYMPH-Backups\nymph-stage3h1-dev-runtime.enc" -Confirm
```

Each command prompts for the passphrase without echoing it; enter the same passphrase for the restore test. Review each `ShouldProcess` confirmation; choose `A` only if you approve the listed backup/restore operations. `RestoreTest` decrypts into a fresh temporary directory, restores the PostgreSQL dump into a disposable container and volume, and restores Synapse data into a separate no-network disposable volume for config, signing-key, and policy-database checks. The service data and legacy files are never used as restore targets. Disposable restore containers and volumes are removed by the script; if cleanup fails, it reports the exact resource names for manual inspection. Plaintext staging is overwritten before deletion where the filesystem permits; overwrite is not guaranteed secure erasure on SSDs, snapshots, or copy-on-write storage. Keep encrypted backups outside the repository and retain the passphrase offline; do not put it in a command, source file, or log. The runtime backup and restore have not yet completed.

To inspect the deployment plan without side effects:

```powershell
.\backend\start-isolated-dev.ps1 -WhatIf
.\backend\provision-dev-partners.ps1 -WhatIf
.\backend\backup-isolated-dev.ps1 -Mode RestoreTest -BackupPath 'E:\NYMPH-Backups\backup.enc' -WhatIf
```

For later use only, after reviewing the deployment and receiving explicit approval, start the isolated infrastructure and then run the separately approved provisioner. No production hosting or account migration is part of this development setup.

The dev acceptance test has its own Playwright config and persistent profiles under `.matrix-e2e/dev-stage-3h/`. It does not use or alter the legacy live-test profiles. Playwright traces, screenshots, and video are disabled. It checks each recovery export in a separate client, distinct Secret Storage key IDs and backup versions, SAS trust for both partner devices, exact decrypted message and reply contents, persistence after browser restart, third-user invite/pairing replay rejection, and active-device revocation. After provisioning is separately approved and the dev Synapse server is running, run:

```powershell
npm test
npm run test:matrix:dev-live
```

The dev test reads `partner1_dev_password`, `partner2_dev_password`, and the two dev device-ID files from the ignored `backend/dev-isolated/secrets/` directory. It requires two distinct process-only export passphrases, `NYMPH_DEV_RECOVERY_EXPORT_PASSPHRASE_A` and `NYMPH_DEV_RECOVERY_EXPORT_PASSPHRASE_B`, each at least 12 characters. Enter them through masked `Read-Host` prompts; do not put them in the command text, a `.env` file, or source. Example:

```powershell
$items = @(
    @{ Name = 'NYMPH_DEV_RECOVERY_EXPORT_PASSPHRASE_A'; Prompt = 'Partner A offline-export passphrase' },
    @{ Name = 'NYMPH_DEV_RECOVERY_EXPORT_PASSPHRASE_B'; Prompt = 'Partner B offline-export passphrase' }
)
try {
    foreach ($item in $items) {
        $secureValue = Read-Host $item.Prompt -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
        try {
            [Environment]::SetEnvironmentVariable(
                $item.Name,
                [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer),
                'Process'
            )
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
            $secureValue.Dispose()
        }
    }
    npm run test:matrix:dev-live
} finally {
    Remove-Item Env:NYMPH_DEV_RECOVERY_EXPORT_PASSPHRASE_A -ErrorAction SilentlyContinue
    Remove-Item Env:NYMPH_DEV_RECOVERY_EXPORT_PASSPHRASE_B -ErrorAction SilentlyContinue
}
```

The acceptance flow creates a distinct SDK recovery key for each new account only when no default Secret Storage key exists, stores only authenticated-encrypted exports in ignored local files, and requires a recovery restore on a separate temporary verifier before continuing. During new security bootstrap it creates a key backup only when none exists; an existing backup must validate and is never reset by this flow. The server authorizes the short-lived verifier only from the current active device, does not let it become active, and removes its pending authorization when it is revoked. The flow then verifies cross-signing continuity and SAS, exchanges/decrypts messages, restarts both clients, rejects third-user invites and pairing-token replay, and replaces Partner A's active device. A replacement revokes the old Matrix device before the new client starts crypto sync; the server's admission callback rejects new logins for the replaced device ID. This is a dev-only exception for a bounded recovery test, not permission for ordinary second devices.

`block_non_admin_invites`, a private room, and a client-side member check are not enough to enforce an exact two-person allowlist. The local development module uses Synapse's supported spam-checker callbacks `user_may_create_room`, `user_may_invite`, `user_may_join_room`, and `check_event_for_spam`; the API is present in pinned Synapse 1.164.2. Its `on_new_event` callback records the newly created room ID after Synapse persists the validated creation event, so later membership checks are bound to that room. It also uses `ModuleApi.create_login_token` (available since 1.69.0) for the second, one-time login credential. The module limits its local policy state to one created room and checks private/invite-only/encrypted room settings. The more generic third-party `check_event_allowed` callback is documented as very experimental and is not used.

In local development, `block_non_admin_invites` is disabled only because the bootstrap client must invite partner B; the module restricts that action to partner A inviting partner B. The production scaffold keeps non-admin invitations disabled. Policy unit tests cover invite/join restrictions and pairing-token expiry/reuse, and local API checks confirmed both accounts can log in, the room is encrypted and invite-only, a third-user invite is rejected, and partner B cannot create another room. An actual join attempt by a separately provisioned unauthorized account and a federation join have not been tested. The administrator remains trusted and can override any room policy. Registration remains disabled; account creation must be performed by an administrator through the local Synapse provisioning process, never by exposing admin credentials to either phone.

Synapse device verification is distinct from app invitation redemption. The local pairing endpoint is not a replacement for Matrix device verification. The app uses the SDK's `VerificationRequest` flow for SAS emoji/decimal or QR verification, explicit confirmation, cross-signing bootstrap, key-change status, and device revocation controls. The PC live suite has not yet validated SAS or cross-signing between its isolated browser profiles. On Android, the app stores the Matrix session and a random 32-byte Rust crypto-store key in `@aparajita/capacitor-secure-storage`, which encrypts values with an Android Keystore-generated AES-GCM key. The Rust crypto store itself remains in persistent IndexedDB and uses that random key for its SDK-supported encrypted storage. The six-digit app PIN is not used as the crypto-store key. Device IDs are saved and passed back to the SDK so the same device identity and per-device store are restored after restart. Android persistence still requires physical-device restart-and-decrypt validation.

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
