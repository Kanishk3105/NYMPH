import os
import pathlib
import re
import sys
import tempfile
from urllib.parse import urlsplit

import yaml


CONFIG_PATH = pathlib.Path("/data/homeserver.yaml")
DNS_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
RESERVED_SUFFIXES = (
    ".localhost",
    ".local",
    ".test",
    ".example",
    ".invalid",
    ".example.com",
    ".example.org",
    ".example.net",
)


def read_secret(path_variable: str) -> str:
    path = os.environ.get(path_variable)
    if not path:
        raise RuntimeError(f"{path_variable} is required")
    value = pathlib.Path(path).read_text(encoding="utf-8").strip()
    if not value:
        raise RuntimeError(f"{path_variable} points to an empty secret")
    if len(value) < 32:
        raise RuntimeError(f"{path_variable} must contain at least 32 characters")
    return value


def validate_server_name(server_name: str) -> None:
    labels = server_name.split(".")
    if (
        server_name != server_name.lower()
        or len(labels) < 2
        or any(not DNS_LABEL.fullmatch(label) for label in labels)
        or any(server_name == suffix.lstrip(".") or server_name.endswith(suffix) for suffix in RESERVED_SUFFIXES)
    ):
        raise RuntimeError("MATRIX_SERVER_NAME must be a lowercase production DNS hostname, not a reserved or development name.")


def apply_production_policy(config: dict, server_name: str) -> dict:
    validate_server_name(server_name)
    if config.get("server_name") != server_name:
        raise RuntimeError("MATRIX_SERVER_NAME must match the server name in the generated config.")

    config["report_stats"] = False
    config["public_baseurl"] = f"https://{server_name}/"
    config["enable_registration"] = False
    config["allow_guest_access"] = False
    config["block_non_admin_invites"] = True
    config["allow_public_rooms"] = False
    config["allow_public_rooms_over_federation"] = False
    config["require_auth_for_profile_requests"] = True
    config["federation_domain_whitelist"] = [server_name]

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
    return config


def production_module_config(server_name: str) -> dict:
    partner_a = os.environ.get("NYMPH_PARTNER_A_USER_ID", "")
    partner_b = os.environ.get("NYMPH_PARTNER_B_USER_ID", "")
    app_origins = os.environ.get("NYMPH_APP_ORIGINS", "")
    if not partner_a or not partner_b or partner_a == partner_b:
        raise RuntimeError("NYMPH_PARTNER_A_USER_ID and NYMPH_PARTNER_B_USER_ID must be distinct Matrix user IDs.")
    if not all(
        user_id.startswith("@")
        and user_id.count(":") == 1
        and user_id.rsplit(":", 1)[1] == server_name
        for user_id in (partner_a, partner_b)
    ):
        raise RuntimeError("Both NYMPH participant IDs must belong to MATRIX_SERVER_NAME.")
    origins = [origin.strip() for origin in app_origins.split(",") if origin.strip()]
    if not origins:
        raise RuntimeError("NYMPH_APP_ORIGINS must contain at least one HTTPS application origin.")
    for origin in origins:
        parsed = urlsplit(origin)
        if (
            parsed.scheme != "https"
            or not parsed.netloc
            or parsed.path
            or parsed.query
            or parsed.fragment
            or parsed.username
            or parsed.password
        ):
            raise RuntimeError("NYMPH_APP_ORIGINS entries must be HTTPS origins without paths or credentials.")
    return {
        "policy_mode": "production",
        "partner_a_user_id": partner_a,
        "partner_b_user_id": partner_b,
        "server_name": server_name,
        "homeserver_url": f"https://{server_name}",
        "app_origins": ",".join(origins),
        "state_path": "/data/nymph-policy.sqlite3",
    }


def main() -> None:
    if not CONFIG_PATH.is_file():
        raise RuntimeError("Synapse config is missing. Run the init-profile config generation first.")

    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    server_name = os.environ["SYNAPSE_SERVER_NAME"]
    config = apply_production_policy(config, server_name)
    if config.get("modules"):
        raise RuntimeError("Unexpected Synapse modules are present; review them before production startup.")
    module_config = production_module_config(server_name)
    sys.path.insert(0, "/modules")
    from nymph_policy import NymphPolicy

    NymphPolicy.parse_config(module_config)
    config["modules"] = [{"module": "nymph_policy.NymphPolicy", "config": module_config}]
    config["log_config"] = "/data/nymph-log-config.yaml"
    write_logging_config(pathlib.Path(config["log_config"]))

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


def write_logging_config(path: pathlib.Path) -> None:
    logging_config = {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "nymph_json": {
                "()": "nymph_safe_logging.SafeJsonFormatter",
            }
        },
        "handlers": {
            "console": {
                "class": "logging.StreamHandler",
                "level": "INFO",
                "formatter": "nymph_json",
                "stream": "ext://sys.stdout",
            }
        },
        "root": {"level": "INFO", "handlers": ["console"]},
        "loggers": {
            "synapse.access.http.server": {"level": "WARNING"},
            "synapse.storage.SQL": {"level": "WARNING"},
        },
    }
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=".nymph-log.",
        suffix=".yaml",
        delete=False,
    ) as temporary:
        yaml.safe_dump(logging_config, temporary, default_flow_style=False, sort_keys=False)
        temporary_path = pathlib.Path(temporary.name)
    os.chmod(temporary_path, 0o600)
    os.chown(temporary_path, 991, 991)
    os.replace(temporary_path, path)


if __name__ == "__main__":
    main()
