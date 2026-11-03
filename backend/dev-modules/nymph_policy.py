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
            "homeserver_url",
            "app_origins",
            "state_path",
        )
        if any(not isinstance(config.get(key), str) or not config[key] for key in required):
            raise ValueError("NYMPH policy requires both development IDs and local service URLs.")
        if config["partner_a_user_id"] == config["partner_b_user_id"]:
            raise ValueError("NYMPH development partner IDs must be distinct.")
        if not all(
            user_id.startswith("@") and user_id.endswith(":localhost")
            for user_id in (config["partner_a_user_id"], config["partner_b_user_id"])
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
        self.partner_a = config["partner_a_user_id"]
        self.partner_b = config["partner_b_user_id"]
        self.homeserver_url = config["homeserver_url"]
        self.app_origins = set(config["app_origins"].split(","))
        self.api = api
        self.invitation_lock = asyncio.Lock()
        self.invitations: dict[str, int] = {}
        self.invitation_status = "not_created"
        self.invitation_expires_at: int | None = None
        self.db = sqlite3.connect(config["state_path"], check_same_thread=False, isolation_level=None)
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS nymph_room_policy "
            "(id INTEGER PRIMARY KEY CHECK (id = 1), room_id TEXT, creation_reserved_at INTEGER)"
        )
        self.db.execute(
            "INSERT OR IGNORE INTO nymph_room_policy (id, room_id, creation_reserved_at) VALUES (1, NULL, NULL)"
        )
        self.api.register_spam_checker_callbacks(
            check_event_for_spam=self.check_event_for_spam,
            user_may_join_room=self.user_may_join_room,
            user_may_invite=self.user_may_invite,
            user_may_create_room=self.user_may_create_room,
            user_may_create_room_alias=self.user_may_create_room_alias,
            user_may_publish_room=self.user_may_publish_room,
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

    def current_room_id(self) -> str | None:
        row = self.db.execute("SELECT room_id FROM nymph_room_policy WHERE id = 1").fetchone()
        return row[0] if row else None

    async def on_new_event(self, event: Any, _state: Any) -> None:
        if (
            event.type != "m.room.create"
            or event.sender != self.partner_a
            or event.content.get("m.federate") is not False
        ):
            return

        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute(
                "SELECT room_id, creation_reserved_at FROM nymph_room_policy WHERE id = 1"
            ).fetchone()
            reserved_at = row[1] if row else None
            if (
                row
                and row[0] is None
                and reserved_at is not None
                and now_ms() - reserved_at <= ROOM_RESERVATION_TTL_MS
            ):
                self.db.execute(
                    "UPDATE nymph_room_policy SET room_id = ?, creation_reserved_at = NULL WHERE id = 1",
                    (event.room_id,),
                )
            self.db.execute("COMMIT")
        except Exception:
            self.db.execute("ROLLBACK")
            raise

    async def user_may_create_room(self, user_id: str, room_config: dict[str, Any]) -> str | Codes:
        if user_id != self.partner_a or not is_private_encrypted_room(room_config, self.partner_a, self.partner_b):
            return Codes.FORBIDDEN

        now = now_ms()
        self.db.execute("BEGIN IMMEDIATE")
        try:
            row = self.db.execute(
                "SELECT room_id, creation_reserved_at FROM nymph_room_policy WHERE id = 1"
            ).fetchone()
            if row[0] is not None:
                self.db.execute("ROLLBACK")
                return Codes.FORBIDDEN
            reservation = row[1]
            if reservation is not None and now - reservation < ROOM_RESERVATION_TTL_MS:
                self.db.execute("ROLLBACK")
                return Codes.FORBIDDEN
            self.db.execute(
                "UPDATE nymph_room_policy SET creation_reserved_at = ? WHERE id = 1",
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
            if sender != self.partner_a or content.get("m.federate") is not False:
                return Codes.FORBIDDEN
            self.db.execute("BEGIN IMMEDIATE")
            try:
                row = self.db.execute(
                    "SELECT room_id, creation_reserved_at FROM nymph_room_policy WHERE id = 1"
                ).fetchone()
                if row[0] is not None or row[1] is None or now_ms() - row[1] > ROOM_RESERVATION_TTL_MS:
                    self.db.execute("ROLLBACK")
                    return Codes.FORBIDDEN
                self.db.execute(
                    "UPDATE nymph_room_policy SET room_id = ?, creation_reserved_at = NULL WHERE id = 1",
                    (room_id,),
                )
                self.db.execute("COMMIT")
            except Exception:
                self.db.execute("ROLLBACK")
                raise
            return NOT_SPAM

        if room_id != self.current_room_id():
            return Codes.FORBIDDEN
        if event_type == "m.room.member":
            target = event.state_key
            membership = content.get("membership")
            if target not in {self.partner_a, self.partner_b} or membership not in {"join", "invite", "leave"}:
                return Codes.FORBIDDEN
            if membership == "invite" and (sender != self.partner_a or target != self.partner_b):
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
            if not self.valid_power_levels(content):
                return Codes.FORBIDDEN
        return NOT_SPAM

    def valid_power_levels(self, content: dict[str, Any]) -> bool:
        users = content.get("users")
        return (
            isinstance(users, dict)
            and users.get(self.partner_b) == 0
            and users.get(self.partner_a, 100) == 100
            and set(users).issubset({self.partner_a, self.partner_b})
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
        if room_id != self.current_room_id() or user_id not in {self.partner_a, self.partner_b}:
            return Codes.FORBIDDEN
        if user_id == self.partner_b and not is_invited:
            return Codes.FORBIDDEN
        return NOT_SPAM

    async def user_may_invite(self, inviter: str, invitee: str, room_id: str) -> str | Codes:
        if inviter != self.partner_a or invitee != self.partner_b:
            return Codes.FORBIDDEN
        configured_room_id = self.current_room_id()
        if configured_room_id is not None:
            return NOT_SPAM if room_id == configured_room_id else Codes.FORBIDDEN

        reservation = self.db.execute(
            "SELECT creation_reserved_at FROM nymph_room_policy WHERE id = 1"
        ).fetchone()
        reserved_at = reservation[0] if reservation else None
        if reserved_at is not None and now_ms() - reserved_at < ROOM_RESERVATION_TTL_MS:
            return NOT_SPAM
        return Codes.FORBIDDEN

    async def user_may_create_room_alias(self, user_id: str, room_alias: Any) -> str | Codes:
        return Codes.FORBIDDEN

    async def user_may_publish_room(self, user_id: str, room_id: str) -> str | Codes:
        return Codes.FORBIDDEN

    async def authenticated_partner_a(self, request: Any) -> None:
        requester = await self.api.get_user_by_req(request)
        if requester.user.to_string() != self.partner_a:
            raise SynapseError(403, "Only partner A may manage the development pairing invitation.", Codes.FORBIDDEN)

    async def create_invitation(self, request: Any, payload: dict[str, Any]) -> dict[str, Any]:
        await self.authenticated_partner_a(request)
        room_id = self.current_room_id()
        if room_id is None:
            raise SynapseError(409, "Create the private room before inviting partner B.", Codes.INVALID_PARAM)
        if payload.get("room_id") != room_id:
            raise SynapseError(403, "This is not the configured private room.", Codes.FORBIDDEN)
        raw_token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(raw_token.encode("ascii")).hexdigest()
        expires_at = now_ms() + INVITATION_TTL_MS
        async with self.invitation_lock:
            self.invitations.clear()
            self.invitations[token_hash] = expires_at
            self.invitation_status = "pending"
            self.invitation_expires_at = expires_at
        return {
            "version": 1,
            "homeserver": self.homeserver_url,
            "partner_user_id": self.partner_b,
            "room_id": room_id,
            "token": raw_token,
            "expires_at": expires_at,
        }

    async def cancel_invitation(self, request: Any) -> dict[str, bool]:
        await self.authenticated_partner_a(request)
        async with self.invitation_lock:
            self.invitations.clear()
            self.invitation_status = "cancelled"
            self.invitation_expires_at = None
        return {"cancelled": True}

    async def get_room_status(self, request: Any) -> dict[str, Any]:
        await self.authenticated_partner_a(request)
        async with self.invitation_lock:
            if self.invitation_status == "pending" and (
                self.invitation_expires_at is None or self.invitation_expires_at <= now_ms()
            ):
                self.invitations.clear()
                self.invitation_status = "expired"
            return {
                "room_id": self.current_room_id(),
                "pairing_status": self.invitation_status,
                "expires_at": self.invitation_expires_at,
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
            expires_at = self.invitations.get(token_hash)
            if expires_at is None or expires_at <= now_ms():
                self.invitations.pop(token_hash, None)
                self.invitation_status = "expired"
                raise SynapseError(403, "Invitation expired or already used.", Codes.FORBIDDEN)
            del self.invitations[token_hash]
            self.invitation_status = "redeemed"

        login_token = await self.api.create_login_token(
            self.partner_b,
            duration_in_ms=LOGIN_TOKEN_TTL_MS,
        )
        return {
            "homeserver": self.homeserver_url,
            "partner_user_id": self.partner_b,
            "room_id": self.current_room_id(),
            "login_token": login_token,
            "expires_in_ms": LOGIN_TOKEN_TTL_MS,
        }
