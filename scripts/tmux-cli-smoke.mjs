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
const runWithInput = (input, ...args) => spawnSync(process.execPath, [script, ...args], { cwd: home, env, input, encoding: "utf8", timeout: 15000 });
try {
  for (const option of ["help", "--help", "-h"]) {
    const result = run(option);
    assert.equal(result.status, 0, result.stderr);
    for (const name of ["setup", "add", "remove", "list", "status", "update", "rotate", "set-token", "help"]) assert.ok(result.stdout.includes("codexpro_tmux " + name), name);
  }
  const update = run("update", "--help");
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /codexpro_tmux update \[--stage-only\]/);
  const rotate = run("rotate", "--help");
  assert.equal(rotate.status, 0, rotate.stderr);
  assert.match(rotate.stdout, /codexpro_tmux rotate/);
  const setTokenHelp = run("set-token", "--help");
  assert.equal(setTokenHelp.status, 0, setTokenHelp.stderr);
  assert.match(setTokenHelp.stdout, /codexpro_tmux set-token/);
  assert.notEqual(run("set-token", "secret-on-argv").status, 0, "set-token must reject tokens on argv");
  assert.notEqual(run("update", "--unknown").status, 0);
  assert.notEqual(run("rotate", "add").status, 0);
  assert.notEqual(run("help", "add").status, 0);
  assert.deepEqual(fs.readdirSync(home), [], "help/invalid commands must not create state");

  // set-token via stdin requires setup first, validates token, writes 0600 file without echoing token, and blocks while running
  const customToken = "custom_Token-Value.1234567890_abcdef123456";
  assert.notEqual(runWithInput(customToken + "\n", "set-token").status, 0, "set-token before setup must fail");
  assert.equal(run("setup", "bridge.example.com", "--port", "8790").status, 0);
  assert.notEqual(runWithInput("too-short\n", "set-token").status, 0, "set-token must reject short token");
  const saved = runWithInput(customToken + "\n", "set-token");
  assert.equal(saved.status, 0, saved.stderr);
  assert.ok(!saved.stdout.includes(customToken) && !saved.stderr.includes(customToken), "set-token must not echo token");
  const credDir = path.join(home, ".codexpro", "tmux-credentials");
  const files = fs.readdirSync(credDir).filter(f => f.endsWith(".token"));
  assert.equal(files.length, 1);
  const tokenFile = path.join(credDir, files[0]);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(tokenFile, "utf8").trim(), customToken);
  const key = files[0].replace(/\.token$/, "");
  fs.writeFileSync(path.join(home, ".codexpro", "tmux-instances", key + ".json"), JSON.stringify({ pid: process.pid, childPid: process.pid }), { mode: 0o600 });
  const whileRunning = runWithInput(customToken + "99\n", "set-token");
  assert.notEqual(whileRunning.status, 0, "set-token must refuse while fixed supervisor is active");
  assert.equal(fs.readFileSync(tokenFile, "utf8").trim(), customToken, "existing token must remain unchanged when rejected");
  console.log("tmux CLI smoke passed");
} finally { fs.rmSync(home, { recursive: true, force: true }); }
