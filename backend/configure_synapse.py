import os
import pathlib
import tempfile

import yaml


CONFIG_PATH = pathlib.Path("/data/homeserver.yaml")


def read_secret(path_variable: str) -> str:
    path = os.environ.get(path_variable)
    if not path:
        raise RuntimeError(f"{path_variable} is required")
    value = pathlib.Path(path).read_text(encoding="utf-8").strip()
    if not value:
        raise RuntimeError(f"{path_variable} points to an empty secret")
    return value


def main() -> None:
    if not CONFIG_PATH.is_file():
        raise RuntimeError("Synapse config is missing. Run the init-profile config generation first.")

    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    server_name = os.environ["SYNAPSE_SERVER_NAME"]
    if config.get("server_name") != server_name:
        raise RuntimeError("MATRIX_SERVER_NAME must match the server name in the generated config.")

    config["report_stats"] = False
    config["enable_registration"] = False
    config["allow_guest_access"] = False
    config["block_non_admin_invites"] = True
    config["allow_public_rooms"] = False
    config["allow_public_rooms_over_federation"] = False
    config["require_auth_for_profile_requests"] = True
    config["federation_domain_whitelist"] = []

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

    config["database"] = {
        "name": "psycopg2",
        "args": {
            "user": os.environ["POSTGRES_USER"],
            "password": read_secret("POSTGRES_PASSWORD_FILE"),
            "database": os.environ["POSTGRES_DB"],
            "host": os.environ["POSTGRES_HOST"],
            "port": int(os.environ["POSTGRES_PORT"]),
            "cp_min": 5,
            "cp_max": 10,
        },
    }
    config["registration_shared_secret"] = read_secret("REGISTRATION_SHARED_SECRET_FILE")

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
