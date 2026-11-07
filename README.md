# NYMPH

NYMPH is a private couples' messaging application in active development. It uses a React, TypeScript, and Vite frontend, packaged for Android with Capacitor. Matrix and Synapse provide end-to-end encrypted text and media transport; device-local interactions must not be mistaken for delivered content.

## Architecture

- `src/main.tsx` contains the chat UI, mode-aware message presentation, local sticker library, media previews, mood interactions, and settings.
- `src/matrix/` contains Matrix client integration, message envelopes, pairing, verification, recovery, and device identity helpers.
- `src/native/` contains native session-storage integration.
- `backend/` contains the Synapse/PostgreSQL deployment and isolated development scripts. See [backend/README.md](./backend/README.md) before operating any Matrix environment.
- `android/` is the Capacitor Android project. The Android package ID is `com.nymph.privateroom`.

The isolated Matrix development target documented by the backend is `http://127.0.0.1:18008`, with server name `nymph-dev.localhost`. The legacy local Synapse environment is separate and must not be used by the isolated acceptance suite.

## Current implementation status

| Area | Status |
|---|---|
| Dark-red chat interface and Romantic, Flirty, Spicy, and Kinky mode views | Implemented. Mode context is represented in message envelopes and the UI filters messages by mode. The chat has restrained message-arrival motion, depth on desktop hover, animated reactions, and reduced-motion support. The modes are not separate Matrix rooms or server-enforced security boundaries. |
| Message reactions | A connected Matrix session can send heart reactions for event-backed messages. Removing a sent Matrix reaction is not implemented. Two-client text messaging, replies, reactions, receipts, all four modes, offline delivery, and restart persistence passed isolated live acceptance. |
| Personal sticker packs | Create, rename, delete, search, favorite, recent, categorize, describe, and choose cover artwork for custom packs. GIF, JPEG, PNG, and WebP imports are supported with per-file and local-library limits. |
| Private sticker/GIF synchronization | Pack metadata and each sticker/GIF binary are sent as Matrix room events; binary uploads use the existing Matrix v2 encrypted-attachment format, with keys and references only in the end-to-end encrypted event. The partner downloads and decrypts before caching locally. Pack updates/deletes and favorite/recent IDs synchronize without adding entries to the chat timeline. Adult pack metadata is sent in the Kinky · 18+ mode context; ordinary modes do not include pack names or categories. The local app cache remains in the existing device-local state store and is not an encrypted-at-rest media vault. |
| Matrix messaging and pairing | Matrix client, pairing, verification, and security interfaces exist. Isolated two-client encrypted messaging acceptance passed. Device-lifecycle acceptance is separate from the core messaging suite. |
| Encrypted photo/video | Photo and video bytes, plus generated WebP previews, are encrypted on-device using Matrix v2 encrypted-attachment metadata before authenticated Matrix media upload. The encrypted room event carries the MXC URLs, keys, IVs, hashes, media type, and display name. Transfers show progress and support cancellation, retry, offline delivery, recipient decryption, and integrity checking. Isolated two-client photo/video acceptance passed again alongside Stage 5 validation. |
| Media server visibility | Synapse/PostgreSQL store encrypted Matrix events and Synapse’s media repository stores encrypted attachment blobs; the server does not receive attachment plaintext, decryption keys, thumbnail plaintext, or filenames in the media-upload request. The server still observes account/device and network metadata, upload timing/size, and opaque MXC identifiers. Authenticated-media access is used for downloads; Matrix media authentication is not a room-membership ACL, so ciphertext confidentiality depends on end-to-end encryption and keeping encrypted event metadata private. |
| Voice | Browser/WebView `MediaRecorder` capture supports available Opus/WebM, Opus/Ogg, or MP4 audio, with timer, pause/resume, cancel, preview, encrypted send progress, recipient decryption, playback, seek, and speed control. Isolated two-client acceptance passed both directions, including offline delivery, interrupted upload/cancellation, and corrupted-ciphertext rejection. The acceptance fixture was a generated browser recording rather than a physical microphone capture. Android's manifest already declares microphone permission; physical-device permission and codec behavior still require Android validation. |
| View-once photo/video | Implemented for the isolated development pair: each attachment uses the existing per-file Matrix v2 encryption key, ciphertext-only upload, an authenticated recipient claim, a server-gated ciphertext route, synchronized encrypted open receipts, countdowns, and scheduled deletion of expired server objects. Unopened media expires after 30 days; opening starts the selected 1–86,400 second timer. Stage 6 two-client live acceptance passed for a rendered photo, playable video, sender denial, opening receipt, repeat-open rejection, preset/custom durations, unopened/offline expiry, consistent expiry status, and media-store deletion. The follow-up UI test selects Custom in the actual preview but could not yet carry that UI send through Synapse. Screenshots and video recording are disabled, so there is no visual evidence; this cannot prevent external recording or revoke downloaded/decrypted copies. |
| Conversation retention | **Implemented, not live-accepted.** Never, 1 hour, 24 hours, 7 days, 30 days, and custom durations synchronize inside the encrypted room. The isolated Synapse module persists expiry jobs and issues server-side redactions for eligible events, including offline events; replies and reactions inherit parent expiry. The policy suite passes, but Stage 7 live acceptance remains incomplete. Partner B's exact configured device is registered and active on Synapse, and its profile contains the matching account/device CryptoStore namespace. A masked same-device login attempt was rejected as invalid credentials before device registration, so the CryptoStore, room keys, and cross-signing trust could not be verified. Redaction is not guaranteed ciphertext erasure and does not remove backups or recipient copies. |
| Mood and private notifications | Romantic, Flirty, Spicy, and Kinky mood pings, including custom labels and emojis, use the existing verified encrypted Matrix room. Received mood events open an in-app response card with encrypted-room reactions and mood replies. Device-local notification preferences, Android permission/channel handling, generic private notification payloads, duplicate suppression, event-age/retention checks, and local quiet hours are implemented. The app does not register a remote push gateway: it can alert only after the app/device receives and decrypts an event. Remote delivery while the app is stopped, production FCM/provider credentials, and live two-partner notification acceptance remain unconfigured/unverified. |
| Android | Native BiometricPrompt-backed unlock, six-digit app PIN, background relocking, runtime microphone permission through Capacitor's WebView bridge, Android 13+ notification permission, and a private-visibility mood channel are implemented. The app window uses `FLAG_SECURE`; Android cloud and device-transfer backup are disabled, cleartext traffic is blocked, and the FileProvider no longer exposes shared external storage. Locking revokes in-memory media object URLs and cancels active transfers; persistent Matrix crypto storage remains a separate encrypted store. The Android host test passed (1/1), and the instrumentation APK with four test methods packaged successfully; no emulator/device was available to execute them. Physical-device acceptance remains outstanding. |
| Production deployment | **NO-GO.** HTTPS proxy/configuration scaffolding is hardened, but there is no production-specific two-person membership/media-expiry module, deployed host, tested backup restore, or production logging review. |

The isolated two-client voice/sticker acceptance verifies actual encrypted attachment delivery/decryption in both voice directions, offline voice delivery, interrupted upload cancellation, corrupted-ciphertext rejection, encrypted PNG/GIF sticker assets in both directions, and ciphertext-only server media storage. It uses a generated browser audio recording fixture, not a physical microphone. Do not treat this as physical Android validation or proof of push delivery, secure deletion, or production readiness.

### Stage 9 — Android security and release readiness

The existing biometric and PIN paths are preserved. When the app is backgrounded with a configured PIN, the app locks, stops recording, aborts active media work, revokes displayed in-memory media URLs, and reloads non-view-once encrypted media after unlock. Android's secure-window flag deters ordinary screenshots and capture APIs, but cannot prevent external cameras or all recording methods. Android backup declarations exclude app data from cloud backup and device transfer. These are configuration-level protections; no physical device or emulator has been accepted.

Release signing is read from `NYMPH_RELEASE_STORE_FILE`, `NYMPH_RELEASE_STORE_PASSWORD`, `NYMPH_RELEASE_KEY_ALIAS`, and `NYMPH_RELEASE_KEY_PASSWORD`; the keystore path must be absolute. No signing key or password is committed. `npm run android:release` also requires a production HTTPS `VITE_MATRIX_HOMESERVER`; direct unsigned Gradle release builds are configuration checks, not distributable production builds. Existing application ID and version remain `com.nymph.privateroom`, version code `1`, version name `1.0`.

Remote push is not operational. A future provider-neutral gateway must carry only an opaque wake-up signal, keep device registration/provider credentials server-side, and let the authenticated app fetch and decrypt Matrix events. Push payloads, logs, and provider-visible metadata must never contain message text, room/event identifiers, media URLs, attachment keys, or decrypted content. Current notifications are device-local and require the app to receive/decrypt the event first.

### Stage 10 — production readiness and release gate

The production scaffold uses a pinned Synapse 1.164.2/PostgreSQL 16.10/Caddy 2.10.2 stack. Synapse is private to the Compose network; only Caddy publishes ports. The generated Synapse config now sets the HTTPS `public_baseurl`, disables registration and guest access, blocks non-admin invitations and public-room listing, restricts federation to the configured server name, and removes the federation HTTP resource from its listener. Production server names must be lowercase public DNS names, and database/registration secrets must each contain at least 32 characters. Caddy adds HSTS, `X-Content-Type-Options`, `X-Frame-Options`, and `Referrer-Policy` headers and continues to block admin and public-room creation routes.

This is configuration hardening, not a production deployment or acceptance. The Compose stack does **not** load a production-safe NYMPH policy module. Exact two-person room membership, Stage 6 view-once registration/deletion, and Stage 7 message-expiry jobs/redactions are therefore not enforced in the production scaffold. The development policy module is tied to development identities/state and is deliberately not reused. Production logging configuration/content review, image digest pinning, off-host backup/restore exercise, DNS/HTTPS operation, monitoring, and public-host validation remain incomplete. Treat production as **NO-GO**.

Release metadata remains application ID `com.nymph.privateroom`, version code `1`, version name `1.0`, min SDK 24, and target/compile SDK 36. The manifest declares internet, camera, microphone, and biometric permissions; notification permission is included through the Capacitor plugin. Backup/transfer is disabled, cleartext traffic is blocked, and no FCM provider configuration is present. `npm run android:release` requires an externally supplied HTTPS homeserver and private signing values/keystore. The unsigned Gradle release output is only a build check and must not be distributed.

**Acceptance dashboard**

| Gate | Status |
|---|---|
| Stage 6 core isolated photo/video acceptance | Passed; the integrated main-app Custom-preview-to-Synapse follow-up remains outstanding. |
| Stage 7 policy implementation/tests | Implemented; live two-partner acceptance remains blocked pending safe restoration and verification of Partner B's existing trusted session. No login/recovery retry or live message test was performed for Stage 10. |
| Physical Android acceptance | Outstanding; no device/emulator was available. |
| Remote push | Not operational; provider, credentials, deployment, and delivery tests are absent. |
| Production backend enforcement and operations | NO-GO; exact pair policy and view-once/retention modules are not wired; deployment, logging review, and tested restore are outstanding. |
| Signed release artifact | NO-GO; no external production keystore/credentials were supplied. Unsigned APKs are not distributable. |

Final release decision: **NO-GO** until each applicable acceptance, production enforcement, operational recovery, and signing gate above is closed.

- [ ] Complete the Stage 6 integrated Custom-preview-to-Synapse acceptance.
- [ ] Restore and verify Partner B's existing trusted crypto session, then complete Stage 7 live two-partner acceptance without replacing its identity or state.
- [ ] Complete physical Android acceptance and production notification-provider delivery tests if remote push is required.
- [ ] Implement and validate production-specific two-person membership, view-once media, and message-expiry enforcement.
- [ ] Complete production logging/monitoring review and an encrypted off-host backup restore exercise.
- [ ] Supply private release-signing credentials and verify the resulting signed APK before distribution.

Redaction is not proof of physical ciphertext erasure; encrypted backups, local caches, downloaded/decrypted media, and external recordings may retain content.

Stage 10 validation: **70 Node tests passed**; **29 Synapse policy/configuration tests passed** (including a final 5/5 production-config rerun); **3 Matrix runtime-configuration tests passed**; production web build passed with the existing large-chunk warning; Compose configuration validation with `.env.example` placeholders passed (no services were started); and `npm audit` found zero advisories. The browser UI suite completed with 1 passed and 5 failed because page navigation/control interactions timed out; a retry timed out waiting for Vite, and a manually started preview did not respond to HTTP. The Android Gradle host/package command did not complete and was stopped after remaining at Gradle configuration without task output; no Stage 10 APK result is claimed. Stage 9 baseline Android host test (1/1) and four-method instrumentation APK packaging passed, but no device/emulator was available. Caddyfile syntax could not be separately checked because its pinned image is not locally available. The release validator correctly rejects the current environment because no production HTTPS URL or private signing values were supplied.

## Development and validation

Install dependencies with `npm ci`, then run:

```powershell
npm test
npm run build
```

`npm test` runs local unit/configuration tests and does not provision Matrix accounts or send live messages. The isolated Playwright acceptance suites use pre-existing accounts and do send real encrypted events. To inspect test discovery without starting live acceptance:

```powershell
npm run validate:matrix-e2e-config
npm run test:matrix:live -- --list
```

The live Matrix acceptance test requires pre-existing isolated accounts, crypto state, and locally supplied credentials. It must not be run as a configuration check.

For Android debug packaging, use `npm run android:debug` with JDK 21 and the Android SDK configured. The debug APK produced in this workspace is at `android/app/build/outputs/apk/debug/app-debug.apk`. A release build requires `VITE_MATRIX_HOMESERVER` to be set to the eventual HTTPS production endpoint and requires release signing configuration.

Matrix sign-in, pairing, and security panels are lazy-loaded instead of being part of the initial app entry. The current build's initial entry is about 211 kB minified; Matrix-dependent deferred chunks include a shared chunk of about 734 kB, and the Matrix crypto WASM asset is about 7.8 MB (about 2.1 MB gzip). Vite still warns about the largest deferred chunk. Loading-cost, caching, and Android startup behavior need measurement on-device.

## Operational cautions

- Preserve the archived legacy Matrix accounts, room, databases, and crypto profiles.
- Do not run provisioning or live acceptance operations without the applicable authorization and prerequisites.
- The Stage 3H.3 encrypted backup remains unchanged. Its restore previously failed at AES-256-GCM authentication; restoration was not retried here. The exposed backup passphrase must not be reused.
- Isolated development provisioning has not been performed in this work session. The provisioner requires a pre-provision backup, and the backup restore issue remains unresolved; no accounts, rooms, or recovery credentials were created here.
- Never put credentials, recovery keys, or passphrases in source files, documentation, shell command text, or logs.

## Known limitations

NYMPH is not yet a complete production-ready private messaging product. Stage 6 core live acceptance passed, but the follow-up main-app Custom-preview-to-Synapse test remains unverified. Stage 7 remains blocked before live policy tests. Read-only server checks confirmed Partner B's exact configured device is registered and active; the persistent Partner B profile contains the exact account/device CryptoStore namespace, while no Matrix access token is persisted in Local Storage. Synapse 1.164.2 reuses an existing non-hidden device record when a login supplies its exact device ID, but creates a record if that ID is absent. A masked local login attempt with the existing Partner B Matrix account credential was rejected as invalid username/password; Synapse rejects it before device registration, and the registered-device count remained two. Do not retry with guesses. This does not prove that the correct Matrix account password or another already-authenticated session is unavailable, so the original export passphrase cannot be called the only possible recovery route; the existing export still requires its original separate passphrase if used. CryptoStore contents, room-key availability, and cross-signing trust remain unverified. Screenshots and recordings are disabled in the live test configuration. Remote push notifications, production deployment, and physical Android microphone/playback validation also remain outstanding. Server redaction or media deletion does not guarantee erasure from backups, caches, or recipient copies, and cannot prevent screen capture.
