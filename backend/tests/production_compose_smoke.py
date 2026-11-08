import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from synapse.media.filepath import MediaFilePaths


BASE_URL = "http://127.0.0.1:8008"
SERVER_NAME = os.environ["SYNAPSE_SERVER_NAME"]
PARTNER_A = os.environ["NYMPH_PARTNER_A_USER_ID"]
PARTNER_B = os.environ["NYMPH_PARTNER_B_USER_ID"]
STATE_PATH = Path("/smoke-state/state.json")
MEDIA_PATHS = MediaFilePaths("/data/media_store")
ENCRYPTED_CONTENT = {
    "algorithm": "m.megolm.v1.aes-sha2",
    "ciphertext": "synthetic-ciphertext",
    "device_id": "disposable-smoke-device",
    "sender_key": "synthetic-sender-key",
    "session_id": "synthetic-session",
}


def request(
    method: str,
    path: str,
    token: str | None = None,
    payload: dict[str, Any] | None = None,
    body: bytes | None = None,
    content_type: str = "application/json",
) -> tuple[int, dict[str, Any] | bytes]:
    headers = {"Content-Type": content_type}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(payload).encode() if payload is not None else body
    outgoing = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(outgoing, timeout=20) as response:
            response_body = response.read()
            status = response.status
    except urllib.error.HTTPError as error:
        response_body = error.read()
        status = error.code
    if not response_body:
        return status, response_body
    try:
        return status, json.loads(response_body)
    except json.JSONDecodeError:
        return status, response_body


def expect_status(actual: int, expected: int, action: str) -> None:
    if actual != expected:
        raise AssertionError(f"{action}: expected HTTP {expected}, received HTTP {actual}.")


def register_user(username: str, password: str, is_admin: bool = False) -> None:
    status, challenge = request("GET", "/_synapse/admin/v1/register")
    expect_status(status, 200, "request registration challenge")
    registration_secret = Path("/run/secrets/registration_shared_secret").read_text().strip()
    admin_flag = "admin" if is_admin else "notadmin"
    message = "\0".join((challenge["nonce"], username, password, admin_flag)).encode()
    mac = hmac.new(registration_secret.encode(), message, hashlib.sha1).hexdigest()
    status, _ = request(
        "POST",
        "/_synapse/admin/v1/register",
        payload={
            "nonce": challenge["nonce"],
            "username": username,
            "password": password,
            "admin": is_admin,
            "mac": mac,
        },
    )
    expect_status(status, 200, f"register disposable {username} account")


def login(username: str, password: str) -> tuple[str, str]:
    device_id = f"SMOKE-{username.upper()}"
    status, response = request(
        "POST",
        "/_matrix/client/v3/login",
        payload={
            "type": "m.login.password",
            "identifier": {"type": "m.id.user", "user": username},
            "password": password,
            "device_id": device_id,
        },
    )
    expect_status(status, 200, f"login disposable {username} account")
    expected_user = f"@{username}:{SERVER_NAME}"
    if response["user_id"] != expected_user or not response.get("device_id"):
        raise AssertionError("Synapse returned an unexpected disposable account or device identity.")
    return response["access_token"], response["device_id"]


def client_json(
    method: str,
    path: str,
    token: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    status, response = request(method, path, token=token, payload=payload)
    expect_status(status, 200, path)
    if not isinstance(response, dict):
        raise AssertionError(f"{path}: expected a JSON response.")
    return response


def send_event(
    token: str,
    room_id: str,
    event_type: str,
    content: dict[str, Any],
) -> str:
    transaction = f"smoke-{time.time_ns()}"
    path = (
        f"/_matrix/client/v3/rooms/{urllib.parse.quote(room_id, safe='')}"
        f"/send/{urllib.parse.quote(event_type, safe='')}/{transaction}"
    )
    for attempt in range(10):
        status, response = request("PUT", path, token=token, payload=content)
        if status == 429:
            retry_after_ms = response.get("retry_after_ms", 1000) if isinstance(response, dict) else 1000
            time.sleep(min(max(retry_after_ms / 1000, 0.1), 10))
            continue
        expect_status(status, 200, path)
        if not isinstance(response, dict):
            raise AssertionError(f"{path}: expected a JSON response.")
        result = response
        break
    else:
        raise AssertionError("Synapse rate limiting did not clear during disposable smoke acceptance.")
    event_id = result.get("event_id")
    if not isinstance(event_id, str) or not event_id.startswith("$"):
        raise AssertionError("Synapse did not return a valid event ID.")
    return event_id


def send_encrypted(token: str, room_id: str) -> str:
    return send_event(token, room_id, "m.room.encrypted", ENCRYPTED_CONTENT)


def policy_request(token: str, endpoint: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    return client_json("POST", f"/_synapse/client/nymph/retention/{endpoint}", token, payload)


def media_request(token: str, endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
    return client_json("POST", f"/_synapse/client/nymph/media/{endpoint}", token, payload)


def local_media_path(media_id: str) -> Path:
    return Path(MEDIA_PATHS.local_media_filepath(media_id))


def wait_for(predicate, timeout_seconds: int, failure: str) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(1)
    raise AssertionError(failure)


def api_status(token: str, endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
    return client_json("POST", f"/_synapse/client/nymph/{endpoint}", token, payload)


def setup() -> None:
    last_health: dict[str, Any] = {}

    def policy_workers_healthy() -> bool:
        try:
            status, response = request("GET", "/_synapse/client/nymph/health")
            last_health.update({"http_status": status, "response": response})
            return status == 200 and isinstance(response, dict) and response.get("healthy") is True
        except urllib.error.URLError as error:
            last_health["connection_error"] = type(error).__name__
            return False

    try:
        wait_for(policy_workers_healthy, 45, "Production policy or expiry workers did not become healthy.")
    except AssertionError as error:
        raise AssertionError(f"{error} Health status: {json.dumps(last_health, separators=(',', ':'))}") from error
    usernames = ("partnera", "partnerb", "intruder")
    suffix = str(time.time_ns())[-9:]
    passwords = tuple(f"Smoke-{suffix}-{index}-Only" for index in range(3))
    for username, password in zip(usernames, passwords):
        register_user(username, password)

    a_token, _a_device = login(usernames[0], passwords[0])
    b_token, _b_device = login(usernames[1], passwords[1])
    outsider_token, _outsider_device = login(usernames[2], passwords[2])
    if PARTNER_A != f"@{usernames[0]}:{SERVER_NAME}" or PARTNER_B != f"@{usernames[1]}:{SERVER_NAME}":
        raise AssertionError("Production policy IDs do not match the disposable test accounts.")

    room = client_json(
        "POST",
        "/_matrix/client/v3/createRoom",
        a_token,
        {
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
        },
    )
    room_id = room["room_id"]
    client_json(
        "POST",
        f"/_matrix/client/v3/rooms/{urllib.parse.quote(room_id, safe='')}/join",
        b_token,
        {},
    )

    status, _ = request(
        "POST",
        f"/_matrix/client/v3/rooms/{urllib.parse.quote(room_id, safe='')}/invite",
        token=a_token,
        payload={"user_id": f"@{usernames[2]}:{SERVER_NAME}"},
    )
    expect_status(status, 403, "reject a third-member invitation")
    status, _ = request(
        "POST",
        f"/_matrix/client/v3/rooms/{urllib.parse.quote(room_id, safe='')}/join",
        token=outsider_token,
        payload={},
    )
    expect_status(status, 403, "reject a third-member join")
    status, _ = request(
        "POST",
        "/_matrix/client/v3/createRoom",
        outsider_token,
        {"visibility": "public", "preset": "public_chat"},
    )
    expect_status(status, 403, "reject unauthorized public room creation")

    members = client_json(
        "GET",
        f"/_matrix/client/v3/rooms/{urllib.parse.quote(room_id, safe='')}/members",
        a_token,
    )["chunk"]
    joined_users = {
        event["state_key"]
        for event in members
        if event.get("type") == "m.room.member" and event.get("content", {}).get("membership") == "join"
    }
    if joined_users != {PARTNER_A, PARTNER_B}:
        raise AssertionError("The created private room does not have exactly the two authorized members.")

    payload = b"synthetic encrypted view-once media fixture"
    status, upload = request(
        "POST",
        "/_matrix/media/v3/upload",
        token=a_token,
        body=payload,
        content_type="application/octet-stream",
    )
    expect_status(status, 200, "upload encrypted media fixture")
    media_id = upload["content_uri"].rsplit("/", 1)[-1]
    media_path = local_media_path(media_id)
    if media_path.read_bytes() != payload:
        raise AssertionError("The Synapse media store did not preserve the synthetic ciphertext fixture.")
    media_request(
        a_token,
        "register",
        {"media_id": media_id, "room_id": room_id, "duration_seconds": 2, "pending_ttl_seconds": 60},
    )
    status, _ = request(
        "GET",
        f"/_synapse/client/nymph/media/content/{media_id}",
        token=a_token,
    )
    expect_status(status, 403, "deny owner access before recipient open")
    status, _ = request(
        "POST",
        "/_synapse/client/nymph/media/register",
        token=b_token,
        payload={"media_id": media_id, "room_id": room_id, "duration_seconds": 2},
    )
    expect_status(status, 403, "deny non-owner media registration")
    opened = media_request(b_token, "open", {"media_id": media_id})
    if opened.get("opened") is not True:
        raise AssertionError("The intended recipient could not claim the media.")
    status, response_body = request(
        "GET",
        f"/_synapse/client/nymph/media/content/{media_id}",
        token=b_token,
        content_type="application/octet-stream",
    )
    expect_status(status, 200, "allow recipient ciphertext download")
    if response_body != payload:
        raise AssertionError("The authorized recipient did not receive the stored ciphertext.")
    status, _ = request(
        "POST",
        "/_synapse/client/nymph/media/open",
        token=b_token,
        payload={"media_id": media_id},
    )
    expect_status(status, 410, "reject repeat media opening")
    wait_for(lambda: not media_path.exists(), 20, "Scheduled expiry did not remove opened media from Synapse's media store.")
    media_status = media_request(a_token, "status", {"media_id": media_id})
    if media_status.get("state") != "deleted" or media_status.get("media_exists") is not False:
        raise AssertionError("The server did not report completed media deletion.")

    pending_payload = b"synthetic unopened encrypted media fixture"
    status, pending_upload = request(
        "POST",
        "/_matrix/media/v3/upload",
        token=a_token,
        body=pending_payload,
        content_type="application/octet-stream",
    )
    expect_status(status, 200, "upload unopened media fixture")
    pending_id = pending_upload["content_uri"].rsplit("/", 1)[-1]
    pending_path = local_media_path(pending_id)
    media_request(
        a_token,
        "register",
        {
            "media_id": pending_id,
            "room_id": room_id,
            "duration_seconds": 2,
            "pending_ttl_seconds": 2,
        },
    )
    wait_for(lambda: not pending_path.exists(), 20, "Scheduled expiry did not delete unopened media.")

    policy_results = []
    for seconds in (None, 3600, 86400, 604800, 2592000, 137):
        event_id = send_encrypted(a_token, room_id)
        configured = policy_request(a_token, "set", {"event_id": event_id, "seconds": seconds})
        if configured.get("seconds") != seconds or configured.get("applied") is not True:
            raise AssertionError(f"Retention policy failed to synchronize for {seconds!r} seconds.")
        if seconds is None:
            never_event = send_encrypted(a_token, room_id)
            never_status = api_status(
                a_token,
                "retention/message-status",
                {"event_id": never_event},
            )
            if never_status.get("state") != "never":
                raise AssertionError("Never retention was not preserved for the following message.")
        policy_results.append(seconds)

    custom_policy = send_encrypted(a_token, room_id)
    policy_request(a_token, "set", {"event_id": custom_policy, "seconds": 300})
    parent = send_encrypted(a_token, room_id)
    reply = send_encrypted(b_token, room_id)
    policy_request(a_token, "relation", {"child_event_id": reply, "parent_event_id": parent})
    reaction = send_event(
        b_token,
        room_id,
        "m.reaction",
        {"m.relates_to": {"rel_type": "m.annotation", "event_id": parent, "key": "❤️"}},
    )
    policy_request(a_token, "relation", {"child_event_id": reaction, "parent_event_id": parent})
    parent_status = api_status(a_token, "retention/message-status", {"event_id": parent})
    for related_id in (reply, reaction):
        related_status = api_status(a_token, "retention/message-status", {"event_id": related_id})
        if related_status.get("expires_at") != parent_status.get("expires_at"):
            raise AssertionError("A reply or reaction did not inherit the parent's expiry.")

    a_since = client_json("GET", "/_matrix/client/v3/sync?timeout=0", a_token)["next_batch"]
    b_since = client_json("GET", "/_matrix/client/v3/sync?timeout=0", b_token)["next_batch"]
    persistent_policy = send_encrypted(a_token, room_id)
    policy_request(a_token, "set", {"event_id": persistent_policy, "seconds": 30})
    persistent_event = send_encrypted(a_token, room_id)
    persistent_status = api_status(
        a_token,
        "retention/message-status",
        {"event_id": persistent_event},
    )
    marker = {
        "a_token": a_token,
        "b_token": b_token,
        "room_id": room_id,
        "persistent_event": persistent_event,
        "expires_at": persistent_status["expires_at"],
        "a_since": a_since,
        "b_since": b_since,
    }
    STATE_PATH.write_text(json.dumps(marker), encoding="utf-8")
    print(
        json.dumps(
            {
                "phase": "setup",
                "membership_checks": 4,
                "media_checks": 14,
                "retention_policies": len(policy_results),
                "relation_checks": 2,
                "restart_event": persistent_event,
                "restart_at": persistent_status["expires_at"],
            },
            separators=(",", ":"),
        )
    )


def verify_restart() -> None:
    marker = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    last_health: dict[str, Any] = {}

    def policy_workers_healthy() -> bool:
        try:
            status, response = request("GET", "/_synapse/client/nymph/health")
            last_health.update({"http_status": status, "response": response})
            return status == 200 and isinstance(response, dict) and response.get("healthy") is True
        except urllib.error.URLError as error:
            last_health["connection_error"] = type(error).__name__
            return False

    try:
        wait_for(policy_workers_healthy, 90, "Expiry workers did not recover after the Synapse restart.")
    except AssertionError as error:
        raise AssertionError(f"{error} Health status: {json.dumps(last_health, separators=(',', ':'))}") from error
    remaining = max(0, marker["expires_at"] / 1000 - time.time())
    if remaining:
        time.sleep(remaining + 1)
    event_status = api_status(
        marker["a_token"],
        "retention/message-status",
        {"event_id": marker["persistent_event"]},
    )
    if event_status.get("state") != "redacted":
        raise AssertionError("Persistent server-side expiry did not complete after Synapse restart.")
    redaction_events = {}
    for label, token, since in (
        ("partner_a", marker["a_token"], marker["a_since"]),
        ("partner_b", marker["b_token"], marker["b_since"]),
    ):
        sync = client_json(
            "GET",
            "/_matrix/client/v3/sync?"
            + urllib.parse.urlencode({"since": since, "timeout": 0}),
            token,
        )
        events = sync.get("rooms", {}).get("join", {}).get(marker["room_id"], {}).get("timeline", {}).get("events", [])
        found = any(
            event.get("type") == "m.room.redaction"
            and event.get("redacts") == marker["persistent_event"]
            for event in events
        )
        if not found:
            raise AssertionError(f"{label} did not receive the expired-event redaction after reconnect.")
        redaction_events[label] = found
    print(json.dumps({"phase": "restart-verification", "redacted": True, "recipients": redaction_events}))


if __name__ == "__main__":
    phase = os.environ.get("NYMPH_SMOKE_PHASE")
    if phase == "setup":
        setup()
    elif phase == "verify-restart":
        verify_restart()
    else:
        raise SystemExit("Set NYMPH_SMOKE_PHASE to setup or verify-restart.")
