import asyncio
import hashlib
import json
import logging
import secrets
import sqlite3
import time
from typing import Any

from synapse.api.errors import Codes, SynapseError
from synapse.module_api import NOT_SPAM, ModuleApi
from twisted.internet import defer
from twisted.web.resource import Resource
from twisted.web.server import NOT_DONE_YET


logger = logging.getLogger(__name__)
INVITATION_TTL_MS = 120_000
LOGIN_TOKEN_TTL_MS = 120_000
ROOM_RESERVATION_TTL_MS = 120_000
ROOM_ENCRYPTION = "m.megolm.v1.aes-sha2"


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


class NymphPolicy:
    @staticmethod
    def parse_config(config: dict[str, Any]) -> dict[str, Any]:
        required = (
            "partner_a_user_id",
            "partner_b_user_id",
            "dev_partner_a_user_id",
            "dev_partner_b_user_id",
            "homeserver_url",
            "app_origins",
            "state_path",
        )
        if any(not isinstance(config.get(key), str) or not config[key] for key in required):
            raise ValueError("NYMPH policy requires both development IDs and local service URLs.")
        user_ids = (
            config["partner_a_user_id"],
            config["partner_b_user_id"],
            config["dev_partner_a_user_id"],
            config["dev_partner_b_user_id"],
        )
        if len(set(user_ids)) != len(user_ids):
            raise ValueError("NYMPH legacy and development partner IDs must be distinct.")
        if user_ids[:2] != ("@partner1:localhost", "@partner2:localhost"):
            raise ValueError("The archived development identities cannot be rebound by the policy.")
        if user_ids[2:] != ("@partner1-dev:localhost", "@partner2-dev:localhost"):
            raise ValueError("The additive development identities must use their dedicated IDs.")
        if not all(
            user_id.startswith("@") and user_id.endswith(":localhost")
            for user_id in user_ids
        ):
            raise ValueError("The development-only policy accepts @user:localhost IDs.")
        homeserver = config["homeserver_url"]
        if not (
            homeserver == "http://localhost:8008"
            or homeserver.startswith("https://")
        ):
            raise ValueError("The development pairing endpoint must use localhost HTTP or HTTPS.")
        return config

    def __init__(self, config: dict[str, Any], api: ModuleApi) -> None:
        self.pairs = {
            "legacy": {
                "partner_a": config["partner_a_user_id"],
                "partner_b": config["partner_b_user_id"],
                "table": "nymph_room_policy",
            },
            "dev": {
                "partner_a": config["dev_partner_a_user_id"],
                "partner_b": config["dev_partner_b_user_id"],
                "table": "nymph_dev_room_policy",
            },
        }
        all_users = [
            user_id
            for pair in self.pairs.values()
            for user_id in (pair["partner_a"], pair["partner_b"])
        ]
        if len(set(all_users)) != len(all_users):
            raise ValueError("Legacy and development partner IDs must all be distinct.")
        self.dev_users = {
            self.pairs["dev"]["partner_a"],
            self.pairs["dev"]["partner_b"],
        }
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
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS nymph_room_policy "
            "(id INTEGER PRIMARY KEY CHECK (id = 1), room_id TEXT, creation_reserved_at INTEGER)"
        )
        self.db.execute(
            "INSERT OR IGNORE INTO nymph_room_policy (id, room_id, creation_reserved_at) VALUES (1, NULL, NULL)"
        )
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS nymph_dev_room_policy "
            "(id INTEGER PRIMARY KEY CHECK (id = 1), room_id TEXT, creation_reserved_at INTEGER)"
        )
        self.db.execute(
            "INSERT OR IGNORE INTO nymph_dev_room_policy "
            "(id, room_id, creation_reserved_at) VALUES (1, NULL, NULL)"
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
        for user_id in self.dev_users:
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
        return self.room_id("legacy")

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

    async def check_login_for_spam(
        self,
        user_id: str,
        device_id: str | None,
        _initial_display_name: str | None,
        _request_info: Any,
        _auth_provider_id: str | None = None,
    ) -> str | Codes:
        if user_id not in self.dev_users:
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
        if event.type != "m.room.create" or event.content.get("m.federate") is not False:
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
        if user_id not in self.dev_users:
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
        if user_id not in self.dev_users or not active_device_id:
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
        if user_id not in self.dev_users or not device_id:
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
        if user_id not in self.dev_users or not device_id:
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
