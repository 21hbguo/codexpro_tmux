#!/usr/bin/env node
import { runCodexproTmux } from "./codexpro-tmux.mjs";
runCodexproTmux({ rotateToken: true }).catch(error => { console.error(error.message); process.exitCode = 1; });
