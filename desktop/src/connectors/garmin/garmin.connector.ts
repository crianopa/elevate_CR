import { BaseConnector } from "../base.connector";
import { ReplaySubject, Subject } from "rxjs";
import { AppService } from "../../app-service";
import _ from "lodash";
import { inject, singleton } from "tsyringe";
import { ConnectorConfig, GarminConnectorConfig } from "../connector-config.model";
import { GarminApiClient } from "../../clients/garmin-api.client";
import { IpcSyncMessageSender } from "../../senders/ipc-sync-message.sender";
import { Logger } from "../../logger";
import moment from "moment";
import { WorkerService } from "../../worker-service";
import { Environment, EnvironmentToken } from "../../environments/environment.interface";
import { HttpClient } from "../../clients/http.client";
import { ConnectorType } from "@elevate/shared/sync/connectors/connector-type.enum";
import { SyncEvent } from "@elevate/shared/sync/events/sync.event";
import { Activity, ActivityExtras, ActivityStats, Lap } from "@elevate/shared/models/sync/activity.model";
import { StoppedSyncEvent } from "@elevate/shared/sync/events/stopped-sync.event";
import { ErrorSyncEvent } from "@elevate/shared/sync/events/error-sync.event";
import { BareActivity } from "@elevate/shared/models/sync/bare-activity.model";
import { SyncEventType } from "@elevate/shared/sync/events/sync-event-type";
import { ActivitySyncEvent } from "@elevate/shared/sync/events/activity-sync.event";
import { GenericSyncEvent } from "@elevate/shared/sync/events/generic-sync.event";
import { ElevateSport } from "@elevate/shared/enums/elevate-sport.enum";
import { Streams } from "@elevate/shared/models/activity-data/streams.model";
import { StartedSyncEvent } from "@elevate/shared/sync/events/started-sync.event";
import { GarminSchemaTranslator, GarminRawActivitySummary } from "./garmin-schema-translator";

@singleton()
export class GarminConnector extends BaseConnector {
  public static readonly ENABLED: boolean = true;
  public static readonly ACTIVITIES_PER_PAGE: number = 20;

  public garminConnectorConfig: GarminConnectorConfig;

  constructor(
    @inject(AppService) protected readonly appService: AppService,
    @inject(EnvironmentToken) protected readonly environment: Environment,
    @inject(IpcSyncMessageSender) protected readonly ipcSyncMessageSender: IpcSyncMessageSender,
    @inject(GarminApiClient) public readonly garminApiClient: GarminApiClient,
    @inject(WorkerService) protected readonly workerService: WorkerService,
    @inject(HttpClient) protected readonly httpClient: HttpClient,
    @inject(Logger) protected readonly logger: Logger
  ) {
    super(appService, environment, ipcSyncMessageSender, workerService, httpClient, logger);
    this.type = ConnectorType.GARMIN;
    this.enabled = GarminConnector.ENABLED;
  }

  public configure(connectorConfig: ConnectorConfig): this {
    super.configure(connectorConfig);
    this.garminConnectorConfig = this.connectorConfig as GarminConnectorConfig;
    return this;
  }

  public sync(): Subject<SyncEvent> {
    if (this.isSyncing) {
      this.syncEvents$.next(ErrorSyncEvent.SYNC_ALREADY_STARTED.create(ConnectorType.GARMIN));
    } else {
      this.syncEvents$ = new ReplaySubject<SyncEvent>();
      this.syncEvents$.next(new StartedSyncEvent(ConnectorType.GARMIN));
      this.isSyncing = true;

      this.logger.info(`Starting new sync on '${this.type}' connector`);

      this.syncPages(this.syncEvents$).then(
        () => {
          this.isSyncing = false;
          this.syncEvents$.complete();
        },
        (syncError: any) => {
          this.isSyncing = false;
          const isCancelEvent = syncError?.type === SyncEventType.STOPPED;

          if (isCancelEvent) {
            this.syncEvents$.next(syncError);
          } else {
            const errorMessage = syncError instanceof Error ? syncError.message : String(syncError?.message || syncError);
            this.logger.error(`[GarminConnector] Sync failed: ${errorMessage}`, syncError);
            this.syncEvents$.next(ErrorSyncEvent.UNHANDLED_ERROR_SYNC.create(this.type, errorMessage));
            this.syncEvents$.next(new StoppedSyncEvent(this.type));
            this.syncEvents$.error(syncError);
          }
        }
      );
    }

    return this.syncEvents$;
  }

  public syncPages(
    syncEvents$: Subject<SyncEvent>,
    offset = 0,
    limit: number = GarminConnector.ACTIVITIES_PER_PAGE
  ): Promise<void> {
    if (this.stopRequested) {
      return Promise.reject(new StoppedSyncEvent(this.type));
    }

    return new Promise((resolve, reject) => {
      this.syncEvents$.next(
        new GenericSyncEvent(this.type, `Scanning ${offset + limit} activities from Garmin Connect...`)
      );

      const config = {
        email: this.garminConnectorConfig?.info?.email,
        personalApiKey: this.garminConnectorConfig?.info?.personalApiKey
      };

      this.garminApiClient.getActivities(offset, limit, config).then(
        (garminSummaries: GarminRawActivitySummary[]) => {
          if (garminSummaries && garminSummaries.length > 0) {
            this.processGarminActivities(syncEvents$, garminSummaries).then(
              () => {
                // Garmin returns newest first: once a page reaches activities older than syncFromDateTime, stop paging
                if (this.syncFromDateTime && this.isPageOlderThanSyncDate(garminSummaries)) {
                  resolve();
                  return;
                }
                const nextOffset = offset + limit;
                resolve(this.syncPages(syncEvents$, nextOffset, limit));
              },
              error => reject(error)
            );
          } else {
            resolve();
          }
        },
        error => reject(error)
      );
    });
  }

  private isPageOlderThanSyncDate(garminSummaries: GarminRawActivitySummary[]): boolean {
    return garminSummaries.some(
      summary => GarminSchemaTranslator.toBareActivity(summary).startTimestamp * 1000 < this.syncFromDateTime
    );
  }

  public processGarminActivities(
    syncEvents$: Subject<SyncEvent>,
    garminSummaries: GarminRawActivitySummary[]
  ): Promise<void> {
    return garminSummaries.reduce((previousPromise: Promise<void>, summary: GarminRawActivitySummary) => {
      return previousPromise.then(() => {
        if (this.stopRequested) {
          return Promise.reject(new StoppedSyncEvent(this.type));
        }

        const bareActivity = GarminSchemaTranslator.toBareActivity(summary);

        // Check if activity before syncFromDateTime
        if (this.syncFromDateTime && bareActivity.startTimestamp * 1000 < this.syncFromDateTime) {
          return Promise.resolve();
        }

        return this.findLocalActivities(bareActivity.startTime, bareActivity.endTime).then(
          (localActivities: Activity[]) => {
            if (_.isEmpty(localActivities) || this.environment.allowActivitiesOverLapping) {
              // Fetch details / streams
              return this.fetchRemoteGarminStreams(summary.activityId).then(
                (streams: Streams) => {
                  let activity: Partial<Activity> = bareActivity;
                  activity = this.assignBaseProperties(activity, streams);

                  activity.extras = {
                    garmin: {
                      activityId: summary.activityId
                    }
                  } as ActivityExtras;

                  const athleteSnapshot = this.athleteSnapshotResolver.resolve(activity.startTime);
                  activity.srcStats = this.getSourceStats(activity.type, summary, streams);

                  if (summary.laps && summary.laps.length > 0) {
                    activity.laps = GarminSchemaTranslator.toLaps(activity.type, summary.laps);
                  }

                  activity.device = summary.metadataDTO?.deviceName || null;
                  activity.notes = summary.description || null;

                  return this.computeActivity(
                    activity,
                    athleteSnapshot,
                    this.connectorConfig.userSettings,
                    streams,
                    true
                  )
                    .then(results => {
                      const { computedActivity, deflatedStreams } = results;
                      syncEvents$.next(new ActivitySyncEvent(this.type, null, computedActivity, true, deflatedStreams));
                      return Promise.resolve();
                    })
                    .catch(error => {
                      const errorSyncEvent =
                        error instanceof Error
                          ? ErrorSyncEvent.SYNC_ERROR_COMPUTE.create(this.type, error.message, bareActivity, error)
                          : ErrorSyncEvent.SYNC_ERROR_COMPUTE.create(this.type, error.toString(), bareActivity);

                      syncEvents$.next(errorSyncEvent);
                      return Promise.resolve();
                    });
                },
                error => {
                  this.logger.error(`Failed to fetch streams for Garmin activity ${summary.activityId}`, error);
                  return Promise.resolve(); // Continue to next activity on stream error
                }
              );
            } else {
              // Handle existing activity updates
              if (_.isArray(localActivities) && localActivities.length === 1) {
                if (this.garminConnectorConfig?.info?.updateExistingNamesTypesCommutes) {
                  const localActivity = localActivities[0];
                  localActivity.name = bareActivity.name;
                  localActivity.extras = _.merge<ActivityExtras, ActivityExtras>(localActivity.extras, {
                    garmin: {
                      activityId: summary.activityId
                    }
                  });
                  syncEvents$.next(new ActivitySyncEvent(this.type, null, localActivity, false));
                }
              }
              return Promise.resolve();
            }
          }
        );
      });
    }, Promise.resolve());
  }

  public fetchRemoteGarminStreams(activityId: number): Promise<Streams> {
    const config = {
      email: this.garminConnectorConfig?.info?.email,
      personalApiKey: this.garminConnectorConfig?.info?.personalApiKey
    };
    return this.garminApiClient.getActivityDetails(activityId, config).then(
      details => {
        return GarminSchemaTranslator.toStreamsFromDetails(details);
      },
      error => {
        this.logger.warn(`Could not fetch details for activity ${activityId}, details stream will be empty.`, error);
        return null;
      }
    );
  }

  public getSourceStats(
    sport: ElevateSport,
    source: Partial<GarminRawActivitySummary>,
    streams: Streams
  ): Partial<ActivityStats> {
    return GarminSchemaTranslator.toSourceStats(sport, source, streams);
  }
}
