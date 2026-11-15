import { IpcListener } from "./ipc-listener.interface";
import { inject, singleton } from "tsyringe";
import { IpcTunnelService } from "@elevate/shared/electron/ipc-tunnel";
import { Channel } from "@elevate/shared/electron/channels.enum";
import { GarminApiClient, GarminAthleteMetrics } from "../clients/garmin-api.client";

@singleton()
export class IpcGarminAthleteMetricsListener implements IpcListener {
  constructor(@inject(GarminApiClient) private readonly garminApiClient: GarminApiClient) {}

  public startListening(ipcTunnelService: IpcTunnelService): void {
    // Provide Garmin physiological metrics (LTHR, pace, max HR, rest HR) to ipc renderer
    ipcTunnelService.on<Array<[string]>, GarminAthleteMetrics>(Channel.garminAthleteMetrics, payload => {
      const [email] = payload[0] || [];
      return this.garminApiClient.getAthleteMetrics({ email: email || undefined });
    });
  }
}
