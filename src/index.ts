import { type PluginContext } from "@lmstudio/sdk";
import { configSchematics, globalConfigSchematics } from "./configSchematics";
import { parseRepoUrlList, runInstallPass, InstallerSettings } from "./bootstrap";

export async function main(context: PluginContext) {
  context.withConfigSchematics(configSchematics);
  context.withGlobalConfigSchematics(globalConfigSchematics);

  // Kick off the install pass after the plugin finishes registering. We do
  // NOT await it — LM Studio shouldn't be blocked on git/npm while loading.
  setImmediate(() => {
    runStartupInstall(context).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[plugin-installer] startup install crashed:", err);
    });
  });
}

async function runStartupInstall(context: PluginContext): Promise<void> {
  // PluginContext shape for non-tool config reads varies across SDK minors;
  // probe for the same getter shape used by ToolsProviderController.
  const cfgAny = context as any;
  let config: any = null;
  let globalConfig: any = null;
  try {
    if (typeof cfgAny.getPluginConfig === "function") {
      config = cfgAny.getPluginConfig(configSchematics);
      globalConfig = cfgAny.getPluginConfig(globalConfigSchematics);
    }
  } catch {
    config = null;
    globalConfig = null;
  }

  if (!config || !globalConfig) {
    // eslint-disable-next-line no-console
    console.warn(
      "[plugin-installer] could not read live config from PluginContext; using defaults.",
    );
    config = mkDefaults(configSchematics);
    globalConfig = mkDefaults(globalConfigSchematics);
  }

  if (!config.get("installerEnabled")) {
    // eslint-disable-next-line no-console
    console.log("[plugin-installer] disabled in config; skipping.");
    return;
  }

  const settings: InstallerSettings = {
    allowAnyHost: config.get("allowAnyHost"),
    autoBuild: config.get("autoBuild"),
    overwriteExisting: config.get("overwriteExisting"),
    installTimeoutSec: config.get("installTimeoutSec"),
    reinstall: config.get("reinstallEverything"),
    scanDropFolder: config.get("scanDropFolder"),
    pluginsDir: globalConfig.get("pluginsDir"),
    stagingDir: globalConfig.get("stagingDir"),
    dropDir: globalConfig.get("dropDir"),
    gitCommand: globalConfig.get("gitCommand"),
    npmCommand: globalConfig.get("npmCommand"),
    lmsCommand: globalConfig.get("lmsCommand"),
  };

  const urls = parseRepoUrlList(config.get("repoUrls") ?? "");
  if (urls.length === 0 && !settings.scanDropFolder) {
    // eslint-disable-next-line no-console
    console.log("[plugin-installer] nothing to install (no URLs, drop scan off).");
    return;
  }

  // eslint-disable-next-line no-console
  const log = (line: string) => console.log("[plugin-installer]", line);
  log(`starting install pass: ${urls.length} URL(s), dropScan=${settings.scanDropFolder}`);

  const { reports } = await runInstallPass(urls, settings, log);

  const installed = reports.filter((r) => r.ok && !r.skipped);
  const skipped = reports.filter((r) => r.skipped);
  const failed = reports.filter((r) => !r.ok);

  log(
    `pass done — installed: ${installed.length}, skipped: ${skipped.length}, failed: ${failed.length}`,
  );
  for (const f of failed) {
    log(`  ✗ ${f.source} :: ${f.step ?? "?"} :: ${f.error ?? "?"}`);
  }
  for (const i of installed) {
    const p = i.installedAs;
    log(`  ✓ ${i.source}${p ? ` -> ${p.owner}/${p.name}` : ""}`);
  }
}

/**
 * Build a tiny stand-in `config` object that returns the default value for
 * each field. Used only when PluginContext doesn't expose live config reads.
 */
function mkDefaults(schematics: any): { get: (k: string) => any } {
  const defaults: Record<string, any> = {};
  const fields = schematics?.fields ?? schematics?._fields ?? [];
  for (const f of fields) {
    if (f && typeof f.key === "string") defaults[f.key] = f.defaultValue;
  }
  return { get: (k: string) => defaults[k] };
}
