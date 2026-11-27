import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-cli-"));
const root = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(root, "scripts", "codexpro-tmux.mjs");
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config") };
for (const key of Object.keys(env)) if (/^CODEXPRO_|^CODEBASE_BRIDGE_|^TMUX(?:_|$)/.test(key)) delete env[key];
const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: home, env, encoding: "utf8", timeout: 15000 });
try {
  for (const option of ["help", "--help", "-h"]) {
    const result = run(option);
    assert.equal(result.status, 0, result.stderr);
    for (const name of ["setup", "add", "remove", "list", "status", "update", "rotate", "help"]) assert.ok(result.stdout.includes("codexpro_tmux " + name), name);
  }
  const update = run("update", "--help");
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /codexpro_tmux update \[--stage-only\]/);
  const rotate = run("rotate", "--help");
  assert.equal(rotate.status, 0, rotate.stderr);
  assert.match(rotate.stdout, /codexpro_tmux rotate/);
  assert.notEqual(run("update", "--unknown").status, 0);
  assert.notEqual(run("rotate", "add").status, 0);
  assert.notEqual(run("help", "add").status, 0);
  assert.deepEqual(fs.readdirSync(home), [], "help/invalid commands must not create state");
  console.log("tmux CLI smoke passed");
} finally { fs.rmSync(home, { recursive: true, force: true }); }
