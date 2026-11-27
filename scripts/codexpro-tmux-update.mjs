#!/usr/bin/env node
// Stage first, then ask a compatible local foreground supervisor to activate. Never rotate credentials.
import { spawnSync } from "node:child_process";
import { controlPath, requestActivation, writePrivateJson, readPrivateJson } from "./tmux-lifecycle.mjs";
import { readExternalEndpoint, fixedInstanceKey } from "./tmux-endpoint.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateDirectory } from "./tmux-credentials.mjs";

const branch = "main";
const repo = "https://github.com/21hbguo/codexpro_tmux.git";
function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", timeout: 300000 });
  if (result.error || result.status !== 0) throw new Error(command + " failed during staging; live instance was not changed.");
}
try {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: codexpro_tmux_update [--stage-only]\nFetch, build and test remotely tracked code; activate via the running fixed-endpoint supervisor if available. Token and tunnel unchanged. --stage-only never activates.");
  } else {
    if (args.some(arg => arg !== "--stage-only")) throw new Error("Only --stage-only is supported.");
    const root = path.join(os.homedir(), ".codexpro", "tmux-releases");
    privateDirectory(root);
    const staging = fs.mkdtempSync(path.join(root, "stage-"));
    const env = { ...process.env, LC_ALL: "C", CODEXPRO_HOST: "127.0.0.1" };
    // No production bridge credentials or authority in build/test child processes.
    for (const key of Object.keys(env)) if (/^CODEXPRO_|^CODEBASE_BRIDGE_|^TMUX(?:_|$)|^CLOUDFLARE_|^NGROK_/.test(key) && key !== "CODEXPRO_HOST") delete env[key];
    try {
      run("git", ["clone", "--single-branch", "--branch", branch, repo, staging], root, env);
      run("npm", ["ci"], staging, env);
      const testHome = fs.mkdtempSync(path.join(root, "test-home-"));
      try { run("npm", ["run", "tmux:smoke"], staging, { ...env, HOME: testHome, XDG_CONFIG_HOME: path.join(testHome, ".config") }); }
      finally { fs.rmSync(testHome, { recursive: true, force: true }); }
      const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: staging, env, encoding: "utf8" });
      const commit = rev.stdout?.trim();
      if (rev.status !== 0 || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("Cannot resolve staged commit.");
      writePrivateJson(path.join(staging, ".tmux-tested.json"), { commit });
      console.log("Staged and tested:", commit, staging);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    // Staged release must remain on disk even if activation response is lost.
    const stateDir = path.join(os.homedir(), ".codexpro", "tmux-instances");
    const endpoint = readExternalEndpoint(path.join(os.homedir(), ".codexpro", "tmux-endpoint.json"));
    const key = endpoint ? fixedInstanceKey(endpoint) : undefined;
    const state = key ? readPrivateJson(path.join(stateDir, key + ".json")) : undefined;
    if (args.includes("--stage-only") || !endpoint || !state?.supervisor || !state.external || state.port !== endpoint.port || state.cwd !== endpoint.cwd) {
      console.log("Staging only: no compatible active fixed-endpoint supervisor selected. No live changes.");
    } else {
      privateDirectory(stateDir);
      const result = await requestActivation(controlPath(stateDir, key), staging);
      console.log("Activation:", result.status, result.commit ?? "", result.reason ?? "");
      if (!["activated", "unchanged"].includes(result.status)) process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
