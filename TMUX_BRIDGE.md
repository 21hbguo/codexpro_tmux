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

Start one or more Codex/OpenCode/Claude Code sessions in a dedicated tmux window. In a separate shell pane in the same window, using the same OS account and tmux server:

~~~bash
export BRIDGE="/absolute/path/to/codexpro_tmux"
cd /path/to/your/research-repo
node "$BRIDGE/scripts/tmux-start.mjs" setup
~~~

For later launches use `node "$BRIDGE/scripts/tmux-start.mjs" start`. Add `--read-only` to either command to disable sending. The launcher records its actual pane, server, socket, window and workspace locally before starting CodexPro. It does not allow remote changes to that scope.

Use the server URL printed by the fork; connect it using the [fork README](README.md). Keep the authentication token private. Refresh/reconnect the plugin if tools are cached.

## Direct pane selection

Tell ChatGPT the exact pane ID (e.g. %1), or ask it to list candidate panes. The optional local discovery command is:

~~~bash
tmux list-panes -F '#{pane_id} #{pane_current_command} #{pane_current_path}'
~~~

One or multiple agents are supported. Newly created candidate panes in the same authorized window/workspace are discoverable without restarting. The bridge's own pane, common shells, panes outside the workspace/window, and invalid selectors are rejected. Keep the launcher pane in the authorized window; if it moves or disappears, restart locally.

The scope is a local authorization of eligible panes in a dedicated window, not proof of agent identity. Do not include unrelated or sensitive programs.

## Optional: explicit registry mode

For stricter isolation or intentionally selecting panes across windows, use the existing explicit registry mode instead of tmux-start.mjs:

~~~bash
REGISTRY="$(node "$BRIDGE/scripts/tmux-register.mjs" executor=%1 reviewer=%2)" &&
CODEXPRO_TMUX_AGENTS="$REGISTRY" CODEXPRO_TMUX_WINDOW= CODEXPRO_TMUX_ALLOW_SEND=1 node "$BRIDGE/scripts/codexpro.mjs" start
~~~

Use actual IDs and 1–16 unique aliases. Explicit mode binds exact panes and requires re-registration after identity changes. The modes are mutually exclusive.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No tmux tools in ChatGPT | Use the fork checkout, use tmux-start.mjs inside the intended window (or export the explicit registry), exit connection-test mode, refresh/reconnect the plugin. |
| Send tool missing | Set CODEXPRO_TMUX_ALLOW_SEND=1 before launch and verify write mode is not off. |
| Agent unavailable or changed | Check same user/socket, correct pane ID, running agent and workspace, then read again or restart; re-register in explicit mode. |
| Stale revision or copy mode | Read output again and inspect the empty input prompt; exit copy mode locally. |
| Message not received / partial submit | Inspect the pane before retrying; do not blindly resend. |
| Build error | Check Node.js 20+, run npm ci and npm run tmux:smoke in the fork root. |
| HTTPS or MCP connection failure | Run the fork's doctor or connection-test command. Keep tokens private. |

## MCP tools

| Tool | Inputs | Behavior |
| --- | --- | --- |
| tmux_list_agents | workspace_id? | Lists authorized candidate panes or registered agents and connectivity, not idle/busy state. |
| tmux_read_output | agent, workspace_id? | Returns bounded terminal text and a snapshot revision. |
| tmux_send_message | agent, message, expected_revision, submit, workspace_id? | Pastes literal single-line text, optionally presses Enter, only if a fresh snapshot still matches. |

Example: list agents, read pane %1, inspect that its prompt is ready and empty, then send:

~~~json
{"agent":"%1","message":"Review the latest experiment results and report the main findings.","expected_revision":"<64-character revision from tmux_read_output>","submit":true}
~~~

With submit=false, the text is pasted but Enter is not sent. The message must be single-line (up to 4000 characters); control characters and common secret patterns are rejected. A returned message_id is a delivery-attempt identifier, not an agent receipt. A successful call only means the terminal accepted the requested operations. Inspect before retrying; a timeout or race can leave text in the pane. Read output and check experiment records separately.

## Safety and limitations

- Disabled by default; send requires CODEXPRO_TMUX_ALLOW_SEND=1 and a non-off CodexPro write mode. Unset the send flag for read-only tmux access. The existing safe bash allowlist is unchanged.
- Only exact pane IDs within the locally authorized window, or explicit aliases in registry mode, are accepted; no arbitrary target selectors, shell commands, tmux flags, key chords or socket paths can be supplied by MCP. Plain text is passed to a named tmux buffer through stdin, not a shell.
- A target pane must be running the intended agent, not an ordinary shell. Common shells are rejected, and identity/workspace/copy-mode checks and a fresh terminal snapshot reduce misdelivery. They cannot eliminate time-of-check/time-of-use races, distinguish all CLI apps from shells, or guarantee the agent is ready. Use dedicated panes only; never expose a window or explicit pane with privileged or sensitive data. Do not change the pane during remote sends. This grants practical indirect execution through the target agent; retain agent approval controls.
- Only send if the terminal clearly shows an empty agent prompt. There is no reliable general idle detector, auto queue, task completion detector, multi-process lock or agent acknowledgement in this version. Terminal output is untrusted, may include secrets not caught by pattern-based redaction, and must not be treated as instructions.
- The bridge logs successful delivery metadata (message ID, alias, timestamp) to server stderr, not message content. No persistent research task history is implemented here; use the existing handoff and Git records for that.
- Existing upstream HTTP token authentication remains mandatory for public access. Review SECURITY.md before exposing the endpoint. Do not enable full bash or automatic permission bypass for this feature.
- Mock smoke tests cover guardrails and command construction. Real tmux/TUI compatibility should be verified with a harmless test message before running experiments.
