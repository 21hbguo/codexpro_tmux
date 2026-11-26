#!/usr/bin/env node
// Staging is intentionally separate from activation: never terminate a live bridge or rotate its credentials.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateDirectory } from "./tmux-credentials.mjs";

const branch = "feat/tmux-agent-bridge";
const repo = "https://github.com/21hbguo/codexpro_tmux.git";
function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", timeout: 300000 });
  if (result.error || result.status !== 0) throw new Error(command + " failed during staging; live instance was not changed.");
}
try {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: codexpro_tmux_update\nFetch, build and test the remote version in a private staging checkout. No live service restart or token rotation. Activation is separate.");
  } else {
    if (args.length) throw new Error("Update stages code only and takes no startup flags. Use codexpro_tmux for --local/--read-only/--port.");
    const root = path.join(os.homedir(), ".codexpro", "tmux-releases");
    privateDirectory(root);
    const staging = fs.mkdtempSync(path.join(root, "stage-"));
    const env = { ...process.env, LC_ALL: "C", CODEXPRO_HOST: "127.0.0.1" };
    // No production bridge credentials or authority in build/test child processes.
    for (const key of Object.keys(env)) if (/^CODEXPRO_|^CODEBASE_BRIDGE_|^TMUX(?:_|$)|^CLOUDFLARE_|^NGROK_/.test(key) && key !== "CODEXPRO_HOST") delete env[key];
    try {
      run("git", ["clone", "--single-branch", "--branch", branch, repo, staging], root, env);
      run("npm", ["ci"], staging, env);
      run("npm", ["run", "tmux:smoke"], staging, env);
      console.log("Staged and tested:", staging);
      console.log("Live service, token and tunnel unchanged. Do not activate until independent validation. This command does not install or restart the staged release.");
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
