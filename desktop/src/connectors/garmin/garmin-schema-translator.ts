import _ from "lodash";
import { ElevateSport } from "@elevate/shared/enums/elevate-sport.enum";
import { BareActivity } from "@elevate/shared/models/sync/bare-activity.model";
import {
  Activity,
  ActivityStats,
  ElevationStats,
  Lap,
  PaceStats,
  Scores,
  SpeedStats
} from "@elevate/shared/models/sync/activity.model";
import { Streams } from "@elevate/shared/models/activity-data/streams.model";
import { Constant } from "@elevate/shared/constants/constant";
import { ActivityComputer } from "@elevate/shared/sync/compute/activity-computer";
import { Movement } from "@elevate/shared/tools/movement";

/**
 * Raw summary returned by Garmin Connect API (e.g. get_activities)
 */
export interface GarminRawActivitySummary {
  activityId: number;
  activityName: string;
  description?: string;
  startTimeLocal?: string;
  startTimeGMT?: string;
  activityType?: {
    typeId?: number;
    typeKey: string;
    parentTypeId?: number;
    isHidden?: boolean;
  };
  eventTypeDTO?: {
    typeId?: number;
    typeKey?: string;
  };
  distance?: number; // meters
  duration?: number; // seconds
  elapsedDuration?: number; // seconds
  movingDuration?: number; // seconds
  elevationGain?: number; // meters
  elevationLoss?: number; // meters
  averageSpeed?: number; // m/s
  maxSpeed?: number; // m/s
  startLatitude?: number;
  startLongitude?: number;
  hasPolyline?: boolean;
  hasSplits?: boolean;
  calories?: number;
  averageHR?: number;
  maxHR?: number;
  averageRunningCadenceInStepsPerMinute?: number;
  maxRunningCadenceInStepsPerMinute?: number;
  averageBikingCadenceInRevPerMinute?: number;
  maxBikingCadenceInRevPerMinute?: number;
  averageSwimCadenceInStrokesPerMinute?: number;
  avgPower?: number; // Watts
  maxPower?: number;
  hasPowerMeter?: boolean;
  isIndoor?: boolean;
  pr?: boolean;
  manualActivity?: boolean;
  deviceId?: number;
  metadataDTO?: {
    isOriginal?: boolean;
    deviceApplicationInstallationId?: number;
    agentApplicationInstallationId?: number;
    agentString?: string;
    deviceName?: string;
  };
  splits?: GarminRawSplit[];
  laps?: GarminRawLap[];
}

export interface GarminRawLap {
  lapIndex: number;
  startTimeGMT: string;
  distance: number;
  duration: number;
  movingDuration?: number;
  elapsedDuration?: number;
  elevationGain?: number;
  elevationLoss?: number;
  averageSpeed?: number;
  maxSpeed?: number;
  averageHR?: number;
  maxHR?: number;
  averageRunCadence?: number;
  maxRunCadence?: number;
  averageBikeCadence?: number;
  maxBikeCadence?: number;
  averagePower?: number;
  maxPower?: number;
  calories?: number;
  startIndex?: number;
  endIndex?: number;
}

export interface GarminRawSplit {
  splitType?: string;
  distance: number;
  duration: number;
  movingDuration?: number;
  elevationGain?: number;
  averageSpeed?: number;
  maxSpeed?: number;
  averageHR?: number;
  maxHR?: number;
  averagePower?: number;
  calories?: number;
}

export interface GarminMetricDescriptor {
  metricsIndex: number;
  key: string;
  unit?: {
    id: number;
    key: string;
    factor: number;
  };
}

export interface GarminActivityDetailsResponse {
  activityId: number;
  measurementCount?: number;
  metricDescriptors?: GarminMetricDescriptor[];
  metricsDescriptors?: GarminMetricDescriptor[];
  activityDetailMetrics?: Array<{
    metrics: number[];
  }>;
  geoPolylineDTO?: {
    polyline: Array<{
      lat: number;
      lon: number;
      altitude?: number;
      time?: number;
    }>;
  };
  summaryDTO?: GarminRawActivitySummary;
}

export class GarminSchemaTranslator {
  public static readonly GARMIN_TO_ELEVATE_SPORT_MAP: Record<string, ElevateSport> = {
    running: ElevateSport.Run,
    trail_running: ElevateSport.Run,
    treadmill_running: ElevateSport.Run,
    track_running: ElevateSport.Run,
    cycling: ElevateSport.Ride,
    road_biking: ElevateSport.Ride,
    mountain_biking: ElevateSport.Ride,
    gravel_cycling: ElevateSport.Ride,
    indoor_cycling: ElevateSport.Ride,
    virtual_ride: ElevateSport.VirtualRide,
    swimming: ElevateSport.Swim,
    lap_swimming: ElevateSport.Swim,
    open_water_swimming: ElevateSport.Swim,
    walking: ElevateSport.Walk,
    hiking: ElevateSport.Hike,
    strength_training: ElevateSport.WeightTraining,
    cardio_training: ElevateSport.Cardio,
    yoga: ElevateSport.Yoga,
    pilates: ElevateSport.Yoga,
    rowing: ElevateSport.Rowing,
    indoor_rowing: ElevateSport.Rowing,
    stand_up_paddleboarding: ElevateSport.StandUpPaddling,
    kayaking: ElevateSport.Kayaking,
    canoeing: ElevateSport.Canoeing,
    cross_country_skiing: ElevateSport.NordicSki,
    resort_skiing: ElevateSport.AlpineSki,
    snowboarding: ElevateSport.Snowboard,
    elliptical: ElevateSport.Elliptical,
    stair_climbing: ElevateSport.StairStepper,
    multisport: ElevateSport.Triathlon,
    fitness_equipment: ElevateSport.Workout,
    other: ElevateSport.Workout
  };

  /**
   * Resolves Garmin sport key to ElevateSport
   */
  public static resolveSportType(typeKey: string): ElevateSport {
    if (!typeKey) {
      return ElevateSport.Workout;
    }
    const normalizedKey = typeKey.toLowerCase().trim();
    return GarminSchemaTranslator.GARMIN_TO_ELEVATE_SPORT_MAP[normalizedKey] || ElevateSport.Workout;
  }

  /**
   * Translates a Garmin raw activity summary into an Elevate BareActivity.
   */
  public static toBareActivity(garminSummary: GarminRawActivitySummary): BareActivity {
    const bareActivity: BareActivity = new BareActivity();

    // Start time resolution: prefer startTimeGMT (ISO 8601 or YYYY-MM-DD HH:mm:ss)
    const rawStart = garminSummary.startTimeGMT || garminSummary.startTimeLocal;
    const startDate = new Date(rawStart.includes("Z") ? rawStart : `${rawStart}Z`);
    const startTimestamp = Math.floor(startDate.getTime() / 1000);
    const elapsedSeconds = garminSummary.elapsedDuration || garminSummary.duration || 0;
    const endTimestamp = startTimestamp + elapsedSeconds;

    bareActivity.id = garminSummary.activityId;
    bareActivity.name = garminSummary.activityName || `Garmin Activity ${garminSummary.activityId}`;
    bareActivity.type = GarminSchemaTranslator.resolveSportType(garminSummary.activityType?.typeKey);
    bareActivity.startTime = new Date(startTimestamp * 1000).toISOString();
    bareActivity.endTime = new Date(endTimestamp * 1000).toISOString();
    bareActivity.startTimestamp = startTimestamp;
    bareActivity.endTimestamp = endTimestamp;
    bareActivity.hasPowerMeter = !!(
      garminSummary.hasPowerMeter ||
      (garminSummary.avgPower && garminSummary.avgPower > 0)
    );
    bareActivity.trainer = !!garminSummary.isIndoor;
    bareActivity.commute = false;
    bareActivity.manual = !!garminSummary.manualActivity;

    return bareActivity;
  }

  /**
   * Extracts device source stats from Garmin activity summary and detail.
   */
  public static toSourceStats(
    sport: ElevateSport,
    garminSummary: Partial<GarminRawActivitySummary>,
    streams?: Streams
  ): Partial<ActivityStats> {
    const srcStats: Partial<ActivityStats> = {
      speed: {} as SpeedStats,
      pace: {} as PaceStats,
      elevation: {} as ElevationStats
    };

    // Timings
    const movingTime = garminSummary.movingDuration || garminSummary.duration || null;
    const elapsedTime = garminSummary.elapsedDuration || garminSummary.duration || null;

    srcStats.movingTime = movingTime;
    srcStats.elapsedTime = elapsedTime;
    srcStats.pauseTime = movingTime && elapsedTime && elapsedTime >= movingTime ? elapsedTime - movingTime : null;
    srcStats.moveRatio =
      movingTime && elapsedTime && elapsedTime > 0 ? _.round(movingTime / elapsedTime, ActivityComputer.RND) : null;

    if (garminSummary.distance && garminSummary.distance > 0) {
      srcStats.distance = _.round(garminSummary.distance, ActivityComputer.RND);
    }

    if (garminSummary.calories && garminSummary.calories > 0) {
      srcStats.calories = _.round(garminSummary.calories, ActivityComputer.RND);
      srcStats.caloriesPerHour =
        elapsedTime && elapsedTime > 0
          ? _.round((srcStats.calories / elapsedTime) * Constant.SEC_HOUR_FACTOR, ActivityComputer.RND)
          : null;
    }

    if (garminSummary.elevationGain && garminSummary.elevationGain > 0) {
      srcStats.elevation.ascent = _.round(garminSummary.elevationGain);
      srcStats.elevationGain = srcStats.elevation.ascent;
    }
    if (garminSummary.elevationLoss && garminSummary.elevationLoss > 0) {
      srcStats.elevation.descent = _.round(garminSummary.elevationLoss);
    }

    if (garminSummary.averageSpeed && garminSummary.averageSpeed > 0) {
      srcStats.speed.avg = _.round(garminSummary.averageSpeed * Constant.MPS_KPH_FACTOR, ActivityComputer.RND);
      srcStats.pace.avg = Movement.speedToPace(srcStats.speed.avg);
    }

    if (garminSummary.maxSpeed && garminSummary.maxSpeed > 0) {
      srcStats.speed.max = _.round(garminSummary.maxSpeed * Constant.MPS_KPH_FACTOR, ActivityComputer.RND);
      srcStats.pace.max = Movement.speedToPace(srcStats.speed.max);
    }

    // Heart Rate stats from summary
    if (garminSummary.averageHR || garminSummary.maxHR) {
      srcStats.heartRate = {
        avg: garminSummary.averageHR ? _.round(garminSummary.averageHR) : null,
        max: garminSummary.maxHR ? _.round(garminSummary.maxHR) : null
      } as any;
    }

    // Cadence stats from summary
    const avgCadence =
      garminSummary.averageRunningCadenceInStepsPerMinute || garminSummary.averageBikingCadenceInRevPerMinute;
    const maxCadence =
      garminSummary.maxRunningCadenceInStepsPerMinute || garminSummary.maxBikingCadenceInRevPerMinute;
    if (avgCadence || maxCadence) {
      srcStats.cadence = {
        avg: avgCadence ? _.round(avgCadence) : null,
        max: maxCadence ? _.round(maxCadence) : null
      } as any;
    }

    // Swim SWOLF
    const swimCadence = garminSummary.averageSwimCadenceInStrokesPerMinute;
    if (Activity.isSwim(sport) && srcStats.speed?.avg && swimCadence) {
      srcStats.scores = {
        swolf: {
          25: ActivityComputer.computeSwimSwolf(Movement.speedToSwimPace(srcStats.speed.avg), swimCadence, 25),
          50: ActivityComputer.computeSwimSwolf(Movement.speedToSwimPace(srcStats.speed.avg), swimCadence, 50)
        }
      } as Scores;
    }

    return srcStats;
  }

  /**
   * Extracts laps from Garmin raw lap array.
   */
  public static toLaps(sport: ElevateSport, rawLaps: GarminRawLap[]): Lap[] {
    if (!rawLaps || rawLaps.length <= 1) {
      return null;
    }

    return rawLaps.map((gLap, idx) => {
      const lap: Lap = {
        id: (gLap.lapIndex ?? idx) + 1,
        active: !!(gLap.distance || gLap.averageSpeed),
        indexes: [gLap.startIndex ?? 0, gLap.endIndex ?? 0]
      };

      if (gLap.distance) {
        lap.distance = gLap.distance;
      }
      if (gLap.elevationGain) {
        lap.elevationGain = gLap.elevationGain;
      }
      if (gLap.elapsedDuration || gLap.duration) {
        lap.elapsedTime = gLap.elapsedDuration || gLap.duration;
      }
      if (gLap.movingDuration) {
        lap.movingTime = gLap.movingDuration;
      }

      if (gLap.averageSpeed) {
        lap.avgSpeed = _.round(gLap.averageSpeed * Constant.MPS_KPH_FACTOR, ActivityComputer.RND);
        lap.avgPace = _.round(Movement.speedToPace(lap.avgSpeed));
      }
      if (gLap.maxSpeed) {
        lap.maxSpeed = _.round(gLap.maxSpeed * Constant.MPS_KPH_FACTOR, ActivityComputer.RND);
        lap.maxPace = _.round(Movement.speedToPace(lap.maxSpeed));
      }

      const avgCadence = gLap.averageRunCadence || gLap.averageBikeCadence;
      if (avgCadence) {
        lap.avgCadence = avgCadence;
      }

      if (gLap.averageHR) {
        lap.avgHr = gLap.averageHR;
      }
      if (gLap.maxHR) {
        lap.maxHr = gLap.maxHR;
      }

      if (gLap.averagePower) {
        lap.avgWatts = _.round(gLap.averagePower);
      }

      if (lap.active && Activity.isSwim(sport) && lap.avgSpeed && lap.avgCadence) {
        lap.swolf25m = ActivityComputer.computeSwimSwolf(Movement.speedToSwimPace(lap.avgSpeed), lap.avgCadence, 25);
        lap.swolf50m = ActivityComputer.computeSwimSwolf(Movement.speedToSwimPace(lap.avgSpeed), lap.avgCadence, 50);
      }

      return lap;
    });
  }

  /**
   * Maps Garmin Connect JSON details telemetry (activityDetailMetrics + metricsDescriptors)
   * into an Elevate unified Streams object.
   */
  public static toStreamsFromDetails(details: GarminActivityDetailsResponse): Streams {
    if (!details || !details.activityDetailMetrics || details.activityDetailMetrics.length === 0) {
      return null;
    }

    const descriptors = details.metricDescriptors || details.metricsDescriptors || [];
    const keyToIndex = new Map<string, number>();
    descriptors.forEach(d => {
      keyToIndex.set(d.key, d.metricsIndex);
    });

    const streams: Partial<Streams> = {
      time: [],
      distance: [],
      velocity_smooth: [],
      altitude: [],
      cadence: [],
      heartrate: [],
      watts: [],
      latlng: []
    };

    const hasLat = keyToIndex.has("directLatitude");
    const hasLon = keyToIndex.has("directLongitude");
    const hasElevation = keyToIndex.has("directElevation");
    const hasSpeed = keyToIndex.has("directSpeed");
    const hasDist = keyToIndex.has("directDistance");
    const hasHR = keyToIndex.has("directHeartRate");
    const hasCadence = keyToIndex.has("directBikeCadence") || keyToIndex.has("directRunCadence");
    const cadenceKey = keyToIndex.has("directBikeCadence") ? "directBikeCadence" : "directRunCadence";
    const hasPower = keyToIndex.has("directPower");
    const hasTime = keyToIndex.has("directTimestamp");

    let firstTimestamp: number = null;
    let lastValidLatLng: [number, number] = null;

    for (let i = 0; i < details.activityDetailMetrics.length; i++) {
      const metricRow = details.activityDetailMetrics[i].metrics;

      // Time calculation
      if (hasTime) {
        const ts = metricRow[keyToIndex.get("directTimestamp")];
        if (firstTimestamp === null && typeof ts === "number" && Number.isFinite(ts)) {
          firstTimestamp = ts;
        }
        streams.time.push(
          firstTimestamp !== null && typeof ts === "number" && Number.isFinite(ts)
            ? Math.round((ts - firstTimestamp) / 1000)
            : i
        );
      } else {
        streams.time.push(i);
      }

      // Lat / Lon (skip null/undefined/[0,0] to avoid plotting Null Island in the ocean)
      if (hasLat && hasLon) {
        const lat = metricRow[keyToIndex.get("directLatitude")];
        const lon = metricRow[keyToIndex.get("directLongitude")];
        if (
          typeof lat === "number" &&
          typeof lon === "number" &&
          Number.isFinite(lat) &&
          Number.isFinite(lon) &&
          !(lat === 0 && lon === 0) &&
          Math.abs(lat) <= 90 &&
          Math.abs(lon) <= 180
        ) {
          lastValidLatLng = [lat, lon];
          streams.latlng.push(lastValidLatLng);
        } else if (lastValidLatLng) {
          streams.latlng.push(lastValidLatLng);
        } else {
          streams.latlng.push(null);
        }
      }

      // Altitude
      if (hasElevation) {
        const val = metricRow[keyToIndex.get("directElevation")];
        streams.altitude.push(typeof val === "number" && Number.isFinite(val) ? val : 0);
      }

      // Velocity (m/s)
      if (hasSpeed) {
        const val = metricRow[keyToIndex.get("directSpeed")];
        streams.velocity_smooth.push(typeof val === "number" && Number.isFinite(val) ? val : 0);
      }

      // Distance (m)
      if (hasDist) {
        const val = metricRow[keyToIndex.get("directDistance")];
        const prev = streams.distance.length > 0 ? streams.distance[streams.distance.length - 1] : 0;
        streams.distance.push(typeof val === "number" && Number.isFinite(val) ? val : prev);
      }

      // Heartrate
      if (hasHR) {
        const val = metricRow[keyToIndex.get("directHeartRate")];
        const prev = streams.heartrate.length > 0 ? streams.heartrate[streams.heartrate.length - 1] : 0;
        streams.heartrate.push(typeof val === "number" && Number.isFinite(val) ? val : prev);
      }

      // Cadence
      if (hasCadence) {
        const val = metricRow[keyToIndex.get(cadenceKey)];
        streams.cadence.push(typeof val === "number" && Number.isFinite(val) ? val : 0);
      }

      // Power
      if (hasPower) {
        const val = metricRow[keyToIndex.get("directPower")];
        streams.watts.push(typeof val === "number" && Number.isFinite(val) ? val : 0);
      }
    }

    // Backfill leading null GPS coordinates with first valid point, or clear if none exist
    if (streams.latlng.length > 0) {
      const firstValidLatLng = streams.latlng.find(p => p !== null);
      if (firstValidLatLng) {
        for (let i = 0; i < streams.latlng.length; i++) {
          if (streams.latlng[i] === null) {
            streams.latlng[i] = firstValidLatLng;
          } else {
            break;
          }
        }
      } else {
        streams.latlng = [];
      }
    }

    // Clean up empty streams
    if (_.isEmpty(streams.latlng)) {
      delete streams.latlng;
    }
    if (_.isEmpty(streams.altitude)) {
      delete streams.altitude;
    }
    if (_.isEmpty(streams.velocity_smooth)) {
      delete streams.velocity_smooth;
    }
    if (_.isEmpty(streams.distance)) {
      delete streams.distance;
    }
    if (_.isEmpty(streams.heartrate)) {
      delete streams.heartrate;
    }
    if (_.isEmpty(streams.cadence)) {
      delete streams.cadence;
    }
    if (_.isEmpty(streams.watts)) {
      delete streams.watts;
    }

    return streams as Streams;
  }
}
