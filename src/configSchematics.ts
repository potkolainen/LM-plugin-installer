import { createConfigSchematics } from "@lmstudio/sdk";
import * as os from "os";
import * as path from "path";

const DEFAULT_PLUGINS_DIR = path.join(os.homedir(), ".lmstudio", "extensions", "plugins");
const DEFAULT_STAGING_DIR = path.join(os.homedir(), ".lmstudio", "plugin-installer", "staging");
const DEFAULT_DROP_DIR = path.join(os.homedir(), ".lmstudio", "plugin-installer", "drop");

export const configSchematics = createConfigSchematics()
  .field(
    "installerEnabled",
    "boolean",
    {
      displayName: "Enable Plugin Installer",
      subtitle: "Master switch. When off, no install pass runs on startup.",
    },
    true,
  )
  .field(
    "repoUrls",
    "string",
    {
      displayName: "Plugins to install (one URL per line)",
      subtitle:
        "GitHub URLs or shorthand (owner/repo). Add /tree/<branch> to pin a branch. " +
        "On every plugin reload, new or edited entries are cloned, built, and registered.",
      isParagraph: true,
      placeholder: "https://github.com/owner/repo\nowner/another-plugin",
    } as any,
    "",
  )
  .field(
    "scanDropFolder",
    "boolean",
    {
      displayName: "Also scan the drop folder",
      subtitle:
        "If on, any subfolder of the drop folder that contains a manifest.json will be installed on startup.",
    },
    true,
  )
  .field(
    "allowAnyHost",
    "boolean",
    {
      displayName: "Allow non-GitHub hosts",
      subtitle:
        "If off, only github.com URLs may be cloned. Turn on to allow gitlab, codeberg, etc. " +
        "Leave OFF unless you trust the URL source.",
    },
    false,
  )
  .field(
    "autoBuild",
    "boolean",
    {
      displayName: "Run npm install + build",
      subtitle:
        "If the cloned repo has a package.json with a 'build' script, run npm install and npm run build before installing.",
    },
    true,
  )
  .field(
    "overwriteExisting",
    "boolean",
    {
      displayName: "Overwrite existing install",
      subtitle: "Pass -y to 'lms dev -i' so an already-installed plugin is replaced.",
    },
    true,
  )
  .field(
    "reinstallEverything",
    "boolean",
    {
      displayName: "Force reinstall on next startup",
      subtitle:
        "Ignore the state file and reinstall every URL / drop entry on the next plugin reload. " +
        "Turn off afterwards.",
    },
    false,
  )
  .field(
    "installTimeoutSec",
    "numeric",
    {
      displayName: "Install timeout per plugin (seconds)",
      subtitle: "Max time to wait for clone + build + lms install. Hard kill after this.",
      int: true,
      min: 30,
      max: 1800,
    },
    300,
  )
  .build();

export const globalConfigSchematics = createConfigSchematics()
  .field(
    "pluginsDir",
    "string",
    {
      displayName: "LM Studio plugins directory",
      subtitle: "Where installed plugins live.",
    },
    DEFAULT_PLUGINS_DIR,
  )
  .field(
    "stagingDir",
    "string",
    {
      displayName: "Staging directory",
      subtitle: "Where repos are cloned and built. The state file lives here too.",
    },
    DEFAULT_STAGING_DIR,
  )
  .field(
    "dropDir",
    "string",
    {
      displayName: "Drop folder",
      subtitle:
        "Drop plugin folders here (each containing a manifest.json). Each will be installed on startup.",
    },
    DEFAULT_DROP_DIR,
  )
  .field(
    "gitCommand",
    "string",
    {
      displayName: "git command",
      subtitle: "Override if git is not on PATH.",
    },
    "git",
  )
  .field(
    "npmCommand",
    "string",
    {
      displayName: "npm command",
      subtitle: "Override if npm is not on PATH (e.g. pnpm, yarn, bun).",
    },
    "npm",
  )
  .field(
    "lmsCommand",
    "string",
    {
      displayName: "lms command",
      subtitle: "Path to the LM Studio CLI. Used to run 'lms dev -i'.",
    },
    "lms",
  )
  .build();
