# LM Studio Plugin Installer

A meta-plugin for LM Studio that lets you manage other plugins by typing
`--plugin` commands in the chat. The plugin exposes a small set of tools;
when you type a command, your model calls the matching tool and the
plugin runs `git clone` / `npm install` / `npm run build` / `lms dev -i -y`
for you, streaming the output back into the chat.

> Why is a model involved? LM Studio's first-class "plugin owns the
> chat" API (prediction loop handler) is still marked deprecated /
> in-development in the SDK and makes plugins hang in "Initializing
> plugin…". So this plugin uses the stable tools API: any modern
> instruction-tuned model will faithfully route `--plugin …` commands
> to the right tool.

---

## Quick start

1. Make sure a model is loaded in LM Studio.
2. Enable **Plugin Installer** on a chat.
3. Type:

   ```
   --plugin install https://github.com/potkolainen/LM-Multi-Online-Search-plugin
   ```

4. The model will call the `plugin_install` tool. You'll see live
   `git clone`, `npm install`, `npm run build`, `lms dev -i -y` output
   in the tool's status area, then a summary in the chat.

---

## Commands

| Command | Tool the model calls | What it does |
| --- | --- | --- |
| `--plugin help` | `plugin` | Print the built-in command list. |
| `--plugin status` | `plugin_status` | For each installed plugin, run `git ls-remote` and compare to the stored sha. Table of local sha vs upstream sha and whether an update is available. |
| `--plugin list` | `plugin_list` | List installed plugins (no network). |
| `--plugin install <url> [<url> …]` | `plugin_install` | Clone, build, and register one or more plugins. |
| `--plugin update` | `plugin_update` | Update every installed plugin that has new commits upstream. |
| `--plugin update <owner/name>` | `plugin_update` | Update one specific plugin. |
| `--plugin remove <owner/name>` | `plugin_remove` | Delete the plugin folder and forget it from state. |
| `--plugin log [N]` | `plugin_log` | Print the last N lines (default 80) of the persistent log. |
| `--plugin config` | `plugin` | Print current settings and resolved paths. |

URL forms accepted by `install`:

- `https://github.com/owner/repo`
- `https://github.com/owner/repo/tree/<branch>` — branch / tag / commit
- `git@github.com:owner/repo.git`
- Shorthand `owner/repo` or `github:owner/repo`

If your model is being clumsy about routing, you can also just ask in
plain English: *"install the plugin at https://github.com/owner/repo"*
or *"check if any of my plugins have updates"*. The tool descriptions
are written to catch those phrasings too.

---

## What you'll see

During an install/update the chat shows live status lines from the
tool's `status` channel — every `git`, `npm`, and `lms` command and its
output as it runs. When the command finishes, the model writes a
summary into the message. A sample install:

```
$ --plugin install https://github.com/potkolainen/LM-Multi-Online-Search-plugin

[potkolainen/LM-Multi-Online-Search-plugin] $ git clone --depth 1 …
[potkolainen/LM-Multi-Online-Search-plugin] Cloning into '…' …
[potkolainen/LM-Multi-Online-Search-plugin] $ npm install --no-audit --no-fund
[potkolainen/LM-Multi-Online-Search-plugin] added 42 packages in 6s
[potkolainen/LM-Multi-Online-Search-plugin] $ npm run build
[potkolainen/LM-Multi-Online-Search-plugin] $ lms dev -i -y
[potkolainen/LM-Multi-Online-Search-plugin] dev server listening on …

install done — installed: 1, updated: 0, skipped: 0, failed: 0
  ✓ https://github.com/potkolainen/LM-Multi-Online-Search-plugin -> potkolainen/LM-Multi-Online-Search-plugin
```

Failures include the failing step name and the last several lines of
its terminal output. A persistent copy of every line lives at
`<stagingDir>/install.log` (default
`~/.lmstudio/extensions/.installer/install.log`). Tail it with
`--plugin log` or any external `tail -f`.

---

## Settings

Per-chat:

| Setting | Default | Meaning |
| --- | --- | --- |
| `installerEnabled` | `true` | Master switch. When `false`, every command refuses. |
| `installTrigger` | `false` | Legacy: off→on transition runs a pass on `repoUrls` (mostly obsolete now). |
| `checkForUpdates` | `true` | Used by `--plugin status` / `--plugin update`. |
| `repoUrls` | `""` | Optional default URL list for the legacy trigger path. |
| `scanDropFolder` | `false` | Legacy: scan `dropDir` for pre-built folders. |
| `allowAnyHost` | `false` | Allow non-GitHub git hosts. |
| `autoBuild` | `true` | Run `npm install` + `npm run build` after cloning. |
| `overwriteExisting` | `true` | Pass `-y` to `lms dev -i`. |
| `reinstallEverything` | `false` | Force reinstall, ignoring cached hashes. |
| `installTimeoutSec` | `300` | Per-step timeout. |

Global:

| Setting | Default |
| --- | --- |
| `pluginsDir` | `~/.lmstudio/extensions/plugins` |
| `stagingDir` | `~/.lmstudio/extensions/.installer` (also holds `install.log`) |
| `dropDir` | `~/.lmstudio/extensions/.drop` |
| `gitCommand` / `npmCommand` / `lmsCommand` | `git` / `npm` / `lms` |
