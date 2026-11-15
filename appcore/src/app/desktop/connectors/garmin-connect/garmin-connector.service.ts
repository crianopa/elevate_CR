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
import { DatedAthleteSettings } from "@elevate/shared/models/athlete/athlete-settings/dated-athlete-settings.model";
import { UserLactateThreshold } from "@elevate/shared/models/athlete/athlete-settings/user-lactate-threshold.model";
import { MatDialog } from "@angular/material/dialog";
import { MatSnackBar } from "@angular/material/snack-bar";
import { ConfirmDialogComponent } from "../../../shared/dialogs/confirm-dialog/confirm-dialog.component";
import { ConfirmDialogDataModel } from "../../../shared/dialogs/confirm-dialog/confirm-dialog-data.model";
import { SyncEventType } from "@elevate/shared/sync/events/sync-event-type";
import _ from "lodash";

export interface GarminLthHistoryPoint {
  date: string;
  heartRate: number | null;
  speedMps: number | null;
}

export interface GarminAthleteMetrics {
  lactateThresholdHeartRate: number | null;
  lactateThresholdSpeedMps: number | null;
  lactateThresholdHistory?: GarminLthHistoryPoint[];
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

export interface AthleteSettingsDiffItem {
  label: string;
  currentText: string;
  newText: string;
}

@Injectable()
export class GarminConnectorService extends ConnectorService {
  private syncListenerRegistered = false;
  private isPromptOpen = false;

  constructor(
    @Inject(SyncService) private readonly desktopSyncService: DesktopSyncService,
    @Inject(IPC_TUNNEL_SERVICE) private readonly ipcTunnelService: IpcTunnelService,
    @Inject(AthleteService) private readonly athleteService: AthleteService,
    @Inject(ActivityService) private readonly activityService: ActivityService,
    @Inject(GarminConnectorInfoService) private readonly garminConnectorInfoService: GarminConnectorInfoService,
    @Inject(MatDialog) private readonly dialog: MatDialog,
    @Inject(MatSnackBar) private readonly snackBar: MatSnackBar
  ) {
    super();
  }

  public sync(fastSync: boolean = null, forceSync: boolean = null): Promise<void> {
    return this.desktopSyncService.sync(fastSync, forceSync, ConnectorType.GARMIN);
  }

  /**
   * Listen for Garmin sync completion and prompt the user if Garmin Connect has updated athlete metrics.
   */
  public listenForSyncUpdates(): void {
    if (this.syncListenerRegistered) {
      return;
    }
    this.syncListenerRegistered = true;
    this.desktopSyncService.syncEvents$.subscribe(event => {
      if (
        event?.type === SyncEventType.COMPLETE &&
        this.desktopSyncService.currentConnectorType === ConnectorType.GARMIN
      ) {
        this.checkAndPromptAthleteSettingsUpdate(false).catch(() => {
          // Silent on background post-sync check
        });
      }
    });
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
   * Format seconds/km as mm:ss/km for user-facing prompts.
   */
  public static formatPace(secPerKm: number): string {
    if (!secPerKm || secPerKm <= 0) {
      return "not set";
    }
    const mins = Math.floor(secPerKm / 60);
    const secs = Math.round(secPerKm % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}/km (${secPerKm} s/km)`;
  }

  /**
   * Compute human-readable differences between current AthleteSettings and Garmin Connect values.
   */
  public static diffWithAthlete(
    athleteModel: AthleteModel,
    imported: GarminAthleteSettingsImport
  ): AthleteSettingsDiffItem[] {
    const current = athleteModel.datedAthleteSettings[0];
    const diffs: AthleteSettingsDiffItem[] = [];

    if (imported.lthrRunning && imported.lthrRunning !== current?.lthr?.running) {
      diffs.push({
        label: "Running LTHR",
        currentText: current?.lthr?.running ? `${current.lthr.running} bpm` : "not set",
        newText: `${imported.lthrRunning} bpm`
      });
    }
    if (imported.runningFtp && imported.runningFtp !== current?.runningFtp) {
      diffs.push({
        label: "Running Threshold Pace (FTP)",
        currentText: GarminConnectorService.formatPace(current?.runningFtp),
        newText: GarminConnectorService.formatPace(imported.runningFtp)
      });
    }
    if (imported.maxHr && imported.maxHr !== current?.maxHr) {
      diffs.push({
        label: "Max HR",
        currentText: current?.maxHr ? `${current.maxHr} bpm` : "not set",
        newText: `${imported.maxHr} bpm`
      });
    }
    if (imported.restHr && imported.restHr !== current?.restHr) {
      diffs.push({
        label: "Rest HR",
        currentText: current?.restHr ? `${current.restHr} bpm` : "not set",
        newText: `${imported.restHr} bpm`
      });
    }

    return diffs;
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
   * Sort dated athlete settings descending by `since`, keeping the `since === null` ("forever") entry last.
   */
  private static sortDatedSettings(list: DatedAthleteSettings[]): DatedAthleteSettings[] {
    return [...list].sort((a, b) => {
      if (a.since === null && b.since === null) {
        return 0;
      }
      if (a.since === null) {
        return 1;
      }
      if (b.since === null) {
        return -1;
      }
      return b.since.localeCompare(a.since);
    });
  }

  /**
   * Create or update DatedAthleteSettings entries for each Garmin 1-year LTH history point.
   */
  public static applyLthHistoryToAthlete(
    athleteModel: AthleteModel,
    history: GarminLthHistoryPoint[]
  ): { athleteModel: AthleteModel; addedCount: number; updatedCount: number } {
    let addedCount = 0;
    let updatedCount = 0;

    const baseSettings = athleteModel.datedAthleteSettings[0]
      ? DatedAthleteSettings.asInstance(athleteModel.datedAthleteSettings[0]).toAthleteSettingsModel()
      : _.cloneDeep(AthleteSettings.DEFAULT_MODEL);

    for (const point of history || []) {
      if (!point?.date) {
        continue;
      }
      const lthrRunning = point.heartRate > 0 ? Math.round(point.heartRate) : null;
      const runningFtp = point.speedMps > 0 ? Math.round(1000 / point.speedMps) : null;
      if (!lthrRunning && !runningFtp) {
        continue;
      }

      const existing = athleteModel.datedAthleteSettings.find(s => s.since === point.date);
      if (existing) {
        let changed = false;
        if (lthrRunning && existing.lthr?.running !== lthrRunning) {
          existing.lthr = existing.lthr || { ...AthleteSettings.DEFAULT_MODEL.lthr };
          existing.lthr.running = lthrRunning;
          existing.lthr.default = existing.lthr.default || lthrRunning;
          changed = true;
        }
        if (runningFtp && existing.runningFtp !== runningFtp) {
          existing.runningFtp = runningFtp;
          changed = true;
        }
        if (changed) {
          updatedCount++;
        }
      } else {
        const entry = new DatedAthleteSettings(point.date, _.cloneDeep(baseSettings));
        entry.lthr = entry.lthr || { ...AthleteSettings.DEFAULT_MODEL.lthr };
        if (lthrRunning) {
          entry.lthr.running = lthrRunning;
          entry.lthr.default = entry.lthr.default || lthrRunning;
        }
        if (runningFtp) {
          entry.runningFtp = runningFtp;
        }
        athleteModel.datedAthleteSettings.push(entry);
        addedCount++;
      }
    }

    // Ensure a "forever" (since: null) entry always exists
    if (!athleteModel.datedAthleteSettings.some(s => s.since === null)) {
      athleteModel.datedAthleteSettings.push(new DatedAthleteSettings(null, _.cloneDeep(baseSettings)));
    }

    athleteModel.datedAthleteSettings = GarminConnectorService.sortDatedSettings(athleteModel.datedAthleteSettings);
    return { athleteModel, addedCount, updatedCount };
  }

  private fetchGarminMetrics(): Promise<GarminAthleteMetrics> {
    return this.garminConnectorInfoService
      .fetch()
      .then(info =>
        this.ipcTunnelService.send<IpcMessage, GarminAthleteMetrics>(
          new IpcMessage(Channel.garminAthleteMetrics, info?.email || null)
        )
      );
  }

  /**
   * Fetch Garmin metrics, compare with existing Athlete Settings, and ask the user whether to replace changed values.
   */
  public checkAndPromptAthleteSettingsUpdate(
    notifyIfUpToDate = true
  ): Promise<{ updated: boolean; imported: GarminAthleteSettingsImport; errors: string[] }> {
    let imported: GarminAthleteSettingsImport = {};
    let errors: string[] = [];
    let athleteModel: AthleteModel;

    return this.fetchGarminMetrics()
      .then(metrics => {
        errors = metrics.errors || [];
        imported = GarminConnectorService.toAthleteSettingsImport(metrics);
        if (!Object.keys(imported).length) {
          return Promise.reject(new Error("No metrics available in Garmin Connect. " + errors.join(" | ")));
        }
        return this.athleteService.fetch();
      })
      .then(fetchedAthlete => {
        athleteModel = fetchedAthlete;
        const diffs = GarminConnectorService.diffWithAthlete(athleteModel, imported);

        if (!diffs.length) {
          if (notifyIfUpToDate) {
            this.snackBar.open("Your Athlete Settings are already up to date with Garmin Connect.", "Ok", {
              duration: 6000
            });
          }
          return { updated: false, imported, errors };
        }

        if (this.isPromptOpen) {
          return { updated: false, imported, errors };
        }
        this.isPromptOpen = true;

        const rows = diffs
          .map(d => `<li><strong>${d.label}:</strong> ${d.currentText} &rarr; <strong>${d.newText}</strong></li>`)
          .join("");

        const dialogRef = this.dialog.open(ConfirmDialogComponent, {
          minWidth: ConfirmDialogComponent.MIN_WIDTH,
          maxWidth: ConfirmDialogComponent.MAX_WIDTH,
          data: {
            title: "Garmin Connect Athlete Settings Update",
            content:
              `<p>Garmin Connect has updated physiological metrics that differ from your current Athlete Settings:</p>` +
              `<ul>${rows}</ul>` +
              `<p>Do you want to replace your existing values with the new ones calculated by Garmin?</p>`,
            confirmText: "Replace",
            cancelText: "Keep existing"
          } as ConfirmDialogDataModel
        });

        return dialogRef
          .afterClosed()
          .toPromise()
          .then((confirm: boolean) => {
            this.isPromptOpen = false;
            if (!confirm) {
              return { updated: false, imported, errors };
            }
            return this.athleteService
              .update(GarminConnectorService.applyToAthlete(athleteModel, imported))
              .then(() => {
                this.activityService.verifyConsistencyWithAthleteSettings();
                this.snackBar.open("Athlete settings updated from Garmin Connect.", "Ok", { duration: 6000 });
                return { updated: true, imported, errors };
              });
          })
          .catch(err => {
            this.isPromptOpen = false;
            return Promise.reject(err);
          });
      });
  }

  /**
   * Import the 1-year running LTH history (HR and pace) into Elevate's Dated Athlete Settings.
   */
  public importLthHistory(): Promise<{ addedCount: number; updatedCount: number; totalPoints: number }> {
    let history: GarminLthHistoryPoint[] = [];

    return this.fetchGarminMetrics()
      .then(metrics => {
        history = metrics.lactateThresholdHistory || [];
        if (!history.length) {
          const errMsg = (metrics.errors || []).join(" | ");
          return Promise.reject(new Error("No 1-year running LTH history found in Garmin Connect. " + errMsg));
        }
        return this.athleteService.fetch();
      })
      .then(athleteModel => {
        const res = GarminConnectorService.applyLthHistoryToAthlete(athleteModel, history);
        return this.athleteService.validateUpdate(res.athleteModel).then(() => {
          this.activityService.verifyConsistencyWithAthleteSettings();
          return {
            addedCount: res.addedCount,
            updatedCount: res.updatedCount,
            totalPoints: history.length
          };
        });
      });
  }
}
