import { Inject, Injectable } from "@angular/core";
import { DesktopSyncService } from "../../../shared/services/sync/impl/desktop-sync.service";
import { SyncService } from "../../../shared/services/sync/sync.service";
import { ConnectorService } from "../connector.service";
import { ConnectorType } from "@elevate/shared/sync/connectors/connector-type.enum";
import { IPC_TUNNEL_SERVICE } from "../../ipc/ipc-tunnel-service.token";
import { IpcTunnelService } from "@elevate/shared/electron/ipc-tunnel";
import { IpcMessage } from "@elevate/shared/electron/ipc-message";
import { Channel } from "@elevate/shared/electron/channels.enum";
import { AthleteService } from "../../../shared/services/athlete/athlete.service";
import { ActivityService } from "../../../shared/services/activity/activity.service";
import { GarminConnectorInfoService } from "../../../shared/services/garmin-connector-info/garmin-connector-info.service";
import { AthleteModel } from "@elevate/shared/models/athlete/athlete.model";
import { AthleteSettings } from "@elevate/shared/models/athlete/athlete-settings/athlete-settings.model";
import { UserLactateThreshold } from "@elevate/shared/models/athlete/athlete-settings/user-lactate-threshold.model";

export interface GarminAthleteMetrics {
  lactateThresholdHeartRate: number | null;
  lactateThresholdSpeedMps: number | null;
  runningMaxHeartRate: number | null;
  avgRestingHeartRate: number | null;
  errors: string[];
}

export interface GarminAthleteSettingsImport {
  maxHr?: number;
  restHr?: number;
  lthrRunning?: number;
  runningFtp?: number; // Threshold pace, seconds per km
}

@Injectable()
export class GarminConnectorService extends ConnectorService {
  constructor(
    @Inject(SyncService) private readonly desktopSyncService: DesktopSyncService,
    @Inject(IPC_TUNNEL_SERVICE) private readonly ipcTunnelService: IpcTunnelService,
    @Inject(AthleteService) private readonly athleteService: AthleteService,
    @Inject(ActivityService) private readonly activityService: ActivityService,
    @Inject(GarminConnectorInfoService) private readonly garminConnectorInfoService: GarminConnectorInfoService
  ) {
    super();
  }

  public sync(fastSync: boolean = null, forceSync: boolean = null): Promise<void> {
    return this.desktopSyncService.sync(fastSync, forceSync, ConnectorType.GARMIN);
  }

  /**
   * Convert raw Garmin metrics into values usable for athlete settings. Missing metrics are omitted.
   */
  public static toAthleteSettingsImport(metrics: GarminAthleteMetrics): GarminAthleteSettingsImport {
    const result: GarminAthleteSettingsImport = {};
    if (metrics?.runningMaxHeartRate > 0) {
      result.maxHr = Math.round(metrics.runningMaxHeartRate);
    }
    if (metrics?.avgRestingHeartRate > 0) {
      result.restHr = Math.round(metrics.avgRestingHeartRate);
    }
    if (metrics?.lactateThresholdHeartRate > 0) {
      result.lthrRunning = Math.round(metrics.lactateThresholdHeartRate);
    }
    if (metrics?.lactateThresholdSpeedMps > 0) {
      result.runningFtp = Math.round(1000 / metrics.lactateThresholdSpeedMps);
    }
    return result;
  }

  /**
   * Apply imported values to the current (most recent) dated athlete settings.
   */
  public static applyToAthlete(athleteModel: AthleteModel, imported: GarminAthleteSettingsImport): AthleteModel {
    const current = athleteModel.datedAthleteSettings[0];
    if (imported.maxHr) {
      current.maxHr = imported.maxHr;
    }
    if (imported.restHr) {
      current.restHr = imported.restHr;
    }
    if (imported.lthrRunning) {
      const lthr: UserLactateThreshold = current.lthr || { ...AthleteSettings.DEFAULT_MODEL.lthr };
      lthr.running = imported.lthrRunning;
      lthr.default = lthr.default || imported.lthrRunning;
      current.lthr = lthr;
    }
    if (imported.runningFtp) {
      current.runningFtp = imported.runningFtp;
    }
    return athleteModel;
  }

  /**
   * Fetch Garmin metrics, update athlete settings, then trigger the recalculation of impacted activities.
   * @return The imported values and Garmin errors (if any)
   */
  public importAthleteSettings(): Promise<{ imported: GarminAthleteSettingsImport; errors: string[] }> {
    let imported: GarminAthleteSettingsImport;
    let errors: string[] = [];

    return this.garminConnectorInfoService
      .fetch()
      .then(info =>
        this.ipcTunnelService.send<IpcMessage, GarminAthleteMetrics>(
          new IpcMessage(Channel.garminAthleteMetrics, info?.email || null)
        )
      )
      .then(metrics => {
        errors = metrics.errors || [];
        imported = GarminConnectorService.toAthleteSettingsImport(metrics);
        if (!Object.keys(imported).length) {
          return Promise.reject(new Error("No metrics available in Garmin Connect. " + errors.join(" | ")));
        }
        return this.athleteService.fetch();
      })
      .then(athleteModel => {
        return this.athleteService.update(GarminConnectorService.applyToAthlete(athleteModel, imported));
      })
      .then(() => {
        // Settings changed: recalculation of impacted activities starts automatically
        this.activityService.verifyConsistencyWithAthleteSettings();
        return { imported, errors };
      });
  }
}
