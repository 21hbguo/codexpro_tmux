#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { authorizeTmuxWindow } from "../dist/tmuxOps.js";

try {
  const args = process.argv.slice(2);
  const action = args.shift() ?? "start";
  if (!["setup", "start"].includes(action) || args.some(arg => arg !== "--read-only")) {
    throw Error("Usage: node scripts/tmux-start.mjs [setup|start] [--read-only] (from any directory inside a dedicated tmux window)");
  }
  const scope = authorizeTmuxWindow(process.env.TMUX_PANE ?? "");
  const readOnly = args.includes("--read-only");
  console.error("CodexPro TMUX: authorizing candidate panes in " + scope.window + " only, excluding launcher " + scope.anchor + "; " + (readOnly ? "read-only" : "message sending enabled"));
  const profileRoot = fileURLToPath(new URL("../", import.meta.url));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./codexpro.mjs", import.meta.url)), action, "--root", profileRoot, "--write", "off", "--no-bash", "--codex-sessions", "off"], {
    stdio: "inherit",
    env: { ...process.env, CODEXPRO_TMUX_ONLY: "1", CODEXPRO_TMUX_AGENTS: "", CODEXPRO_TMUX_WINDOW: JSON.stringify(scope), CODEXPRO_TMUX_ALLOW_SEND: readOnly ? "0" : "1" }
  });
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
