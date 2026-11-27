#!/usr/bin/env node
import { runCodexproTmux } from "./codexpro-tmux.mjs";
runCodexproTmux({ argv: ["rotate", ...process.argv.slice(2)] }).catch(error => { console.error(error.message); process.exitCode = 1; });
