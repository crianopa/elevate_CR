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


def get_athlete_metrics(client: Garmin) -> dict:
    """
    Collects physiological metrics used to update Elevate athlete settings:
    - Running lactate threshold (heart rate + speed) -> LTHR and running threshold pace
    - Running max HR over the last 365 days
    - Average resting HR over the last 365 days
    Each metric is fetched independently so a failure of one does not block the others.
    """
    from datetime import date, timedelta

    today = date.today()
    year_ago = today - timedelta(days=365)
    result = {
        "lactateThresholdHeartRate": None,
        "lactateThresholdSpeedMps": None,
        "lactateThresholdHistory": [],
        "runningMaxHeartRate": None,
        "avgRestingHeartRate": None,
        "errors": [],
    }

    try:
        lt = client.get_lactate_threshold(latest=True)
        shr = (lt or {}).get("speed_and_heart_rate") or {}
        if shr.get("heartRate"):
            result["lactateThresholdHeartRate"] = int(round(float(shr["heartRate"])))
        speed = shr.get("speed")
        if speed:
            speed = float(speed)
            # Garmin reports this value in 10 m/s units (e.g. 0.37 => 3.7 m/s)
            result["lactateThresholdSpeedMps"] = speed * 10 if speed < 1 else speed
    except Exception as e:
        result["errors"].append(f"lactate threshold: {e}")

    try:
        lt_range = client.get_lactate_threshold(
            latest=False,
            start_date=year_ago.isoformat(),
            end_date=today.isoformat(),
            aggregation="daily",
        ) or {}
        by_date = {}
        for entry in lt_range.get("heart_rate") or []:
            if not isinstance(entry, dict):
                continue
            d = entry.get("calendarDate") or entry.get("from") or entry.get("date")
            val = entry.get("value") if entry.get("value") is not None else entry.get("heartRate")
            if d and val is not None:
                by_date.setdefault(str(d)[:10], {})["heartRate"] = int(round(float(val)))
        for entry in lt_range.get("speed") or []:
            if not isinstance(entry, dict):
                continue
            d = entry.get("calendarDate") or entry.get("from") or entry.get("date")
            val = entry.get("value") if entry.get("value") is not None else entry.get("speed")
            if d and val is not None:
                spd = float(val)
                by_date.setdefault(str(d)[:10], {})["speedMps"] = spd * 10 if spd < 1 else spd

        history = []
        last_pair = None
        for d in sorted(by_date.keys()):
            pt = by_date[d]
            hr = pt.get("heartRate")
            spd = pt.get("speedMps")
            pair = (hr, round(spd, 4) if spd is not None else None)
            if pair != last_pair and (hr is not None or spd is not None):
                history.append({"date": d, "heartRate": hr, "speedMps": spd})
                last_pair = pair
        result["lactateThresholdHistory"] = history
    except Exception as e:
        result["errors"].append(f"lactate threshold history: {e}")

    try:
        max_hr = 0
        activities = client.get_activities_by_date(year_ago.isoformat(), today.isoformat(), "running")
        for a in activities or []:
            value = a.get("maxHR") or 0
            if value > max_hr:
                max_hr = value
        if max_hr:
            result["runningMaxHeartRate"] = int(round(max_hr))
    except Exception as e:
        result["errors"].append(f"running max HR: {e}")

    try:
        url = f"{client.garmin_connect_rhr_url}/{client.display_name}"
        data = client.connectapi(
            url,
            params={"fromDate": year_ago.isoformat(), "untilDate": today.isoformat(), "metricId": 60},
        )
        metrics_map = ((data or {}).get("allMetrics") or {}).get("metricsMap") or {}
        values = [
            float(m["value"])
            for m in metrics_map.get("WELLNESS_RESTING_HEART_RATE", [])
            if m.get("value")
        ]
        if values:
            result["avgRestingHeartRate"] = int(round(sum(values) / len(values)))
    except Exception as e:
        result["errors"].append(f"resting HR: {e}")

    return result


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

    elif command == "get_athlete_metrics":
        return {"data": get_athlete_metrics(client)}

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
