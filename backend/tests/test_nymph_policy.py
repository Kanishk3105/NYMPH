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
ROOM_ID = "!private:localhost"
DEV_ROOM_ID = "!private-dev:localhost"


def valid_room_config() -> dict:
    return {
        "visibility": "private",
        "preset": "private_chat",
        "invite": [PARTNER_B],
        "creation_content": {"m.federate": False},
        "initial_state": [
            {"type": "m.room.encryption", "state_key": "", "content": {"algorithm": "m.megolm.v1.aes-sha2"}},
            {"type": "m.room.join_rules", "state_key": "", "content": {"join_rule": "invite"}},
            {"type": "m.room.history_visibility", "state_key": "", "content": {"history_visibility": "joined"}},
            {
                "type": "m.room.power_levels",
                "state_key": "",
                "content": {
                    "users": {PARTNER_B: 0},
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


class FakeApi:
    def __init__(self) -> None:
        self.login_token_count = 0
        self.user_id = PARTNER_A
        self.device_id = None
        self.registered_callbacks = {}

    def register_spam_checker_callbacks(self, **callbacks) -> None:
        self.registered_callbacks.update(callbacks)

    def register_third_party_rules_callbacks(self, **_callbacks) -> None:
        pass

    def register_web_resource(self, *_args) -> None:
        pass

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
            "homeserver_url": "http://127.0.0.1:18008",
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
