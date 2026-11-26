import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077)) {
    throw new Error("Credential directory must be owned by the current user, not a symlink, and mode 0700.");
  }
}
function validateToken(token) {
  if (typeof token !== "string" || token.length < 32 || token.length > 512 || !/^[A-Za-z0-9._~+/=-]+$/.test(token)) {
    throw new Error("Invalid token; supply the existing token locally or use explicit rotation.");
  }
  return token;
}
function readToken(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if (err.code === "ENOENT") return undefined;
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) || st.size > 513) {
      throw new Error("Credential file must be a private regular file owned by the current user.");
    }
    return validateToken(fs.readFileSync(fd, "utf8").trim());
  } finally { fs.closeSync(fd); }
}
export function persistentToken(dir, key, { initialToken, rotate = false, legacyRunning = false } = {}) {
  if (!/^[a-f0-9]{16}$/.test(key)) throw new Error("Invalid instance key.");
  privateDirectory(dir);
  const file = path.join(dir, key + ".token");
  const previous = readToken(file);
  if (previous !== undefined && !rotate) {
    if (initialToken && initialToken !== previous) throw new Error("Environment token differs from saved token; refusing implicit rotation.");
    return previous;
  }
  if (!rotate && legacyRunning && !initialToken) {
    throw new Error("An older instance is active without a saved token. Import its existing token locally via CODEXPRO_HTTP_TOKEN before replacing it; no restart was performed.");
  }
  const token = !rotate && initialToken ? validateToken(initialToken) : randomBytes(24).toString("hex");
  const temp = path.join(dir, "." + key + "-" + randomBytes(12).toString("hex"));
  try {
    fs.writeFileSync(temp, token + "\n", { mode: 0o600, flag: "wx" });
    if (rotate) fs.renameSync(temp, file);
    else {
      // Exclusive publication: never overwrite credentials created by a concurrent start.
      try { fs.linkSync(temp, file); }
      catch (err) {
        if (err.code !== "EEXIST") throw err;
        // Remove our temporary link before reading the winner.
        fs.unlinkSync(temp);
        const winner = readToken(file);
        if (!winner || (initialToken && initialToken !== winner)) throw new Error("Concurrent credential creation; retry without changing the token.");
        return winner;
      }
      fs.unlinkSync(temp);
    }
    return token;
  } finally { fs.rmSync(temp, { force: true }); }
}
