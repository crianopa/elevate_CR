import { Component, Inject, OnDestroy, OnInit } from "@angular/core";
import { ConnectorsComponent } from "../connectors.component";
import { SyncService } from "../../../shared/services/sync/sync.service";
import { DesktopSyncService } from "../../../shared/services/sync/impl/desktop-sync.service";
import {
  OPEN_RESOURCE_RESOLVER,
  OpenResourceResolver
} from "../../../shared/services/links-opener/open-resource-resolver";
import { Router } from "@angular/router";
import { MatDialog } from "@angular/material/dialog";
import { GarminConnectorInfoService } from "../../../shared/services/garmin-connector-info/garmin-connector-info.service";
import { GarminConnectorService } from "./garmin-connector.service";
import { GarminConnectorInfo } from "@elevate/shared/sync/connectors/garmin-connector-info.model";
import { ConnectorType } from "@elevate/shared/sync/connectors/connector-type.enum";
import { Subscription } from "rxjs";
import { MatSnackBar } from "@angular/material/snack-bar";

@Component({
  selector: "app-garmin-connect",
  templateUrl: "./garmin-connect.component.html",
  styleUrls: ["./garmin-connect.component.scss"]
})
export class GarminConnectComponent extends ConnectorsComponent implements OnInit, OnDestroy {
  public garminConnectorInfo: GarminConnectorInfo;
  public connectorType = ConnectorType.GARMIN;
  public isConnected = false;
  public isImportingSettings = false;
  private infoSubscription: Subscription;

  constructor(
    @Inject(SyncService) protected readonly desktopSyncService: DesktopSyncService,
    @Inject(GarminConnectorService) protected readonly garminConnectorService: GarminConnectorService,
    @Inject(OPEN_RESOURCE_RESOLVER) protected readonly openResourceResolver: OpenResourceResolver,
    @Inject(Router) protected readonly router: Router,
    @Inject(MatDialog) protected readonly dialog: MatDialog,
    @Inject(GarminConnectorInfoService) private readonly garminConnectorInfoService: GarminConnectorInfoService,
    @Inject(MatSnackBar) private readonly snackBar: MatSnackBar
  ) {
    super(desktopSyncService, openResourceResolver, router, dialog);
  }

  public ngOnInit(): void {
    this.garminConnectorInfoService.fetch().then(info => {
      this.garminConnectorInfo = info || new GarminConnectorInfo();
      this.isConnected = !!(this.garminConnectorInfo.email || this.garminConnectorInfo.personalApiKey);
    });

    this.infoSubscription = this.garminConnectorInfoService.info$.subscribe(info => {
      this.garminConnectorInfo = info;
      this.isConnected = !!(info.email || info.personalApiKey);
    });

    this.updateSyncDateTimeText();
  }

  public onSave(): void {
    this.garminConnectorInfoService.update(this.garminConnectorInfo).then(updated => {
      this.garminConnectorInfo = updated;
      this.isConnected = !!(updated.email || updated.personalApiKey);
    });
  }

  public sync(fastSync: boolean = null, forceSync: boolean = null): Promise<void> {
    return this.garminConnectorService.sync(fastSync, forceSync).catch(err => {
      if (err !== ConnectorsComponent.ATHLETE_CHECKING_FIRST_SYNC_MESSAGE) {
        return Promise.reject(err);
      }
      return Promise.resolve();
    });
  }

  public onSync(): void {
    this.sync(true); // Fast sync: only new activities
  }

  public onSyncAll(): void {
    this.sync(false); // Full sync: scan every activity
  }

  public onImportAthleteSettings(): void {
    this.isImportingSettings = true;
    this.garminConnectorService
      .importAthleteSettings()
      .then(({ imported }) => {
        const parts: string[] = [];
        if (imported.maxHr) {
          parts.push(`Max HR ${imported.maxHr} bpm`);
        }
        if (imported.restHr) {
          parts.push(`Rest HR ${imported.restHr} bpm`);
        }
        if (imported.lthrRunning) {
          parts.push(`Running LTHR ${imported.lthrRunning} bpm`);
        }
        if (imported.runningFtp) {
          parts.push(`Threshold pace ${imported.runningFtp}s/km`);
        }
        this.snackBar.open(`Athlete settings updated from Garmin: ${parts.join(", ")}`, "Ok", { duration: 10000 });
      })
      .catch(err => {
        this.snackBar.open(`Unable to import Garmin athlete settings: ${err?.message || err}`, "Ok", {
          duration: 10000
        });
      })
      .finally(() => (this.isImportingSettings = false));
  }

  public ngOnDestroy(): void {
    if (this.infoSubscription) {
      this.infoSubscription.unsubscribe();
    }
  }
}
