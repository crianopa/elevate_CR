import { ConnectorInfo } from "./connector-info.model";

export class GarminAccount {
  constructor(
    public id: string | number,
    public displayName: string,
    public fullName: string = null,
    public profileImageUrl: string = null
  ) {}
}

export class GarminConnectorInfo extends ConnectorInfo {
  public static readonly DEFAULT_MODEL: GarminConnectorInfo = new GarminConnectorInfo(null, null);

  constructor(
    public email: string | null = null,
    public tokenStorePath: string | null = null,
    public personalApiKey: string | null = null,
    public updateExistingNamesTypesCommutes: boolean = true,
    public garminAccount: GarminAccount | null = null
  ) {
    super();
    this.email = email;
    this.tokenStorePath = tokenStorePath;
    this.personalApiKey = personalApiKey;
    this.updateExistingNamesTypesCommutes = updateExistingNamesTypesCommutes;
    this.garminAccount = garminAccount;
  }
}
