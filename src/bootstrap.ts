import * as fsp from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import {
  ensureDir,
  getRemoteHeadSha,
  parseRepoSpec,
  pathExists,
  readManifest,
  readPackageJson,
  rmRecursive,
  run,
  runLmsInstall,
  LogFn,
} from "./installer";

export interface InstallerSettings {
  allowAnyHost: boolean;
  autoBuild: boolean;
  overwriteExisting: boolean;
  installTimeoutSec: number;
  pluginsDir: string;
  stagingDir: string;
  dropDir: string;
  gitCommand: string;
  npmCommand: string;
  lmsCommand: string;
  reinstall: boolean;
  scanDropFolder: boolean;
  /** If true, run `git ls-remote` for each URL and reinstall when the upstream SHA changed. */
  checkForUpdates: boolean;
}

export interface InstallReport {
  source: string;
  ok: boolean;
  step?: string;
  error?: string;
  installedAs?: { owner?: string; name?: string };
  skipped?: "already-installed" | "up-to-date";
  updated?: boolean;
  log_tail?: string[];
}

interface InstallerState {
  /** map of source-key -> hash of last install */
  installed: Record<
    string,
    {
      hash: string;
      at: string;
      plugin?: { owner?: string; name?: string };
      /** Remote commit SHA observed at last install (for URL entries only). */
      remoteSha?: string;
    }
  >;
}

const STATE_FILE = "installer-state.json";

async function readState(stagingDir: string): Promise<InstallerState> {
  const p = path.join(stagingDir, STATE_FILE);
  if (!(await pathExists(p))) return { installed: {} };
  try {
    const raw = await fsp.readFile(p, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.installed) return parsed;
  } catch {
    /* corrupt — start fresh */
  }
  return { installed: {} };
}

async function writeState(stagingDir: string, state: InstallerState): Promise<void> {
  await ensureDir(stagingDir);
  const p = path.join(stagingDir, STATE_FILE);
  await fsp.writeFile(p, JSON.stringify(state, null, 2), "utf8");
}

function hashStr(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
}

export function parseRepoUrlList(raw: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
}

/** Install a single GitHub URL / shorthand. Returns the report plus the
 * resolved remote SHA (if we managed to look one up) so the caller can
 * record it in state for later update checks. */
async function installFromRepo(
  spec: string,
  settings: InstallerSettings,
  log: LogFn,
): Promise<{ report: InstallReport; remoteSha?: string }> {
  let parsed;
  try {
    parsed = parseRepoSpec(spec, settings.allowAnyHost);
  } catch (e: any) {
    return {
      report: { source: spec, ok: false, step: "parse", error: e?.message ?? String(e) },
    };
  }

  const timeoutMs = settings.installTimeoutSec * 1000;
  await ensureDir(settings.stagingDir);
  const targetDir = path.join(settings.stagingDir, "repos", parsed.owner, parsed.repo);
  await rmRecursive(targetDir);
  await ensureDir(path.dirname(targetDir));

  const tail: string[] = [];
  const wrappedLog: LogFn = (line) => {
    tail.push(line);
    if (tail.length > 60) tail.shift();
    log(`[${parsed.shortLabel}] ${line}`);
  };

  const cloneArgs = ["clone", "--depth", "1"];
  if (parsed.ref) cloneArgs.push("--branch", parsed.ref);
  cloneArgs.push(parsed.cloneUrl, targetDir);

  const cloneRes = await run(settings.gitCommand, cloneArgs, {
    timeoutMs,
    log: wrappedLog,
  });
  if (cloneRes.code !== 0) {
    return {
      report: {
        source: spec,
        ok: false,
        step: "git clone",
        error: `git clone exit ${cloneRes.code}${cloneRes.timedOut ? " (timeout)" : ""}`,
        log_tail: tail.slice(),
      },
    };
  }

  // Read the cloned commit SHA so we can detect upstream changes later.
  let remoteSha: string | undefined;
  const revRes = await run(settings.gitCommand, ["rev-parse", "HEAD"], {
    cwd: targetDir,
    timeoutMs,
    log: wrappedLog,
  });
  if (revRes.code === 0) {
    const sha = revRes.stdout.trim().split(/\s+/)[0];
    if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) remoteSha = sha;
  }

  const report = await finishInstall(spec, targetDir, settings, wrappedLog, tail);
  return { report, remoteSha };
}

/** Install a plugin folder that already exists on disk (drop folder entry). */
async function installFromFolder(
  folder: string,
  settings: InstallerSettings,
  log: LogFn,
): Promise<InstallReport> {
  const label = path.basename(folder);
  const tail: string[] = [];
  const wrappedLog: LogFn = (line) => {
    tail.push(line);
    if (tail.length > 60) tail.shift();
    log(`[drop:${label}] ${line}`);
  };
  return finishInstall(`drop:${folder}`, folder, settings, wrappedLog, tail);
}

async function finishInstall(
  source: string,
  workDir: string,
  settings: InstallerSettings,
  log: LogFn,
  tail: string[],
): Promise<InstallReport> {
  const manifest = await readManifest(workDir);
  if (!manifest || manifest.type !== "plugin") {
    return {
      source,
      ok: false,
      step: "validate manifest",
      error: `No valid manifest.json at ${workDir} (need type: "plugin").`,
      log_tail: tail.slice(),
    };
  }

  const pkg = await readPackageJson(workDir);
  const hasBuild = pkg?.scripts && typeof pkg.scripts.build === "string";
  const timeoutMs = settings.installTimeoutSec * 1000;

  if (settings.autoBuild && pkg) {
    const inst = await run(
      settings.npmCommand,
      ["install", "--no-audit", "--no-fund"],
      { cwd: workDir, timeoutMs, log, env: { NODE_ENV: "development" } },
    );
    if (inst.code !== 0) {
      return {
        source,
        ok: false,
        step: "npm install",
        error: `npm install exit ${inst.code}${inst.timedOut ? " (timeout)" : ""}`,
        log_tail: tail.slice(),
      };
    }
    if (hasBuild) {
      const build = await run(settings.npmCommand, ["run", "build"], {
        cwd: workDir,
        timeoutMs,
        log,
      });
      if (build.code !== 0) {
        return {
          source,
          ok: false,
          step: "npm run build",
          error: `build exit ${build.code}${build.timedOut ? " (timeout)" : ""}`,
          log_tail: tail.slice(),
        };
      }
    }
  }

  const lmsRes = await runLmsInstall(
    settings.lmsCommand,
    workDir,
    settings.overwriteExisting,
    timeoutMs,
    log,
  );
  const ok = lmsRes.detectedInstall || lmsRes.code === 0;
  if (!ok) {
    return {
      source,
      ok: false,
      step: "lms dev -i",
      error: `lms dev exit ${lmsRes.code}${lmsRes.timedOut ? " (timeout)" : ""}; install signal not detected`,
      installedAs: { owner: manifest.owner, name: manifest.name },
      log_tail: tail.slice(),
    };
  }

  return {
    source,
    ok: true,
    installedAs: { owner: manifest.owner, name: manifest.name },
    log_tail: tail.slice(-10),
  };
}

/**
 * Run one full install pass: walk the URL list and drop folder, install
 * anything whose source-hash has changed since last time (or everything if
 * `reinstall` is true). Returns per-entry reports.
 */
export async function runInstallPass(
  urls: string[],
  settings: InstallerSettings,
  log: LogFn,
): Promise<{ reports: InstallReport[]; state: InstallerState }> {
  const state = await readState(settings.stagingDir);
  const reports: InstallReport[] = [];

  // 1) URL list
  for (const spec of urls) {
    const key = `url:${spec}`;
    const hash = hashStr(spec); // re-installs if user edits the line
    const prev = state.installed[key];

    // Decide if we need to install:
    //   - user forced reinstall
    //   - never installed before
    //   - URL line text changed (hash differs)
    //   - update check is on and upstream SHA changed since last install
    let mustInstall = settings.reinstall || !prev || prev.hash !== hash;
    let updateReason: "new" | "edited" | "upstream-update" | "forced" | null = null;
    if (settings.reinstall) updateReason = "forced";
    else if (!prev) updateReason = "new";
    else if (prev.hash !== hash) updateReason = "edited";

    let latestRemoteSha: string | null = null;
    if (!mustInstall && settings.checkForUpdates && prev?.remoteSha) {
      let parsedForCheck;
      try {
        parsedForCheck = parseRepoSpec(spec, settings.allowAnyHost);
      } catch {
        parsedForCheck = null;
      }
      if (parsedForCheck) {
        latestRemoteSha = await getRemoteHeadSha(
          settings.gitCommand,
          parsedForCheck.cloneUrl,
          parsedForCheck.ref,
          Math.min(settings.installTimeoutSec * 1000, 30_000),
          (line) => log(`[${parsedForCheck!.shortLabel}] ${line}`),
        );
        if (latestRemoteSha && latestRemoteSha !== prev.remoteSha) {
          mustInstall = true;
          updateReason = "upstream-update";
          log(
            `↻ upstream update for ${spec}: ${prev.remoteSha.slice(0, 7)} → ${latestRemoteSha.slice(0, 7)}`,
          );
        }
      }
    }

    if (!mustInstall) {
      reports.push({
        source: spec,
        ok: true,
        skipped: settings.checkForUpdates ? "up-to-date" : "already-installed",
      });
      continue;
    }

    log(`→ installing from URL (${updateReason}): ${spec}`);
    const { report, remoteSha } = await installFromRepo(spec, settings, log);
    if (updateReason === "upstream-update") report.updated = true;
    reports.push(report);
    if (report.ok) {
      state.installed[key] = {
        hash,
        at: new Date().toISOString(),
        plugin: report.installedAs,
        remoteSha: remoteSha ?? latestRemoteSha ?? prev?.remoteSha,
      };
    }
  }

  // 2) Drop folder
  if (settings.scanDropFolder && (await pathExists(settings.dropDir))) {
    const entries = await fsp.readdir(settings.dropDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const folder = path.join(settings.dropDir, e.name);
      const manifest = await readManifest(folder);
      if (!manifest || manifest.type !== "plugin") continue;
      const key = `drop:${folder}`;
      // Hash the manifest contents so edits trigger reinstall.
      const manifestRaw = await fsp.readFile(path.join(folder, "manifest.json"), "utf8");
      const pkgRaw = (await pathExists(path.join(folder, "package.json")))
        ? await fsp.readFile(path.join(folder, "package.json"), "utf8")
        : "";
      const hash = hashStr(manifestRaw + "|" + pkgRaw);
      const prev = state.installed[key];
      if (!settings.reinstall && prev && prev.hash === hash) {
        reports.push({ source: `drop:${e.name}`, ok: true, skipped: "already-installed" });
        continue;
      }
      log(`→ installing from drop folder: ${e.name}`);
      const report = await installFromFolder(folder, settings, log);
      reports.push(report);
      if (report.ok) {
        state.installed[key] = {
          hash,
          at: new Date().toISOString(),
          plugin: report.installedAs,
        };
      }
    }
  } else if (settings.scanDropFolder) {
    // Create the drop folder so the user can see where to put things.
    await ensureDir(settings.dropDir);
  }

  // 3) Prune state entries that no longer correspond to a configured source.
  const validKeys = new Set<string>();
  for (const u of urls) validKeys.add(`url:${u}`);
  if (settings.scanDropFolder && (await pathExists(settings.dropDir))) {
    const entries = await fsp.readdir(settings.dropDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) validKeys.add(`drop:${path.join(settings.dropDir, e.name)}`);
    }
  }
  for (const key of Object.keys(state.installed)) {
    if (!validKeys.has(key)) delete state.installed[key];
  }

  await writeState(settings.stagingDir, state);
  return { reports, state };
}
