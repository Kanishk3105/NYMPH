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
ROOM_ID = "!private:localhost"


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


class FakeApi:
    def __init__(self) -> None:
        self.login_token_count = 0

    def register_spam_checker_callbacks(self, **_callbacks) -> None:
        pass

    def register_third_party_rules_callbacks(self, **_callbacks) -> None:
        pass

    def register_web_resource(self, *_args) -> None:
        pass

    async def get_user_by_req(self, _request):
        return SimpleNamespace(user=SimpleNamespace(to_string=lambda: PARTNER_A))

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
                "homeserver_url": "http://localhost:8008",
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

    def test_requires_private_non_federatable_encrypted_room(self) -> None:
        self.assertTrue(is_private_encrypted_room(valid_room_config(), PARTNER_A, PARTNER_B))

        invalid = valid_room_config()
        invalid["initial_state"][0]["content"]["algorithm"] = "m.megolm.v1.aes-sha2-weak"
        self.assertFalse(is_private_encrypted_room(invalid, PARTNER_A, PARTNER_B))

    async def test_only_partner_a_can_reserve_the_single_room(self) -> None:
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
        self.policy.invitations[token_hash] = now_ms() - 1

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


if __name__ == "__main__":
    unittest.main()
