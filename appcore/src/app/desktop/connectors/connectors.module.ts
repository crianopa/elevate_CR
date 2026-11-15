import { NgModule } from "@angular/core";
import { CoreModule } from "../../core/core.module";
import { RouterModule, Routes } from "@angular/router";
import { ConnectorsComponent } from "./connectors.component";
import { StravaConnectorComponent } from "./strava-connector/strava-connector.component";
import { StravaConnectorService } from "./strava-connector/strava-connector.service";
import { FileConnectorComponent } from "./file-connector/file-connector.component";
import { FileConnectorService } from "./file-connector/file-connector.service";
import { GarminConnectComponent } from "./garmin-connect/garmin-connect.component";
import { GarminConnectorInfoDao } from "../../shared/dao/garmin-connector-info/garmin-connector-info.dao";
import { GarminConnectorInfoService } from "../../shared/services/garmin-connector-info/garmin-connector-info.service";

const routes: Routes = [
  {
    path: "",
    component: ConnectorsComponent
  }
];

@NgModule({
  imports: [CoreModule, RouterModule.forChild(routes)],
  declarations: [ConnectorsComponent, StravaConnectorComponent, FileConnectorComponent, GarminConnectComponent],
  providers: [
    StravaConnectorService,
    FileConnectorService,
    GarminConnectorInfoDao,
    GarminConnectorInfoService
  ]
})
export class ConnectorsModule {}
