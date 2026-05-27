import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import {
  InstallerSettings,
  runInstallPass,
} from "./bootstrap";
import {
  getRemoteHeadSha,
  parseRepoSpec,
  rmRecursive,
  LogFn,
} from "./installer";

/** Shape of installer-state.json. Mirrors `InstallerState` in bootstrap.ts. */
interface InstallerStateOnDisk {
  installed: Record<
    string,
    {
      hash: string;
      at: string;
      plugin?: { owner?: string; name?: string };
      remoteSha?: string;
    }
  >;
}

export interface CommandEnv {
  settings: InstallerSettings;
  /** Path to the persistent log file, or null if not yet known. */
  logFilePath: string | null;
}

const HELP = `Plugin Installer commands

  --plugin help                      Show this message.
  --plugin status                    List installed plugins and whether
                                     each is up to date with its GitHub
                                     source.
  --plugin list                      Just list installed plugins (no
                                     network check).
  --plugin install <url> [<url> …]   Clone, build and register one or
                                     more plugins. URLs may be the same
                                     forms as the settings field
                                     (https://github.com/owner/repo,
                                     /tree/<branch>, owner/repo, etc).
  --plugin update                    Update every installed plugin that
                                     has new commits upstream.
  --plugin update <owner/name>       Update one specific plugin.
  --plugin remove <owner/name>       Uninstall a plugin: delete its
                                     folder and forget it from state.
  --plugin log [N]                   Print the last N lines of the
                                     installer log (default 80).
  --plugin config                    Print current settings and paths.

Tip: anything that doesn't start with "--plugin" is passed straight
through to the LLM as a normal chat message.`;

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

async function readState(stagingDir: string): Promise<InstallerStateOnDisk> {
  const p = path.join(stagingDir, "installer-state.json");
  try {
    const raw = await fsp.readFile(p, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.installed) return parsed;
  } catch {
    /* missing or unreadable */
  }
  return { installed: {} };
}

async function writeState(
  stagingDir: string,
  state: InstallerStateOnDisk,
): Promise<void> {
  await fsp.mkdir(stagingDir, { recursive: true });
  const p = path.join(stagingDir, "installer-state.json");
  await fsp.writeFile(p, JSON.stringify(state, null, 2), "utf8");
}

/** Tokenise a `--plugin …` command line, respecting simple quoting. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

/** Returns true if `text` is a Plugin Installer command. */
export function isPluginCommand(text: string): boolean {
  return /^\s*--plugin(\s|$)/.test(text);
}

export async function dispatchCommand(
  text: string,
  env: CommandEnv,
  log: LogFn,
): Promise<string> {
  const tokens = tokenize(text.trim());
  // tokens[0] is "--plugin"
  const sub = (tokens[1] ?? "help").toLowerCase();
  const args = tokens.slice(2);

  switch (sub) {
    case "help":
    case "-h":
    case "--help":
    case "?":
      return HELP;

    case "list":
      return cmdList(env);

    case "status":
      return cmdStatus(env, log);

    case "install":
      if (args.length === 0)
        return "Usage: --plugin install <url> [<url> …]\n\nSee --plugin help for accepted URL forms.";
      return cmdInstall(args, env, log);

    case "update":
      return cmdUpdate(args, env, log);

    case "remove":
    case "uninstall":
    case "rm":
      if (args.length === 0)
        return "Usage: --plugin remove <owner/name>\n\nUse --plugin list to see installed names.";
      return cmdRemove(args[0], env, log);

    case "log":
      return cmdLog(args[0], env);

    case "config":
    case "settings":
      return cmdConfig(env);

    default:
      return `Unknown command: --plugin ${sub}\n\n` + HELP;
  }
}

/* ---------------- individual command implementations ---------------- */

async function cmdList(env: CommandEnv): Promise<string> {
  const state = await readState(env.settings.stagingDir);
  const entries = Object.entries(state.installed);
  if (entries.length === 0)
    return "No plugins are installed yet.\n\nUse `--plugin install <url>` to install one.";

  const rows: string[] = [];
  rows.push(
    pad("source", 38) + pad("plugin", 30) + pad("installed", 22) + "sha",
  );
  rows.push("-".repeat(96));
  for (const [key, info] of entries) {
    const source = key.startsWith("url:")
      ? key.slice(4)
      : key.startsWith("drop:")
        ? "drop:" + path.basename(key.slice(5))
        : key;
    const pluginName = info.plugin
      ? `${info.plugin.owner ?? "?"}/${info.plugin.name ?? "?"}`
      : "(unknown)";
    const installedAt = info.at?.slice(0, 19).replace("T", " ") ?? "?";
    const sha = info.remoteSha ? info.remoteSha.slice(0, 7) : "—";
    rows.push(
      pad(truncate(source, 36), 38) +
        pad(truncate(pluginName, 28), 30) +
        pad(installedAt, 22) +
        sha,
    );
  }
  rows.push("");
  rows.push(`${entries.length} plugin(s) installed.`);
  return rows.join("\n");
}

async function cmdStatus(env: CommandEnv, log: LogFn): Promise<string> {
  const state = await readState(env.settings.stagingDir);
  const entries = Object.entries(state.installed);
  if (entries.length === 0)
    return "No plugins are installed yet.\n\nUse `--plugin install <url>` to install one.";

  const lines: string[] = [];
  lines.push(
    pad("plugin", 30) +
      pad("source", 38) +
      pad("local", 10) +
      pad("upstream", 10) +
      "status",
  );
  lines.push("-".repeat(100));

  let upToDate = 0;
  let outdated = 0;
  let unknown = 0;
  for (const [key, info] of entries) {
    if (!key.startsWith("url:")) {
      // Local (drop) plugin — nothing to compare against remotely.
      lines.push(
        pad(
          truncate(
            info.plugin
              ? `${info.plugin.owner ?? "?"}/${info.plugin.name ?? "?"}`
              : "(unknown)",
            28,
          ),
          30,
        ) +
          pad(truncate(key, 36), 38) +
          pad("—", 10) +
          pad("—", 10) +
          "local",
      );
      unknown++;
      continue;
    }
    const spec = key.slice(4);
    const local = info.remoteSha ? info.remoteSha.slice(0, 7) : "?";
    let upstream = "?";
    let status = "unknown";
    try {
      const parsed = parseRepoSpec(spec, env.settings.allowAnyHost);
      const sha = await getRemoteHeadSha(
        env.settings.gitCommand,
        parsed.cloneUrl,
        parsed.ref,
        15_000,
        log,
      );
      if (!sha) {
        status = "could not reach remote";
      } else {
        upstream = sha.slice(0, 7);
        if (!info.remoteSha) {
          status = "unknown local sha";
          unknown++;
        } else if (sha === info.remoteSha) {
          status = "up to date";
          upToDate++;
        } else {
          status = "UPDATE AVAILABLE";
          outdated++;
        }
      }
    } catch (err: any) {
      status = `parse error: ${err?.message ?? err}`;
    }
    lines.push(
      pad(
        truncate(
          info.plugin
            ? `${info.plugin.owner ?? "?"}/${info.plugin.name ?? "?"}`
            : "(unknown)",
          28,
        ),
        30,
      ) +
        pad(truncate(spec, 36), 38) +
        pad(local, 10) +
        pad(upstream, 10) +
        status,
    );
  }

  lines.push("");
  lines.push(
    `${entries.length} plugin(s): ${upToDate} up to date, ${outdated} with updates available, ${unknown} unknown/local.`,
  );
  if (outdated > 0) lines.push(`Run \`--plugin update\` to install the updates.`);
  return lines.join("\n");
}

async function cmdInstall(
  urls: string[],
  env: CommandEnv,
  log: LogFn,
): Promise<string> {
  log(`--plugin install: ${urls.length} URL(s)`);
  for (const u of urls) log(`  • ${u}`);
  const settings: InstallerSettings = {
    ...env.settings,
    scanDropFolder: false, // don't scan the drop folder on an explicit install
    reinstall: false,
    checkForUpdates: false,
  };
  const { reports } = await runInstallPass(urls, settings, log);
  return summarizePass("install", reports);
}

async function cmdUpdate(
  args: string[],
  env: CommandEnv,
  log: LogFn,
): Promise<string> {
  const state = await readState(env.settings.stagingDir);
  const entries = Object.entries(state.installed).filter(([k]) =>
    k.startsWith("url:"),
  );
  if (entries.length === 0)
    return "No URL-installed plugins to update. Drop-folder plugins are not version-tracked.";

  // Resolve which plugins to update.
  let target: typeof entries;
  if (args.length === 0 || args[0].toLowerCase() === "all") {
    target = entries;
  } else {
    const wanted = args[0].toLowerCase();
    target = entries.filter(([, info]) => {
      const name =
        `${info.plugin?.owner ?? ""}/${info.plugin?.name ?? ""}`.toLowerCase();
      return name === wanted || name.endsWith("/" + wanted);
    });
    if (target.length === 0)
      return `No installed plugin matches "${args[0]}". Try \`--plugin list\`.`;
  }

  // Identify ones that actually have an upstream update.
  log(`--plugin update: checking ${target.length} plugin(s) for upstream changes`);
  const toUpdate: string[] = [];
  for (const [key, info] of target) {
    const spec = key.slice(4);
    try {
      const parsed = parseRepoSpec(spec, env.settings.allowAnyHost);
      const sha = await getRemoteHeadSha(
        env.settings.gitCommand,
        parsed.cloneUrl,
        parsed.ref,
        15_000,
        log,
      );
      if (!sha) {
        log(`  ? ${spec} — could not reach remote, skipping`);
        continue;
      }
      if (!info.remoteSha || info.remoteSha !== sha) {
        log(
          `  ↻ ${spec} — ${
            info.remoteSha ? info.remoteSha.slice(0, 7) : "?"
          } → ${sha.slice(0, 7)}`,
        );
        toUpdate.push(spec);
      } else {
        log(`  ✓ ${spec} — already at ${sha.slice(0, 7)}`);
      }
    } catch (err: any) {
      log(`  ! ${spec} — parse error: ${err?.message ?? err}`);
    }
  }

  if (toUpdate.length === 0)
    return "All checked plugins are already up to date.";

  // Force reinstall of just the outdated ones.
  const settings: InstallerSettings = {
    ...env.settings,
    scanDropFolder: false,
    reinstall: true,
    checkForUpdates: false,
  };
  const { reports } = await runInstallPass(toUpdate, settings, log);
  return summarizePass("update", reports);
}

async function cmdRemove(
  name: string,
  env: CommandEnv,
  log: LogFn,
): Promise<string> {
  const state = await readState(env.settings.stagingDir);
  const want = name.toLowerCase();
  const match = Object.entries(state.installed).find(([, info]) => {
    if (!info.plugin) return false;
    const full =
      `${info.plugin.owner ?? ""}/${info.plugin.name ?? ""}`.toLowerCase();
    return full === want || full.endsWith("/" + want);
  });
  if (!match) return `No installed plugin matches "${name}". Try \`--plugin list\`.`;
  const [key, info] = match;
  const owner = info.plugin?.owner ?? "";
  const pname = info.plugin?.name ?? "";
  // LM Studio plugin install layout: <pluginsDir>/<owner>/<name>
  const candidates = [
    path.join(env.settings.pluginsDir, owner, pname),
    path.join(env.settings.pluginsDir, pname),
    path.join(env.settings.pluginsDir, `${owner}-${pname}`),
  ].filter((p) => p && p.length > 0);

  const out: string[] = [];
  out.push(`Removing ${owner}/${pname} …`);
  let removed = false;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      log(`rm -rf ${c}`);
      await rmRecursive(c);
      out.push(`  ✓ removed ${c}`);
      removed = true;
    }
  }
  if (!removed)
    out.push(
      `  ! could not locate plugin folder under ${env.settings.pluginsDir}; you may need to remove it manually from LM Studio.`,
    );

  delete state.installed[key];
  await writeState(env.settings.stagingDir, state);
  out.push(`  ✓ removed from installer state`);
  out.push("");
  out.push(
    "Note: LM Studio may still show the plugin until you restart it or remove it from the plugin list manually.",
  );
  return out.join("\n");
}

async function cmdLog(arg: string | undefined, env: CommandEnv): Promise<string> {
  if (!env.logFilePath) return "No log file path is configured yet.";
  if (!fs.existsSync(env.logFilePath))
    return `Log file ${env.logFilePath} does not exist yet — run any install command to create it.`;
  const n = Math.max(1, Math.min(2000, parseInt(arg ?? "80", 10) || 80));
  const data = await fsp.readFile(env.logFilePath, "utf8");
  const lines = data.split(/\r?\n/);
  const tail = lines.slice(-n);
  return `Last ${tail.length} line(s) of ${env.logFilePath}:\n\n${tail.join("\n")}`;
}

function cmdConfig(env: CommandEnv): string {
  const s = env.settings;
  const lines: string[] = [];
  lines.push("Plugin Installer settings");
  lines.push("=========================");
  lines.push(`pluginsDir       : ${s.pluginsDir}`);
  lines.push(`stagingDir       : ${s.stagingDir}`);
  lines.push(`dropDir          : ${s.dropDir}`);
  lines.push(`gitCommand       : ${s.gitCommand}`);
  lines.push(`npmCommand       : ${s.npmCommand}`);
  lines.push(`lmsCommand       : ${s.lmsCommand}`);
  lines.push(`installTimeoutSec: ${s.installTimeoutSec}`);
  lines.push(`autoBuild        : ${s.autoBuild}`);
  lines.push(`allowAnyHost     : ${s.allowAnyHost}`);
  lines.push(`overwriteExisting: ${s.overwriteExisting}`);
  lines.push(`scanDropFolder   : ${s.scanDropFolder}`);
  lines.push(`checkForUpdates  : ${s.checkForUpdates}`);
  lines.push(`reinstall (force): ${s.reinstall}`);
  if (env.logFilePath) {
    lines.push("");
    lines.push(`Log file         : ${env.logFilePath}`);
  }
  return lines.join("\n");
}

function summarizePass(
  label: string,
  reports: { source: string; ok: boolean; step?: string; error?: string; installedAs?: { owner?: string; name?: string }; skipped?: string; updated?: boolean; log_tail?: string[] }[],
): string {
  const installed = reports.filter((r) => r.ok && !r.skipped);
  const updated = installed.filter((r) => r.updated);
  const skipped = reports.filter((r) => r.skipped);
  const failed = reports.filter((r) => !r.ok);

  const lines: string[] = [];
  lines.push(
    `${label} done — installed: ${installed.length}, updated: ${updated.length}, skipped: ${skipped.length}, failed: ${failed.length}`,
  );
  for (const i of installed) {
    const p = i.installedAs;
    lines.push(
      `  ✓ ${i.source}${p ? ` -> ${p.owner}/${p.name}` : ""}${i.updated ? " (updated)" : ""}`,
    );
  }
  for (const s of skipped) lines.push(`  · ${s.source} (${s.skipped})`);
  for (const f of failed) {
    lines.push(`  ✗ ${f.source}`);
    lines.push(`      step : ${f.step ?? "?"}`);
    lines.push(`      error: ${f.error ?? "?"}`);
    if (f.log_tail && f.log_tail.length) {
      lines.push(`      last output:`);
      for (const t of f.log_tail.slice(-12)) lines.push(`        | ${t}`);
    }
  }
  if (installed.length > 0) {
    lines.push("");
    lines.push(
      "New plugins are registered with LM Studio. Open a fresh chat and enable them to use their tools.",
    );
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
