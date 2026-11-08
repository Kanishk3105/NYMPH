import asyncio
import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from synapse.api.errors import Codes, SynapseError
from synapse.module_api import NOT_SPAM

from nymph_policy import NymphPolicy, is_private_encrypted_room, now_ms


PARTNER_A = "@partner1:localhost"
PARTNER_B = "@partner2:localhost"
DEV_PARTNER_A = "@partner1-dev:localhost"
DEV_PARTNER_B = "@partner2-dev:localhost"
PROD_PARTNER_A = "@alice:matrix.nymph.com"
PROD_PARTNER_B = "@bob:matrix.nymph.com"
ROOM_ID = "!private:localhost"
DEV_ROOM_ID = "!private-dev:localhost"
PROD_ROOM_ID = "!private-prod:matrix.nymph.com"


def valid_room_config(partner_b: str = PARTNER_B) -> dict:
    return {
        "visibility": "private",
        "preset": "private_chat",
        "invite": [partner_b],
        "creation_content": {"m.federate": False},
        "initial_state": [
            {"type": "m.room.encryption", "state_key": "", "content": {"algorithm": "m.megolm.v1.aes-sha2"}},
            {"type": "m.room.join_rules", "state_key": "", "content": {"join_rule": "invite"}},
            {"type": "m.room.history_visibility", "state_key": "", "content": {"history_visibility": "joined"}},
            {
                "type": "m.room.power_levels",
                "state_key": "",
                "content": {
                    "users": {partner_b: 0},
                    "users_default": 0,
                    "events_default": 0,
                    "state_default": 100,
                    "invite": 100,
                    "kick": 100,
                    "ban": 100,
                    "redact": 100,
                },
            },
        ],
    }


def valid_dev_room_config() -> dict:
    config = valid_room_config()
    config["invite"] = [DEV_PARTNER_B]
    config["initial_state"][-1]["content"]["users"] = {DEV_PARTNER_B: 0}
    return config


def valid_production_policy_config(state_path: str) -> dict:
    return {
        "policy_mode": "production",
        "partner_a_user_id": PROD_PARTNER_A,
        "partner_b_user_id": PROD_PARTNER_B,
        "server_name": "matrix.nymph.com",
        "homeserver_url": "https://matrix.nymph.com",
        "app_origins": "https://app.nymph.com",
        "state_path": state_path,
    }


class FakeApi:
    def __init__(self) -> None:
        self.login_token_count = 0
        self.user_id = PARTNER_A
        self.device_id = None
        self.registered_callbacks = {}
        self.background_calls = []
        self.sent_events = []
        self.web_resources = {}

    def register_spam_checker_callbacks(self, **callbacks) -> None:
        self.registered_callbacks.update(callbacks)

    def register_third_party_rules_callbacks(self, **_callbacks) -> None:
        pass

    def register_web_resource(self, path, resource) -> None:
        self.web_resources[path] = resource

    def looping_background_call(self, callback, interval_ms, **kwargs) -> None:
        self.background_calls.append((callback, interval_ms, kwargs))

    async def create_and_send_event_into_room(self, event_dict):
        self.sent_events.append(event_dict)
        return SimpleNamespace(event_id=f"$redaction-{len(self.sent_events)}")

    async def get_user_by_req(self, _request):
        return SimpleNamespace(
            user=SimpleNamespace(to_string=lambda: self.user_id),
            device_id=self.device_id,
        )

    async def create_login_token(self, user_id: str, duration_in_ms: int) -> str:
        self.login_token_count += 1
        self.login_token_duration = duration_in_ms
        return f"one-time-{user_id}"


class NymphPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.api = FakeApi()
        self.policy = NymphPolicy(
            {
                "partner_a_user_id": PARTNER_A,
                "partner_b_user_id": PARTNER_B,
                "dev_partner_a_user_id": DEV_PARTNER_A,
                "dev_partner_b_user_id": DEV_PARTNER_B,
                "homeserver_url": "http://localhost:8008",
                "server_name": "localhost",
                "legacy_pair_enabled": True,
                "app_origins": "http://localhost:5173,https://localhost",
                "state_path": str(Path(self.temp_dir.name) / "policy.sqlite3"),
            },
            self.api,
        )
        self.state_path = str(Path(self.temp_dir.name) / "policy.sqlite3")

    async def asyncTearDown(self) -> None:
        self.policy.db.close()
        self.temp_dir.cleanup()

    async def reserve_room(self) -> None:
        self.assertEqual(await self.policy.user_may_create_room(PARTNER_A, valid_room_config()), NOT_SPAM)

    async def record_room(self) -> None:
        await self.reserve_room()
        await self.policy.on_new_event(
            SimpleNamespace(
                type="m.room.create",
                sender=PARTNER_A,
                content={"m.federate": False},
                room_id=ROOM_ID,
            ),
            {},
        )

    async def reserve_dev_room(self) -> None:
        self.assertEqual(
            await self.policy.user_may_create_room(DEV_PARTNER_A, valid_dev_room_config()),
            NOT_SPAM,
        )

    async def record_dev_room(self) -> None:
        await self.reserve_dev_room()
        await self.policy.check_event_for_spam(
            SimpleNamespace(
                type="m.room.create",
                sender=DEV_PARTNER_A,
                content={"m.federate": False},
                room_id=DEV_ROOM_ID,
            ),
        )

    async def record_encrypted_event(
        self,
        event_id: str,
        sender: str = DEV_PARTNER_A,
        timestamp: int | None = None,
    ) -> None:
        await self.policy.on_new_event(
            SimpleNamespace(
                type="m.room.encrypted",
                sender=sender,
                room_id=DEV_ROOM_ID,
                event_id=event_id,
                origin_server_ts=timestamp if timestamp is not None else now_ms(),
            ),
            {},
        )

    def test_production_policy_config_requires_two_production_accounts_and_secure_urls(self) -> None:
        config = valid_production_policy_config(self.state_path)
        self.assertIs(NymphPolicy.parse_config(config), config)

        invalid_configs = [
            {**config, "homeserver_url": "http://matrix.nymph.com"},
            {**config, "app_origins": "http://app.nymph.com"},
            {**config, "partner_b_user_id": DEV_PARTNER_B},
            {**config, "dev_partner_a_user_id": DEV_PARTNER_A},
        ]
        for invalid in invalid_configs:
            with self.subTest(config=invalid), self.assertRaises(ValueError):
                NymphPolicy.parse_config(invalid)

    async def test_production_policy_enforces_membership_and_persists_room_across_restart(self) -> None:
        api = FakeApi()
        api._hs = SimpleNamespace(get_media_repository=lambda: object())
        config = valid_production_policy_config(self.state_path)
        self.policy.db.close()
        policy = NymphPolicy(config, api)
        try:
            self.assertEqual(
                await policy.user_may_create_room(PROD_PARTNER_A, valid_room_config(PROD_PARTNER_B)),
                NOT_SPAM,
            )
            self.assertEqual(
                await policy.check_event_for_spam(
                    SimpleNamespace(
                        type="m.room.create",
                        sender=PROD_PARTNER_A,
                        content={"m.federate": False},
                        room_id=PROD_ROOM_ID,
                    )
                ),
                NOT_SPAM,
            )
            self.assertEqual(
                await policy.user_may_join_room("@intruder:matrix.nymph.com", PROD_ROOM_ID, False),
                Codes.FORBIDDEN,
            )
            self.assertEqual(
                await policy.user_may_invite(PROD_PARTNER_A, "@intruder:matrix.nymph.com", PROD_ROOM_ID),
                Codes.FORBIDDEN,
            )
            self.assertEqual(
                await policy.user_may_join_room(PROD_PARTNER_B, PROD_ROOM_ID, True),
                NOT_SPAM,
            )
            self.assertEqual(policy.worker_health()["healthy"], False)
            self.assertIn("/_synapse/client/nymph/health", api.web_resources)
            self.assertTrue(all(call[2]["run_on_all_instances"] is False for call in api.background_calls))

            restarted_api = FakeApi()
            restarted_api._hs = SimpleNamespace(get_media_repository=lambda: object())
            restarted = NymphPolicy(config, restarted_api)
            try:
                self.assertEqual(restarted.room_id("primary"), PROD_ROOM_ID)
                self.assertEqual(
                    await restarted.user_may_join_room("@intruder:matrix.nymph.com", PROD_ROOM_ID, True),
                    Codes.FORBIDDEN,
                )
            finally:
                restarted.db.close()
        finally:
            policy.db.close()

    def test_requires_private_non_federatable_encrypted_room(self) -> None:
        self.assertTrue(is_private_encrypted_room(valid_room_config(), PARTNER_A, PARTNER_B))

        invalid = valid_room_config()
        invalid["initial_state"][0]["content"]["algorithm"] = "m.megolm.v1.aes-sha2-weak"
        self.assertFalse(is_private_encrypted_room(invalid, PARTNER_A, PARTNER_B))

    async def test_each_partner_a_can_reserve_only_its_private_room(self) -> None:
        self.assertEqual(
            await self.policy.user_may_create_room(PARTNER_B, valid_room_config()),
            Codes.FORBIDDEN,
        )
        await self.reserve_room()
        self.assertEqual(
            await self.policy.user_may_create_room(PARTNER_A, valid_room_config()),
            Codes.FORBIDDEN,
        )

    async def test_creation_event_binds_later_policy_to_its_room(self) -> None:
        await self.record_room()
        self.assertEqual(self.policy.current_room_id(), ROOM_ID)
        self.assertEqual(
            await self.policy.user_may_create_room(PARTNER_A, valid_room_config()),
            Codes.FORBIDDEN,
        )

    async def test_only_the_two_partners_can_join_and_only_a_can_invite_b(self) -> None:
        await self.record_room()
        self.assertEqual(await self.policy.user_may_join_room(PARTNER_A, ROOM_ID, False), NOT_SPAM)
        self.assertEqual(await self.policy.user_may_join_room(PARTNER_B, ROOM_ID, True), NOT_SPAM)
        self.assertEqual(await self.policy.user_may_join_room(PARTNER_B, ROOM_ID, False), Codes.FORBIDDEN)
        self.assertEqual(await self.policy.user_may_join_room("@third:localhost", ROOM_ID, True), Codes.FORBIDDEN)
        self.assertEqual(await self.policy.user_may_invite(PARTNER_A, PARTNER_B, ROOM_ID), NOT_SPAM)
        self.assertEqual(await self.policy.user_may_invite(PARTNER_A, "@third:localhost", ROOM_ID), Codes.FORBIDDEN)
        self.assertEqual(await self.policy.user_may_invite(PARTNER_B, PARTNER_A, ROOM_ID), Codes.FORBIDDEN)

    async def test_legacy_and_dev_rooms_are_independent_and_preserve_legacy_membership(self) -> None:
        await self.record_room()
        await self.record_dev_room()

        self.assertEqual(self.policy.current_room_id(), ROOM_ID)
        self.assertEqual(self.policy.room_id("dev"), DEV_ROOM_ID)
        self.assertEqual(await self.policy.user_may_join_room(PARTNER_A, ROOM_ID, False), NOT_SPAM)
        self.assertEqual(await self.policy.user_may_join_room(PARTNER_B, ROOM_ID, True), NOT_SPAM)
        self.assertEqual(await self.policy.user_may_join_room(DEV_PARTNER_A, ROOM_ID, True), Codes.FORBIDDEN)
        self.assertEqual(await self.policy.user_may_join_room(DEV_PARTNER_B, ROOM_ID, True), Codes.FORBIDDEN)
        self.assertEqual(await self.policy.user_may_join_room(DEV_PARTNER_A, DEV_ROOM_ID, False), NOT_SPAM)
        self.assertEqual(await self.policy.user_may_join_room(DEV_PARTNER_B, DEV_ROOM_ID, True), NOT_SPAM)
        self.assertEqual(await self.policy.user_may_join_room(PARTNER_A, DEV_ROOM_ID, True), Codes.FORBIDDEN)
        self.assertEqual(await self.policy.user_may_join_room("@third:localhost", DEV_ROOM_ID, True), Codes.FORBIDDEN)

    async def test_isolated_policy_uses_only_dev_ids_and_its_own_policy_schema(self) -> None:
        isolated_path = Path(self.temp_dir.name) / "isolated-policy.sqlite3"
        isolated_config = {
            "server_name": "nymph-dev.localhost",
            "legacy_pair_enabled": False,
            "dev_partner_a_user_id": "@partner1-dev:nymph-dev.localhost",
            "dev_partner_b_user_id": "@partner2-dev:nymph-dev.localhost",
            "homeserver_url": "http://127.0.0.1:8008",
            "app_origins": "http://localhost:5173",
            "state_path": str(isolated_path),
        }
        NymphPolicy.parse_config(isolated_config)
        isolated = NymphPolicy(isolated_config, FakeApi())
        try:
            tables = {
                row[0]
                for row in isolated.db.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            self.assertNotIn("nymph_room_policy", tables)
            self.assertIn("nymph_dev_room_policy", tables)
            self.assertNotIn(PARTNER_A, isolated.dev_users)
            self.assertEqual(isolated.current_room_id(), None)
            self.assertEqual(
                await isolated.user_may_join_room(PARTNER_A, DEV_ROOM_ID, True),
                Codes.FORBIDDEN,
            )
        finally:
            isolated.db.close()

    def test_isolated_policy_rejects_archived_identity_configuration(self) -> None:
        config = {
            "server_name": "nymph-dev.localhost",
            "legacy_pair_enabled": False,
            "partner_a_user_id": PARTNER_A,
            "partner_b_user_id": PARTNER_B,
            "dev_partner_a_user_id": "@partner1-dev:nymph-dev.localhost",
            "dev_partner_b_user_id": "@partner2-dev:nymph-dev.localhost",
            "homeserver_url": "http://127.0.0.1:18008",
            "app_origins": "http://localhost:5173",
            "state_path": str(Path(self.temp_dir.name) / "rejected-policy.sqlite3"),
        }
        with self.assertRaises(ValueError):
            NymphPolicy.parse_config(config)

    async def test_each_room_rejects_cross_pair_and_third_party_invites(self) -> None:
        await self.record_room()
        await self.record_dev_room()
        self.assertEqual(await self.policy.user_may_invite(PARTNER_A, PARTNER_B, ROOM_ID), NOT_SPAM)
        self.assertEqual(await self.policy.user_may_invite(DEV_PARTNER_A, DEV_PARTNER_B, DEV_ROOM_ID), NOT_SPAM)
        self.assertEqual(await self.policy.user_may_invite(PARTNER_A, DEV_PARTNER_B, ROOM_ID), Codes.FORBIDDEN)
        self.assertEqual(await self.policy.user_may_invite(DEV_PARTNER_A, PARTNER_B, DEV_ROOM_ID), Codes.FORBIDDEN)
        self.assertEqual(await self.policy.user_may_invite(DEV_PARTNER_A, "@third:localhost", DEV_ROOM_ID), Codes.FORBIDDEN)

    async def test_pairing_invitation_is_single_use_and_login_token_is_short_lived(self) -> None:
        await self.record_room()
        invitation = await self.policy.create_invitation(object(), {"room_id": ROOM_ID})
        paired = await self.policy.redeem_invitation({"token": invitation["token"]})

        self.assertEqual(paired["partner_user_id"], PARTNER_B)
        self.assertEqual(paired["room_id"], ROOM_ID)
        self.assertEqual(paired["expires_in_ms"], 120_000)
        self.assertEqual(self.api.login_token_count, 1)
        with self.assertRaises(SynapseError):
            await self.policy.redeem_invitation({"token": invitation["token"]})

    async def test_expired_pairing_invitation_is_rejected(self) -> None:
        raw_token = "expired-invitation-token-which-is-long-enough"
        token_hash = hashlib.sha256(raw_token.encode("ascii")).hexdigest()
        self.policy.invitations[token_hash] = ("legacy", now_ms() - 1)

        with self.assertRaises(SynapseError) as error:
            await self.policy.redeem_invitation({"token": raw_token})
        self.assertEqual(error.exception.code, 403)

    async def test_partner_a_can_observe_and_cancel_the_active_pairing(self) -> None:
        await self.record_room()
        await self.policy.create_invitation(object(), {"room_id": ROOM_ID})
        status = await self.policy.get_room_status(object())
        self.assertEqual(status["room_id"], ROOM_ID)
        self.assertEqual(status["pairing_status"], "pending")
        self.assertIsInstance(status["expires_at"], int)

        self.assertEqual(await self.policy.cancel_invitation(object()), {"cancelled": True})
        status = await self.policy.get_room_status(object())
        self.assertEqual(status["pairing_status"], "cancelled")

    async def test_dev_pairing_uses_its_own_room_and_partner_identity(self) -> None:
        await self.record_dev_room()
        self.api.user_id = DEV_PARTNER_A
        invitation = await self.policy.create_invitation(object(), {"room_id": DEV_ROOM_ID})
        paired = await self.policy.redeem_invitation({"token": invitation["token"]})

        self.assertEqual(invitation["partner_user_id"], DEV_PARTNER_B)
        self.assertEqual(paired["partner_user_id"], DEV_PARTNER_B)
        self.assertEqual(paired["room_id"], DEV_ROOM_ID)
        self.assertEqual(self.api.login_token_count, 1)

    async def test_ephemeral_media_claim_is_partner_only_and_single_use(self) -> None:
        await self.record_dev_room()
        media_path = Path(self.temp_dir.name) / "ciphertext.bin"
        media_path.write_bytes(b"encrypted media")
        self.policy.media_repository = SimpleNamespace(
            store=SimpleNamespace(
                get_local_media=lambda _media_id: asyncio.sleep(
                    0,
                    result=SimpleNamespace(user_id=DEV_PARTNER_A, media_length=15),
                ),
            ),
            filepaths=SimpleNamespace(local_media_filepath=lambda _media_id: str(media_path)),
        )
        self.api.user_id = DEV_PARTNER_A
        registered = await self.policy.register_ephemeral_media(
            object(),
            {
                "media_id": "ciphertext-id",
                "room_id": DEV_ROOM_ID,
                "duration_seconds": 10,
            },
        )
        self.assertTrue(registered["registered"])
        self.assertGreater(registered["pending_expires_at"], now_ms())
        self.assertLessEqual(
            registered["pending_expires_at"] - now_ms(),
            30 * 24 * 60 * 60 * 1000,
        )
        with self.assertRaises(SynapseError):
            self.policy.authorized_ephemeral_media_path(DEV_PARTNER_A, "ciphertext-id")

        other_path = Path(self.temp_dir.name) / "other-ciphertext.bin"
        other_path.write_bytes(b"another encrypted upload")
        self.policy.media_repository.store.get_local_media = lambda _media_id: asyncio.sleep(
            0,
            result=SimpleNamespace(user_id=DEV_PARTNER_B, media_length=24),
        )
        with self.assertRaises(SynapseError):
            await self.policy.register_ephemeral_media(
                object(),
                {
                    "media_id": "other-ciphertext",
                    "room_id": DEV_ROOM_ID,
                    "duration_seconds": 10,
                },
            )
        self.policy.media_repository.store.get_local_media = lambda _media_id: asyncio.sleep(
            0,
            result=SimpleNamespace(user_id=DEV_PARTNER_A, media_length=15),
        )

        with self.assertRaises(SynapseError):
            await self.policy.open_ephemeral_media(object(), {"media_id": "ciphertext-id"})
        self.api.user_id = DEV_PARTNER_B
        first_open = await self.policy.open_ephemeral_media(object(), {"media_id": "ciphertext-id"})
        self.assertTrue(first_open["opened"])
        with self.assertRaises(SynapseError) as second_open:
            await self.policy.open_ephemeral_media(object(), {"media_id": "ciphertext-id"})
        self.assertEqual(second_open.exception.code, 410)
        self.assertEqual(
            self.policy.authorized_ephemeral_media_path(DEV_PARTNER_B, "ciphertext-id"),
            str(media_path),
        )
        self.api.user_id = "@unrelated:nymph-dev.localhost"
        with self.assertRaises(SynapseError):
            self.policy.authorized_ephemeral_media_path(self.api.user_id, "ciphertext-id")

    async def test_unopened_media_accepts_bounded_pending_expiry(self) -> None:
        await self.record_dev_room()
        media_path = Path(self.temp_dir.name) / "short-lived-ciphertext.bin"
        media_path.write_bytes(b"encrypted media")
        self.policy.media_repository = SimpleNamespace(
            store=SimpleNamespace(
                get_local_media=lambda _media_id: asyncio.sleep(
                    0,
                    result=SimpleNamespace(user_id=DEV_PARTNER_A, media_length=15),
                ),
            ),
            filepaths=SimpleNamespace(local_media_filepath=lambda _media_id: str(media_path)),
        )
        self.api.user_id = DEV_PARTNER_A
        result = await self.policy.register_ephemeral_media(
            object(),
            {
                "media_id": "short-lived-ciphertext",
                "room_id": DEV_ROOM_ID,
                "duration_seconds": 5,
                "pending_ttl_seconds": 2,
            },
        )
        remaining_ms = result["pending_expires_at"] - now_ms()
        self.assertGreater(remaining_ms, 0)
        self.assertLessEqual(remaining_ms, 2_000)
        with self.assertRaises(SynapseError):
            await self.policy.register_ephemeral_media(
                object(),
                {
                    "media_id": "invalid-pending-ciphertext",
                    "room_id": DEV_ROOM_ID,
                    "duration_seconds": 5,
                    "pending_ttl_seconds": 0,
                },
            )

    async def test_conversation_retention_schedules_custom_expiry_and_never(self) -> None:
        await self.record_dev_room()
        self.api.user_id = DEV_PARTNER_A
        policy_timestamp = now_ms()
        await self.record_encrypted_event("$policy-never", timestamp=policy_timestamp)
        never = await self.policy.set_conversation_retention(
            object(),
            {"event_id": "$policy-never", "seconds": None},
        )
        self.assertTrue(never["applied"])
        self.assertIsNone(never["seconds"])

        await self.record_encrypted_event("$never-message", timestamp=policy_timestamp + 1)
        never_status = await self.policy.get_message_expiry_status(
            object(),
            {"event_id": "$never-message"},
        )
        self.assertEqual(never_status["state"], "never")

        self.api.user_id = DEV_PARTNER_B
        with self.assertRaises(SynapseError):
            await self.policy.set_conversation_retention(
                object(),
                {"event_id": "$not-seen", "seconds": 1},
            )
        self.api.user_id = DEV_PARTNER_A
        await self.record_encrypted_event("$policy-custom", timestamp=policy_timestamp + 2)
        custom = await self.policy.set_conversation_retention(
            object(),
            {"event_id": "$policy-custom", "seconds": 2},
        )
        self.assertEqual(custom["seconds"], 2)
        self.assertTrue(custom["applied"])

        await self.record_encrypted_event("$parent", timestamp=policy_timestamp + 3)
        parent_status = await self.policy.get_message_expiry_status(
            object(),
            {"event_id": "$parent"},
        )
        self.assertEqual(parent_status["state"], "scheduled")
        self.assertEqual(parent_status["expires_at"], policy_timestamp + 2_003)

        await self.record_encrypted_event("$policy-never-again", timestamp=policy_timestamp + 4)
        await self.policy.set_conversation_retention(
            object(),
            {"event_id": "$policy-never-again", "seconds": None},
        )
        await self.record_encrypted_event("$reply", sender=DEV_PARTNER_B, timestamp=policy_timestamp + 5)
        self.api.user_id = DEV_PARTNER_B
        await self.policy.register_message_relation(
            object(),
            {"child_event_id": "$reply", "parent_event_id": "$parent"},
        )
        reply_status = await self.policy.get_message_expiry_status(
            object(),
            {"event_id": "$reply"},
        )
        self.assertEqual(reply_status["state"], "scheduled")
        self.assertEqual(reply_status["expires_at"], parent_status["expires_at"])

        self.policy.db.execute(
            "UPDATE nymph_message_expiry SET expires_at = ? WHERE event_id IN (?, ?)",
            (now_ms() - 1, "$parent", "$reply"),
        )
        await self.policy.expire_room_messages()
        self.assertEqual(
            {event["redacts"] for event in self.api.sent_events},
            {"$parent", "$reply"},
        )

    async def test_expiry_reconciliation_returns_only_expired_events_in_the_private_room(self) -> None:
        await self.record_dev_room()
        self.api.user_id = DEV_PARTNER_A
        policy_timestamp = now_ms()
        await self.record_encrypted_event("$reconcile-policy", timestamp=policy_timestamp)
        await self.policy.set_conversation_retention(
            object(),
            {"event_id": "$reconcile-policy", "seconds": 10},
        )
        await self.record_encrypted_event("$reconcile-due", timestamp=policy_timestamp + 1)
        await self.record_encrypted_event("$reconcile-future", timestamp=policy_timestamp + 2)
        self.policy.db.execute(
            "UPDATE nymph_message_expiry SET expires_at = ? WHERE event_id = ?",
            (now_ms() - 1, "$reconcile-due"),
        )

        result = await self.policy.reconcile_expired_messages(
            object(),
            {"event_ids": ["$reconcile-due", "$reconcile-future", "$not-in-room"]},
        )
        self.assertEqual(result, {"expired_event_ids": ["$reconcile-due"]})

        self.api.user_id = DEV_PARTNER_B
        self.assertEqual(
            await self.policy.reconcile_expired_messages(
                object(),
                {"event_ids": ["$reconcile-due"]},
            ),
            {"expired_event_ids": ["$reconcile-due"]},
        )
        with self.assertRaises(SynapseError):
            await self.policy.reconcile_expired_messages(
                object(),
                {"event_ids": ["not-an-event-id"]},
            )
        with self.assertRaises(SynapseError):
            await self.policy.reconcile_expired_messages(
                object(),
                {"event_ids": ["$event"] * 101},
            )

    async def test_expiry_jobs_persist_across_policy_reinitialization(self) -> None:
        await self.record_dev_room()
        self.api.user_id = DEV_PARTNER_A
        await self.record_encrypted_event("$policy-persist")
        await self.policy.set_conversation_retention(
            object(),
            {"event_id": "$policy-persist", "seconds": 1},
        )
        await self.record_encrypted_event("$persisted-message")
        self.policy.db.execute(
            "UPDATE nymph_message_expiry SET expires_at = ? WHERE event_id = ?",
            (now_ms() - 1, "$persisted-message"),
        )
        self.policy.db.close()
        self.api = FakeApi()
        self.api.user_id = DEV_PARTNER_A
        self.policy = NymphPolicy(
            {
                "server_name": "localhost",
                "legacy_pair_enabled": False,
                "dev_partner_a_user_id": DEV_PARTNER_A,
                "dev_partner_b_user_id": DEV_PARTNER_B,
                "homeserver_url": "http://127.0.0.1:18008",
                "app_origins": "http://localhost:5173",
                "state_path": self.state_path,
            },
            self.api,
        )
        await self.policy.expire_room_messages()
        status = await self.policy.get_message_expiry_status(
            object(),
            {"event_id": "$persisted-message"},
        )
        self.assertEqual(status["state"], "redacted")
        self.assertEqual(self.api.sent_events[0]["redacts"], "$persisted-message")

    async def test_ephemeral_media_expiration_deletes_ciphertext_and_persists_status(self) -> None:
        await self.record_dev_room()
        media_path = Path(self.temp_dir.name) / "ciphertext.bin"
        media_path.write_bytes(b"encrypted media")

        async def delete_local_media_ids(media_ids: list[str]) -> tuple[list[str], int]:
            media_path.unlink(missing_ok=True)
            return media_ids, len(media_ids)

        self.policy.media_repository = SimpleNamespace(
            store=SimpleNamespace(
                get_local_media=lambda _media_id: asyncio.sleep(
                    0,
                    result=SimpleNamespace(user_id=DEV_PARTNER_A, media_length=15),
                ),
            ),
            filepaths=SimpleNamespace(local_media_filepath=lambda _media_id: str(media_path)),
            delete_local_media_ids=delete_local_media_ids,
        )
        self.api.user_id = DEV_PARTNER_A
        await self.policy.register_ephemeral_media(
            object(),
            {
                "media_id": "expired-ciphertext",
                "room_id": DEV_ROOM_ID,
                "duration_seconds": 5,
            },
        )
        self.policy.db.execute(
            "UPDATE nymph_ephemeral_media SET expires_at = ? WHERE media_id = ?",
            (now_ms() - 1, "expired-ciphertext"),
        )

        await self.policy.expire_ephemeral_media()

        self.assertFalse(media_path.exists())
        state = self.policy.db.execute(
            "SELECT state FROM nymph_ephemeral_media WHERE media_id = ?",
            ("expired-ciphertext",),
        ).fetchone()[0]
        self.assertEqual(state, "deleted")
        status = await self.policy.get_ephemeral_media_status(
            object(),
            {"media_id": "expired-ciphertext"},
        )
        self.assertEqual(status["state"], "deleted")
        self.assertFalse(status["media_exists"])
        self.api.user_id = "@unrelated:nymph-dev.localhost"
        with self.assertRaises(SynapseError):
            await self.policy.get_ephemeral_media_status(
                object(),
                {"media_id": "expired-ciphertext"},
            )

    async def test_dev_login_admits_one_active_device_and_replacement_only(self) -> None:
        await self.record_dev_room()
        callback = self.api.registered_callbacks["check_login_for_spam"]
        first_device = "dev-first"
        second_device = "dev-second"

        self.assertEqual(await callback(DEV_PARTNER_A, first_device, None, [], None), NOT_SPAM)
        self.assertEqual(await callback(DEV_PARTNER_A, first_device, None, [], None), NOT_SPAM)
        self.assertEqual(await callback(DEV_PARTNER_A, second_device, None, [], None), Codes.FORBIDDEN)

        self.api.user_id = DEV_PARTNER_A
        self.api.device_id = first_device
        replacement = await self.policy.create_device_replacement(object(), {"device_id": second_device})
        self.assertEqual(replacement["device_id"], second_device)
        self.assertEqual(replacement["room_id"], DEV_ROOM_ID)
        self.assertEqual(await callback(DEV_PARTNER_A, second_device, None, [], None), NOT_SPAM)
        self.assertEqual(await callback(DEV_PARTNER_A, first_device, None, [], None), NOT_SPAM)
        active = self.policy.db.execute(
            "SELECT device_id FROM nymph_active_device WHERE user_id = ?",
            (DEV_PARTNER_A,),
        ).fetchone()[0]
        self.assertEqual(active, first_device)

        self.api.device_id = second_device
        self.assertEqual(await self.policy.activate_device_replacement(object()), {"activated": True})
        self.assertEqual(await self.policy.activate_device_replacement(object()), {"activated": True})
        self.assertEqual(await callback(DEV_PARTNER_A, first_device, None, [], None), Codes.FORBIDDEN)

    async def test_pending_replacement_can_be_cancelled_by_either_authorized_device(self) -> None:
        await self.record_dev_room()
        callback = self.api.registered_callbacks["check_login_for_spam"]
        self.assertEqual(await callback(DEV_PARTNER_A, "active-device", None, [], None), NOT_SPAM)
        self.api.user_id = DEV_PARTNER_A
        self.api.device_id = "active-device"
        await self.policy.create_device_replacement(object(), {"device_id": "replacement"})
        self.api.device_id = "replacement"
        self.assertEqual(await self.policy.cancel_device_replacement(object()), {"cancelled": True})
        self.assertEqual(await callback(DEV_PARTNER_A, "active-device", None, [], None), NOT_SPAM)
        self.assertEqual(await callback(DEV_PARTNER_A, "replacement", None, [], None), Codes.FORBIDDEN)

    async def test_authenticated_replacement_can_activate_after_login_token_expiry(self) -> None:
        await self.record_dev_room()
        callback = self.api.registered_callbacks["check_login_for_spam"]
        self.assertEqual(await callback(DEV_PARTNER_A, "active-device", None, [], None), NOT_SPAM)
        self.api.user_id = DEV_PARTNER_A
        self.api.device_id = "active-device"
        await self.policy.create_device_replacement(object(), {"device_id": "replacement"})
        self.assertEqual(await callback(DEV_PARTNER_A, "replacement", None, [], None), NOT_SPAM)
        self.policy.db.execute(
            "UPDATE nymph_pending_device SET expires_at = ? WHERE user_id = ?",
            (now_ms() - 1, DEV_PARTNER_A),
        )

        self.api.device_id = "replacement"
        self.assertEqual(await self.policy.activate_device_replacement(object()), {"activated": True})
        self.assertEqual(await callback(DEV_PARTNER_A, "active-device", None, [], None), Codes.FORBIDDEN)

    async def test_device_replacement_requires_the_current_active_device(self) -> None:
        await self.record_dev_room()
        callback = self.api.registered_callbacks["check_login_for_spam"]
        self.assertEqual(await callback(DEV_PARTNER_A, "active-device", None, [], None), NOT_SPAM)
        self.api.user_id = DEV_PARTNER_A
        self.api.device_id = "different-device"
        with self.assertRaises(SynapseError) as error:
            await self.policy.create_device_replacement(object(), {"device_id": "replacement"})
        self.assertEqual(error.exception.code, 403)

    async def test_recovery_verifier_is_authorized_by_active_device_but_cannot_replace_it(self) -> None:
        callback = self.api.registered_callbacks["check_login_for_spam"]
        active_device = "active-device"
        verifier_device = "temporary-verifier"
        self.assertEqual(await callback(DEV_PARTNER_A, active_device, None, [], None), NOT_SPAM)

        self.api.user_id = DEV_PARTNER_A
        self.api.device_id = active_device
        authorization = await self.policy.create_recovery_verification(
            object(),
            {"device_id": verifier_device},
        )
        self.assertEqual(authorization["user_id"], DEV_PARTNER_A)
        self.assertEqual(authorization["device_id"], verifier_device)
        self.assertEqual(authorization["expires_in_ms"], 120_000)
        self.assertEqual(await callback(DEV_PARTNER_A, verifier_device, None, [], None), NOT_SPAM)

        self.api.device_id = verifier_device
        with self.assertRaises(SynapseError) as error:
            await self.policy.activate_device_replacement(object())
        self.assertEqual(error.exception.code, 403)
        self.assertEqual(await self.policy.cancel_device_replacement(object()), {"cancelled": True})

        active = self.policy.db.execute(
            "SELECT device_id FROM nymph_active_device WHERE user_id = ?",
            (DEV_PARTNER_A,),
        ).fetchone()[0]
        self.assertEqual(active, active_device)
        self.assertEqual(await callback(DEV_PARTNER_A, verifier_device, None, [], None), Codes.FORBIDDEN)

    async def test_recovery_verifier_requires_the_current_active_device(self) -> None:
        callback = self.api.registered_callbacks["check_login_for_spam"]
        self.assertEqual(await callback(DEV_PARTNER_A, "active-device", None, [], None), NOT_SPAM)
        self.api.user_id = DEV_PARTNER_A
        self.api.device_id = "unrelated-device"

        with self.assertRaises(SynapseError) as error:
            await self.policy.create_recovery_verification(object(), {"device_id": "temporary-verifier"})
        self.assertEqual(error.exception.code, 403)
        self.assertEqual(self.api.login_token_count, 0)


if __name__ == "__main__":
    unittest.main()
