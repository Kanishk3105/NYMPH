import os
import pathlib
import tempfile

import yaml


CONFIG_PATH = pathlib.Path("/data/homeserver.yaml")


def main() -> None:
    if not CONFIG_PATH.is_file():
        raise RuntimeError("Synapse config is missing. Run the dev init profile first.")

    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    server_name = os.environ["SYNAPSE_SERVER_NAME"]
    if server_name != "localhost" or config.get("server_name") != server_name:
        raise RuntimeError("The local development homeserver must use the dev-only name 'localhost'.")

    partners = {
        os.environ["PARTNER_A_USER_ID"],
        os.environ["PARTNER_B_USER_ID"],
    }
    if len(partners) != 2 or any(not user_id.endswith(":localhost") for user_id in partners):
        raise RuntimeError("Development partner IDs must be two distinct @user:localhost IDs.")

    secret_path = pathlib.Path("/run/secrets/dev_registration_shared_secret")
    registration_secret = secret_path.read_text(encoding="utf-8").strip()
    if len(registration_secret) < 32:
        raise RuntimeError("The local registration secret must contain at least 32 characters.")

    config["report_stats"] = False
    config["public_baseurl"] = "http://localhost:8008/"
    config["enable_registration"] = False
    config["allow_guest_access"] = False
    config["allow_public_rooms"] = False
    config["allow_public_rooms_over_federation"] = False
    # The policy module narrows non-admin invitations to partner A inviting partner B only.
    config["block_non_admin_invites"] = False
    config["require_auth_for_profile_requests"] = True
    config["federation_domain_whitelist"] = []
    config["registration_shared_secret"] = registration_secret
    config["modules"] = [
        {
            "module": "nymph_policy.NymphPolicy",
            "config": {
                "partner_a_user_id": os.environ["PARTNER_A_USER_ID"],
                "partner_b_user_id": os.environ["PARTNER_B_USER_ID"],
                "homeserver_url": os.environ.get("DEV_HOMESERVER_URL", "http://localhost:8008"),
                "app_origins": os.environ.get("DEV_APP_ORIGINS", "http://localhost:5173,https://localhost").replace(" ", ""),
                "state_path": "/data/nymph-policy.sqlite3",
            },
        }
    ]

    listeners = config.get("listeners")
    if not isinstance(listeners, list) or not listeners:
        raise RuntimeError("Generated Synapse config has no HTTP listener.")
    for listener in listeners:
        resources = listener.get("resources", [])
        for resource in resources:
            names = resource.get("names", [])
            resource["names"] = [name for name in names if name != "federation"]
        listener["resources"] = [resource for resource in resources if resource.get("names")]
    if not any(
        "client" in resource.get("names", [])
        for listener in listeners
        for resource in listener.get("resources", [])
    ):
        raise RuntimeError("Synapse HTTP listener has no client API after federation was disabled.")

    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=CONFIG_PATH.parent,
        prefix=".homeserver.",
        suffix=".yaml",
        delete=False,
    ) as temporary:
        yaml.safe_dump(config, temporary, default_flow_style=False, sort_keys=False)
        temporary_path = pathlib.Path(temporary.name)

    os.chmod(temporary_path, 0o600)
    os.chown(temporary_path, 991, 991)
    os.replace(temporary_path, CONFIG_PATH)


if __name__ == "__main__":
    main()
