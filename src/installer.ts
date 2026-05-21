import { spawn } from "child_process";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

export type LogFn = (line: string) => void;

export interface RunOptions {
  cwd?: string;
  timeoutMs: number;
  log: LogFn;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Spawn a command, stream output to log(), capture stdout/stderr, enforce a timeout. */
export function run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    opts.log(`$ ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      stdout += s;
      for (const line of s.split(/\r?\n/)) if (line) opts.log(line);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString();
      stderr += s;
      for (const line of s.split(/\r?\n/)) if (line) opts.log(line);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      opts.log(`! timeout after ${opts.timeoutMs}ms — killing ${cmd}`);
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += String(err);
      opts.log(`! spawn error: ${String(err)}`);
      resolve({ code: null, signal: null, stdout, stderr, timedOut });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

/**
 * Run `lms dev -i -y` from `cwd`. `lms dev` normally stays running as a dev
 * server after install. We watch its output for an "installed" signal and
 * then kill it so the tool call can return.
 */
export function runLmsInstall(
  lmsCmd: string,
  cwd: string,
  overwrite: boolean,
  timeoutMs: number,
  log: LogFn,
): Promise<RunResult & { detectedInstall: boolean }> {
  return new Promise((resolve) => {
    const args = ["dev", "-i"];
    if (overwrite) args.push("-y");
    log(`$ ${lmsCmd} ${args.join(" ")}  (cwd=${cwd})`);

    const child = spawn(lmsCmd, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let detectedInstall = false;
    let timedOut = false;
    let settled = false;

    const INSTALL_PATTERNS = [
      /installed/i,
      /ready/i,
      /dev server/i,
      /listening on/i,
      /watching/i,
    ];

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try {
        if (!child.killed) child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve({ code, signal, stdout, stderr, timedOut, detectedInstall });
    };

    const onChunk = (s: string, isErr: boolean) => {
      if (isErr) stderr += s;
      else stdout += s;
      for (const line of s.split(/\r?\n/)) if (line) log(line);
      if (!detectedInstall && INSTALL_PATTERNS.some((re) => re.test(s))) {
        detectedInstall = true;
        log("✓ install signal detected — stopping lms dev");
        // Give it a moment to flush, then kill.
        setTimeout(() => finish(0, null), 750);
      }
    };

    child.stdout?.on("data", (c: Buffer) => onChunk(c.toString(), false));
    child.stderr?.on("data", (c: Buffer) => onChunk(c.toString(), true));

    const hardTimer = setTimeout(() => {
      timedOut = true;
      log(`! lms dev install timeout after ${timeoutMs}ms`);
      finish(null, "SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      stderr += String(err);
      log(`! lms spawn error: ${String(err)}`);
      finish(null, null);
    });

    child.on("close", (code, signal) => finish(code, signal));
  });
}

export interface ParsedRepo {
  host: string;
  owner: string;
  repo: string;
  ref?: string;
  cloneUrl: string;
  shortLabel: string; // owner/repo
}

/**
 * Accepts forms like:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo/tree/branch
 *   git@github.com:owner/repo.git
 *   owner/repo
 *   github:owner/repo
 */
export function parseRepoSpec(input: string, allowAnyHost: boolean): ParsedRepo {
  const raw = input.trim();
  if (!raw) throw new Error("Empty repo spec");

  // Shorthand: owner/repo or github:owner/repo
  const short = raw.replace(/^github:/i, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(short)) {
    const [owner, repo] = short.split("/");
    return {
      host: "github.com",
      owner,
      repo: repo.replace(/\.git$/, ""),
      cloneUrl: `https://github.com/${owner}/${repo.replace(/\.git$/, "")}.git`,
      shortLabel: `${owner}/${repo.replace(/\.git$/, "")}`,
    };
  }

  // SCP-style git URL: git@host:owner/repo(.git)
  const scp = raw.match(/^git@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (scp) {
    const [, host, owner, repo] = scp;
    if (!allowAnyHost && host.toLowerCase() !== "github.com") {
      throw new Error(`Host ${host} blocked. Enable "Allow non-GitHub hosts" in plugin config.`);
    }
    return {
      host,
      owner,
      repo,
      cloneUrl: `git@${host}:${owner}/${repo}.git`,
      shortLabel: `${owner}/${repo}`,
    };
  }

  // Full URL
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Unrecognized repo spec: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  if (!allowAnyHost && url.hostname.toLowerCase() !== "github.com") {
    throw new Error(
      `Host ${url.hostname} blocked. Enable "Allow non-GitHub hosts" in plugin config to install from it.`,
    );
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error(`URL missing owner/repo: ${raw}`);
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, "");
  let ref: string | undefined;
  // /owner/repo/tree/<ref>/...
  if (parts[2] === "tree" && parts[3]) {
    ref = decodeURIComponent(parts.slice(3).join("/"));
  }
  return {
    host: url.hostname,
    owner,
    repo,
    ref,
    cloneUrl: `https://${url.hostname}/${owner}/${repo}.git`,
    shortLabel: `${owner}/${repo}`,
  };
}

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export async function rmRecursive(target: string): Promise<void> {
  await fsp.rm(target, { recursive: true, force: true });
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export interface PluginManifest {
  type?: string;
  runner?: string;
  owner?: string;
  name?: string;
  revision?: number;
}

export async function readManifest(dir: string): Promise<PluginManifest | null> {
  const p = path.join(dir, "manifest.json");
  if (!(await pathExists(p))) return null;
  try {
    const raw = await fsp.readFile(p, "utf8");
    return JSON.parse(raw) as PluginManifest;
  } catch {
    return null;
  }
}

export async function readPackageJson(dir: string): Promise<any | null> {
  const p = path.join(dir, "package.json");
  if (!(await pathExists(p))) return null;
  try {
    return JSON.parse(await fsp.readFile(p, "utf8"));
  } catch {
    return null;
  }
}
