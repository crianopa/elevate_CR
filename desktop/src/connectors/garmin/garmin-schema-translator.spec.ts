import {
  GarminSchemaTranslator,
  GarminRawActivitySummary,
  GarminActivityDetailsResponse
} from "./garmin-schema-translator";
import { ElevateSport } from "@elevate/shared/enums/elevate-sport.enum";

describe("GarminSchemaTranslator", () => {
  const sampleSummary: GarminRawActivitySummary = {
    activityId: 123456789,
    activityName: "Morning Ride in the Hills",
    startTimeGMT: "2023-05-10 07:30:00.0",
    startTimeLocal: "2023-05-10 09:30:00.0",
    activityType: {
      typeId: 2,
      typeKey: "cycling"
    },
    distance: 45200.5,
    duration: 5400,
    elapsedDuration: 5600,
    movingDuration: 5350,
    elevationGain: 620,
    elevationLoss: 615,
    averageSpeed: 8.45,
    maxSpeed: 16.2,
    calories: 1150,
    averageHR: 148,
    maxHR: 176,
    averageBikingCadenceInRevPerMinute: 82,
    avgPower: 210,
    maxPower: 580,
    hasPowerMeter: true,
    isIndoor: false,
    manualActivity: false,
    metadataDTO: {
      deviceName: "Garmin Edge 830"
    }
  };

  it("should correctly resolve Garmin sport types to ElevateSport", () => {
    expect(GarminSchemaTranslator.resolveSportType("cycling")).toBe(ElevateSport.Ride);
    expect(GarminSchemaTranslator.resolveSportType("road_biking")).toBe(ElevateSport.Ride);
    expect(GarminSchemaTranslator.resolveSportType("running")).toBe(ElevateSport.Run);
    expect(GarminSchemaTranslator.resolveSportType("trail_running")).toBe(ElevateSport.Run);
    expect(GarminSchemaTranslator.resolveSportType("lap_swimming")).toBe(ElevateSport.Swim);
    expect(GarminSchemaTranslator.resolveSportType("strength_training")).toBe(ElevateSport.WeightTraining);
    expect(GarminSchemaTranslator.resolveSportType("non_existing_sport")).toBe(ElevateSport.Workout);
  });

  it("should convert GarminRawActivitySummary to BareActivity", () => {
    const bare = GarminSchemaTranslator.toBareActivity(sampleSummary);

    expect(bare.id).toBe(123456789);
    expect(bare.name).toBe("Morning Ride in the Hills");
    expect(bare.type).toBe(ElevateSport.Ride);
    expect(bare.hasPowerMeter).toBe(true);
    expect(bare.trainer).toBe(false);
    expect(bare.manual).toBe(false);
    expect(bare.startTime).toBeDefined();
    expect(bare.endTime).toBeDefined();
    expect(bare.endTimestamp).toBeGreaterThan(bare.startTimestamp);
  });

  it("should extract source stats from Garmin activity summary", () => {
    const stats = GarminSchemaTranslator.toSourceStats(ElevateSport.Ride, sampleSummary);

    expect(stats.movingTime).toBe(5350);
    expect(stats.elapsedTime).toBe(5600);
    expect(stats.pauseTime).toBe(250);
    expect(stats.distance).toBe(45200.5);
    expect(stats.calories).toBe(1150);
    expect(stats.elevationGain).toBe(620);
    expect(stats.elevation.ascent).toBe(620);
    expect(stats.elevation.descent).toBe(615);
    expect(stats.speed.avg).toBeCloseTo(8.45 * 3.6, 1);
    expect(stats.speed.max).toBeCloseTo(16.2 * 3.6, 1);
  });

  it("should map activity details metrics to Streams", () => {
    const sampleDetails: GarminActivityDetailsResponse = {
      activityId: 123456789,
      metricsDescriptors: [
        { metricsIndex: 0, key: "directTimestamp" },
        { metricsIndex: 1, key: "directLatitude" },
        { metricsIndex: 2, key: "directLongitude" },
        { metricsIndex: 3, key: "directElevation" },
        { metricsIndex: 4, key: "directSpeed" },
        { metricsIndex: 5, key: "directHeartRate" },
        { metricsIndex: 6, key: "directBikeCadence" },
        { metricsIndex: 7, key: "directPower" }
      ],
      activityDetailMetrics: [
        { metrics: [1683703800000, 45.19, 5.72, 220, 7.5, 135, 80, 180] },
        { metrics: [1683703801000, 45.191, 5.721, 221, 7.6, 136, 81, 185] },
        { metrics: [1683703802000, 45.192, 5.722, 222, 7.8, 138, 82, 190] }
      ]
    };

    const streams = GarminSchemaTranslator.toStreamsFromDetails(sampleDetails);

    expect(streams.time).toEqual([0, 1, 2]);
    expect(streams.latlng.length).toBe(3);
    expect(streams.latlng[0]).toEqual([45.19, 5.72]);
    expect(streams.altitude).toEqual([220, 221, 222]);
    expect(streams.velocity_smooth).toEqual([7.5, 7.6, 7.8]);
    expect(streams.heartrate).toEqual([135, 136, 138]);
    expect(streams.cadence).toEqual([80, 81, 82]);
    expect(streams.watts).toEqual([180, 185, 190]);
  });
});
