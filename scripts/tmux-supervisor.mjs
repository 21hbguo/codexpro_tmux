import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { checkedRelease, controlPath, instanceLock, readPrivateJson, writePrivateJson } from "./tmux-lifecycle.mjs";

function spawnBackend(root, port, env) {
  // Direct HTTP child, no tunnel process or profile mutations. Explicit policy.
  const child = spawn(process.execPath, [path.join(root, "dist", "http.js"), "--root", root, "--host", "127.0.0.1", "--port", String(port), "--write", "off", "--bash", "off", "--codex-sessions", "off", "--tool-mode", "standard"], {
    cwd: root, env: { ...env, CODEXPRO_PORT: String(port), CODEXPRO_ROOT: root }, stdio: ["ignore", "inherit", "inherit"]
  });
  const handle = { child, exited: false, done: undefined };
  handle.done = new Promise(resolve => {
    const finish = () => { handle.exited = true; resolve(); };
    child.once("exit", finish);
    child.once("error", finish);
  });
  return handle;
}
async function stopBackend(handle) {
  if (!handle || handle.exited) return;
  handle.child.kill("SIGTERM");
  await Promise.race([handle.done, sleep(2500)]);
  if (!handle.exited) {
    handle.child.kill("SIGKILL");
    await Promise.race([handle.done, sleep(2500)]);
  }
  if (!handle.exited) throw new Error("Backend did not stop; refusing to start another process.");
}
async function ready(handle, port, token) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && !handle.exited) {
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/healthz", {
        headers: { Authorization: "Bearer " + token }, redirect: "error", signal: AbortSignal.timeout(750)
      });
      if (response.ok) {
        const body = await response.json();
        if (!handle.exited && body.ok === true && body.mode === "tmux-only" && body.authEnabled === true) return;
      }
    } catch {}
    await sleep(150);
  }
  throw new Error("Backend did not pass authenticated tmux-only readiness check.");
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
export function selectedRelease(stateDir, key, releaseDir, fallback) {
  const pointer = readPrivateJson(path.join(stateDir, key + ".release.json"));
  return pointer ? checkedRelease(releaseDir, pointer.root).root : fallback;
}
export async function superviseExternal({ root, port, token, env, stateDir, key, releaseDir, onReady, onState, releaseStartup, onExit }) {
  // Preserve the original anchor, authorization, access policy and credentials on every switch.
  const socketPath = controlPath(stateDir, key);
  const pointer = path.join(stateDir, key + ".release.json");
  let active, currentRoot = root, closing = false, transition, server, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const connections = new Set();
  const safeEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !/^(CODEXPRO_|CODEBASE_BRIDGE_)/.test(k)));
  Object.assign(safeEnv, {
    CODEXPRO_TMUX_ONLY: "1", CODEXPRO_TMUX_AGENTS: "", CODEXPRO_TMUX_WINDOW: env.CODEXPRO_TMUX_WINDOW,
    CODEXPRO_TMUX_ALLOW_SEND: env.CODEXPRO_TMUX_ALLOW_SEND, CODEXPRO_HTTP_TOKEN: token,
    CODEXPRO_HOST: "127.0.0.1", CODEXPRO_REQUIRE_HTTP_TOKEN: "1", CODEXPRO_ALLOW_NO_HTTP_TOKEN: "0",
    CODEXPRO_CONNECTION_TEST: "0"
  });
  async function start(root, targetPort) {
    const h = spawnBackend(root, targetPort, safeEnv);
    try { await ready(h, targetPort, token); return h; }
    catch (error) { await stopBackend(h); throw error; }
  }
  function watch(h) {
    h.done.then(() => {
      if (active === h && !transition && !closing) {
        console.error("Active backend exited.");
        process.exitCode = 1;
        finish();
      }
    });
  }
  async function activate(releasePath) {
    if (closing || transition) return { status: "busy" };
    const operation = (async () => {
      const unlock = instanceLock(stateDir, key);
      let candidate;
      try {
        const release = checkedRelease(releaseDir, releasePath);
        if (release.root === currentRoot) return { status: "unchanged", commit: release.commit };
        // Test candidate away from the routed port before interrupting live traffic.
        const probePort = await freePort();
        candidate = await start(release.root, probePort);
        await stopBackend(candidate);
        candidate = undefined;
        if (closing) return { status: "cancelled" };
        const oldRoot = currentRoot;
        await stopBackend(active);
        active = undefined;
        try {
          active = await start(release.root, port);
          onState(active.child.pid, release.root);
          writePrivateJson(pointer, { root: release.root, commit: release.commit });
          currentRoot = release.root;
          watch(active);
          return { status: "activated", commit: release.commit };
        } catch {
          try {
            await stopBackend(active);
            active = await start(oldRoot, port);
            onState(active.child.pid, oldRoot);
            watch(active);
            return { status: "rolled_back", reason: "New backend failed activation; previous backend restored." };
          } catch {
            console.error("Activation and rollback failed; inspect the local port and process state.");
            process.exitCode = 1;
            finish();
            return { status: "rollback_failed" };
          }
        }
      } catch (error) {
        return { status: "rejected", reason: error.message };
      } finally {
        if (candidate) await stopBackend(candidate);
        unlock();
      }
    })();
    transition = operation;
    try { return await operation; }
    finally { transition = undefined; if (active?.exited && !closing) { process.exitCode = 1; finish(); } }
  }
  const signal = () => { closing = true; finish(); };
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, signal);
  let ownsSocket = false;
  try {
    active = await start(currentRoot, port);
    watch(active);
    onState(active.child.pid, currentRoot);
    // Stale socket is removable only under the startup lock after previous instance replacement.
    if (fs.existsSync(socketPath)) {
      if (!fs.lstatSync(socketPath).isSocket()) throw new Error("Unexpected control socket path.");
      fs.unlinkSync(socketPath);
    }
    server = net.createServer(conn => {
      if (connections.size >= 8 || closing) { conn.destroy(); return; }
      connections.add(conn);
      conn.once("close", () => connections.delete(conn));
      conn.on("error", () => {});
      conn.setTimeout(5000, () => conn.destroy());
      let input = "", accepted = false;
      conn.on("data", async chunk => {
        if (accepted) return;
        input += chunk.toString("utf8");
        if (input.length > 4096) { conn.destroy(); return; }
        if (!input.includes("\n")) return;
        accepted = true;
        conn.setTimeout(0);
        let response;
        try {
          const request = JSON.parse(input.slice(0, input.indexOf("\n")));
          if (typeof request.release !== "string" || Object.keys(request).length !== 1) throw new Error("Invalid request.");
          response = await activate(request.release);
        } catch { response = { status: "rejected", reason: "Invalid or failed local activation request." }; }
        conn.end(JSON.stringify(response) + "\n");
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    ownsSocket = true;
    fs.chmodSync(socketPath, 0o600);
    onReady();
    releaseStartup();
    await done;
  } finally {
    closing = true;
    if (transition) await transition.catch(() => {});
    for (const conn of connections) conn.destroy();
    if (server) server.close();
    if (ownsSocket) fs.rmSync(socketPath, { force: true });
    await stopBackend(active);
    onExit();
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(name, signal);
  }
}
