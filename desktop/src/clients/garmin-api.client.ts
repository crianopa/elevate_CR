import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { inject, singleton } from "tsyringe";
import { Logger } from "../logger";
import { GarminRawActivitySummary, GarminActivityDetailsResponse } from "../connectors/garmin/garmin-schema-translator";

@singleton()
export class GarminApiClient {
  private readonly pythonScriptPath: string;
  private readonly venvPythonPath: string;

  constructor(@inject(Logger) private readonly logger: Logger) {
    const rootDir = path.resolve(__dirname, "../../..");
    this.pythonScriptPath = path.join(rootDir, "scripts", "garmin_bridge.py");
    this.venvPythonPath = path.join(rootDir, ".venv", "bin", "python");
  }

  /**
   * Executes a command against the python-garminconnect bridge script.
   */
  public executeBridge<T>(command: string, args: Record<string, any> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const pythonExecutable = fs.existsSync(this.venvPythonPath) ? this.venvPythonPath : "python3";
      const payload = JSON.stringify({ command, ...args });

      this.logger.debug(`[GarminApiClient] Spawning bridge command: ${command}`);

      const child = spawn(pythonExecutable, [this.pythonScriptPath, command], {
        env: {
          ...process.env
        }
      });

      let stdoutData = "";
      let stderrData = "";

      child.stdout.on("data", data => {
        stdoutData += data.toString();
      });

      child.stderr.on("data", data => {
        stderrData += data.toString();
      });

      child.on("close", code => {
        if (code !== 0) {
          this.logger.error(
            `[GarminApiClient] Bridge command '${command}' failed with code ${code}. Stderr: ${stderrData}`
          );
          return reject(new Error(`Garmin bridge error (code ${code}): ${stderrData || stdoutData}`));
        }

        try {
          const parsed = JSON.parse(stdoutData.trim());
          if (parsed.error) {
            return reject(new Error(parsed.error));
          }
          resolve(parsed.data as T);
        } catch (e) {
          reject(new Error(`Failed to parse bridge JSON output: ${stdoutData}`));
        }
      });

      child.on("error", err => {
        this.logger.error(`[GarminApiClient] Process spawn error:`, err);
        reject(err);
      });

      // Write payload to stdin if needed
      child.stdin.write(payload);
      child.stdin.end();
    });
  }

  /**
   * Fetch paginated activity summaries from Garmin Connect.
   */
  public getActivities(
    start: number,
    limit: number,
    config?: { email?: string; personalApiKey?: string }
  ): Promise<GarminRawActivitySummary[]> {
    return this.executeBridge<GarminRawActivitySummary[]>("get_activities", { start, limit, ...config });
  }

  /**
   * Fetch full activity details (metric streams).
   */
  public getActivityDetails(
    activityId: number,
    config?: { email?: string; personalApiKey?: string }
  ): Promise<GarminActivityDetailsResponse> {
    return this.executeBridge<GarminActivityDetailsResponse>("get_activity_details", { activityId, ...config });
  }

  /**
   * Downloads raw original activity file (.fit or .zip) as a base64 string or buffer.
   */
  public downloadActivity(
    activityId: number,
    config?: { email?: string; personalApiKey?: string }
  ): Promise<{ buffer: Buffer; filename: string }> {
    return this.executeBridge<{ base64Data: string; filename: string }>("download_activity", {
      activityId,
      ...config
    }).then(res => ({
      buffer: Buffer.from(res.base64Data, "base64"),
      filename: res.filename
    }));
  }
}
