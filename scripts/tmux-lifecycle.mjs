import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { privateDirectory } from "./tmux-credentials.mjs";

// Fail closed on a stale lock. Never guess that a PID was not reused.
export function instanceLock(dir, key) {
  privateDirectory(dir);
  const lock = path.join(dir, key + ".lock");
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (err) {
    if (err.code === "EEXIST") throw new Error("Instance startup/update locked; inspect stale lock locally after confirming no transition is running.");
    throw err;
  }
  try { fs.writeFileSync(path.join(lock, "owner"), String(process.pid), { mode: 0o600, flag: "wx" }); }
  catch (err) { fs.rmdirSync(lock); throw err; }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.unlinkSync(path.join(lock, "owner"));
    fs.rmdirSync(lock);
  };
}
export function writePrivateJson(file, value) {
  const temp = file + "." + randomBytes(8).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(temp, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
export function readPrivateJson(file) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (err) { if (err.code === "ENOENT") return undefined; throw err; }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) || st.size > 8192) throw new Error("Invalid private release metadata.");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
}
export function checkedRelease(root, release) {
  const canonicalRoot = fs.realpathSync(root);
  const canonical = fs.realpathSync(release);
  if (canonical !== release || path.dirname(canonical) !== canonicalRoot || !/^stage-[A-Za-z0-9]+$/.test(path.basename(canonical))) throw new Error("Release must be a staged local checkout.");
  const metadata = readPrivateJson(path.join(canonical, ".tmux-tested.json"));
  if (!metadata || !/^[a-f0-9]{40}$/.test(metadata.commit) || !fs.statSync(path.join(canonical, "dist", "http.js")).isFile()) throw new Error("Release has no completed build/test marker.");
  return { root: canonical, commit: metadata.commit };
}
export function controlPath(stateDir, key) {
  const result = path.join(stateDir, key + ".sock");
  if (Buffer.byteLength(result) > 100) throw new Error("Local control socket path is too long.");
  return result;
}
export function requestActivation(socket, release) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let buffer = "";
    const timer = setTimeout(() => client.destroy(new Error("Activation response timed out; inspect local supervisor, do not retry blindly.")), 120000);
    client.on("connect", () => client.write(JSON.stringify({ release }) + "\n"));
    client.on("data", chunk => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 8192) client.destroy(new Error("Invalid activation response."));
      else if (buffer.includes("\n")) {
        try { resolve(JSON.parse(buffer.slice(0, buffer.indexOf("\n")))); }
        catch { reject(new Error("Invalid activation response.")); }
        client.destroy();
      }
    });
    client.on("error", reject);
    client.on("close", () => { clearTimeout(timer); reject(new Error("Activation connection closed; inspect local supervisor.")); });
  });
}
