import os
import tempfile
import unittest
from unittest.mock import patch

from configure_synapse import apply_production_policy, read_secret, validate_server_name


class ProductionSynapseConfigTest(unittest.TestCase):
    def base_config(self):
        return {
            "server_name": "matrix.nymph.com",
            "listeners": [
                {
                    "resources": [
                        {"names": ["client", "federation"]},
                        {"names": ["openid"]},
                    ]
                }
            ],
        }

    def test_production_policy_sets_public_url_and_disables_external_federation(self):
        config = apply_production_policy(self.base_config(), "matrix.nymph.com")

        self.assertEqual(config["public_baseurl"], "https://matrix.nymph.com/")
        self.assertEqual(config["federation_domain_whitelist"], ["matrix.nymph.com"])
        self.assertFalse(config["enable_registration"])
        self.assertFalse(config["allow_guest_access"])
        self.assertTrue(config["block_non_admin_invites"])
        resources = config["listeners"][0]["resources"]
        self.assertEqual(resources, [{"names": ["client"]}, {"names": ["openid"]}])

    def test_production_policy_rejects_mismatched_generated_identity(self):
        with self.assertRaisesRegex(RuntimeError, "must match"):
            apply_production_policy(self.base_config(), "other.nymph.com")

    def test_production_policy_rejects_reserved_or_development_server_names(self):
        for name in [
            "nymph-dev.localhost",
            "matrix.example.com",
            "matrix.example.org",
            "matrix.example.net",
            "matrix.example",
            "UPPER.nymph.example",
        ]:
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, "production DNS hostname"):
                validate_server_name(name)

    def test_production_policy_requires_a_client_api_listener(self):
        config = self.base_config()
        config["listeners"][0]["resources"] = [{"names": ["federation"]}]
        with self.assertRaisesRegex(RuntimeError, "no client API"):
            apply_production_policy(config, "matrix.nymph.com")

    def test_production_secrets_must_contain_at_least_32_characters(self):
        with tempfile.TemporaryDirectory() as directory:
            secret_path = os.path.join(directory, "test-secret")
            with open(secret_path, "w", encoding="utf-8") as secret_file:
                secret_file.write("s" * 32)
            with patch.dict(os.environ, {"NYMPH_TEST_SECRET_FILE": secret_path}):
                self.assertEqual(read_secret("NYMPH_TEST_SECRET_FILE"), "s" * 32)

                with open(secret_path, "w", encoding="utf-8") as secret_file:
                    secret_file.write("s" * 31)
                with self.assertRaisesRegex(RuntimeError, "at least 32 characters"):
                    read_secret("NYMPH_TEST_SECRET_FILE")


if __name__ == "__main__":
    unittest.main()
