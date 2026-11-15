#!/usr/bin/env python3
"""
Verification script to inspect the last 365 days of Garmin Connect athlete metrics:
1. Lactate Threshold (pace & HR) - latest + 1-year history
2. Running Max HR (last 365 days)
3. Resting HR (last 365 days + annual average)

Run from repo root or scripts/:
    python scripts/verify_athlete_metrics.py
"""

import json
from datetime import date, timedelta
from pathlib import Path
import sys

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from garmin_bridge import get_client, get_athlete_metrics


def format_pace(speed_mps: float) -> str:
    if not speed_mps or speed_mps <= 0:
        return "N/A"
    sec_per_km = round(1000.0 / speed_mps)
    mins, secs = divmod(sec_per_km, 60)
    return f"{mins}:{secs:02d} /km ({sec_per_km} s/km)"


def main():
    today = date.today()
    year_ago = today - timedelta(days=365)

    print("=" * 65)
    print(f" Garmin Athlete Metrics Verification ({year_ago} .. {today})")
    print("=" * 65)

    client = get_client()

    # 1. Lactate Threshold (latest + 1-year range)
    print("\n--- 1. Running Lactate Threshold (Latest) ---")
    try:
        lt_latest = client.get_lactate_threshold(latest=True)
        print(json.dumps(lt_latest, indent=2))
        shr = (lt_latest or {}).get("speed_and_heart_rate") or {}
        raw_speed = shr.get("speed")
        if raw_speed:
            mps = float(raw_speed) * 10 if float(raw_speed) < 1 else float(raw_speed)
            print(f"Converted threshold pace: {format_pace(mps)} (raw speed={raw_speed}, m/s={mps:.3f})")
    except Exception as e:
        print(f"Error fetching latest lactate threshold: {e}")

    print(f"\n--- 1b. Running Lactate Threshold (Last 365 days: {year_ago} .. {today}) ---")
    try:
        lt_range = client.get_lactate_threshold(
            latest=False,
            start_date=year_ago.isoformat(),
            end_date=today.isoformat(),
            aggregation="daily",
        )
        hr_entries = lt_range.get("heart_rate") or []
        speed_entries = lt_range.get("speed") or []
        print(f"HR entries returned: {len(hr_entries)} | Speed entries returned: {len(speed_entries)}")
        if hr_entries:
            print("Sample HR entries (last 10 non-null or first 5):")
            non_null_hr = [e for e in hr_entries if isinstance(e, dict) and (e.get("value") or e.get("heartRate"))]
            for e in (non_null_hr[-10:] if non_null_hr else hr_entries[:5]):
                print(" ", e)
        if speed_entries:
            print("Sample Speed entries (last 10 non-null or first 5):")
            non_null_spd = [e for e in speed_entries if isinstance(e, dict) and (e.get("value") or e.get("speed"))]
            for e in (non_null_spd[-10:] if non_null_spd else speed_entries[:5]):
                val = e.get("value") or e.get("speed")
                pace_str = ""
                if val:
                    mps = float(val) * 10 if float(val) < 1 else float(val)
                    pace_str = f" -> {format_pace(mps)}"
                print(f"  {e}{pace_str}")
    except Exception as e:
        print(f"Error fetching 1-year lactate threshold range: {e}")

    # 2. Running Max HR (last 365 days)
    print(f"\n--- 2. Running Max HR ({year_ago} .. {today}) ---")
    try:
        activities = client.get_activities_by_date(year_ago.isoformat(), today.isoformat(), "running") or []
        with_hr = [
            (a.get("maxHR"), a.get("startTimeLocal"), a.get("activityName"), a.get("activityId"))
            for a in activities
            if a.get("maxHR")
        ]
        with_hr.sort(key=lambda x: x[0], reverse=True)
        print(f"Running activities found: {len(activities)} | With maxHR: {len(with_hr)}")
        for hr, dt, name, aid in with_hr[:5]:
            print(f"  {int(round(hr))} bpm | {dt} | '{name}' (ID: {aid})")
    except Exception as e:
        print(f"Error fetching running max HR: {e}")

    # 3. Resting HR (last 365 days)
    print(f"\n--- 3. Resting HR ({year_ago} .. {today}) ---")
    try:
        url = f"{client.garmin_connect_rhr_url}/{client.display_name}"
        data = client.connectapi(
            url,
            params={"fromDate": year_ago.isoformat(), "untilDate": today.isoformat(), "metricId": 60},
        )
        metrics_map = ((data or {}).get("allMetrics") or {}).get("metricsMap") or {}
        rhr_list = metrics_map.get("WELLNESS_RESTING_HEART_RATE", [])
        values = [float(m["value"]) for m in rhr_list if isinstance(m, dict) and m.get("value")]
        print(f"Top-level keys: {list(data.keys()) if isinstance(data, dict) else type(data)}")
        print(f"RHR entries: {len(rhr_list)} | Valid values: {len(values)}")
        if values:
            print(
                f"Min: {min(values):.1f} bpm | Max: {max(values):.1f} bpm | "
                f"Average: {sum(values)/len(values):.2f} bpm (rounded: {round(sum(values)/len(values))})"
            )
            print("Last 5 entries:", rhr_list[-5:])
        else:
            print("Raw RHR payload snippet:", str(data)[:500])
    except Exception as e:
        print(f"Error fetching resting HR: {e}")

    # 4. Bridge summary
    print("\n--- 4. garmin_bridge.get_athlete_metrics() output ---")
    print(json.dumps(get_athlete_metrics(client), indent=2))
    print("\n[Done]")


if __name__ == "__main__":
    main()
