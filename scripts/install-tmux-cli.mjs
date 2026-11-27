import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const bin = path.join(os.homedir(), ".local", "bin");
const commands = { codexpro_tmux: "codexpro-tmux.mjs", codexpro_tmux_update: "codexpro-tmux-update.mjs", codexpro_tmux_rotate: "codexpro-tmux-rotate.mjs" };
try {
  fs.accessSync(path.join(root, "dist", "http.js"), fs.constants.R_OK);
  fs.mkdirSync(bin, { recursive: true, mode: 0o755 });
  const pending = [];
  for (const [name, script] of Object.entries(commands)) {
    const source = path.join(root, "scripts", script);
    fs.accessSync(source, fs.constants.X_OK);
    const dest = path.join(bin, name);
    let info;
    try { info = fs.lstatSync(dest); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!info) pending.push([source, dest]);
    else if (!info.isSymbolicLink() || fs.realpathSync(dest) !== source) throw new Error("Existing command differs: " + dest + ". Inspect and migrate it locally.");
  }
  const created = [];
  try {
    for (const [source, dest] of pending) {
      fs.symlinkSync(source, dest);
      created.push([source, dest]);
    }
  } catch (error) {
    for (const [source, dest] of created) {
      try { if (fs.readlinkSync(dest) === source) fs.unlinkSync(dest); } catch {}
    }
    throw error;
  }
  console.log("CLI installed in " + bin + ". No service or endpoint changed.");
  if (!(process.env.PATH ?? "").split(path.delimiter).includes(bin)) console.log("Add ~/.local/bin to PATH in your shell.");
} catch (error) { console.error(error.message); process.exitCode = 1; }
