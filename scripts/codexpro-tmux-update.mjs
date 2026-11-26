#!/usr/bin/env node
import { runCodexproTmux } from "./codexpro-tmux.mjs";

runCodexproTmux({ rotateToken: true }).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
