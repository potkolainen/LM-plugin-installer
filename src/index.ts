import { type PluginContext, ChatMessage, tool } from "@lmstudio/sdk";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import {
  configSchematics,
  globalConfigSchematics,
} from "./configSchematics";
import {
  InstallerSettings,
} from "./bootstrap";
import {
  CommandEnv,
  dispatchCommand,
} from "./commands";
import { LogFn } from "./installer";

let logFilePath: string | null = null;

function appendLogFile(line: string) {
  if (!logFilePath) return;
  try {
    fs.appendFileSync(logFilePath, line + "\n");
  } catch {
    /* ignore */
  }
}

function bgLog(line: string) {
  // eslint-disable-next-line no-console
  console.log("[plugin-installer]", line);
  appendLogFile(`${new Date().toISOString()} ${line}`);
}

function buildEnv(ctl: any): CommandEnv {
  const cfg = ctl.getPluginConfig(configSchematics);
  const gc = ctl.getGlobalPluginConfig(globalConfigSchematics);

  const stagingDir: string = gc.get("stagingDir");
  try {
    fs.mkdirSync(stagingDir, { recursive: true });
  } catch {
    /* ignore */
  }
  logFilePath = path.join(stagingDir, "install.log");

  const settings: InstallerSettings = {
    allowAnyHost: cfg.get("allowAnyHost"),
    autoBuild: cfg.get("autoBuild"),
    overwriteExisting: cfg.get("overwriteExisting"),
    installTimeoutSec: cfg.get("installTimeoutSec"),
    reinstall: !!cfg.get("reinstallEverything"),
    scanDropFolder: cfg.get("scanDropFolder"),
    checkForUpdates: cfg.get("checkForUpdates"),
    pluginsDir: gc.get("pluginsDir"),
    stagingDir,
    dropDir: gc.get("dropDir"),
    gitCommand: gc.get("gitCommand"),
    npmCommand: gc.get("npmCommand"),
    lmsCommand: gc.get("lmsCommand"),
  };

  return {
    settings,
    logFilePath,
  };
}

export async function main(context: PluginContext) {
  context.withConfigSchematics(configSchematics);
  context.withGlobalConfigSchematics(globalConfigSchematics);

  // Prompt preprocessor: when the user types a `--plugin …` line, replace
  // the message the LLM sees with a tight, no-think directive that forces
  // an immediate tool call. This cuts the "thinking" phase from ~10–30s
  // down to near-zero on most instruction-tuned models.
  context.withPromptPreprocessor(async (_ctl, userMessage) => {
    let text = "";
    try {
      text = userMessage.getText();
    } catch {
      return userMessage;
    }
    const trimmed = text.trim();
    if (!/^--plugin(\s|$)/.test(trimmed)) return userMessage;

    const cmd = trimmed;
    // /no_think is a Qwen3 directive but harmless on other models;
    // combined with the explicit instructions below, instruction-tuned
    // models call the tool with no deliberation.
    const fast =
      `/no_think\n` +
      `SYSTEM: The user invoked a Plugin Installer command. You MUST ` +
      `immediately call the \`plugin\` tool with parameter ` +
      `command="${cmd.replace(/"/g, '\\"')}". Do not think. Do not write any ` +
      `text before the tool call. Do not paraphrase. After the tool ` +
      `returns, output its result verbatim inside a fenced code block ` +
      `and nothing else.\n\n` +
      `User message: ${cmd}`;

    return ChatMessage.create("user", fast);
  });

  context.withToolsProvider(async (ctl) => {
    // Pre-resolve log file so background bgLog has somewhere to write.
    try {
      const gc = ctl.getGlobalPluginConfig(globalConfigSchematics);
      const stagingDir = gc.get("stagingDir");
      try {
        fs.mkdirSync(stagingDir, { recursive: true });
      } catch {
        /* ignore */
      }
      logFilePath = path.join(stagingDir, "install.log");
      bgLog(`tools provider attached, log=${logFilePath}`);
    } catch {
      /* ignore */
    }

    // One generic command tool — matches the chat grammar the user types.
    const pluginTool = tool({
      name: "plugin",
      description:
        "Plugin Installer command runner. The user drives this plugin by " +
        "typing chat messages that start with `--plugin`, e.g. " +
        "`--plugin status`, `--plugin install <url>`, `--plugin update`, " +
        "`--plugin list`, `--plugin remove <owner/name>`, `--plugin log`, " +
        "`--plugin help`. " +
        "WHENEVER the user's message starts with `--plugin`, call this " +
        "tool with `command` set to the user's full message text, then " +
        "reply to the user with the tool's output verbatim inside a " +
        "fenced code block — do not paraphrase. Streams live " +
        "git/npm/lms output via tool status, returns a summary string.",
      parameters: {
        command: z
          .string()
          .describe(
            "The full `--plugin …` command line the user typed, " +
              "verbatim (e.g. `--plugin install https://github.com/owner/repo`).",
          ),
      },
      implementation: async ({ command }, toolCtx) => {
        let env: CommandEnv;
        try {
          env = buildEnv(ctl);
        } catch (err: any) {
          return `Plugin Installer: failed to read config — ${err?.message ?? err}`;
        }

        const cfg = ctl.getPluginConfig(configSchematics);
        if (!cfg.get("installerEnabled")) {
          return "Plugin Installer is disabled in settings. Turn on 'Enable Plugin Installer' and try again.";
        }

        const streamLog: LogFn = (line) => {
          try {
            toolCtx.status(line);
          } catch {
            /* ignore */
          }
          bgLog(line);
        };

        toolCtx.status(`$ ${command.trim()}`);
        try {
          const out = await dispatchCommand(command, env, streamLog);
          return out;
        } catch (err: any) {
          const msg = `Command crashed: ${err?.stack ?? err?.message ?? String(err)}`;
          bgLog(msg);
          return msg;
        }
      },
    });

    // Explicit per-subcommand tools — some models route better to a
    // specific tool name than to a freeform "command" string.
    const installTool = tool({
      name: "plugin_install",
      description:
        "Install one or more LM Studio plugins from GitHub URLs. " +
        "Call this when the user types `--plugin install <url> [<url> …]` " +
        "or asks to 'install plugin <url>'. Streams live git/npm/lms output.",
      parameters: {
        urls: z
          .array(z.string())
          .min(1)
          .describe("Repo URLs to install (https or owner/repo)."),
      },
      implementation: async ({ urls }, toolCtx) => {
        const env = buildEnv(ctl);
        const streamLog: LogFn = (line) => {
          try {
            toolCtx.status(line);
          } catch {
            /* ignore */
          }
          bgLog(line);
        };
        return dispatchCommand(
          `--plugin install ${urls.join(" ")}`,
          env,
          streamLog,
        );
      },
    });

    const statusTool = tool({
      name: "plugin_status",
      description:
        "Show installed plugins and whether each is up to date with its " +
        "GitHub source. Call this when the user types `--plugin status` " +
        "or asks 'are there updates for my plugins?'.",
      parameters: {},
      implementation: async (_p, toolCtx) => {
        const env = buildEnv(ctl);
        const streamLog: LogFn = (line) => {
          try {
            toolCtx.status(line);
          } catch {
            /* ignore */
          }
          bgLog(line);
        };
        return dispatchCommand(`--plugin status`, env, streamLog);
      },
    });

    const updateTool = tool({
      name: "plugin_update",
      description:
        "Update installed plugins that have new commits upstream. Call " +
        "this when the user types `--plugin update` (optionally with a " +
        "specific owner/name to target).",
      parameters: {
        target: z
          .string()
          .optional()
          .describe(
            "Optional owner/name. If omitted, every URL-installed plugin is checked.",
          ),
      },
      implementation: async ({ target }, toolCtx) => {
        const env = buildEnv(ctl);
        const streamLog: LogFn = (line) => {
          try {
            toolCtx.status(line);
          } catch {
            /* ignore */
          }
          bgLog(line);
        };
        const cmd = target ? `--plugin update ${target}` : `--plugin update`;
        return dispatchCommand(cmd, env, streamLog);
      },
    });

    const listTool = tool({
      name: "plugin_list",
      description:
        "List installed plugins (no network check). Call this for " +
        "`--plugin list` or 'show installed plugins'.",
      parameters: {},
      implementation: async (_p) => {
        const env = buildEnv(ctl);
        return dispatchCommand(`--plugin list`, env, () => {});
      },
    });

    const removeTool = tool({
      name: "plugin_remove",
      description:
        "Uninstall a plugin by owner/name (or just name). Call this for " +
        "`--plugin remove <name>` / 'uninstall plugin <name>'.",
      parameters: {
        name: z
          .string()
          .describe("owner/name or bare name of the plugin to remove."),
      },
      implementation: async ({ name }, toolCtx) => {
        const env = buildEnv(ctl);
        const streamLog: LogFn = (line) => {
          try {
            toolCtx.status(line);
          } catch {
            /* ignore */
          }
          bgLog(line);
        };
        return dispatchCommand(`--plugin remove ${name}`, env, streamLog);
      },
    });

    const logTool = tool({
      name: "plugin_log",
      description:
        "Print the tail of the persistent installer log file. Call this " +
        "for `--plugin log`.",
      parameters: {
        lines: z
          .number()
          .optional()
          .describe("Number of lines to return (default 80)."),
      },
      implementation: async ({ lines }) => {
        const env = buildEnv(ctl);
        const cmd = lines ? `--plugin log ${lines}` : `--plugin log`;
        return dispatchCommand(cmd, env, () => {});
      },
    });

    return [
      pluginTool,
      installTool,
      statusTool,
      updateTool,
      listTool,
      removeTool,
      logTool,
    ];
  });
}
