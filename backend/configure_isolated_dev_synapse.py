import os
import pathlib
import tempfile

import yaml


CONFIG_PATH = pathlib.Path("/data/homeserver.yaml")
SERVER_NAME = "nymph-dev.localhost"


def main() -> None:
    if not CONFIG_PATH.is_file():
        raise RuntimeError("The isolated Synapse config is missing; run the isolated init profile first.")

    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    if config.get("server_name") != SERVER_NAME or os.environ.get("DEV_MATRIX_SERVER_NAME") != SERVER_NAME:
        raise RuntimeError("The isolated deployment must use the dedicated nymph-dev.localhost identity.")

    homeserver_url = os.environ["DEV_HOMESERVER_URL"]
    if homeserver_url != "http://127.0.0.1:18008":
        raise RuntimeError("The isolated homeserver URL must match the dedicated loopback endpoint.")
    partner_a = os.environ["DEV_PARTNER_A_USER_ID"]
    partner_b = os.environ["DEV_PARTNER_B_USER_ID"]
    if (partner_a, partner_b) != (
        f"@partner1-dev:{SERVER_NAME}",
        f"@partner2-dev:{SERVER_NAME}",
    ):
        raise RuntimeError("The isolated partner IDs must use the dedicated Matrix server name.")

    postgres_password = pathlib.Path("/run/secrets/postgres_password").read_text(encoding="utf-8").strip()
    registration_secret = pathlib.Path("/run/secrets/registration_shared_secret").read_text(encoding="utf-8").strip()
    if len(postgres_password) < 32 or len(registration_secret) < 32:
        raise RuntimeError("Isolated deployment secrets must each contain at least 32 characters.")

    config["report_stats"] = False
    config["public_baseurl"] = homeserver_url + "/"
    config["enable_registration"] = False
    config["allow_guest_access"] = False
    config["allow_public_rooms"] = False
    config["allow_public_rooms_over_federation"] = False
    config["block_non_admin_invites"] = False
    config["require_auth_for_profile_requests"] = True
    config["federation_domain_whitelist"] = []
    config["registration_shared_secret"] = registration_secret
    config["database"] = {
        "name": "psycopg2",
        "args": {
            "database": os.environ["POSTGRES_DB"],
            "user": os.environ["POSTGRES_USER"],
            "password": postgres_password,
            "host": os.environ["POSTGRES_HOST"],
            "port": int(os.environ["POSTGRES_PORT"]),
            "cp_min": 5,
            "cp_max": 10,
        },
    }
    config["modules"] = [
        {
            "module": "nymph_policy.NymphPolicy",
            "config": {
                "server_name": SERVER_NAME,
                "legacy_pair_enabled": False,
                "dev_partner_a_user_id": partner_a,
                "dev_partner_b_user_id": partner_b,
                "homeserver_url": homeserver_url,
                "app_origins": os.environ["DEV_APP_ORIGINS"].replace(" ", ""),
                "state_path": "/data/nymph-policy.sqlite3",
            },
        }
    ]

    listeners = config.get("listeners")
    if not isinstance(listeners, list) or not listeners:
        raise RuntimeError("The isolated Synapse config has no HTTP listener.")
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
        raise RuntimeError("The isolated Synapse config has no client API after federation was disabled.")

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
