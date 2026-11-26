#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { persistentToken, privateDirectory } from "./tmux-credentials.mjs";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authorizeTmuxWindow } from "../dist/tmuxOps.js";

const SHELL_RE = /^(?:-)?(?:bash|sh|dash|zsh|fish|ksh|csh|tcsh|ash|nu|nushell|xonsh|pwsh|powershell|cmd(?:\.exe)?|login|sudo|su|tmux|busybox)(?:\.exe)?$/i;
const STATE_DIR = path.join(os.homedir(), ".codexpro", "tmux-instances");
const DEFAULT_BASE_PORT = 8788;
const CREDENTIAL_DIR = path.join(os.homedir(), ".codexpro", "tmux-credentials");

function usage(commandName) {
  console.log(`Usage: ${commandName} [--read-only] [--local] [--port <port>]

Run in a shell pane inside the target tmux window (foreground keepalive).
- Authorizes the current tmux window (excluding this launcher pane)
- Replaces an existing instance for the same directory and window only
- Reuses its persistent local token (explicit rotate command changes it)
- Prints the window's panes and the MCP Server URL (Cloudflare Quick Tunnel by default)

Options:
  --read-only     Disable tmux_send_message (read-only mode)
  --local         Use local HTTP only (--tunnel none) instead of Cloudflare Quick Tunnel
  --port <port>   Preferred starting local port (default: ${DEFAULT_BASE_PORT})
  -h, --help      Show this help`);
}

function parseOptions(argv) {
  let readOnly = false;
  let localOnly = false;
  let preferredPort = Number(process.env.CODEXPRO_PORT || DEFAULT_BASE_PORT);
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--read-only") readOnly = true;
    else if (arg === "--local") localOnly = true;
    else if (arg === "-h" || arg === "--help") help = true;
    else if (arg === "--port") {
      const next = argv[++i];
      preferredPort = Number(next);
    } else if (arg.startsWith("--port=")) {
      preferredPort = Number(arg.slice("--port=".length));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(preferredPort) || preferredPort < 1024 || preferredPort > 65535) {
    throw new Error(`Invalid port: ${preferredPort}`);
  }
  return { readOnly, localOnly, preferredPort, help };
}

function instanceKey(cwd) { return createHash("sha256").update(cwd).digest("hex").slice(0, 16); }
function stateFileForCwd(cwd) { return path.join(STATE_DIR, `${instanceKey(cwd)}.json`); }
function previousState(cwd) {
  try { return JSON.parse(fs.readFileSync(stateFileForCwd(cwd), "utf8")); }
  catch (err) { if (err.code === "ENOENT") return undefined; throw new Error("Invalid instance state; inspect it locally before restarting."); }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pidLooksLikeCodexpro(pid) {
  if (!isPidAlive(pid)) return false;
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    return cmdline.includes("codexpro");
  } catch {
    const res = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
    return res.status === 0 && res.stdout.includes("codexpro");
  }
}

async function terminatePid(pid, label) {
  if (!pidLooksLikeCodexpro(pid)) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  console.error(`[codexpro_tmux] Force-stopped ${label} (pid ${pid}).`);
  return true;
}

async function replaceExistingCwdInstance(cwd, scope) {
  const statePath = stateFileForCwd(cwd);
  if (!fs.existsSync(statePath)) return;
  let prev;
  try {
    prev = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    fs.rmSync(statePath, { force: true });
    return;
  }
  if (!prev || prev.cwd !== cwd) throw new Error("Instance state directory mismatch.");
  if ((isPidAlive(prev.pid) || isPidAlive(prev.childPid)) && (prev.window !== scope.window || (prev.socket && prev.socket !== scope.socket) || (prev.serverPid && prev.serverPid !== scope.serverPid))) throw new Error("Existing instance belongs to another tmux window; stop it locally before starting here.");

  const stoppedParent = await terminatePid(Number(prev.pid), "previous launcher");
  const stoppedChild = await terminatePid(Number(prev.childPid), "previous server");
  if (stoppedParent || stoppedChild) {
    console.error(`[codexpro_tmux] Replaced previous instance for ${cwd} (port ${prev.port ?? "?"}).`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fs.rmSync(statePath, { force: true });
}

function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", () => resolve(false));
    srv.listen(port, host, () => {
      srv.close(() => resolve(true));
    });
  });
}

async function findFreePort(startPort) {
  for (let port = startPort; port <= 65535; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free local port found starting from ${startPort}.`);
}

function isPortListening(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(300);
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

function listWindowPanes(scope) {
  const args = [
    ...(scope.socket ? ["-S", scope.socket] : []),
    "list-panes",
    "-t",
    scope.window,
    "-F",
    ["#{pane_id}", "#{pane_current_command}", "#{pane_current_path}", "#{pane_in_mode}", "#{pane_dead}"].join("\t")
  ];
  const res = spawnSync("tmux", args, { encoding: "utf8", timeout: 4000 });
  if (res.status !== 0) return [];
  return res.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pane, command, cwd, inMode, dead] = line.split("\t");
      let role = "agent";
      if (pane === scope.anchor) role = "launcher (excluded)";
      else if (dead !== "0") role = "dead (excluded)";
      else if (SHELL_RE.test(path.basename(command || ""))) role = "shell (start agent to use)";
      else if (inMode !== "0") role = "agent (copy_mode)";
      return { pane, command, cwd, role };
    });
}

function printSummary({ scope, port, serverUrl, readOnly, rotateToken }) {
  const panes = listWindowPanes(scope);
  console.log("");
  console.log("================ CodexPro TMUX Ready ================");
  console.log(`Window : ${scope.window}  (anchor: ${scope.anchor})`);
  console.log(`CWD    : ${fs.realpathSync(process.cwd())}`);
  console.log(`Local  : http://127.0.0.1:${port}/mcp`);
  console.log(`Access : ${readOnly ? "read-only" : "read + send enabled"}${rotateToken ? " (token rotated)" : ""}`);
  console.log(`URL    : ${serverUrl}`);
  console.log("");
  console.log(`Panes in ${scope.window}:`);
  if (!panes.length) {
    console.log("  (none found)");
  } else {
    for (const p of panes) {
      console.log(`  ${p.pane.padEnd(5)} [${p.role}]  ${p.command}  ${p.cwd}`);
    }
  }
  console.log("-----------------------------------------------------");
  console.log("Foreground keepalive active. Press Ctrl+C to stop.");
  console.log("=====================================================");
}

export async function runCodexproTmux({ rotateToken = false, argv = process.argv.slice(2), commandName = rotateToken ? "codexpro_tmux_rotate" : "codexpro_tmux" } = {}) {
  const opts = parseOptions(argv);
  if (opts.help) {
    usage(commandName);
    return;
  }

  const scope = authorizeTmuxWindow(process.env.TMUX_PANE ?? "");
  const cwd = fs.realpathSync(process.cwd());
  privateDirectory(STATE_DIR);
  const previous = previousState(cwd);
  const active = Boolean(previous && (isPidAlive(previous.pid) || isPidAlive(previous.childPid)));
  if (active && (previous.cwd !== cwd || previous.window !== scope.window || (previous.socket && previous.socket !== scope.socket) || (previous.serverPid && previous.serverPid !== scope.serverPid))) {
    throw new Error("Existing instance belongs to another tmux window; stop it locally before starting here.");
  }
  // Never change a legacy live token silently. Import it before stopping the old launcher.
  const token = persistentToken(CREDENTIAL_DIR, instanceKey(cwd), { initialToken: process.env.CODEXPRO_HTTP_TOKEN?.trim(), rotate: rotateToken, legacyRunning: active });
  await replaceExistingCwdInstance(cwd, scope);
  const preferred = Number.isInteger(previous?.port) && !argv.some(arg => arg === "--port" || arg.startsWith("--port=")) ? previous.port : opts.preferredPort;
  const port = await findFreePort(preferred);

  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const codexproEntry = fileURLToPath(new URL("./codexpro.mjs", import.meta.url));
  const childArgs = [
    codexproEntry,
    "start",
    "--root",
    repoRoot,
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
    "--write",
    "off",
    "--no-bash",
    "--codex-sessions",
    "off",
    "--headless"
  ];
  if (opts.localOnly) childArgs.push("--tunnel", "none");

  const env = {
    ...process.env,
    CODEXPRO_TMUX_ONLY: "1",
    CODEXPRO_TMUX_AGENTS: "",
    CODEXPRO_TMUX_WINDOW: JSON.stringify(scope),
    CODEXPRO_TMUX_ALLOW_SEND: opts.readOnly ? "0" : "1",
    CODEXPRO_HTTP_TOKEN: token,
    CODEXPRO_PORT: String(port),
    CODEXPRO_HOST: "127.0.0.1"
  };
  const hasProxy = Boolean(env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy);
  if (!opts.localOnly && !hasProxy && await isPortListening(7890)) {
    env.HTTPS_PROXY = "http://127.0.0.1:7890";
  }

  console.error(`CodexPro TMUX: authorizing window ${scope.window} (anchor ${scope.anchor}, cwd ${cwd}, port ${port})`);

  const child = spawn(process.execPath, childArgs, {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "inherit"]
  });

  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const statePath = stateFileForCwd(cwd);
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      pid: process.pid,
      childPid: child.pid ?? null,
      cwd,
      window: scope.window,
      socket: scope.socket,
      serverPid: scope.serverPid,
      anchor: scope.anchor,
      port,
      startedAt: new Date().toISOString()
    }, null, 2),
    { mode: 0o600 }
  );

  const removeOwnState = () => {
    try {
      const current = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (current?.pid === process.pid) fs.rmSync(statePath, { force: true });
    } catch {}
  };

  let stopping = false;
  const shutdown = (signal, exitCode) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = exitCode;
    try {
      child.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
    } catch {}
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      removeOwnState();
      process.exit(exitCode);
    }, 3000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT", 130));
  process.on("SIGTERM", () => shutdown("SIGTERM", 143));
  process.on("SIGHUP", () => shutdown("SIGHUP", 129));

  let buffer = "";
  let printedSummary = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("CODEXPRO_READY ") && !printedSummary) {
        printedSummary = true;
        const serverUrl = line.slice("CODEXPRO_READY ".length).trim();
        printSummary({ scope, port, serverUrl, readOnly: opts.readOnly, rotateToken });
      } else {
        console.log(line);
      }
    }
  });

  await new Promise((resolve) => {
    child.on("error", (error) => {
      console.error(error.message);
      removeOwnState();
      process.exitCode = 1;
      resolve();
    });
    child.on("exit", (code, signal) => {
      if (buffer) console.log(buffer);
      removeOwnState();
      if (!stopping) process.exitCode = code ?? (signal ? 1 : 0);
      resolve();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  runCodexproTmux().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
