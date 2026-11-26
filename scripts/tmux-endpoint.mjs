import fs from "node:fs";
import path from "node:path";

// A single externally routed endpoint is bound to an explicit local instance directory.
// Never accept this configuration from MCP or inherit a hostname from the repository.
export function readExternalEndpoint(file, cwd) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  let config;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) || st.size > 4096) throw new Error("External endpoint config must be a private regular file (0600).");
    config = JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      typeof config.cwd !== "string" || !path.isAbsolute(config.cwd) ||
      typeof config.hostname !== "string" || config.hostname.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(config.hostname) ||
      !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 ||
      Object.keys(config).some(k => !["cwd", "hostname", "port"].includes(k))) {
    throw new Error("Invalid external endpoint configuration (expected cwd, hostname, port).");
  }
  if (fs.realpathSync(config.cwd) !== config.cwd) throw new Error("External endpoint cwd must be a canonical local directory.");
  return { ...config, selected: config.cwd === cwd };
}
export function externalServerUrl(endpoint, token) {
  const url = new URL("https://" + endpoint.hostname + "/mcp");
  url.searchParams.set("codexpro_token", token);
  return url.toString();
}
