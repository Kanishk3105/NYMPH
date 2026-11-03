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

The Caddy proxy rejects public requests to Synapse Admin API paths and room creation. The Synapse and PostgreSQL services have no host-published ports. This is network-layer hardening, not a substitute for Synapse-side authorization, and a Docker/server administrator can still access internal services.

## Local development

For the local-only setup, use the fixed development IDs `@partner1:localhost` and `@partner2:localhost`. `localhost` is a development-only server name: it is not publicly resolvable, must not be used for production, and cannot later be renamed without migrating/recreating the Matrix identities and room.

Run the PowerShell setup script from the repository root:

```powershell
.\backend\start-dev.ps1
```

It creates random local-only passwords and a registration secret under the ignored `backend/dev-secrets/` directory, generates the Synapse config if needed, starts the pinned SQLite service, disables public registration, guests, room discovery and federation, and provisions exactly the two regular partner accounts. It creates no administrator account. To let the one-time local bootstrap invite partner B, `block_non_admin_invites` is disabled only in this development config; the server-side policy module restricts invites to partner A inviting partner B. The production scaffold keeps non-admin invites disabled. The password files stay on this machine and are never printed by the script. Keep the directory private and never copy these credentials to production.

The base service binds only to `127.0.0.1:8008`. Synapse's development policy module permits one private, non-federatable, invite-only encrypted room, one invite from partner1 to partner2, and no other room members. It also exposes a short-lived, single-use pairing invitation endpoint. Redeeming an invitation yields a Synapse `m.login.token` that is itself one-time and short-lived; the QR payload never contains a permanent access token. This is local development code, not a production-ready invitation store or Android credential store.

### Android emulator-only testing

The Android SDK and API 36 Google Play image are installed locally. Two separate AVDs, `NYMPH_PARTNER_A` and `NYMPH_PARTNER_B`, use independent emulator data directories. Start them separately from PowerShell:

```powershell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
Start-Process "$sdk\emulator\emulator.exe" -ArgumentList '-avd NYMPH_PARTNER_A'
Start-Process "$sdk\emulator\emulator.exe" -ArgumentList '-avd NYMPH_PARTNER_B'
```

For Android debug builds, Capacitor's HTTPS `https://localhost` app origin connects to the loopback-bound Synapse at `http://localhost:8008`. ADB reverse maps that device-local address back to the PC without changing Windows networking or opening firewall ports. The app enables this HTTP URL only in an Android `android`-mode build. Desktop browser development defaults to `http://127.0.0.1:8008`. Build and install the debug APK with:

```powershell
npm run android:debug
adb devices -l
adb -s emulator-5554 install -r .\android\app\build\outputs\apk\debug\app-debug.apk
adb -s emulator-5556 install -r .\android\app\build\outputs\apk\debug\app-debug.apk
```

For two physical phones, connect both by USB with debugging authorized, then run `adb devices -l`. For each identified device serial, run `adb -s <SERIAL> reverse tcp:8008 tcp:8008`; confirm both mappings with `adb -s <SERIAL> reverse --list`. The Matrix client API and local pairing endpoints are all served by Synapse on port 8008, so no additional reverse port is needed. On each phone, `http://localhost:8008/_matrix/client/versions` should return the Matrix versions JSON before attempting login. Build and install using the serials shown by ADB:

```powershell
adb -s <PARTNER_A_SERIAL> install -r .\android\app\build\outputs\apk\debug\app-debug.apk
adb -s <PARTNER_B_SERIAL> install -r .\android\app\build\outputs\apk\debug\app-debug.apk
```

Use distinct physical phones and never copy app data or crypto stores between them. `install -r` preserves app data; do not uninstall or clear app storage during verification/persistence testing. Android's debug-only network security configuration permits cleartext only to `localhost`; the main/release manifest denies cleartext. The app WebView origin is `https://localhost`; the custom pairing endpoint's default allowlist includes that exact origin. Synapse 1.164.2's built-in Matrix client API hardcodes `Access-Control-Allow-Origin: *` and has no supported allowlist configuration. This development service remains bound to host loopback, and Matrix authentication/authorization is still enforced server-side. CORS is not an authentication control.

No Windows network profile or firewall setting is changed for emulator access. Emulators are not physical-phone tests.

For two devices on a trusted private Wi-Fi network, first build the frontend from the repository root (`npm run build`), ensure the Windows network profile is explicitly `Private`, then run `.\backend\configure-dev-lan.ps1 -LanAddress <this-PC's-LAN-IPv4>` from the repository root. This development-only overlay starts a local Caddy HTTPS endpoint on port 8443, serves the app, and proxies Matrix traffic without publishing the Admin API. The setup script rejects Public networks and checks for HTTP 200 readiness. Install the exported public Caddy root certificate on both test phones, then run `.\backend\Enable-NymphDevLanFirewall.ps1 -LanAddress <same-IPv4>` in an elevated PowerShell session to allow TCP 8443 only from the local subnet on the Private interface. Do not copy the CA private key. The current Wi-Fi has not been approved or changed to Private, and no firewall rule has been enabled; do not run these steps on an untrusted network. Android certificate trust and physical-device connectivity still require testing.

Run the local server-policy tests inside the pinned Synapse image with `docker exec nymph-local-dev-synapse-1 python -m unittest discover -s /tests`. They cover room creation constraints, server-side membership/invite checks, and expired or reused pairing invitations.

Room creation and membership enforcement must be tested before using private content. The setup script only provisions the local accounts; it does not prove that two different browsers or two physical devices can complete pairing or E2EE.

## Two-partner policy and enrollment status

The local development setup provisions only `@partner1:localhost`, `@partner2:localhost`, and their private encrypted room. The production deployment scaffold is not a completed private two-person service. The app now has a development Partner 1 password sign-in, a one-time QR invitation flow for Partner 2, and Matrix SDK device-verification/cross-signing controls. These interfaces have not yet been validated end-to-end against the live server or between physical phones; no production partner credentials are embedded in the frontend.

`block_non_admin_invites`, a private room, and a client-side member check are not enough to enforce an exact two-person allowlist. The local development module uses Synapse's supported spam-checker callbacks `user_may_create_room`, `user_may_invite`, `user_may_join_room`, and `check_event_for_spam`; the API is present in pinned Synapse 1.164.2. Its `on_new_event` callback records the newly created room ID after Synapse persists the validated creation event, so later membership checks are bound to that room. It also uses `ModuleApi.create_login_token` (available since 1.69.0) for the second, one-time login credential. The module limits its local policy state to one created room and checks private/invite-only/encrypted room settings. The more generic third-party `check_event_allowed` callback is documented as very experimental and is not used.

In local development, `block_non_admin_invites` is disabled only because the bootstrap client must invite partner B; the module restricts that action to partner A inviting partner B. The production scaffold keeps non-admin invitations disabled. Policy unit tests cover invite/join restrictions and pairing-token expiry/reuse, and local API checks confirmed both accounts can log in, the room is encrypted and invite-only, a third-user invite is rejected, and partner B cannot create another room. An actual join attempt by a separately provisioned unauthorized account and a federation join have not been tested. The administrator remains trusted and can override any room policy. Registration remains disabled; account creation must be performed by an administrator through the local Synapse provisioning process, never by exposing admin credentials to either phone.

Synapse device verification is distinct from app invitation redemption. The local pairing endpoint is not a replacement for Matrix device verification. The app uses the SDK's `VerificationRequest` flow for SAS emoji/decimal or QR verification, explicit confirmation, cross-signing bootstrap, key-change status, and device revocation controls. Those flows still need live protocol testing. On Android, the app stores the Matrix session and a random 32-byte Rust crypto-store key in `@aparajita/capacitor-secure-storage`, which encrypts values with an Android Keystore-generated AES-GCM key. The Rust crypto store itself remains in persistent IndexedDB and uses that random key for its SDK-supported encrypted storage. The six-digit app PIN is not used as the crypto-store key. Device IDs are saved and passed back to the SDK so the same device identity and per-device store are restored after restart. Web browser sessions remain memory-only and browser crypto storage is not treated as production-secure. These persistence paths still need restart-and-decrypt validation on both emulators.

The app also uses native biometrics/device credentials for the app lock, a native `FLAG_SECURE` window, and background relocking. These protections are not substitutes for verifying device identity. Synapse 1.164.2's supported module callbacks do not provide a device-login admission callback to atomically enforce one active authenticated device per partner; the present backend therefore does not meet the one-active-device requirement. Do not represent client-side device checks as server enforcement or use it for production device replacement until a supported server-side revocation/admission design is implemented and tested.

## Backups and recovery

Back up PostgreSQL consistently, the Synapse data volume (signing key, media, and config), the Caddy data volume (ACME state), and both secret files. A basic database dump can be made with `docker compose exec -T postgres pg_dump -U synapse -d synapse > synapse.sql`; use a volume-aware backup tool for the named volumes. Encrypt backups and keep them off-host. Test restoration to an isolated host before relying on them. Never rotate or lose the Synapse signing key without following Synapse's documented key-rotation/recovery procedure. Database snapshots alone do not include media or signing keys.

## Current limitations

- The deployment scaffold has not been started against a real public hostname or an always-on server.
- The production scaffold does not yet include or validate the local room-policy module.
- QR enrollment, device verification, cross-signing, and device revocation have not been tested end-to-end against the running server.
- Seven Synapse policy unit tests pass in the pinned Synapse container. No live QR pairing, cross-signing, encrypted two-client messaging, offline delivery, read-receipt, unauthorized-join, or revoked-device integration test has been completed.
- The focused client suite passes (3/3), and `npm run android:debug` previously produced a successful debug APK build. Partner A's Android 36 emulator booted, installed the APK, and opened `MainActivity`, but Android System UI reported an ANR; after dismissing it, the app UI still could not be verified. The emulator's TCP connection to `10.0.2.2:8008` succeeded, while no Matrix login or in-app request was completed.
- The previous emulator ANR dialog named `System UI`, and ADB's focused window was `Application Not Responding: com.android.systemui`; this identifies the reported ANR as System UI, not NYMPH. No retained emulator bugreport or ANR trace was found, and the emulator was not restarted, so the underlying System UI cause remains undiagnosed.
- USB physical-device testing is pending. One Samsung SM-X115 (`R9ZX…49B7F`, serial redacted) is attached, and the `tcp:8008` reverse rule is active. Its browser was opened to the Matrix versions URL, but the response body has not been confirmed. A second phone is not connected, and neither phone has completed app login or messaging.
- The LAN HTTPS overlay and firewall rule have not been activated. No Windows network profile or firewall changes were made. No physical-phone messaging test has completed.
- One-active-device-per-partner enforcement is not implemented server-side.
- Photo/video/voice transfer, push notifications, server-side retention, and media deletion remain unimplemented.

Do not present NYMPH as ready for daily two-phone use until the above security controls and real-device tests pass.
