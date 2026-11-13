#!/usr/bin/env python3
"""
Garmin Connect API Verification Script for Elevate Migration.
Implements authentication with session caching and fetches the 10 most recent activities.
As specified in .agents/agents/api_engineer.md.
"""

import os
import sys
import json
from pathlib import Path
from garminconnect import (
    Garmin,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
    GarminConnectAuthenticationError,
)

TOKEN_STORE_DIR = os.path.expanduser("~/.garminconnect")


def get_garmin_client() -> Garmin:
    email = os.environ.get("GARMIN_EMAIL")
    password = os.environ.get("GARMIN_PASSWORD")

    token_dir = Path(TOKEN_STORE_DIR)
    token_dir.mkdir(parents=True, exist_ok=True)
    token_file = token_dir / "session.json"

    client = Garmin(email=email, password=password)

    if token_file.exists():
        try:
            print(f"[GarminAuth] Found existing session tokens at {token_file}. Attempting to restore...")
            with open(token_file, "r", encoding="utf-8") as f:
                token_data = f.read()
            client.login(token_data)
            print("[GarminAuth] Successfully restored session from cache.")
            return client
        except Exception as e:
            print(f"[GarminAuth] Cached token login failed ({e}). Falling back to credentials login...")

    if not email or not password:
        print("[GarminAuth] ERROR: GARMIN_EMAIL and GARMIN_PASSWORD environment variables are required.")
        print("Please export them:\n  export GARMIN_EMAIL='your_email@example.com'\n  export GARMIN_PASSWORD='your_password'")
        sys.exit(1)

    print(f"[GarminAuth] Authenticating to Garmin Connect as {email}...")
    try:
        client.login()
        tokens = client.garth.dumps()
        with open(token_file, "w", encoding="utf-8") as f:
            f.write(tokens)
        print(f"[GarminAuth] Successfully authenticated and saved session tokens to {token_file}.")
    except GarminConnectAuthenticationError as e:
        print(f"[GarminAuth] Authentication error: {e}")
        sys.exit(1)
    except (GarminConnectConnectionError, GarminConnectTooManyRequestsError) as e:
        print(f"[GarminAuth] Connection / Rate Limit error: {e}")
        sys.exit(1)

    return client


def verify_and_fetch_activities(client: Garmin, count: int = 10):
    print(f"\n[GarminAPI] Fetching the {count} most recent activities...")
    try:
        activities = client.get_activities(0, count)
        print(f"[GarminAPI] Successfully retrieved {len(activities)} activities!\n")

        for idx, act in enumerate(activities, 1):
            act_id = act.get("activityId")
            name = act.get("activityName", "Unnamed Activity")
            sport = act.get("activityType", {}).get("typeKey", "unknown")
            start = act.get("startTimeLocal", act.get("startTimeGMT", "N/A"))
            distance_km = round(act.get("distance", 0) / 1000.0, 2)
            duration_min = round(act.get("elapsedDuration", 0) / 60.0, 1)

            print(f"  {idx:2d}. [ID: {act_id}] '{name}'")
            print(f"      Sport: {sport} | Start: {start} | Dist: {distance_km} km | Duration: {duration_min} min")

        return activities
    except Exception as e:
        print(f"[GarminAPI] Failed to fetch activities: {e}")
        sys.exit(1)


def main():
    print("=" * 60)
    print(" Elevate Garmin Migration: API & Auth Verification")
    print("=" * 60)

    client = get_garmin_client()
    activities = verify_and_fetch_activities(client, count=10)

    # Optional download check of the latest activity if present
    if activities and len(activities) > 0:
        latest_id = activities[0].get("activityId")
        print(f"\n[GarminAPI] Testing raw activity download for activity #{latest_id}...")
        try:
            fit_data = client.download_activity(latest_id, dl_fmt=client.ActivityDownloadFormat.ORIGINAL)
            download_path = Path("/tmp") / f"garmin_activity_{latest_id}.zip"
            with open(download_path, "wb") as f:
                f.write(fit_data)
            print(f"[GarminAPI] Downloaded raw activity archive ({len(fit_data)} bytes) to {download_path}")
        except Exception as e:
            print(f"[GarminAPI] Note: download_activity test skipped/failed: {e}")

    print("\n[Done] Verification complete.")


if __name__ == "__main__":
    main()
