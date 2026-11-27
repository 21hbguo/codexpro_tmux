import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { privateDirectory } from "./tmux-credentials.mjs";
import { instanceLock, writePrivateJson } from "./tmux-lifecycle.mjs";

export const DEFAULT_FIXED_PORT = 8790;
export const fixedInstanceKey = endpoint => createHash("sha256").update(endpoint.cwd).digest("hex").slice(0, 16);

function validateEndpoint(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      typeof config.cwd !== "string" || !path.isAbsolute(config.cwd) || path.normalize(config.cwd) !== config.cwd ||
      typeof config.hostname !== "string" || config.hostname.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(config.hostname) ||
      !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
      Object.keys(config).some(k => !["cwd", "hostname", "port"].includes(k))) {
    throw new Error("Invalid external endpoint configuration (expected persistent identity, hostname, port).");
  }
  // Keep legacy cwd exactly: it is an identity, not a launch-directory requirement.
  return { cwd: config.cwd, hostname: config.hostname, port: config.port };
}
export function readExternalEndpoint(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) || st.size > 4096) throw new Error("External endpoint config must be a private regular file (0600).");
    return validateEndpoint(JSON.parse(fs.readFileSync(fd, "utf8")));
  } finally { fs.closeSync(fd); }
}
export function configureExternalEndpoint(file, stateDir, hostname, port) {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(parent);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o022)) throw new Error("Unsafe local endpoint configuration directory.");
  const unlock = instanceLock(stateDir, "endpoint-config");
  try {
    const existing = readExternalEndpoint(file);
    if (!existing && !hostname) throw new Error("Run codexpro_tmux setup <hostname> [--port <port>] first.");
    const config = validateEndpoint({
      cwd: existing?.cwd ?? path.join(parent, "tmux-fixed"),
      hostname: hostname ?? existing?.hostname,
      port: port ?? existing?.port ?? DEFAULT_FIXED_PORT
    });
    if (existing) {
      if (existing.hostname !== config.hostname || existing.port !== config.port) throw new Error("A different endpoint is already saved. No changes made. To migrate, stop the service and explicitly edit the private config and external route; preserve cwd to retain the token.");
      return existing;
    }
    privateDirectory(config.cwd);
    if (fs.existsSync(file)) throw new Error("Endpoint configuration changed; retry.");
    writePrivateJson(file, config);
    return config;
  } finally { unlock(); }
}
export function selectLaunchEndpoint(config, invokingCwd, { localOnly = false, quickTunnel = false } = {}) {
  if (localOnly && quickTunnel) throw new Error("Choose --local or --quick-tunnel, not both.");
  if (!localOnly && !quickTunnel) {
    if (!config) throw new Error("No fixed domain configured. Run codexpro_tmux setup <hostname> [--port <port>], or explicitly choose --quick-tunnel or --local.");
    return { cwd: config.cwd, external: config };
  }
  if (config && invokingCwd === config.cwd) throw new Error("This identity is reserved for the fixed endpoint; use a different directory for a temporary or local instance.");
  return { cwd: invokingCwd, external: undefined };
}
export function externalServerUrl(endpoint, token) {
  const url = new URL("https://" + endpoint.hostname + "/mcp");
  url.searchParams.set("codexpro_token", token);
  return url.toString();
}
