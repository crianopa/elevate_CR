import { GarminConnectorService } from "./garmin-connector.service";
import { AthleteModel } from "@elevate/shared/models/athlete/athlete.model";
import { DatedAthleteSettings } from "@elevate/shared/models/athlete/athlete-settings/dated-athlete-settings.model";
import { AthleteSettings } from "@elevate/shared/models/athlete/athlete-settings/athlete-settings.model";
import _ from "lodash";

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
    const athlete = _.cloneDeep(AthleteModel.DEFAULT_MODEL);
    const before = athlete.datedAthleteSettings[0].restHr;
    GarminConnectorService.applyToAthlete(athlete, { maxHr: 183, lthrRunning: 158, runningFtp: 286 });
    const current = athlete.datedAthleteSettings[0];
    expect(current.maxHr).toEqual(183);
    expect(current.restHr).toEqual(before);
    expect(current.lthr.running).toEqual(158);
    expect(current.runningFtp).toEqual(286);
  });

  it("should detect diffs between current athlete settings and Garmin values", () => {
    const athlete = _.cloneDeep(AthleteModel.DEFAULT_MODEL);
    athlete.datedAthleteSettings[0].lthr.running = 155;
    const diffs = GarminConnectorService.diffWithAthlete(athlete, {
      lthrRunning: 158,
      runningFtp: 286
    });
    expect(diffs.map(d => d.label)).toEqual(["Running LTHR", "Running Threshold Pace (FTP)"]);
  });

  it("should create DatedAthleteSettings entries for 1-year LTH history sorted descending with forever last", () => {
    const athlete = _.cloneDeep(AthleteModel.DEFAULT_MODEL);
    athlete.datedAthleteSettings = [new DatedAthleteSettings(null, _.cloneDeep(AthleteSettings.DEFAULT_MODEL))];
    const history = [
      { date: "2025-12-02", heartRate: 148, speedMps: 4.2 },
      { date: "2026-01-15", heartRate: 154, speedMps: 4.2 },
      { date: "2026-11-10", heartRate: 153, speedMps: 4.0 }
    ];
    const res = GarminConnectorService.applyLthHistoryToAthlete(athlete, history);
    expect(res.addedCount).toEqual(3);
    expect(res.athleteModel.datedAthleteSettings.map(s => s.since)).toEqual([
      "2026-11-10",
      "2026-01-15",
      "2025-12-02",
      null
    ]);
    expect(res.athleteModel.datedAthleteSettings[0].lthr.running).toEqual(153);
    expect(res.athleteModel.datedAthleteSettings[0].runningFtp).toEqual(250);
  });
});
