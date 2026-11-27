#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { persistentToken, privateDirectory } from "./tmux-credentials.mjs";
import { readExternalEndpoint, externalServerUrl, configureExternalEndpoint, selectLaunchEndpoint } from "./tmux-endpoint.mjs";
import { instanceLock, controlPath, writePrivateJson } from "./tmux-lifecycle.mjs";
import { selectedRelease, superviseExternal, assertWindowBackendCompatible } from "./tmux-supervisor.mjs";
import { prepareWindows, runWindowCommand, windowsFileFor } from "./tmux-windows.mjs";
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
const ENDPOINT_FILE = path.join(os.homedir(), ".codexpro", "tmux-endpoint.json");
const RELEASE_DIR = path.join(os.homedir(), ".codexpro", "tmux-releases");

function usage(commandName) {
  console.log(`Usage: ${commandName} [--read-only] [--local | --quick-tunnel] [--port <port>]
       codexpro_tmux setup <hostname> [--port <port>]
       codexpro_tmux add | remove | list | status  (fixed endpoint; local only)

Run in a shell pane inside the target tmux window (foreground keepalive).
- Initially authorizes the current tmux window (excluding this launcher pane)
- Fixed endpoint: add/remove the current window locally; list/status show the active scope
- Uses the saved fixed domain from any directory; temporary tunnels are opt-in
- Replaces an existing instance for the same identity and window only
- Reuses its persistent local token (explicit rotate command changes it)
- Prints the window's panes and the MCP Server URL (externally managed tunnel when configured)
- The configured external endpoint has a fixed port and is never managed by this launcher

Options:
  --read-only     Disable tmux_send_message (read-only mode)
  --local         Start an explicitly separate local HTTP instance
  --quick-tunnel  Start an explicitly separate temporary Cloudflare tunnel
  --port <port>   Preferred starting local port (default: ${DEFAULT_BASE_PORT})
  -h, --help      Show this help`);
}

function parseOptions(argv) {
  let readOnly = false;
  let localOnly = false;
  let quickTunnel = false;
  let preferredPort = Number(process.env.CODEXPRO_PORT || DEFAULT_BASE_PORT);
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--read-only") readOnly = true;
    else if (arg === "--local") localOnly = true;
    else if (arg === "--quick-tunnel") quickTunnel = true;
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
  return { readOnly, localOnly, quickTunnel, preferredPort, help };
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

async function findFreePort(startPort, reservedPort) {
  for (let port = startPort; port <= 65535; port += 1) {
    if (port !== reservedPort && await isPortFree(port)) return port;
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

function printSummary({ scope, port, serverUrl, readOnly, rotateToken, external }) {
  const panes = listWindowPanes(scope);
  console.log("");
  console.log("================ CodexPro TMUX Ready ================");
  console.log(`Window : ${scope.window}  (anchor: ${scope.anchor})`);
  console.log(`CWD    : ${fs.realpathSync(process.cwd())}`);
  console.log(`Local  : http://127.0.0.1:${port}/mcp`);
  console.log(`Access : ${readOnly ? "read-only" : "read + send enabled"}${rotateToken ? " (token rotated)" : ""}`);
  if (external) {
    console.log("Domain : " + external.hostname + " (persistent; launch directory independent)");
    console.log("Tunnel : externally managed (local backend ready; public routing not verified)");
  }
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
  if (argv[0] === "setup") {
    if (rotateToken) throw new Error("Use codexpro_tmux setup, not the rotation command.");
    const args = argv.slice(1);
    if (args.length === 1 && ["-h", "--help"].includes(args[0])) { usage(commandName); return; }
    if (args.length !== 0 && args.length !== 1 && !(args.length === 3 && args[1] === "--port")) throw new Error("Usage: codexpro_tmux setup <hostname> [--port <port>]");
    if (args[0]?.startsWith("-")) throw new Error("Supply a hostname, not an option.");
    const endpoint = configureExternalEndpoint(ENDPOINT_FILE, STATE_DIR, args[0], args.length === 3 ? Number(args[2]) : undefined);
    console.log("Saved fixed endpoint: https://" + endpoint.hostname + "/mcp");
    console.log("Local origin: http://127.0.0.1:" + endpoint.port);
    console.log("Configure or retain the HTTPS reverse proxy/named tunnel for that hostname and origin. No DNS or tunnel was changed.");
    console.log("Start inside the desired tmux window: codexpro_tmux");
    return;
  }
  if (["add", "remove", "list", "status"].includes(argv[0])) {
    if (rotateToken || argv.length !== 1) throw new Error("Use codexpro_tmux add|remove|list|status without options.");
    console.log(JSON.stringify(runWindowCommand(argv[0], { stateDir: STATE_DIR, endpointFile: ENDPOINT_FILE })));
    return;
  }
  const opts = parseOptions(argv);
  if (opts.help) {
    usage(commandName);
    return;
  }

  const scope = authorizeTmuxWindow(process.env.TMUX_PANE ?? "");
  const invokingCwd = fs.realpathSync(process.cwd());
  const endpoint = readExternalEndpoint(ENDPOINT_FILE);
  const { cwd, external } = selectLaunchEndpoint(endpoint, invokingCwd, opts);
  const explicitPort = argv.some(arg => arg === "--port" || arg.startsWith("--port="));
  if (external && explicitPort && opts.preferredPort !== external.port) throw new Error("Configured external endpoint requires its fixed port.");
  if (!external && explicitPort && endpoint && opts.preferredPort === endpoint.port) throw new Error("Port is reserved for the configured external endpoint.");
  privateDirectory(STATE_DIR);
  const key = instanceKey(cwd);
  const releaseStartup = instanceLock(STATE_DIR, key);
  try {
  const latestEndpoint = readExternalEndpoint(ENDPOINT_FILE);
  if (JSON.stringify(latestEndpoint) !== JSON.stringify(endpoint)) throw new Error("Endpoint configuration changed during startup; retry.");
  const previous = previousState(cwd);
  const active = Boolean(previous && (isPidAlive(previous.pid) || isPidAlive(previous.childPid)));
  if (active && (previous.cwd !== cwd || previous.window !== scope.window || (previous.socket && previous.socket !== scope.socket) || (previous.serverPid && previous.serverPid !== scope.serverPid))) {
    throw new Error(external ? "Fixed endpoint is already running in another tmux window. Use codexpro_tmux add here, or stop it locally before restarting." : "Existing instance belongs to another tmux window; stop it locally before starting here.");
  }
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const backendRoot = external ? selectedRelease(STATE_DIR, key, RELEASE_DIR, fs.realpathSync(repoRoot)) : repoRoot;
  if (external) {
    controlPath(STATE_DIR, key);
    assertWindowBackendCompatible(backendRoot);
  }
  // Check a new fixed port before replacing a running instance; never auto-increment a routed port.
  if (external && !(active && previous.port === external.port) && !await isPortFree(external.port)) throw new Error("External endpoint port is occupied; existing instance unchanged.");
  // Verify an explicitly supplied migration token against the live local service before saving it.
  if (active && !rotateToken && process.env.CODEXPRO_HTTP_TOKEN?.trim()) {
    if (!Number.isInteger(previous.port) || previous.port < 1024 || previous.port > 65535) throw new Error("Invalid existing instance port.");
    let health;
    try {
      const response = await fetch("http://127.0.0.1:" + previous.port + "/healthz", {
        headers: { Authorization: "Bearer " + process.env.CODEXPRO_HTTP_TOKEN.trim() },
        redirect: "error", signal: AbortSignal.timeout(2000)
      });
      if (response.ok) health = await response.json();
    } catch {}
    if (health?.mode !== "tmux-only" || health?.authEnabled !== true) throw new Error("Existing token could not be verified against the local bridge; no restart was performed.");
  }
  // Never change a legacy live token silently. Import it before stopping the old launcher.
  const token = persistentToken(CREDENTIAL_DIR, instanceKey(cwd), { initialToken: process.env.CODEXPRO_HTTP_TOKEN?.trim(), rotate: rotateToken, legacyRunning: active });
  const windowsFile = external ? windowsFileFor(STATE_DIR, key) : "";
  // Validate/prepare before stopping a live instance. Same live root preserves its list.
  if (windowsFile) prepareWindows(windowsFile, scope);
  await replaceExistingCwdInstance(cwd, scope);
  const preferred = Number.isInteger(previous?.port) && !explicitPort ? previous.port : opts.preferredPort;
  const port = external ? external.port : await findFreePort(preferred, endpoint?.port);
  if (external && !await isPortFree(port)) throw new Error("Fixed external endpoint port is occupied; refusing alternate port.");

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
  if (opts.localOnly || external) childArgs.push("--tunnel", "none");
  else if (opts.quickTunnel) childArgs.push("--tunnel", "cloudflare");

  const env = {
    ...process.env,
    CODEXPRO_TMUX_ONLY: "1",
    CODEXPRO_TMUX_AGENTS: "",
    CODEXPRO_TMUX_WINDOW: JSON.stringify(scope),
    CODEXPRO_TMUX_WINDOWS_FILE: windowsFile,
    CODEXPRO_TMUX_ALLOW_SEND: opts.readOnly ? "0" : "1",
    CODEXPRO_HTTP_TOKEN: token,
    CODEXPRO_PORT: String(port),
    CODEXPRO_HOST: "127.0.0.1"
  };
  const hasProxy = Boolean(env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy);
  if (!opts.localOnly && !external && !hasProxy && await isPortListening(7890)) {
    env.HTTPS_PROXY = "http://127.0.0.1:7890";
  }

  console.error(`CodexPro TMUX: authorizing window ${scope.window} (anchor ${scope.anchor}, cwd ${cwd}, port ${port})`);

  const statePath = stateFileForCwd(cwd);
  const removeOwnState = () => {
    try {
      const current = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (current?.pid === process.pid) fs.rmSync(statePath, { force: true });
    } catch {}
  };
  if (external) {
    await superviseExternal({ root: backendRoot, port, token, env, stateDir: STATE_DIR, key, releaseDir: RELEASE_DIR, releaseStartup,
      onState: (childPid, release) => writePrivateJson(statePath, { pid: process.pid, childPid, cwd, window: scope.window, socket: scope.socket, serverPid: scope.serverPid, anchor: scope.anchor, port, external: true, release, supervisor: true, windowsFile }),
      onReady: () => printSummary({ scope, port, serverUrl: externalServerUrl(external, token), readOnly: opts.readOnly, rotateToken, external }),
      onExit: removeOwnState });
    return;
  }
  const child = spawn(process.execPath, childArgs, {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "inherit"]
  });

  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
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
      external: Boolean(external),
      startedAt: new Date().toISOString()
    }, null, 2),
    { mode: 0o600 }
  );

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
      releaseStartup();
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
        const serverUrl = external ? externalServerUrl(external, token) : line.slice("CODEXPRO_READY ".length).trim();
        printSummary({ scope, port, serverUrl, readOnly: opts.readOnly, rotateToken, external });
        releaseStartup();
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
  } finally { releaseStartup(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  runCodexproTmux().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
