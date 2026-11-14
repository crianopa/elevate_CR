import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { inject, singleton } from "tsyringe";
import { Logger } from "../logger";
import { GarminRawActivitySummary, GarminActivityDetailsResponse } from "../connectors/garmin/garmin-schema-translator";

@singleton()
export class GarminApiClient {
  private getRootDir(): string {
    const candidates = [
      process.cwd(),
      path.resolve(__dirname, "../.."),
      path.resolve(__dirname, "../../.."),
      path.resolve(__dirname, "..")
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, "scripts", "garmin_bridge.py"))) {
        return candidate;
      }
    }
    return process.cwd();
  }

  private getPythonExecutable(rootDir: string): string {
    const isWin = process.platform === "win32";
    const venvCandidates = [
      path.join(rootDir, ".venv", isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python"),
      path.join(process.cwd(), ".venv", isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python")
    ];
    for (const venvPath of venvCandidates) {
      if (fs.existsSync(venvPath)) {
        return venvPath;
      }
    }
    return isWin ? "python" : "python3";
  }

  constructor(@inject(Logger) private readonly logger: Logger) {}

  /**
   * Executes a command against the python-garminconnect bridge script.
   */
  public executeBridge<T>(command: string, args: Record<string, any> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const rootDir = this.getRootDir();
      const pythonScriptPath = path.join(rootDir, "scripts", "garmin_bridge.py");
      const pythonExecutable = this.getPythonExecutable(rootDir);
      const payload = JSON.stringify({ command, ...args });

      this.logger.info(`[GarminApiClient] Spawning bridge: ${pythonExecutable} ${pythonScriptPath} ${command}`);

      const child = spawn(pythonExecutable, [pythonScriptPath, command], {
        cwd: rootDir,
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
