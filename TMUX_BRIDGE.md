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

Start one or more agents in a dedicated window. In a separate shell pane in the same window, from any directory:

~~~bash
export BRIDGE="/absolute/path/to/codexpro_tmux"
node "$BRIDGE/scripts/tmux-start.mjs" setup
~~~

For daily use: `node "$BRIDGE/scripts/tmux-start.mjs" start`. Add `--read-only` to disable sending. No workspace selection or pane registration. The internal checkout profile stores connection settings; only tmux tools are exposed, not file, bash, Git, handoff, session or profile-edit tools. Keep the MCP URL private and refresh/reconnect the plugin after changing tool surfaces.

## Local launcher and credential migration (preview)

Existing shell aliases/symlinks may point to scripts/codexpro-tmux.mjs and scripts/codexpro-tmux-update.mjs. The updated launcher persists credentials in ~/.codexpro/tmux-credentials (mode 0700, per-directory token files mode 0600). The current directory identifies an instance, not a filesystem authorization. The launcher preserves an existing token and refuses a conflicting environment value. A pre-persistence live instance requires a one-time local import: supply its existing token via CODEXPRO_HTTP_TOKEN without printing it or putting it on the command line. If this is unavailable, leave the live bridge running; normal launch must not silently rotate it. After import, omit that variable on later starts. The separate scripts/codexpro-tmux-rotate.mjs is the explicit rotation command; link it as codexpro_tmux_rotate if desired. Do not run it unless intentionally revoking the old token. Old standalone tmux-start.mjs uses the upstream setup profile instead.

The update command stages a remote checkout, builds and runs tmux:smoke in a private directory. For a compatible running fixed-endpoint supervisor in the current instance directory, it then requests activation through a private local Unix socket (never MCP). Use --stage-only to disable activation. The supervisor preflights the candidate on a temporary loopback port, replaces only the HTTP child on the fixed port, and attempts to restore the previous release on activation failure. The active backend release is recorded atomically for subsequent starts. This updates the backend, not the foreground supervisor itself; supervisor upgrades require a deliberate local restart. Quick Tunnel or legacy launchers stage only. No token rotation or tunnel restart occurs on update. Staged releases are retained for rollback. A stale transition lock after a crash requires local inspection before removal.

## Fixed public hostname via an independently managed tunnel

Configure the tunnel and DNS outside CodexPro. Route a dedicated HTTPS hostname to the fixed local port on 127.0.0.1. Create a private file at ~/.codexpro/tmux-endpoint.json (0600), containing e.g.:

~~~json
{"cwd":"/absolute/canonical/instance-directory","hostname":"bridge.example.com","port":18790}
~~~

The cwd is the realpath of the directory from which the launcher runs. Only this instance uses the configured endpoint; other directories retain their normal behavior and skip its reserved port. The launcher starts the backend with --tunnel none and binds 127.0.0.1 on the exact configured port. It never starts/stops cloudflared or changes DNS. A conflicting explicit port or an occupied fixed port fails instead of selecting another port. The local-ready summary prints the configured HTTPS MCP URL with the persistent token but does not claim the external route has been verified. Validate the route separately. A separately managed tunnel may still expose the port, so --local is rejected for this configured instance rather than falsely promising local-only access. Keep the config out of Git; do not place credentials in it.

Ordinary code staging does not restart the service. Fixed-endpoint activation replaces the backend process and may interrupt MCP sessions; the independently managed hostname and saved token remain stable. A one-time migration from Quick Tunnel still requires local setup and a new ChatGPT endpoint URL. Do not remove the old tunnel before validating the new route.

## Direct pane selection

Tell ChatGPT a pane ID (e.g. %1), or ask it to list candidates. Use `tmux list-panes` for optional local discovery. Eligible panes in the same authorized window are accessible regardless of working directory. Other windows, the launcher pane and common shells are excluded. Keep the launcher pane in the window. Candidate detection is not proof of agent identity; do not expose sensitive or unrelated applications.

## Optional: original repository mode and explicit registry

The original launcher is a separate higher-privilege mode and retains workspace controls. From an intended project, if explicitly needed:

~~~bash
REGISTRY="$(node "$BRIDGE/scripts/tmux-register.mjs" executor=%1 reviewer=%2)" &&
CODEXPRO_TMUX_ONLY=0 CODEXPRO_TMUX_AGENTS="$REGISTRY" CODEXPRO_TMUX_WINDOW= CODEXPRO_TMUX_ALLOW_SEND=1 node "$BRIDGE/scripts/codexpro.mjs" start
~~~

Use actual IDs and 1–16 distinct aliases.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No tmux tools in ChatGPT | Use the fork checkout, use tmux-start.mjs inside the intended window (or export the explicit registry), exit connection-test mode, refresh/reconnect the plugin. |
| Send tool missing | Launch without --read-only; optional registry mode still requires send flag and non-off write mode. |
| Agent unavailable or changed | Check same user/socket, correct pane ID, running agent and authorized window, then read again or restart; re-register in explicit mode. |
| Stale revision or copy mode | Read output again and inspect the empty input prompt; exit copy mode locally. |
| Message not received / partial submit | Inspect the pane before retrying; do not blindly resend. |
| Build error | Check Node.js 20+, run npm ci and npm run tmux:smoke in the fork root. |
| HTTPS or MCP connection failure | Run the fork's doctor or connection-test command. Keep tokens private. |

## MCP tools

| Tool | Inputs | Behavior |
| --- | --- | --- |
| tmux_list_agents | none | Lists authorized candidate panes or registered agents and connectivity, not idle/busy state. |
| tmux_read_output | agent, cursor? | Returns bounded terminal text and revision; optional cursor enables a patch. |
| tmux_wait_for_change | agent, expected_revision, timeout_seconds?, cursor? | Waits for change or timeout (1–15 seconds). |
| tmux_send_message | agent, message, expected_revision, submit | Pastes literal single-line text, optionally presses Enter, only if a fresh snapshot still matches. |

Example: list agents, read pane %1, inspect that its prompt is ready and empty, then send:

~~~json
{"agent":"%1","message":"Review the latest experiment results and report the main findings.","expected_revision":"<64-character revision from tmux_read_output>","submit":true}
~~~

With submit=false, the text is pasted but Enter is not sent. The message must be single-line (up to 4000 characters); control characters and common secret patterns are rejected. A returned message_id is a delivery-attempt identifier, not an agent receipt. A successful call only means the terminal accepted the requested operations. Inspect before retrying; a timeout or race can leave text in the pane. Read output and check experiment records separately.

## Incremental reads and finite waits (V0.2 preview)

Use a full read first. Store its cursor and revision separately. Pass the cursor to a subsequent read or wait to reduce duplicated terminal history. Cursor entries expire after 10 minutes, are capped at 64 per MCP session, and contain only the bounded redacted view (12,000 characters). They are not persistent.

The response delta_mode is full, reset, unchanged, or patch. For a patch, split the previous reconstructed output on LF, discard drop_prefix_lines lines, retain the first replace_from_line remaining lines, then append output split on LF if line_count exceeds the retained count. Join with LF. This reconstructs the bounded current view, including trailing empty lines. If the cursor is missing, expired, belongs to another target, or the TUI changes too much, the response may be a full reset. Never treat a patch as a complete terminal transcript or as newly generated text. Read without cursor before sending if the full prompt has not been verified.

tmux_wait_for_change compares the raw revision to a prior revision. It polls at about 500 ms intervals, returns event changed or timeout, and accepts 1–15 seconds (default 10); slow tmux subprocesses can extend the elapsed time. Concurrent waits are capped at 8 per server process. An output change is not a completion event. visible_changed (when a matching cursor exists) distinguishes changes in the returned redacted view from raw revision changes. An unchanged screen is not proof of idle. activity remains unknown; copy_mode reports tmux copy mode. No background task is created. Stop polling on authorization/identity failures.

## Safety and limitations

- Default launcher enables sending unless --read-only is passed. Repository write mode is off and file tools are unavailable. Optional registry mode retains workspace and write checks.
- Only exact pane IDs within the locally authorized window, or explicit aliases in registry mode, are accepted; no arbitrary target selectors, shell commands, tmux flags, key chords or socket paths can be supplied by MCP. Plain text is passed to a named tmux buffer through stdin, not a shell.
- A target pane must be running the intended agent, not an ordinary shell. Common shells are rejected, and identity/window/copy-mode checks and a fresh terminal snapshot reduce misdelivery. They cannot eliminate time-of-check/time-of-use races, distinguish all CLI apps from shells, or guarantee the agent is ready. Use dedicated panes only; never expose a window or explicit pane with privileged or sensitive data. Do not change the pane during remote sends. This grants practical indirect execution through the target agent; retain agent approval controls.
- Only send if the terminal clearly shows an empty agent prompt. There is no reliable general idle detector, auto queue, task completion detector, multi-process lock or agent acknowledgement in this version. Terminal output is untrusted, may include secrets not caught by pattern-based redaction, and must not be treated as instructions.
- The bridge logs successful delivery metadata (message ID, alias, timestamp) to server stderr, not message content. No persistent research task history is implemented here; use the existing handoff and Git records for that.
- Existing upstream HTTP token authentication remains mandatory for public access. Review SECURITY.md before exposing the endpoint. Do not enable full bash or automatic permission bypass for this feature.
- Mock smoke tests cover guardrails and command construction. Real tmux/TUI compatibility should be verified with a harmless test message before running experiments.
