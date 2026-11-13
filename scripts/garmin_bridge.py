#!/usr/bin/env python3
"""
Garmin Connect JSON Bridge for Elevate.
Communicates via standard JSON over stdin/stdout with desktop/src/clients/garmin-api.client.ts.
"""

import sys
import os
import json
import base64
from pathlib import Path
from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)

TOKEN_STORE_DIR = os.path.expanduser("~/.garminconnect")
REPO_ROOT = Path(__file__).resolve().parent.parent


def load_env_file(env_path: Path):
    """Loads key=value pairs from a .env file into os.environ without external dependencies."""
    if not env_path.exists():
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


def get_client(payload: dict = None) -> Garmin:
    load_env_file(REPO_ROOT / ".env")
    token_dir = Path(TOKEN_STORE_DIR)
    token_file = token_dir / "session.json"

    payload = payload or {}
    email = payload.get("email") or os.environ.get("GARMIN_EMAIL")
    password = payload.get("password") or os.environ.get("GARMIN_PASSWORD")

    client = Garmin(email=email, password=password)

    if token_file.exists():
        try:
            client.login(str(token_file))
            return client
        except Exception:
            pass

    if not email or not password:
        raise ValueError("GARMIN_EMAIL and GARMIN_PASSWORD are required (via UI config, .env, or environment variables).")

    client.login()
    token_dir.mkdir(parents=True, exist_ok=True)
    if hasattr(client, "client") and hasattr(client.client, "dumps"):
        tokens = client.client.dumps()
    elif hasattr(client, "garth") and hasattr(client.garth, "dumps"):
        tokens = client.garth.dumps()
    else:
        tokens = None

    if tokens:
        with open(token_file, "w", encoding="utf-8") as f:
            f.write(tokens)

    return client


def handle_command(command: str, payload: dict):
    client = get_client(payload)

    if command == "get_activities":
        start = int(payload.get("start", 0))
        limit = int(payload.get("limit", 20))
        activities = client.get_activities(start, limit)
        return {"data": activities}

    elif command == "get_activity_details":
        activity_id = payload.get("activityId")
        if not activity_id:
            raise ValueError("activityId is required for get_activity_details")
        details = client.get_activity_details(activity_id)
        return {"data": details}

    elif command == "download_activity":
        activity_id = payload.get("activityId")
        if not activity_id:
            raise ValueError("activityId is required for download_activity")
        data = client.download_activity(activity_id, dl_fmt=client.ActivityDownloadFormat.ORIGINAL)
        b64 = base64.b64encode(data).decode("ascii")
        return {"data": {"base64Data": b64, "filename": f"{activity_id}.zip"}}

    else:
        raise ValueError(f"Unknown command: {command}")


def main():
    try:
        raw_input = sys.stdin.read().strip()
        payload = json.loads(raw_input) if raw_input else {}
        command = sys.argv[1] if len(sys.argv) > 1 else payload.get("command")

        if not command:
            print(json.dumps({"error": "No command specified"}))
            sys.exit(1)

        result = handle_command(command, payload)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
