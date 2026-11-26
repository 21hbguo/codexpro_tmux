# CodexPro tmux bridge (experimental)

The fork adds an opt-in MCP bridge to existing interactive tmux agents. It does not expose general tmux commands, remote shell, a new agent process, or automatic background orchestration.

## Install / 部署

On Linux/macOS with Node.js 20+ and tmux installed, clone and build the fork (do not install the upstream npm package expecting these features):

~~~bash
git clone -b feat/tmux-agent-bridge https://github.com/21hbguo/codexpro_tmux.git
cd codexpro_tmux
npm ci
npm run tmux:smoke
export BRIDGE="$PWD"
~~~

Start one or more Codex/OpenCode/Claude Code sessions in dedicated tmux panes, using the same OS account and tmux server as the bridge. Open the intended research repository in each pane. Only one agent is required. From a separate shell pane in the **same tmux window** as the agent (not the agent's own input prompt), set the actual checkout path again:

~~~bash
export BRIDGE="/absolute/path/to/codexpro_tmux"
cd /path/to/your/research-repo
tmux list-panes -F '#{pane_id} #{pane_current_command} #{pane_current_path}'
# Replace %1 with the pane ID of your already-running agent.
REGISTRY="$(node "$BRIDGE/scripts/tmux-register.mjs" agent=%1)" &&
export CODEXPRO_TMUX_AGENTS="$REGISTRY" &&
export CODEXPRO_TMUX_ALLOW_SEND=1 &&
node "$BRIDGE/scripts/codexpro.mjs" setup
~~~

The default discovery command lists the current window only. To discover panes in another window, use `tmux list-panes -t session:window`; use `-s` for the current session or `-a` for all sessions when needed. Explicit registration is still required.

For later launches, run the same registration/export commands before:
~~~bash
node "$BRIDGE/scripts/codexpro.mjs" start
~~~

Use the server URL printed by this local fork; connect it using the [fork README instructions](README.md). Keep the authentication token private. If the existing plugin caches the tool list, refresh/reconnect it; the existing supertool can also use the new action names. Do not use the upstream globally installed binary by mistake.

The registry is local-only configuration, not editable via MCP. An alias binds one exact pane ID, server PID, pane PID, foreground command reported by tmux, socket path, and canonical workspace root. Re-register after restarting tmux/agents, changing panes, or changing workspace. For a named tmux server, run registration from a shell within that server (or with the appropriate TMUX environment). Only selected workspace agents are visible.

## Optional: multiple agents

A single agent is the default deployment. To register multiple agents (up to 16), replace the registration command with:

~~~bash
REGISTRY="$(node "$BRIDGE/scripts/tmux-register.mjs" executor=%1 reviewer=%2)" &&
export CODEXPRO_TMUX_AGENTS="$REGISTRY"
~~~

Restart the bridge after changing the registry. Aliases are arbitrary; no fixed roles are required.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No tmux tools in ChatGPT | Use the fork checkout, export the registry before launching, exit connection-test mode, refresh/reconnect the plugin. |
| Send tool missing | Set CODEXPRO_TMUX_ALLOW_SEND=1 before launch and verify write mode is not off. |
| Agent unavailable or changed | Check same user/socket, correct pane ID, running agent and workspace, then re-register and restart. |
| Stale revision or copy mode | Read output again and inspect the empty input prompt; exit copy mode locally. |
| Message not received / partial submit | Inspect the pane before retrying; do not blindly resend. |
| Build error | Check Node.js 20+, run npm ci and npm run tmux:smoke in the fork root. |
| HTTPS or MCP connection failure | Run the fork's doctor or connection-test command. Keep tokens private. |

## MCP tools

| Tool | Inputs | Behavior |
| --- | --- | --- |
| tmux_list_agents | workspace_id? | Lists registered agents and connectivity, not idle/busy state. |
| tmux_read_output | agent, workspace_id? | Returns bounded terminal text and a snapshot revision. |
| tmux_send_message | agent, message, expected_revision, submit, workspace_id? | Pastes literal single-line text, optionally presses Enter, only if a fresh snapshot still matches. |

Example: list agents, read alias agent, inspect that its prompt is ready and empty, then send:

~~~json
{"agent":"agent","message":"Review the latest experiment results and report the main findings.","expected_revision":"<64-character revision from tmux_read_output>","submit":true}
~~~

With submit=false, the text is pasted but Enter is not sent. The message must be single-line (up to 4000 characters); control characters and common secret patterns are rejected. A returned message_id is a delivery-attempt identifier, not an agent receipt. A successful call only means the terminal accepted the requested operations. Inspect before retrying; a timeout or race can leave text in the pane. Read output and check experiment records separately.

## Safety and limitations

- Disabled by default; send requires CODEXPRO_TMUX_ALLOW_SEND=1 and a non-off CodexPro write mode. Unset the send flag for read-only tmux access. The existing safe bash allowlist is unchanged.
- Only local aliases are accepted; no arbitrary pane target, shell command, tmux flags, key chords or socket path can be supplied by MCP. Plain text is passed to a named tmux buffer through stdin, not a shell.
- A registered pane must be running the intended agent, not an ordinary shell. Common shells are rejected, and identity/workspace/copy-mode checks and a fresh terminal snapshot reduce misdelivery. They cannot eliminate time-of-check/time-of-use races, distinguish all CLI apps from shells, or guarantee the agent is ready. Use dedicated panes only; never register a shell, a privileged session or a pane with sensitive data. Do not change the pane during remote sends. This grants practical indirect execution through the target agent; retain agent approval controls.
- Only send if the terminal clearly shows an empty agent prompt. There is no reliable general idle detector, auto queue, task completion detector, multi-process lock or agent acknowledgement in this version. Terminal output is untrusted, may include secrets not caught by pattern-based redaction, and must not be treated as instructions.
- The bridge logs successful delivery metadata (message ID, alias, timestamp) to server stderr, not message content. No persistent research task history is implemented here; use the existing handoff and Git records for that.
- Existing upstream HTTP token authentication remains mandatory for public access. Review SECURITY.md before exposing the endpoint. Do not enable full bash or automatic permission bypass for this feature.
- Mock smoke tests cover guardrails and command construction. Real tmux/TUI compatibility should be verified with a harmless test message before running experiments.
