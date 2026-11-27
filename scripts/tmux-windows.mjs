import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readPrivateJson, writePrivateJson, instanceLock, controlPath } from "./tmux-lifecycle.mjs";
import { privateDirectory } from "./tmux-credentials.mjs";
import { readExternalEndpoint, fixedInstanceKey } from "./tmux-endpoint.mjs";
import { authorizeTmuxWindow, sameWindowScope, readWindowAuthorization, verifyLocalWindowRoot, liveLocalWindowIds, withWindowAuthorizationLock } from "../dist/tmuxOps.js";

export const windowsFileFor = (stateDir, key) => path.join(stateDir, key + ".windows.json");

// Invoked under the lifecycle lock. A different launcher identity never inherits old window permissions.
export function prepareWindows(file, root) {
  return withWindowAuthorizationLock(file, () => {
    let old;
    try { old = readWindowAuthorization(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const data = old && sameWindowScope(old.root, root) ? old : { version: 1, root, windows: [{ window: root.window, epoch: randomUUID() }] };
    writePrivateJson(file, data);
    return data;
  });
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export function runWindowCommand(action, { stateDir, endpointFile, cwd = fs.realpathSync(process.cwd()) }) {
  if (!["add", "remove", "list", "status"].includes(action)) throw new Error("Unknown window command.");
  const endpoint = readExternalEndpoint(endpointFile);
  if (!endpoint) throw new Error("Dynamic window commands require a configured fixed endpoint.");
  const key = fixedInstanceKey(endpoint);
  privateDirectory(stateDir);
  const release = instanceLock(stateDir, key);
  try {
    const state = readPrivateJson(path.join(stateDir, key + ".json"));
    const file = windowsFileFor(stateDir, key);
    if (!state || !state.supervisor || !state.external || state.cwd !== endpoint.cwd || state.port !== endpoint.port || state.windowsFile !== file || !alive(state.pid) || !alive(state.childPid) || !fs.lstatSync(controlPath(stateDir, key)).isSocket()) throw new Error("No running dynamic fixed-endpoint supervisor; upgrade and restart locally first.");
    return withWindowAuthorizationLock(file, () => {
      const data = readWindowAuthorization(file);
      if (data.root.window !== state.window || data.root.anchor !== state.anchor || data.root.socket !== state.socket || data.root.serverPid !== state.serverPid) throw new Error("Window authorization does not match running supervisor.");
      verifyLocalWindowRoot(data.root);
      const live = liveLocalWindowIds(data.root);
      const windows = data.windows.filter(w => live.has(w.window));
      let changed = windows.length !== data.windows.length;
      let window;
      if (action === "add" || action === "remove") {
        const current = authorizeTmuxWindow(process.env.TMUX_PANE ?? "");
        if (current.socket !== data.root.socket || current.serverPid !== data.root.serverPid || !live.has(current.window)) throw new Error("Current pane is not on the authorized tmux server.");
        window = current.window;
        const index = windows.findIndex(w => w.window === window);
        if (action === "add" && index === -1) {
          if (windows.length >= 32) throw new Error("At most 32 authorized windows; remove unused windows first.");
          windows.push({ window, epoch: randomUUID() });
          changed = true;
        } else if (action === "remove" && index !== -1) {
          windows.splice(index, 1);
          changed = true;
        }
      }
      if (changed) writePrivateJson(file, { ...data, windows });
      return { action, window, changed, authorizedWindows: windows.map(w => w.window), ...(action === "status" ? { hostname: endpoint.hostname, port: state.port, supervisorPid: state.pid, backendPid: state.childPid } : {}) };
    });
  } finally { release(); }
}
