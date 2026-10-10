/**
 * `/longhaul-report`: writes what a bug report needs -- versions, the model's shape, which config keys are set,
 * and the newest log records digested (report.ts) -- to a private file next to the log, and names the file. It is
 * written rather than printed so the user reads it before anything leaves the machine.
 */
import fs from "node:fs";
import path from "node:path";
import { getAgentDir, VERSION as PI_VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readConfigFile, resolveStateConfig } from "./config.ts";
import { defaultLogPath, resolveLogPath, withRegularFile } from "./log.ts";
import { homeDirectory } from "./narrative/route-config.ts";
import type { PiVersionStatus } from "./pi-compat.ts";
import { buildReport, readLastRecords } from "./report.ts";

export const REPORT_COMMAND = "longhaul-report";
const REPORT_RECORDS = 8;

function longhaulVersion(): string {
  try {
    const { version } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

function configKeys(text: string | undefined): string[] {
  try {
    const parsed: unknown = text === undefined ? {} : JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? Object.keys(parsed).filter((key) => key !== "_comment") : [];
  } catch {
    return [];
  }
}

/** Write `text` to `file` readable by its owner only, never through a symlink or into a non-file. */
function writePrivate(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  withRegularFile(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, (fd) => {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, text);
  });
}

export function registerReportCommand(pi: ExtensionAPI, piStatus: PiVersionStatus): void {
  pi.registerCommand(REPORT_COMMAND, {
    description: "Write a bug-report digest (versions, model shape, config keys, newest log records) to a private file",
    handler: async (_args, ctx) => {
      const home = homeDirectory();
      const file = path.join(getAgentDir(), "logs", "longhaul-report.md");
      try {
        const text = readConfigFile();
        const logPath = resolveLogPath(process.env.PI_COMPACT_STATE_DEBUG, defaultLogPath());
        const report = buildReport({
          longhaulVersion: longhaulVersion(),
          piVersion: PI_VERSION,
          piStatus,
          node: process.version,
          platform: process.platform,
          model: ctx.model,
          configKeys: configKeys(text),
          config: resolveStateConfig(() => text),
          records: logPath ? readLastRecords(logPath, REPORT_RECORDS) : [],
          home,
        });
        writePrivate(file, report);
        const shown = home && file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
        ctx.ui.notify?.(`${REPORT_COMMAND}: written to ${shown}; read it, then paste it into the issue`, "info");
      } catch (error) {
        ctx.ui.notify?.(`${REPORT_COMMAND}: could not write the report: ${(error as Error).message}`, "error");
      }
    },
  });
}
