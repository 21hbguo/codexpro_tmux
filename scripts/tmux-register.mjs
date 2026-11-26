#!/usr/bin/env node
import { registerTmuxAgent } from "../dist/tmuxOps.js";

try {
  if (process.argv.length < 3 || process.argv.length > 18) throw Error("Usage: node scripts/tmux-register.mjs agent=%1 [reviewer=%2 ...] (run from the allowed workspace root, with registered agents already running)");
  const result = Object.create(null);
  const panes = new Set();
  for (const arg of process.argv.slice(2)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]{0,31})=(%[0-9]+)$/.exec(arg);
    if (!match || Object.hasOwn(result, match[1]) || panes.has(match[2])) throw Error("Use unique alias=%pane_id registrations.");
    panes.add(match[2]);
    result[match[1]] = registerTmuxAgent(process.cwd(), match[2]);
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
