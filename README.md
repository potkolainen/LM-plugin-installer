# LM Studio Plugin Installer

A meta-plugin for LM Studio that installs other plugins automatically.
**No AI / chat is involved** — the install pass runs on plugin startup based
on the plugin's config and a drop folder.

## Two ways to install a plugin

### 1. Add a GitHub URL

Open the plugin's **per-chat config** (the gear icon next to *Plugin
Installer* in LM Studio). In the **Plugins to install** field, paste one
URL per line:

```
https://github.com/owner/repo
https://github.com/owner/another-plugin/tree/dev
yet-another/plugin
```

Save the config. The next time the plugin loads (toggle it off → on, or
run `lms dev -i -y` from this folder), each new or edited line is cloned,
built, and registered with LM Studio.

Accepted forms:

- `https://github.com/owner/repo`
- `https://github.com/owner/repo/tree/<branch>` — branch / tag / commit
- `git@github.com:owner/repo.git`
- Shorthand: `owner/repo` or `github:owner/repo`
- Lines starting with `#` are ignored

### 2. Drop a folder

Put a full plugin folder (one that already contains a `manifest.json`) into
the **drop folder**. Default location:

```
~/.lmstudio/plugin-installer/drop/<your-plugin>/
```

On startup the plugin scans the drop folder, and for every subfolder that
looks like an LM Studio plugin it runs `npm install` + `npm run build`
(if applicable) then `lms dev -i -y` to register it.

Edits to `manifest.json` or `package.json` inside the dropped folder will
trigger a re-install on the next plugin reload.

## State & de-duplication

A small `installer-state.json` file in the staging directory records what
has already been installed (hashed by URL line or manifest+package.json).
On each startup only changed / new entries are re-installed. To force a
full re-install, enable **Force reinstall on next startup** in config.

State entries for URLs you remove from the list (or folders you remove
from the drop directory) are pruned automatically.

## Configuration

Per-chat:

| Field | Default | What it does |
|---|---|---|
| `installerEnabled` | on | Master switch. |
| `repoUrls` | empty | One URL per line. Comma-separated also works. |
| `scanDropFolder` | on | Also install anything found in the drop folder. |
| `allowAnyHost` | off | Permit non-github.com hosts (GitLab, Codeberg, etc.). |
| `autoBuild` | on | Run `npm install` + `npm run build` if a build script exists. |
| `overwriteExisting` | on | Pass `-y` to `lms dev -i`. |
| `reinstallEverything` | off | Ignore state and reinstall everything once. |
| `installTimeoutSec` | 300 | Hard kill any clone/build/install after this. |

Global:

| Field | Default |
|---|---|
| `pluginsDir` | `~/.lmstudio/extensions/plugins` |
| `stagingDir` | `~/.lmstudio/plugin-installer/staging` |
| `dropDir` | `~/.lmstudio/plugin-installer/drop` |
| `gitCommand` | `git` |
| `npmCommand` | `npm` |
| `lmsCommand` | `lms` |

## How install works under the hood

LM Studio's CLI has no native "install from git URL" command. The supported
local-install flow is `lms dev -i -y` from inside a plugin folder. This
plugin automates that:

1. `git clone --depth 1` (optionally `--branch <ref>`) into the staging dir.
2. If `package.json` exists with a `build` script: `npm install` then
   `npm run build` (toggle with `autoBuild`).
3. `lms dev -i -y` inside the plugin folder.

`lms dev` normally stays alive as a dev server; this plugin watches its
output for an install / ready signal and SIGKILLs it once the install is
confirmed, with `installTimeoutSec` as a backstop.

Per-plugin failures are isolated — one bad URL won't stop the rest of the
pass. Output goes to LM Studio's plugin log (look for `[plugin-installer]`).

## Requirements

`git`, `npm`, and the `lms` CLI must be on `PATH` (or set absolute paths
in the global config).

## Build & install (this plugin itself)

```bash
cd "plugin-installer"
npm install
npm run build
lms dev -i -y
```

## Security notes

Cloning and building a plugin runs **arbitrary code** from the repo and
its npm dependencies the moment `npm install` runs. Only install plugins
from sources you trust.

The host allowlist (`allowAnyHost = false` by default) blocks accidental
clones from non-GitHub hosts but is not a sandbox.
