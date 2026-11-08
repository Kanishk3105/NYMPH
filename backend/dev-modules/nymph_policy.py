import asyncio
import hashlib
import json
import logging
import os
import pathlib
import re
import secrets
import sqlite3
import time
from typing import Any
from urllib.parse import urlsplit

from synapse.api.errors import Codes, SynapseError
from synapse.module_api import NOT_SPAM, ModuleApi
from twisted.internet import defer
from twisted.internet.threads import deferToThread
from twisted.web.resource import Resource
from twisted.web.server import NOT_DONE_YET


logger = logging.getLogger(__name__)
INVITATION_TTL_MS = 120_000
LOGIN_TOKEN_TTL_MS = 120_000
ROOM_RESERVATION_TTL_MS = 120_000
EPHEMERAL_MEDIA_PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000
EPHEMERAL_MEDIA_PENDING_MIN_TTL_SECONDS = 1
EPHEMERAL_MEDIA_PENDING_MAX_TTL_SECONDS = EPHEMERAL_MEDIA_PENDING_TTL_MS // 1000
MEDIA_ID_PATTERN = re.compile(r"^[A-Za-z0-9._=-]{1,255}$")
EVENT_ID_PATTERN = re.compile(r"^\$[A-Za-z0-9._=:-]{1,255}$")
ROOM_ENCRYPTION = "m.megolm.v1.aes-sha2"
MAX_RETENTION_SECONDS = 31_536_000
MAX_RETENTION_RECONCILE_EVENTS = 100
WORKER_HEALTH_MAX_AGE_MS = 30_000


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def is_private_encrypted_room(config: dict[str, Any], partner_a: str, partner_b: str) -> bool:
    creation = config.get("creation_content")
    initial_state = config.get("initial_state")
    invitees = config.get("invite")
    if (
        config.get("visibility") != "private"
        or config.get("preset") != "private_chat"
        or invitees != [partner_b]
        or not isinstance(creation, dict)
        or creation.get("m.federate") is not False
        or not isinstance(initial_state, list)
    ):
        return False

    state = {
        (event.get("type"), event.get("state_key", "")): event.get("content", {})
        for event in initial_state
        if isinstance(event, dict)
    }
    encryption = state.get(("m.room.encryption", ""))
    join_rules = state.get(("m.room.join_rules", ""))
    history = state.get(("m.room.history_visibility", ""))
    power = state.get(("m.room.power_levels", ""))
    if not all(isinstance(item, dict) for item in (encryption, join_rules, history, power)):
        return False
    return (
        encryption.get("algorithm") == ROOM_ENCRYPTION
        and join_rules.get("join_rule") == "invite"
        and history.get("history_visibility") == "joined"
        and power.get("users") == {partner_b: 0}
        and power.get("users_default", 0) == 0
        and power.get("events_default", 0) == 0
        and power.get("state_default", 100) == 100
        and power.get("invite", 100) == 100
        and power.get("kick", 100) == 100
        and power.get("ban", 100) == 100
        and power.get("redact", 100) == 100
        and not power.get("events")
    )


class PairingResource(Resource):
    isLeaf = True

    def __init__(self, policy: "NymphPolicy", endpoint: str) -> None:
        super().__init__()
        self.policy = policy
        self.endpoint = endpoint

    def render_OPTIONS(self, request: Any) -> bytes:
        if not self.policy.allow_origin(request):
            request.setResponseCode(403)
            return b""
        self.policy.set_cors_headers(request)
        request.setResponseCode(204)
        return b""

    def render_POST(self, request: Any) -> bytes:
        if not self.policy.allow_origin(request):
            request.setResponseCode(403)
            return b'{"error":"Origin is not allowed."}'
        self.policy.set_cors_headers(request)
        defer.ensureDeferred(self._handle(request))
        return NOT_DONE_YET

    async def _handle(self, request: Any) -> None:
        status = 200
        try:
            raw_body = request.content.read(4097)
            if len(raw_body) > 4096:
                raise SynapseError(413, "Request is too large.", Codes.TOO_LARGE)
            payload = json.loads(raw_body or b"{}")
            if not isinstance(payload, dict):
                raise SynapseError(400, "Invalid request.", Codes.INVALID_PARAM)
            if self.endpoint == "create":
                result = await self.policy.create_invitation(request, payload)
            elif self.endpoint == "cancel":
                result = await self.policy.cancel_invitation(request)
            elif self.endpoint == "status":
                result = await self.policy.get_room_status(request)
            elif self.endpoint == "device_replace":
                result = await self.policy.create_device_replacement(request, payload)
            elif self.endpoint == "device_activate":
                result = await self.policy.activate_device_replacement(request)
            elif self.endpoint == "device_cancel":
                result = await self.policy.cancel_device_replacement(request)
            elif self.endpoint == "device_recovery_check":
                result = await self.policy.create_recovery_verification(request, payload)
            elif self.endpoint == "media_register":
                result = await self.policy.register_ephemeral_media(request, payload)
            elif self.endpoint == "media_open":
                result = await self.policy.open_ephemeral_media(request, payload)
            elif self.endpoint == "media_status":
                result = await self.policy.get_ephemeral_media_status(request, payload)
            elif self.endpoint == "retention_set":
                result = await self.policy.set_conversation_retention(request, payload)
            elif self.endpoint == "retention_status":
                result = await self.policy.get_conversation_retention(request)
            elif self.endpoint == "retention_relation":
                result = await self.policy.register_message_relation(request, payload)
            elif self.endpoint == "retention_message_status":
                result = await self.policy.get_message_expiry_status(request, payload)
            elif self.endpoint == "retention_reconcile":
                result = await self.policy.reconcile_expired_messages(request, payload)
            else:
                result = await self.policy.redeem_invitation(payload)
        except SynapseError as error:
            status = error.code
            result = {"error": error.msg}
        except (UnicodeDecodeError, json.JSONDecodeError):
            status = 400
            result = {"error": "Invalid JSON request."}
        except Exception:
            logger.exception("NYMPH development pairing request failed.")
            status = 500
            result = {"error": "The pairing request failed."}

        request.setResponseCode(status)
        request.setHeader(b"Content-Type", b"application/json")
        request.write(json.dumps(result, separators=(",", ":")).encode("utf-8"))
        request.finish()


class EphemeralMediaContentResource(Resource):
    isLeaf = False

    def __init__(self, policy: "NymphPolicy", media_id: str | None = None) -> None:
        super().__init__()
        self.policy = policy
        self.media_id = media_id

    def getChild(self, path: bytes, _request: Any) -> Resource:
        media_id = path.decode("ascii", errors="ignore")
        return EphemeralMediaContentResource(self.policy, media_id)

    def render_OPTIONS(self, request: Any) -> bytes:
        if not self.policy.allow_origin(request):
            request.setResponseCode(403)
            return b""
        self.policy.set_cors_headers(request)
        request.setHeader(b"Access-Control-Allow-Methods", b"GET, OPTIONS")
        request.setResponseCode(204)
        return b""

    def render_GET(self, request: Any) -> bytes:
        if not self.media_id or not MEDIA_ID_PATTERN.fullmatch(self.media_id):
            request.setResponseCode(404)
            return b""
        if not self.policy.allow_origin(request):
            request.setResponseCode(403)
            return b""
        self.policy.set_cors_headers(request)
        request.setHeader(b"Cache-Control", b"no-store")
        request.setHeader(b"Content-Type", b"application/octet-stream")
        defer.ensureDeferred(self._serve(request))
        return NOT_DONE_YET

    async def _serve(self, request: Any) -> None:
        try:
            requester = await self.policy.api.get_user_by_req(request)
            user_id = requester.user.to_string()
            media_path = self.policy.authorized_ephemeral_media_path(user_id, self.media_id or "")
            data = await deferToThread(pathlib.Path(media_path).read_bytes)
            request.setHeader(b"Content-Length", str(len(data)).encode("ascii"))
            request.setResponseCode(200)
            request.write(data)
        except SynapseError as error:
            request.setResponseCode(error.code)
            request.setHeader(b"Content-Length", b"0")
        except FileNotFoundError:
            request.setResponseCode(410)
            request.setHeader(b"Content-Length", b"0")
        except Exception:
            logger.exception("NYMPH ephemeral media retrieval failed.")
            request.setResponseCode(500)
            request.setHeader(b"Content-Length", b"0")
        request.finish()


class PolicyHealthResource(Resource):
    isLeaf = True

    def __init__(self, policy: "NymphPolicy") -> None:
        super().__init__()
        self.policy = policy

    def render_GET(self, request: Any) -> bytes:
        request.setHeader(b"Content-Type", b"application/json")
        status = self.policy.worker_health()
        request.setResponseCode(200 if status["healthy"] else 503)
        return json.dumps(status, separators=(",", ":")).encode("utf-8")


class NymphPolicy:
    @staticmethod
    def parse_config(config: dict[str, Any]) -> dict[str, Any]:
        mode = config.get("policy_mode", "development")
        if mode not in {"development", "production"}:
            raise ValueError("NYMPH policy_mode must be development or production.")
        partner_keys = (
            ("dev_partner_a_user_id", "dev_partner_b_user_id")
            if mode == "development"
            else ("partner_a_user_id", "partner_b_user_id")
        )
        required = (*partner_keys, "server_name", "homeserver_url", "app_origins", "state_path")
        if any(not isinstance(config.get(key), str) or not config[key] for key in required):
            raise ValueError("NYMPH policy requires two participant IDs and all service URLs/state paths.")
        server_name = config["server_name"]
        if "/" in server_name or ":" in server_name:
            raise ValueError("The Matrix server name must be a hostname.")
        legacy_enabled = config.get("legacy_pair_enabled", mode == "development")
        if not isinstance(legacy_enabled, bool):
            raise ValueError("legacy_pair_enabled must be a boolean.")
        disposable_matrix = config.get("disposable_matrix", False)
        if not isinstance(disposable_matrix, bool):
            raise ValueError("disposable_matrix must be a boolean.")
        legacy_ids = (
            (config.get("partner_a_user_id"), config.get("partner_b_user_id"))
            if mode == "development"
            else (None, None)
        )
        configured_ids = (config[partner_keys[0]], config[partner_keys[1]])
        if mode == "development":
            if legacy_enabled and legacy_ids != ("@partner1:localhost", "@partner2:localhost"):
                raise ValueError("The archived development identities cannot be rebound by the policy.")
            if not legacy_enabled and any(legacy_ids):
                raise ValueError("Archived account IDs cannot be configured in isolated development policy.")
            if not disposable_matrix and configured_ids != (
                f"@partner1-dev:{server_name}",
                f"@partner2-dev:{server_name}",
            ):
                raise ValueError("Development partner IDs must match their dedicated server name.")
        elif legacy_enabled or any(
            config.get(key) for key in ("dev_partner_a_user_id", "dev_partner_b_user_id")
        ):
            raise ValueError("Production policy cannot include archived or development partner identities.")
        user_ids = (*legacy_ids, *configured_ids) if legacy_enabled else configured_ids
        if len(set(user_ids)) != len(user_ids):
            raise ValueError("All NYMPH policy participant IDs must be distinct.")
        if not all(
            isinstance(user_id, str)
            and user_id.startswith("@")
            and user_id.count(":") == 1
            and user_id.rsplit(":", 1)[1] == server_name
            for user_id in user_ids
        ):
            raise ValueError("NYMPH policy participant IDs must belong to its configured server.")
        if disposable_matrix and mode != "development":
            raise ValueError("Disposable Matrix identities are only supported in development policy mode.")
        homeserver = config["homeserver_url"]
        parsed_homeserver = urlsplit(homeserver)
        if mode == "development":
            if not (
                homeserver.startswith("http://127.0.0.1:")
                or homeserver.startswith("http://localhost:")
                or homeserver.startswith("https://")
            ):
                raise ValueError("The development pairing endpoint must use localhost HTTP or HTTPS.")
        elif (
            parsed_homeserver.scheme != "https"
            or parsed_homeserver.hostname != server_name
            or parsed_homeserver.path not in ("", "/")
            or parsed_homeserver.query
            or parsed_homeserver.fragment
            or parsed_homeserver.username
            or parsed_homeserver.password
        ):
            raise ValueError("Production homeserver URL must be HTTPS at the configured Matrix server name.")
        if not os.path.isabs(config["state_path"]):
            raise ValueError("NYMPH policy state_path must be absolute and persistent.")
        origins = config["app_origins"].split(",")
        if mode == "production" and any(
            urlsplit(origin).scheme != "https"
            or not urlsplit(origin).netloc
            or urlsplit(origin).path
            or urlsplit(origin).query
            or urlsplit(origin).fragment
            for origin in origins
        ):
            raise ValueError("Production app origins must be HTTPS origins.")
        return config

    def __init__(self, config: dict[str, Any], api: ModuleApi) -> None:
        self.parse_config(config)
        self.policy_mode = config.get("policy_mode", "development")
        self.primary_pair_key = "primary" if self.policy_mode == "production" else "dev"
        partner_a_key, partner_b_key = (
            ("partner_a_user_id", "partner_b_user_id")
            if self.policy_mode == "production"
            else ("dev_partner_a_user_id", "dev_partner_b_user_id")
        )
        self.pairs = {}
        if self.policy_mode == "development" and config.get("legacy_pair_enabled", True):
            self.pairs["legacy"] = {
                "partner_a": config["partner_a_user_id"],
                "partner_b": config["partner_b_user_id"],
                "table": "nymph_room_policy",
            }
        self.pairs[self.primary_pair_key] = {
            "partner_a": config[partner_a_key],
            "partner_b": config[partner_b_key],
            "table": f"nymph_{self.primary_pair_key}_room_policy",
        }
        all_users = [
            user_id
            for pair in self.pairs.values()
            for user_id in (pair["partner_a"], pair["partner_b"])
        ]
        if len(set(all_users)) != len(all_users):
            raise ValueError("Legacy and development partner IDs must all be distinct.")
        self.partner_users = {
            self.pairs[self.primary_pair_key]["partner_a"],
            self.pairs[self.primary_pair_key]["partner_b"],
        }
        self.dev_users = self.partner_users
        self.homeserver_url = config["homeserver_url"]
        self.app_origins = set(config["app_origins"].split(","))
        self.api = api
        self.invitation_lock = asyncio.Lock()
        self.invitations: dict[str, tuple[str, int]] = {}
        self.invitation_status = {
            key: {"status": "not_created", "expires_at": None}
            for key in self.pairs
        }
        self.db = sqlite3.connect(config["state_path"], check_same_thread=False, isolation_level=None)
        if "legacy" in self.pairs:
            self.db.execute(
                "CREATE TABLE IF NOT EXISTS nymph_room_policy "
                "(id INTEGER PRIMARY KEY CHECK (id = 1), room_id TEXT, creation_reserved_at INTEGER)"
            )
            self.db.execute(
                "INSERT OR IGNORE INTO nymph_room_policy (id, room_id, creation_reserved_at) VALUES (1, NULL, NULL)"
            )
        primary_room_table = self.pairs[self.primary_pair_key]["table"]
        self.db.execute(
            f"CREATE TABLE IF NOT EXISTS {primary_room_table} "
            "(id INTEGER PRIMARY KEY CHECK (id = 1), room_id TEXT, creation_reserved_at INTEGER)"
        )
        self.db.execute(
            f"INSERT OR IGNORE INTO {primary_room_table} "
            "(id, room_id, creation_reserved_at) VALUES (1, NULL, NULL)"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS nymph_ephemeral_media "
            "(media_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, "
            "duration_seconds INTEGER NOT NULL, state TEXT NOT NULL, opened_by TEXT, "
            "opened_at INTEGER, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS nymph_retention_policy "
            "(room_id TEXT PRIMARY KEY, seconds INTEGER, event_timestamp INTEGER NOT NULL, "
            "event_id TEXT NOT NULL)"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS nymph_seen_room_events "
            "(event_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, sender TEXT NOT NULL, "
            "event_type TEXT NOT NULL, origin_server_ts INTEGER NOT NULL)"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS nymph_message_expiry "
            "(event_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, sender TEXT NOT NULL, "
            "expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'scheduled', "
            "redaction_event_id TEXT)"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS nymph_message_relations "
            "(child_event_id TEXT PRIMARY KEY, parent_event_id TEXT NOT NULL, room_id TEXT NOT NULL)"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS nymph_active_device "
            "(user_id TEXT PRIMARY KEY, device_id TEXT, first_login_allowed INTEGER NOT NULL DEFAULT 1)"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS nymph_pending_device "
            "(user_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, previous_device_id TEXT NOT NULL, "
            "expires_at INTEGER NOT NULL, purpose TEXT NOT NULL DEFAULT 'replace')"
        )
        pending_columns = {
            row[1] for row in self.db.execute("PRAGMA table_info(nymph_pending_device)").fetchall()
        }
        if "previous_device_id" not in pending_columns:
            self.db.execute(
                "ALTER TABLE nymph_pending_device ADD COLUMN previous_device_id TEXT NOT NULL DEFAULT ''"
            )
        if "purpose" not in pending_columns:
            self.db.execute(
                "ALTER TABLE nymph_pending_device ADD COLUMN purpose TEXT NOT NULL DEFAULT 'replace'"
            )
        for user_id in self.partner_users:
            self.db.execute(
                "INSERT OR IGNORE INTO nymph_active_device (user_id, device_id, first_login_allowed) "
                "VALUES (?, NULL, 1)",
                (user_id,),
            )
        self.api.register_spam_checker_callbacks(
            check_event_for_spam=self.check_event_for_spam,
            user_may_join_room=self.user_may_join_room,
            user_may_invite=self.user_may_invite,
            user_may_create_room=self.user_may_create_room,
            user_may_create_room_alias=self.user_may_create_room_alias,
            user_may_publish_room=self.user_may_publish_room,
            check_login_for_spam=self.check_login_for_spam,
        )
        self.api.register_third_party_rules_callbacks(on_new_event=self.on_new_event)
        self.api.register_web_resource(
            "/_synapse/client/nymph/pairing/create",
            PairingResource(self, "create"),
        )
        self.api.register_web_resource(
            "/_synapse/client/nymph/pairing/cancel",
            PairingResource(self, "cancel"),
        )
        self.api.register_web_resource(
            "/_synapse/client/nymph/pairing/redeem",
            PairingResource(self, "redeem"),
        )
        self.api.register_web_resource(
            "/_synapse/client/nymph/pairing/status",
            PairingResource(self, "status"),
        )
        self.api.register_web_resource(
            "/_synapse/client/nymph/device/replace",
            PairingResource(self, "device_replace"),
        )
        self.api.register_web_resource(
            "/_synapse/client/nymph/device/activate",
            PairingResource(self, "device_activate"),
        )
        self.api.register_web_resource(
            "/_synapse/client/nymph/device/cancel",
            PairingResource(self, "device_cancel"),
        )
        self.api.register_web_resource(
            "/_synapse/client/nymph/device/recovery-check",
            PairingResource(self, "device_recovery_check"),
        )
        self.api.register_web_resource(
            "/_synapse/client/nymph/media/register",
            PairingResource(self, "media_register"),
        )
        self.api.register_web_resource(
            "/_synapse/client/nymph/media/open",
            PairingResource(self, "media_open"),
        )
        self.api.register_web_resource(
            "/_synapse/client/nymph/media/status",
            PairingResource(self, "media_status"),
        )
        self.api.register_web_resource(
            "/_synapse/client/nymph/media/content",
            EphemeralMediaContentResource(self),
        )
        self.media_repository = getattr(getattr(api, "_hs", None), "get_media_repository", lambda: None)()
        if self.policy_mode == "production" and self.media_repository is None:
            raise RuntimeError("Production NYMPH policy requires Synapse's media repository API.")
        self.worker_heartbeats: dict[str, int | None] = {"media": None, "messages": None}
        self.worker_failures: dict[str, bool] = {"media": False, "messages": False}
        if self.policy_mode == "production":
            self.api.register_web_resource(
                "/_synapse/client/nymph/health",
                PolicyHealthResource(self),
            )
        if self.media_repository is not None:
            self.media_expiry_call = self.api.looping_background_call(
                self.run_media_expiry_worker,
                5_000,
                desc="nymph_expire_ephemeral_media",
                run_on_all_instances=(self.policy_mode != "production"),
            )
        self.message_expiry_loop = self.api.looping_background_call(
            self.run_message_expiry_worker,
            5_000,
            desc="nymph_expire_room_messages",
            run_on_all_instances=(self.policy_mode != "production"),
        )
        self.api.register_web_resource(
            "/_synapse/client/nymph/retention/set",
            PairingResource(self, "retention_set"),
        )
        self.api.register_web_resource(
            "/_synapse/client/nymph/retention/status",
            PairingResource(self, "retention_status"),
        )
        self.api.register_web_resource(
            "/_synapse/client/nymph/retention/relation",
            PairingResource(self, "retention_relation"),
        )
        self.api.register_web_resource(
            "/_synapse/client/nymph/retention/message-status",
            PairingResource(self, "retention_message_status"),
        )
        self.api.register_web_resource(
            "/_synapse/client/nymph/retention/reconcile",
            PairingResource(self, "retention_reconcile"),
        )

    def allow_origin(self, request: Any) -> bool:
        origin = request.getHeader("origin")
        return origin is None or origin in self.app_origins

    def set_cors_headers(self, request: Any) -> None:
        origin = request.getHeader("origin")
        allowed_origin = origin if origin in self.app_origins else next(iter(self.app_origins))
        request.setHeader(b"Access-Control-Allow-Origin", allowed_origin.encode("ascii"))
        request.setHeader(b"Access-Control-Allow-Methods", b"POST, OPTIONS")
        request.setHeader(b"Access-Control-Allow-Headers", b"Authorization, Content-Type")
        request.setHeader(b"Vary", b"Origin")

    def room_id(self, pair_key: str) -> str | None:
        table = self.pairs[pair_key]["table"]
        row = self.db.execute(f"SELECT room_id FROM {table} WHERE id = 1").fetchone()
        return row[0] if row else None

    def current_room_id(self) -> str | None:
        return self.room_id("legacy") if "legacy" in self.pairs else None

    def pair_for_user(self, user_id: str) -> tuple[str, dict[str, str]] | None:
        for pair_key, pair in self.pairs.items():
            if user_id in {pair["partner_a"], pair["partner_b"]}:
                return pair_key, pair
        return None

    def pair_for_room(self, room_id: str) -> tuple[str, dict[str, str]] | None:
        for pair_key, pair in self.pairs.items():
            if room_id == self.room_id(pair_key):
                return pair_key, pair
        return None

    async def register_ephemeral_media(self, request: Any, payload: dict[str, Any]) -> dict[str, Any]:
        requester = await self.api.get_user_by_req(request)
        owner_user_id = requester.user.to_string()
        pair_info = self.pair_for_user(owner_user_id)
        media_id = payload.get("media_id")
        room_id = payload.get("room_id")
        duration_seconds = payload.get("duration_seconds")
        pending_ttl_seconds = payload.get(
            "pending_ttl_seconds",
            EPHEMERAL_MEDIA_PENDING_MAX_TTL_SECONDS,
        )
        if (
            pair_info is None
            or pair_info[0] != self.primary_pair_key
            or not isinstance(media_id, str)
            or not MEDIA_ID_PATTERN.fullmatch(media_id)
            or not isinstance(room_id, str)
            or room_id != self.room_id(pair_info[0])
            or not isinstance(duration_seconds, int)
            or isinstance(duration_seconds, bool)
            or not 1 <= duration_seconds <= 86_400
            or not isinstance(pending_ttl_seconds, int)
            or isinstance(pending_ttl_seconds, bool)
            or not EPHEMERAL_MEDIA_PENDING_MIN_TTL_SECONDS
            <= pending_ttl_seconds
            <= EPHEMERAL_MEDIA_PENDING_MAX_TTL_SECONDS
        ):
            raise SynapseError(400, "Invalid expiring-media registration.", Codes.INVALID_PARAM)
        if self.media_repository is None:
            raise SynapseError(503, "Server-side media expiration is unavailable.", Codes.UNKNOWN)
        media_info = await self.media_repository.store.get_local_media(media_id)
        if media_info is None or media_info.media_length is None:
            raise SynapseError(404, "The encrypted media upload was not found.", Codes.NOT_FOUND)
        if media_info.user_id != owner_user_id:
            raise SynapseError(403, "Only the uploader can register expiring media.", Codes.FORBIDDEN)
        media_path = self.media_repository.filepaths.local_media_filepath(media_id)
        if not os.path.isfile(media_path):
            raise SynapseError(404, "The encrypted media upload was not found.", Codes.NOT_FOUND)
        created_at = now_ms()
        expires_at = created_at + pending_ttl_seconds * 1000
        try:
            self.db.execute(
                "INSERT INTO nymph_ephemeral_media "
                "(media_id, room_id, owner_user_id, duration_seconds, state, expires_at, created_at) "
                "VALUES (?, ?, ?, ?, 'pending', ?, ?)",
                (media_id, room_id, owner_user_id, duration_seconds, expires_at, created_at),
            )
        except sqlite3.IntegrityError as error:
            raise SynapseError(409, "This media object is already registered.", Codes.INVALID_PARAM) from error
        return {"registered": True, "pending_expires_at": expires_at}

    async def open_ephemeral_media(self, request: Any, payload: dict[str, Any]) -> dict[str, Any]:
        requester = await self.api.get_user_by_req(request)
        user_id = requester.user.to_string()
        media_id = payload.get("media_id")
        if not isinstance(media_id, str) or not MEDIA_ID_PATTERN.fullmatch(media_id):
            raise SynapseError(400, "Invalid media reference.", Codes.INVALID_PARAM)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute(
                "SELECT room_id, owner_user_id, duration_seconds, state, opened_by, expires_at "
                "FROM nymph_ephemeral_media WHERE media_id = ?",
                (media_id,),
            ).fetchone()
            if row is None:
                raise SynapseError(404, "Expiring media was not found.", Codes.NOT_FOUND)
            room_id, owner_user_id, duration_seconds, state, opened_by, expires_at = row
            pair_info = self.pair_for_user(user_id)
            if (
                pair_info is None
                or pair_info[0] != self.primary_pair_key
                or user_id == owner_user_id
                or user_id not in {pair_info[1]["partner_a"], pair_info[1]["partner_b"]}
                or room_id != self.room_id(pair_info[0])
            ):
                raise SynapseError(403, "This account cannot open this media.", Codes.FORBIDDEN)
            current_time = now_ms()
            if state == "pending":
                if expires_at <= current_time:
                    raise SynapseError(410, "This expiring media is no longer available.", Codes.NOT_FOUND)
                expires_at = current_time + duration_seconds * 1000
                self.db.execute(
                    "UPDATE nymph_ephemeral_media SET state = 'opened', opened_by = ?, "
                    "opened_at = ?, expires_at = ? WHERE media_id = ? AND state = 'pending'",
                    (user_id, current_time, expires_at, media_id),
                )
            else:
                raise SynapseError(410, "This expiring media is no longer available.", Codes.NOT_FOUND)
            self.db.execute("COMMIT")
        except Exception:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            raise
        return {"opened": True, "expires_at": expires_at}

    async def get_ephemeral_media_status(self, request: Any, payload: dict[str, Any]) -> dict[str, Any]:
        requester = await self.api.get_user_by_req(request)
        user_id = requester.user.to_string()
        pair_info = self.pair_for_user(user_id)
        media_id = payload.get("media_id")
        if (
            pair_info is None
            or pair_info[0] != self.primary_pair_key
            or not isinstance(media_id, str)
            or not MEDIA_ID_PATTERN.fullmatch(media_id)
        ):
            raise SynapseError(403, "This account cannot inspect expiring media.", Codes.FORBIDDEN)
        await self.expire_ephemeral_media()
        row = self.db.execute(
            "SELECT room_id, state, expires_at FROM nymph_ephemeral_media WHERE media_id = ?",
            (media_id,),
        ).fetchone()
        if row is None or row[0] != self.room_id(pair_info[0]):
            raise SynapseError(404, "Expiring media was not found.", Codes.NOT_FOUND)
        media_info = await self.media_repository.store.get_local_media(media_id) if self.media_repository else None
        media_path = (
            self.media_repository.filepaths.local_media_filepath(media_id)
            if self.media_repository is not None
            else ""
        )
        return {
            "state": row[1],
            "expires_at": row[2],
            "media_exists": media_info is not None and os.path.isfile(media_path),
        }

    async def set_conversation_retention(self, request: Any, payload: dict[str, Any]) -> dict[str, Any]:
        requester = await self.api.get_user_by_req(request)
        user_id = requester.user.to_string()
        pair_info = self.pair_for_user(user_id)
        seconds = payload.get("seconds")
        event_id = payload.get("event_id")
        await self.expire_room_messages()
        if (
            pair_info is None
            or pair_info[0] != self.primary_pair_key
            or not isinstance(event_id, str)
            or not EVENT_ID_PATTERN.fullmatch(event_id)
            or (
                seconds is not None
                and (
                    not isinstance(seconds, int)
                    or isinstance(seconds, bool)
                    or not 1 <= seconds <= MAX_RETENTION_SECONDS
                )
            )
        ):
            raise SynapseError(400, "Invalid conversation-retention policy.", Codes.INVALID_PARAM)
        room_id = self.room_id(pair_info[0])
        if not room_id:
            raise SynapseError(404, "The private room is not configured.", Codes.NOT_FOUND)
        event = self.db.execute(
            "SELECT room_id, sender, event_type, origin_server_ts "
            "FROM nymph_seen_room_events WHERE event_id = ?",
            (event_id,),
        ).fetchone()
        if (
            event is None
            or event[0] != room_id
            or event[1] not in {pair_info[1]["partner_a"], pair_info[1]["partner_b"]}
            or event[2] != "m.room.encrypted"
        ):
            raise SynapseError(404, "The encrypted policy event is not available in this room.", Codes.NOT_FOUND)
        event_timestamp = event[3]
        current = self.db.execute(
            "SELECT seconds, event_timestamp, event_id FROM nymph_retention_policy WHERE room_id = ?",
            (room_id,),
        ).fetchone()
        applied = current is None or (event_timestamp, event_id) > (current[1], current[2])
        if current and (event_timestamp, event_id) == (current[1], current[2]) and seconds != current[0]:
            raise SynapseError(409, "The policy event has already been applied with a different value.", Codes.INVALID_PARAM)
        if applied:
            self.db.execute(
                "INSERT INTO nymph_retention_policy (room_id, seconds, event_timestamp, event_id) "
                "VALUES (?, ?, ?, ?) ON CONFLICT(room_id) DO UPDATE SET "
                "seconds = excluded.seconds, event_timestamp = excluded.event_timestamp, event_id = excluded.event_id",
                (room_id, seconds, event_timestamp, event_id),
            )
            if seconds is None:
                self.db.execute(
                    "DELETE FROM nymph_message_expiry WHERE event_id = ? AND state = 'scheduled'",
                    (event_id,),
                )
            else:
                self.db.execute(
                    "UPDATE nymph_message_expiry SET expires_at = ? "
                    "WHERE event_id = ? AND state = 'scheduled'",
                    (event_timestamp + seconds * 1000, event_id),
                )
        effective = self.db.execute(
            "SELECT seconds, event_timestamp, event_id FROM nymph_retention_policy WHERE room_id = ?",
            (room_id,),
        ).fetchone()
        return {
            "seconds": effective[0],
            "event_timestamp": effective[1],
            "event_id": effective[2],
            "applied": applied,
        }

    async def get_conversation_retention(self, request: Any) -> dict[str, Any]:
        requester = await self.api.get_user_by_req(request)
        pair_info = self.pair_for_user(requester.user.to_string())
        if pair_info is None or pair_info[0] != self.primary_pair_key:
            raise SynapseError(403, "This account cannot inspect conversation retention.", Codes.FORBIDDEN)
        room_id = self.room_id(pair_info[0])
        if not room_id:
            raise SynapseError(404, "The private room is not configured.", Codes.NOT_FOUND)
        row = self.db.execute(
            "SELECT seconds, event_timestamp, event_id FROM nymph_retention_policy WHERE room_id = ?",
            (room_id,),
        ).fetchone()
        return {
            "seconds": row[0] if row else None,
            "event_timestamp": row[1] if row else None,
            "event_id": row[2] if row else None,
        }

    async def register_message_relation(self, request: Any, payload: dict[str, Any]) -> dict[str, bool]:
        requester = await self.api.get_user_by_req(request)
        user_id = requester.user.to_string()
        pair_info = self.pair_for_user(user_id)
        child_event_id = payload.get("child_event_id")
        parent_event_id = payload.get("parent_event_id")
        if (
            pair_info is None
            or pair_info[0] != self.primary_pair_key
            or not isinstance(child_event_id, str)
            or not EVENT_ID_PATTERN.fullmatch(child_event_id)
            or not isinstance(parent_event_id, str)
            or not EVENT_ID_PATTERN.fullmatch(parent_event_id)
        ):
            raise SynapseError(400, "Invalid expiring-message relation.", Codes.INVALID_PARAM)
        room_id = self.room_id(pair_info[0])
        child = self.db.execute(
            "SELECT room_id, sender FROM nymph_seen_room_events WHERE event_id = ?",
            (child_event_id,),
        ).fetchone()
        parent = self.db.execute(
            "SELECT room_id FROM nymph_seen_room_events WHERE event_id = ?",
            (parent_event_id,),
        ).fetchone()
        if not child or not parent or child[0] != room_id or parent[0] != room_id:
            raise SynapseError(404, "The related events are not available in the private room.", Codes.NOT_FOUND)
        self.db.execute(
            "INSERT INTO nymph_message_relations (child_event_id, parent_event_id, room_id) "
            "VALUES (?, ?, ?) ON CONFLICT(child_event_id) DO UPDATE SET "
            "parent_event_id = excluded.parent_event_id, room_id = excluded.room_id",
            (child_event_id, parent_event_id, room_id),
        )
        parent_expiry = self.db.execute(
            "SELECT expires_at, state FROM nymph_message_expiry WHERE event_id = ?",
            (parent_event_id,),
        ).fetchone()
        if parent_expiry:
            expires_at = min(parent_expiry[0], now_ms()) if parent_expiry[1] == "redacted" else parent_expiry[0]
            self.db.execute(
                "INSERT INTO nymph_message_expiry (event_id, room_id, sender, expires_at, state) "
                "VALUES (?, ?, ?, ?, 'scheduled') ON CONFLICT(event_id) DO UPDATE SET "
                "expires_at = MIN(nymph_message_expiry.expires_at, excluded.expires_at)",
                (child_event_id, room_id, child[1], expires_at),
            )
        return {"registered": True}

    async def get_message_expiry_status(self, request: Any, payload: dict[str, Any]) -> dict[str, Any]:
        requester = await self.api.get_user_by_req(request)
        pair_info = self.pair_for_user(requester.user.to_string())
        event_id = payload.get("event_id")
        if (
            pair_info is None
            or pair_info[0] != self.primary_pair_key
            or not isinstance(event_id, str)
            or not EVENT_ID_PATTERN.fullmatch(event_id)
        ):
            raise SynapseError(403, "This account cannot inspect message expiration.", Codes.FORBIDDEN)
        await self.expire_room_messages()
        room_id = self.room_id(pair_info[0])
        seen = self.db.execute(
            "SELECT room_id FROM nymph_seen_room_events WHERE event_id = ?",
            (event_id,),
        ).fetchone()
        if not seen or seen[0] != room_id:
            raise SynapseError(404, "The room event was not found.", Codes.NOT_FOUND)
        expiry = self.db.execute(
            "SELECT state, expires_at, redaction_event_id FROM nymph_message_expiry WHERE event_id = ?",
            (event_id,),
        ).fetchone()
        return {
            "state": expiry[0] if expiry else "never",
            "expires_at": expiry[1] if expiry else None,
            "redaction_event_id": expiry[2] if expiry else None,
        }

    async def reconcile_expired_messages(self, request: Any, payload: dict[str, Any]) -> dict[str, list[str]]:
        requester = await self.api.get_user_by_req(request)
        pair_info = self.pair_for_user(requester.user.to_string())
        event_ids = payload.get("event_ids")
        if (
            pair_info is None
            or pair_info[0] != self.primary_pair_key
            or not isinstance(event_ids, list)
            or len(event_ids) > MAX_RETENTION_RECONCILE_EVENTS
            or any(not isinstance(event_id, str) or not EVENT_ID_PATTERN.fullmatch(event_id) for event_id in event_ids)
        ):
            raise SynapseError(400, "Invalid message-expiry reconciliation request.", Codes.INVALID_PARAM)
        room_id = self.room_id(pair_info[0])
        if not room_id:
            raise SynapseError(404, "The private room is not configured.", Codes.NOT_FOUND)
        if not event_ids:
            return {"expired_event_ids": []}

        await self.expire_room_messages()
        unique_event_ids = list(dict.fromkeys(event_ids))
        placeholders = ",".join("?" for _ in unique_event_ids)
        expired = self.db.execute(
            "SELECT event_id FROM nymph_message_expiry "
            f"WHERE room_id = ? AND event_id IN ({placeholders}) "
            "AND (state = 'redacted' OR expires_at <= ?)",
            (room_id, *unique_event_ids, now_ms()),
        ).fetchall()
        return {"expired_event_ids": [row[0] for row in expired]}

    async def expire_room_messages(self) -> None:
        due = self.db.execute(
            "SELECT event_id, room_id, sender FROM nymph_message_expiry "
            "WHERE state = 'scheduled' AND expires_at <= ? ORDER BY expires_at LIMIT 100",
            (now_ms(),),
        ).fetchall()
        for event_id, room_id, sender in due:
            try:
                redaction = await self.api.create_and_send_event_into_room(
                    {
                        "type": "m.room.redaction",
                        "room_id": room_id,
                        "sender": sender,
                        "redacts": event_id,
                        "content": {
                            "reason": "Expired by NYMPH conversation retention",
                        },
                    }
                )
            except Exception:
                self.worker_failures["messages"] = True
                logger.exception("Could not redact an expired NYMPH room event.")
                continue
            redaction_event_id = getattr(redaction, "event_id", None)
            self.db.execute(
                "UPDATE nymph_message_expiry SET state = 'redacted', redaction_event_id = ? "
                "WHERE event_id = ? AND state = 'scheduled'",
                (redaction_event_id, event_id),
            )

    async def run_media_expiry_worker(self) -> None:
        try:
            await self.expire_ephemeral_media()
        except Exception:
            self.worker_failures["media"] = True
            logger.exception("NYMPH media-expiry worker failed.")
            return
        self.worker_failures["media"] = False
        self.worker_heartbeats["media"] = now_ms()

    async def run_message_expiry_worker(self) -> None:
        self.worker_failures["messages"] = False
        try:
            await self.expire_room_messages()
        except Exception:
            self.worker_failures["messages"] = True
            logger.exception("NYMPH message-expiry worker failed.")
            return
        if not self.worker_failures["messages"]:
            self.worker_heartbeats["messages"] = now_ms()

    def worker_health(self) -> dict[str, Any]:
        current_time = now_ms()
        workers = {
            name: {
                "last_success_ms": last_success,
                "healthy": (
                    last_success is not None
                    and current_time - last_success <= WORKER_HEALTH_MAX_AGE_MS
                    and not self.worker_failures[name]
                ),
            }
            for name, last_success in self.worker_heartbeats.items()
        }
        try:
            self.db.execute("SELECT 1").fetchone()
            state_store_healthy = True
        except sqlite3.Error:
            state_store_healthy = False
        healthy = state_store_healthy and all(worker["healthy"] for worker in workers.values())
        if self.policy_mode == "production" and self.media_repository is None:
            healthy = False
        return {
            "healthy": healthy,
            "state_store_healthy": state_store_healthy,
            "workers": workers,
        }

    def authorized_ephemeral_media_path(self, user_id: str, media_id: str) -> str:
        if not MEDIA_ID_PATTERN.fullmatch(media_id):
            raise SynapseError(404, "Expiring media was not found.", Codes.NOT_FOUND)
        pair_info = self.pair_for_user(user_id)
        row = self.db.execute(
            "SELECT room_id, owner_user_id, state, opened_by, expires_at "
            "FROM nymph_ephemeral_media WHERE media_id = ?",
            (media_id,),
        ).fetchone()
        if (
            pair_info is None
            or pair_info[0] != self.primary_pair_key
            or row is None
            or row[0] != self.room_id(pair_info[0])
            or row[1] == user_id
            or row[2] != "opened"
            or row[3] != user_id
            or row[4] <= now_ms()
            or self.media_repository is None
        ):
            raise SynapseError(403, "This account cannot retrieve this expiring media.", Codes.FORBIDDEN)
        return self.media_repository.filepaths.local_media_filepath(media_id)

    async def expire_ephemeral_media(self) -> None:
        if self.media_repository is None:
            return
        expired = self.db.execute(
            "SELECT media_id FROM nymph_ephemeral_media "
            "WHERE expires_at <= ? AND state != 'deleted' ORDER BY expires_at LIMIT 100",
            (now_ms(),),
        ).fetchall()
        if not expired:
            return
        media_ids = [row[0] for row in expired]
        deleted_ids, _count = await self.media_repository.delete_local_media_ids(media_ids)
        if set(deleted_ids) != set(media_ids):
            self.worker_failures["media"] = True
            logger.error("Server-side expiration did not delete all due media objects.")
        for media_id in deleted_ids:
            self.db.execute(
                "UPDATE nymph_ephemeral_media SET state = 'deleted' WHERE media_id = ?",
                (media_id,),
            )

    async def check_login_for_spam(
        self,
        user_id: str,
        device_id: str | None,
        _initial_display_name: str | None,
        _request_info: Any,
        _auth_provider_id: str | None = None,
    ) -> str | Codes:
        if user_id not in self.partner_users:
            return NOT_SPAM
        if not device_id:
            return Codes.FORBIDDEN

        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute(
                "SELECT device_id, first_login_allowed FROM nymph_active_device WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            if row is None:
                self.db.execute("ROLLBACK")
                return Codes.FORBIDDEN
            active_device_id, first_login_allowed = row
            if active_device_id == device_id:
                self.db.execute("COMMIT")
                return NOT_SPAM

            pending = self.db.execute(
                "SELECT device_id, expires_at FROM nymph_pending_device WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            if pending and pending[0] == device_id and pending[1] > now_ms():
                self.db.execute("COMMIT")
                return NOT_SPAM

            if active_device_id is None and first_login_allowed:
                self.db.execute(
                    "UPDATE nymph_active_device SET device_id = ?, first_login_allowed = 0 WHERE user_id = ?",
                    (device_id, user_id),
                )
                self.db.execute("COMMIT")
                return NOT_SPAM

            self.db.execute("ROLLBACK")
            return Codes.FORBIDDEN
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    async def on_new_event(self, event: Any, _state: Any) -> None:
        if event.type == "m.room.create":
            if event.content.get("m.federate") is not False:
                return
            pair_info = self.pair_for_user(event.sender)
            if pair_info is None:
                return
            pair_key, pair = pair_info
            if event.sender != pair["partner_a"]:
                return
            table = pair["table"]
            self.db.execute("BEGIN IMMEDIATE")
            try:
                row = self.db.execute(
                    f"SELECT room_id, creation_reserved_at FROM {table} WHERE id = 1"
                ).fetchone()
                reserved_at = row[1] if row else None
                if (
                    row
                    and row[0] is None
                    and reserved_at is not None
                    and now_ms() - reserved_at <= ROOM_RESERVATION_TTL_MS
                ):
                    self.db.execute(
                        f"UPDATE {table} SET room_id = ?, creation_reserved_at = NULL WHERE id = 1",
                        (event.room_id,),
                    )
                self.db.execute("COMMIT")
            except Exception:
                self.db.execute("ROLLBACK")
                raise
            return

        if event.type != "m.room.encrypted":
            return
        pair_info = self.pair_for_room(event.room_id)
        event_id = getattr(event, "event_id", None)
        event_timestamp = getattr(event, "origin_server_ts", None)
        if (
            pair_info is None
            or pair_info[0] != self.primary_pair_key
            or event.sender not in {pair_info[1]["partner_a"], pair_info[1]["partner_b"]}
            or not isinstance(event_id, str)
            or not EVENT_ID_PATTERN.fullmatch(event_id)
        ):
            return
        if not isinstance(event_timestamp, int) or isinstance(event_timestamp, bool):
            event_timestamp = now_ms()
        self.db.execute(
            "INSERT OR IGNORE INTO nymph_seen_room_events "
            "(event_id, room_id, sender, event_type, origin_server_ts) VALUES (?, ?, ?, ?, ?)",
            (event_id, event.room_id, event.sender, event.type, event_timestamp),
        )
        policy = self.db.execute(
            "SELECT seconds FROM nymph_retention_policy WHERE room_id = ?",
            (event.room_id,),
        ).fetchone()
        if policy and policy[0] is not None:
            self.db.execute(
                "INSERT OR IGNORE INTO nymph_message_expiry "
                "(event_id, room_id, sender, expires_at, state) VALUES (?, ?, ?, ?, 'scheduled')",
                (
                    event_id,
                    event.room_id,
                    event.sender,
                    event_timestamp + policy[0] * 1000,
                ),
            )

    async def user_may_create_room(self, user_id: str, room_config: dict[str, Any]) -> str | Codes:
        pair_info = self.pair_for_user(user_id)
        if pair_info is None:
            return Codes.FORBIDDEN
        pair_key, pair = pair_info
        if user_id != pair["partner_a"] or not is_private_encrypted_room(
            room_config,
            pair["partner_a"],
            pair["partner_b"],
        ):
            return Codes.FORBIDDEN

        now = now_ms()
        table = pair["table"]
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute(
                f"SELECT room_id, creation_reserved_at FROM {table} WHERE id = 1"
            ).fetchone()
            if row[0] is not None:
                self.db.execute("ROLLBACK")
                return Codes.FORBIDDEN
            reservation = row[1]
            if reservation is not None and now - reservation < ROOM_RESERVATION_TTL_MS:
                self.db.execute("ROLLBACK")
                return Codes.FORBIDDEN
            self.db.execute(
                f"UPDATE {table} SET creation_reserved_at = ? WHERE id = 1",
                (now,),
            )
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        return NOT_SPAM

    async def check_event_for_spam(self, event: Any) -> str | Codes:
        event_type = event.type
        content = event.content
        room_id = event.room_id
        sender = event.sender
        if event_type == "m.room.create":
            pair_info = self.pair_for_user(sender)
            if pair_info is None or sender != pair_info[1]["partner_a"] or content.get("m.federate") is not False:
                return Codes.FORBIDDEN
            _pair_key, pair = pair_info
            table = pair["table"]
            self.db.execute("BEGIN IMMEDIATE")
            try:
                row = self.db.execute(
                    f"SELECT room_id, creation_reserved_at FROM {table} WHERE id = 1"
                ).fetchone()
                if row[0] is not None or row[1] is None or now_ms() - row[1] > ROOM_RESERVATION_TTL_MS:
                    self.db.execute("ROLLBACK")
                    return Codes.FORBIDDEN
                self.db.execute(
                    f"UPDATE {table} SET room_id = ?, creation_reserved_at = NULL WHERE id = 1",
                    (room_id,),
                )
                self.db.execute("COMMIT")
            except Exception:
                self.db.execute("ROLLBACK")
                raise
            return NOT_SPAM

        pair_info = self.pair_for_room(room_id)
        if pair_info is None:
            return Codes.FORBIDDEN
        _pair_key, pair = pair_info
        if event_type == "m.room.member":
            target = event.state_key
            membership = content.get("membership")
            if target not in {pair["partner_a"], pair["partner_b"]} or membership not in {"join", "invite", "leave"}:
                return Codes.FORBIDDEN
            if membership == "invite" and (sender != pair["partner_a"] or target != pair["partner_b"]):
                return Codes.FORBIDDEN
            if membership in {"join", "leave"} and sender != target:
                return Codes.FORBIDDEN
        elif event_type == "m.room.join_rules":
            if content.get("join_rule") != "invite":
                return Codes.FORBIDDEN
        elif event_type == "m.room.history_visibility":
            if content.get("history_visibility") != "joined":
                return Codes.FORBIDDEN
        elif event_type == "m.room.encryption":
            if content.get("algorithm") != ROOM_ENCRYPTION:
                return Codes.FORBIDDEN
        elif event_type == "m.room.power_levels":
            if not self.valid_power_levels(content, pair["partner_a"], pair["partner_b"]):
                return Codes.FORBIDDEN
        return NOT_SPAM

    def valid_power_levels(self, content: dict[str, Any], partner_a: str, partner_b: str) -> bool:
        users = content.get("users")
        return (
            isinstance(users, dict)
            and users.get(partner_b) == 0
            and users.get(partner_a, 100) == 100
            and set(users).issubset({partner_a, partner_b})
            and content.get("users_default", 0) == 0
            and content.get("events_default", 0) == 0
            and content.get("state_default", 100) == 100
            and content.get("invite", 100) == 100
            and content.get("kick", 100) == 100
            and content.get("ban", 100) == 100
            and content.get("redact", 100) == 100
            and not content.get("events")
        )

    async def user_may_join_room(self, user_id: str, room_id: str, is_invited: bool) -> str | Codes:
        pair_info = self.pair_for_room(room_id)
        if pair_info is None:
            return Codes.FORBIDDEN
        pair = pair_info[1]
        if user_id not in {pair["partner_a"], pair["partner_b"]}:
            return Codes.FORBIDDEN
        if user_id == pair["partner_b"] and not is_invited:
            return Codes.FORBIDDEN
        return NOT_SPAM

    async def user_may_invite(self, inviter: str, invitee: str, room_id: str) -> str | Codes:
        pair_info = self.pair_for_user(inviter)
        if pair_info is None:
            return Codes.FORBIDDEN
        pair_key, pair = pair_info
        if inviter != pair["partner_a"] or invitee != pair["partner_b"]:
            return Codes.FORBIDDEN
        configured_room_id = self.room_id(pair_key)
        if configured_room_id is not None:
            return NOT_SPAM if room_id == configured_room_id else Codes.FORBIDDEN

        table = pair["table"]
        reservation = self.db.execute(
            f"SELECT creation_reserved_at FROM {table} WHERE id = 1"
        ).fetchone()
        reserved_at = reservation[0] if reservation else None
        if reserved_at is not None and now_ms() - reserved_at < ROOM_RESERVATION_TTL_MS:
            return NOT_SPAM
        return Codes.FORBIDDEN

    async def user_may_create_room_alias(self, user_id: str, room_alias: Any) -> str | Codes:
        return Codes.FORBIDDEN

    async def user_may_publish_room(self, user_id: str, room_id: str) -> str | Codes:
        return Codes.FORBIDDEN

    async def authenticated_partner_a(self, request: Any) -> tuple[str, dict[str, str]]:
        requester = await self.api.get_user_by_req(request)
        pair_info = self.pair_for_user(requester.user.to_string())
        if pair_info is None or requester.user.to_string() != pair_info[1]["partner_a"]:
            raise SynapseError(403, "Only a configured partner A may manage its pairing invitation.", Codes.FORBIDDEN)
        return pair_info

    async def create_invitation(self, request: Any, payload: dict[str, Any]) -> dict[str, Any]:
        pair_key, pair = await self.authenticated_partner_a(request)
        room_id = self.room_id(pair_key)
        if room_id is None:
            raise SynapseError(409, "Create the private room before inviting partner B.", Codes.INVALID_PARAM)
        if payload.get("room_id") != room_id:
            raise SynapseError(403, "This is not the configured private room.", Codes.FORBIDDEN)
        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode("ascii")).hexdigest()
        expires_at = now_ms() + INVITATION_TTL_MS
        async with self.invitation_lock:
            for existing_hash, (existing_pair, _existing_expiry) in list(self.invitations.items()):
                if existing_pair == pair_key:
                    del self.invitations[existing_hash]
            self.invitations[token_hash] = (pair_key, expires_at)
            self.invitation_status[pair_key] = {"status": "pending", "expires_at": expires_at}
        return {
            "version": 1,
            "homeserver": self.homeserver_url,
            "partner_user_id": pair["partner_b"],
            "room_id": room_id,
            "token": raw_token,
            "expires_at": expires_at,
        }

    async def cancel_invitation(self, request: Any) -> dict[str, bool]:
        pair_key, _pair = await self.authenticated_partner_a(request)
        async with self.invitation_lock:
            for token_hash, (existing_pair, _expiry) in list(self.invitations.items()):
                if existing_pair == pair_key:
                    del self.invitations[token_hash]
            self.invitation_status[pair_key] = {"status": "cancelled", "expires_at": None}
        return {"cancelled": True}

    async def get_room_status(self, request: Any) -> dict[str, Any]:
        pair_key, _pair = await self.authenticated_partner_a(request)
        async with self.invitation_lock:
            status = self.invitation_status[pair_key]
            if status["status"] == "pending" and (
                status["expires_at"] is None or status["expires_at"] <= now_ms()
            ):
                for token_hash, (existing_pair, _expiry) in list(self.invitations.items()):
                    if existing_pair == pair_key:
                        del self.invitations[token_hash]
                self.invitation_status[pair_key] = {"status": "expired", "expires_at": None}
            return {
                "room_id": self.room_id(pair_key),
                "pairing_status": self.invitation_status[pair_key]["status"],
                "expires_at": self.invitation_status[pair_key]["expires_at"],
            }

    async def redeem_invitation(self, payload: dict[str, Any]) -> dict[str, Any]:
        raw_token = payload.get("token")
        if (
            not isinstance(raw_token, str)
            or not raw_token.isascii()
            or len(raw_token) < 40
            or len(raw_token) > 128
        ):
            raise SynapseError(400, "Invalid invitation.", Codes.INVALID_PARAM)
        token_hash = hashlib.sha256(raw_token.encode("ascii")).hexdigest()
        async with self.invitation_lock:
            invitation = self.invitations.get(token_hash)
            if invitation is None or invitation[1] <= now_ms():
                self.invitations.pop(token_hash, None)
                raise SynapseError(403, "Invitation expired or already used.", Codes.FORBIDDEN)
            del self.invitations[token_hash]
            pair_key, _expires_at = invitation
            pair = self.pairs[pair_key]
            self.invitation_status[pair_key] = {"status": "redeemed", "expires_at": None}

        login_token = await self.api.create_login_token(
            pair["partner_b"],
            duration_in_ms=LOGIN_TOKEN_TTL_MS,
        )
        return {
            "homeserver": self.homeserver_url,
            "partner_user_id": pair["partner_b"],
            "room_id": self.room_id(pair_key),
            "login_token": login_token,
            "expires_in_ms": LOGIN_TOKEN_TTL_MS,
        }

    async def create_device_replacement(self, request: Any, payload: dict[str, Any]) -> dict[str, Any]:
        requester = await self.api.get_user_by_req(request)
        user_id = requester.user.to_string()
        if user_id not in self.partner_users:
            raise SynapseError(403, "Device replacement is available only for development partner accounts.", Codes.FORBIDDEN)

        device_id = payload.get("device_id")
        if not isinstance(device_id, str) or not device_id or len(device_id) > 512:
            raise SynapseError(400, "A valid replacement device ID is required.", Codes.INVALID_PARAM)
        if device_id == getattr(requester, "device_id", None):
            raise SynapseError(400, "The replacement must use a different device ID.", Codes.INVALID_PARAM)
        room_id = self.room_id("dev")
        if not room_id:
            raise SynapseError(409, "Device replacement requires the configured development room.", Codes.INVALID_PARAM)

        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute(
                "SELECT device_id FROM nymph_active_device WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            if row is None or row[0] != getattr(requester, "device_id", None):
                self.db.execute("ROLLBACK")
                raise SynapseError(403, "Only the active device can authorize its replacement.", Codes.FORBIDDEN)
            pending = self.db.execute(
                "SELECT expires_at FROM nymph_pending_device WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            if pending and pending[0] > now_ms():
                self.db.execute("ROLLBACK")
                raise SynapseError(409, "A device replacement is already pending.", Codes.INVALID_PARAM)
            expires_at = now_ms() + LOGIN_TOKEN_TTL_MS
            self.db.execute(
                "INSERT OR REPLACE INTO nymph_pending_device "
                "(user_id, device_id, previous_device_id, expires_at, purpose) VALUES (?, ?, ?, ?, 'replace')",
                (user_id, device_id, row[0], expires_at),
            )
            self.db.execute("COMMIT")
        except SynapseError:
            raise
        except Exception:
            self.db.execute("ROLLBACK")
            raise

        try:
            login_token = await self.api.create_login_token(user_id, duration_in_ms=LOGIN_TOKEN_TTL_MS)
        except Exception:
            self.db.execute(
                "DELETE FROM nymph_pending_device WHERE user_id = ? AND device_id = ? AND purpose = 'replace'",
                (user_id, device_id),
            )
            raise

        return {
            "user_id": user_id,
            "device_id": device_id,
            "previous_device_id": row[0],
            "room_id": room_id,
            "login_token": login_token,
            "expires_in_ms": LOGIN_TOKEN_TTL_MS,
        }

    async def create_recovery_verification(self, request: Any, payload: dict[str, Any]) -> dict[str, Any]:
        requester = await self.api.get_user_by_req(request)
        user_id = requester.user.to_string()
        active_device_id = getattr(requester, "device_id", None)
        if user_id not in self.partner_users or not active_device_id:
            raise SynapseError(403, "Recovery verification requires an authenticated development partner device.", Codes.FORBIDDEN)

        device_id = payload.get("device_id")
        if not isinstance(device_id, str) or not device_id or len(device_id) > 512:
            raise SynapseError(400, "A valid temporary verification device ID is required.", Codes.INVALID_PARAM)
        if device_id == active_device_id:
            raise SynapseError(400, "Recovery verification requires a separate device ID.", Codes.INVALID_PARAM)

        self.db.execute("BEGIN IMMEDIATE")
        try:
            active = self.db.execute(
                "SELECT device_id FROM nymph_active_device WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            pending = self.db.execute(
                "SELECT expires_at FROM nymph_pending_device WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            if active is None or active[0] != active_device_id:
                self.db.execute("ROLLBACK")
                raise SynapseError(403, "Only the active device can authorize recovery verification.", Codes.FORBIDDEN)
            if pending and pending[0] > now_ms():
                self.db.execute("ROLLBACK")
                raise SynapseError(409, "Another device operation is already pending.", Codes.INVALID_PARAM)

            expires_at = now_ms() + LOGIN_TOKEN_TTL_MS
            self.db.execute(
                "INSERT OR REPLACE INTO nymph_pending_device "
                "(user_id, device_id, previous_device_id, expires_at, purpose) "
                "VALUES (?, ?, ?, ?, 'recovery')",
                (user_id, device_id, active_device_id, expires_at),
            )
            self.db.execute("COMMIT")
        except SynapseError:
            raise
        except Exception:
            self.db.execute("ROLLBACK")
            raise

        try:
            login_token = await self.api.create_login_token(user_id, duration_in_ms=LOGIN_TOKEN_TTL_MS)
        except Exception:
            self.db.execute(
                "DELETE FROM nymph_pending_device WHERE user_id = ? AND device_id = ? AND purpose = 'recovery'",
                (user_id, device_id),
            )
            raise
        return {
            "user_id": user_id,
            "device_id": device_id,
            "login_token": login_token,
            "expires_in_ms": LOGIN_TOKEN_TTL_MS,
        }

    async def activate_device_replacement(self, request: Any) -> dict[str, bool]:
        requester = await self.api.get_user_by_req(request)
        user_id = requester.user.to_string()
        device_id = getattr(requester, "device_id", None)
        if user_id not in self.partner_users or not device_id:
            raise SynapseError(403, "Only an authenticated development partner device can be activated.", Codes.FORBIDDEN)

        self.db.execute("BEGIN IMMEDIATE")
        try:
            pending = self.db.execute(
                "SELECT device_id, expires_at, purpose FROM nymph_pending_device WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            if pending is None:
                active = self.db.execute(
                    "SELECT device_id FROM nymph_active_device WHERE user_id = ?",
                    (user_id,),
                ).fetchone()
                if active and active[0] == device_id:
                    self.db.execute("COMMIT")
                    return {"activated": True}
            if not pending or pending[0] != device_id or pending[2] != "replace":
                self.db.execute("ROLLBACK")
                raise SynapseError(403, "This device has no active replacement authorization.", Codes.FORBIDDEN)
            self.db.execute(
                "UPDATE nymph_active_device SET device_id = ?, first_login_allowed = 0 WHERE user_id = ?",
                (device_id, user_id),
            )
            self.db.execute("DELETE FROM nymph_pending_device WHERE user_id = ?", (user_id,))
            self.db.execute("COMMIT")
        except SynapseError:
            raise
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        return {"activated": True}

    async def cancel_device_replacement(self, request: Any) -> dict[str, bool]:
        requester = await self.api.get_user_by_req(request)
        user_id = requester.user.to_string()
        device_id = getattr(requester, "device_id", None)
        if user_id not in self.partner_users or not device_id:
            raise SynapseError(403, "Only an authenticated development partner device can cancel replacement.", Codes.FORBIDDEN)

        self.db.execute("BEGIN IMMEDIATE")
        try:
            pending = self.db.execute(
                "SELECT device_id, previous_device_id, expires_at, purpose FROM nymph_pending_device WHERE user_id = ?",
                (user_id,),
            ).fetchone()
            if not pending:
                self.db.execute("ROLLBACK")
                raise SynapseError(403, "There is no active device replacement to cancel.", Codes.FORBIDDEN)
            if device_id not in {pending[0], pending[1]}:
                self.db.execute("ROLLBACK")
                raise SynapseError(403, "This device cannot cancel the pending replacement.", Codes.FORBIDDEN)
            if pending[3] == "replace":
                self.db.execute(
                    "UPDATE nymph_active_device SET device_id = ? WHERE user_id = ?",
                    (pending[1], user_id),
                )
            self.db.execute("DELETE FROM nymph_pending_device WHERE user_id = ?", (user_id,))
            self.db.execute("COMMIT")
        except SynapseError:
            raise
        except Exception:
            self.db.execute("ROLLBACK")
            raise
        return {"cancelled": True}
