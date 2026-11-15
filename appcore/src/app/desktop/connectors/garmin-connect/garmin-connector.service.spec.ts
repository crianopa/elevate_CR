import { GarminConnectorService } from "./garmin-connector.service";
import { AthleteModel } from "@elevate/shared/models/athlete/athlete.model";

describe("GarminConnectorService athlete settings import", () => {
  it("should convert Garmin metrics", () => {
    const imported = GarminConnectorService.toAthleteSettingsImport({
      lactateThresholdHeartRate: 158,
      lactateThresholdSpeedMps: 3.5,
      runningMaxHeartRate: 183,
      avgRestingHeartRate: 49,
      errors: []
    });
    expect(imported).toEqual({ maxHr: 183, restHr: 49, lthrRunning: 158, runningFtp: 286 });
  });

  it("should omit missing metrics", () => {
    const imported = GarminConnectorService.toAthleteSettingsImport({
      lactateThresholdHeartRate: null,
      lactateThresholdSpeedMps: null,
      runningMaxHeartRate: 183,
      avgRestingHeartRate: null,
      errors: []
    });
    expect(imported).toEqual({ maxHr: 183 });
  });

  it("should apply values on current dated settings only where provided", () => {
    const athlete = AthleteModel.DEFAULT_MODEL;
    const before = athlete.datedAthleteSettings[0].restHr;
    GarminConnectorService.applyToAthlete(athlete, { maxHr: 183, lthrRunning: 158, runningFtp: 286 });
    const current = athlete.datedAthleteSettings[0];
    expect(current.maxHr).toEqual(183);
    expect(current.restHr).toEqual(before);
    expect(current.lthr.running).toEqual(158);
    expect(current.runningFtp).toEqual(286);
  });
});
