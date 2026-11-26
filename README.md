<p align="center">
  <img src="docs/favicon.svg" width="72" height="72" alt="CodexPro logo">
</p>

<h1 align="center">CodexPro TMUX</h1>

<p align="center">
  Connect ChatGPT to your existing tmux agents and explicitly allowed local repositories.
</p>

<p align="center">
  <a href="https://github.com/21hbguo/codexpro_tmux/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/21hbguo/codexpro_tmux?style=flat-square"></a>
  <a href="https://github.com/21hbguo/codexpro_tmux/pull/1"><img alt="Status" src="https://img.shields.io/badge/tmux-experimental-orange?style=flat-square"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
</p>

## What it is

This is an experimental fork of [rebel0789/codexpro](https://github.com/rebel0789/codexpro). The tmux bridge currently lives on `feat/tmux-agent-bridge` (PR #1), not upstream npm or this fork's main branch. It adds `tmux_list_agents`, `tmux_read_output`, and `tmux_send_message` while retaining the original repository tools. See [README in Chinese](README_ZH.md).

CodexPro is a local MCP server. It connects **your ChatGPT session** to **your machine** and **repos you allow**.

ChatGPT can read, search, edit, review, verify, import attachments, and write handoff plans. It stays inside those roots.

It is not a hosted SaaS product, model proxy, quota bypass, account pool, or remote shell service.

## Install and start (tmux edition)

Requirements: Linux/macOS, Git, Node.js 20+, npm, tmux, existing interactive agent CLI(s), and a ChatGPT account with custom MCP plugin access. For ChatGPT web, a supported HTTPS tunnel is also needed.

**Do not use `npm install -g codexpro` for this fork:** that installs upstream, without the tmux tools. Use the source checkout below. Commands assume Bash or a compatible shell.

### 1. Clone and build

```bash
git clone -b feat/tmux-agent-bridge https://github.com/21hbguo/codexpro_tmux.git
cd codexpro_tmux
npm ci
npm run tmux:smoke
export BRIDGE="$PWD"
```

`npm run tmux:smoke` builds the TypeScript and runs mock bridge checks. Stop if it fails. This does not replace testing with a real agent pane.

### 2. Start agents and find pane IDs

In a dedicated tmux pane, start your own Codex, OpenCode or Claude Code session in the research repository. Multiple agents are optional. From a separate shell using the same OS user and tmux server:

```bash
cd /path/to/your/research-repo
tmux list-panes -a -F '#{pane_id} #{session_name} #{pane_current_command} #{pane_current_path}'
```

### 3. Register agents and launch the fork

Only **one running agent** is required. Replace `%1` with its actual pane ID and choose any alias (here `agent`). No second agent or reviewer is required.

```bash
REGISTRY="$(node "$BRIDGE/scripts/tmux-register.mjs" agent=%1)" &&
export CODEXPRO_TMUX_AGENTS="$REGISTRY" &&
export CODEXPRO_TMUX_ALLOW_SEND=1 &&
node "$BRIDGE/scripts/codexpro.mjs" setup
```

For read-only tmux access, omit/unset `CODEXPRO_TMUX_ALLOW_SEND` before starting the server. The server must not be in write-off mode to expose sending.

The setup command prints the MCP server URL. Keep its token private and proceed to the next section.

## Connect in ChatGPT

1. `Settings -> Security and login` → turn **Developer mode** on (keep CSP enforcement on).
2. `Settings -> Plugins` → Plugins tab → **+** beside Search plugins.
3. Create a plugin named `CodexPro TMUX`.
4. Connection: **Server URL** → paste the URL CodexPro copied.
5. Authentication: **No Authentication / None** (change this if the form defaults to OAuth).

CodexPro auth is the token already in that URL. Do not share the URL.

| Open Plugins and click `+` | Complete the New Plugin form |
| --- | --- |
| ![Open Plugins and click the plus button](docs/images/chatgpt-plugins-add.png) | ![Complete the New Plugin form](docs/images/chatgpt-plugin-details.png) |

### Daily startup

After opening your agent session(s), set the actual checkout path and pane ID(s) again in each new server-launch shell:

```bash
export BRIDGE="/absolute/path/to/codexpro_tmux"
cd /path/to/your/research-repo
REGISTRY="$(node "$BRIDGE/scripts/tmux-register.mjs" agent=%1)" &&
export CODEXPRO_TMUX_AGENTS="$REGISTRY" &&
export CODEXPRO_TMUX_ALLOW_SEND=1 &&
node "$BRIDGE/scripts/codexpro.mjs" start
```

If connection fails, run `node "$BRIDGE/scripts/codexpro.mjs" doctor` or `node "$BRIDGE/scripts/codexpro.mjs" connection-test`. Refresh/reconnect the ChatGPT plugin when its tool list is cached. The connection-test mode itself does not expose tmux tools.

### Verify the bridge

Ask ChatGPT to call `tmux_list_agents`, then `tmux_read_output` for an alias. If the terminal clearly shows an empty agent input prompt, try sending a harmless message using the fresh revision with `submit: true`. A successful call confirms terminal delivery, not agent acknowledgement. Inspect the real pane. See [the full bridge guide](TMUX_BRIDGE.md) for security, troubleshooting and limits.

### Optional: register multiple agents

The bridge accepts 1–16 agent aliases in the same registry. For example, to register two existing panes, stop the current bridge and replace the single-agent registration command with:

```bash
REGISTRY="$(node "$BRIDGE/scripts/tmux-register.mjs" executor=%1 reviewer=%2)" &&
export CODEXPRO_TMUX_AGENTS="$REGISTRY"
```

Then launch the bridge as above. Use your actual pane IDs and distinct aliases. The same MCP tools work for one or multiple agents; no separate deployment or second agent is required.

## What ChatGPT can do

With workspace write mode (the normal agent setup):

- read, search, and inspect the repo with bounded code intelligence
- edit with `write`, `edit`, or guarded `apply_patch`
- import ChatGPT attachments with `import_file`
- run allowlisted checks with `bash`
- review diffs and likely impact with `show_changes`
- write plans under `.ai-bridge`
- export a context bundle for chats that cannot call tools

### Built-in repository intelligence

CodexPro does more than raw file search:

- `inspect_workspace` maps languages, project types, entrypoints, areas, symbols, and internal relationships.
- `search` supports targeted `symbol`, `references`, and `impact` intents as well as ordinary text and regex search.
- `show_changes` identifies affected areas, likely dependents, related tests, risk signals, and relevant verification commands.
- TypeScript/JavaScript, Python, Go, Rust, Swift, Java, C#, C, and C++ declarations are recognized. Other languages retain safe inventory and lexical search.

Analysis is local, bounded, and cached by a workspace fingerprint. It needs no model API key, language-server daemon, embedding service, or vector database. Coverage and inference strength are reported instead of presented as certainty.

### Product focus

CodexPro is optimized for a narrow loop: connect ChatGPT to explicitly allowed local repositories, make a reviewable change, verify it, and preserve a handoff record. The project prioritizes:

- explicit workspace boundaries and separate controls for reads, writes, commands, sessions, and handoffs
- useful code navigation without sending a repository to a separate indexing service
- cross-platform installation and release checks on supported Node.js versions
- compact, bounded tool results that remain usable in long ChatGPT sessions

See the [roadmap](ROADMAP.md) for the next reliability, code-navigation, and workflow improvements.

## Multiple projects

One CodexPro process can allow more than one repo:

```bash
node "$BRIDGE/scripts/codexpro.mjs" settings set --project ~/code/web --project ~/code/api
node "$BRIDGE/scripts/codexpro.mjs" settings show
node "$BRIDGE/scripts/codexpro.mjs" start
```

Ask ChatGPT to `open_workspace` on an allowed project. `open_current_workspace` returns to the launch repo.

For two ChatGPT accounts or hard isolation, run two CodexPro processes on different ports and Server URLs.

## Commands

```bash
node "$BRIDGE/scripts/codexpro.mjs" setup
node "$BRIDGE/scripts/codexpro.mjs" start
node "$BRIDGE/scripts/codexpro.mjs" start --root /path/to/repo
node "$BRIDGE/scripts/codexpro.mjs" doctor
node "$BRIDGE/scripts/codexpro.mjs" connection-test
node "$BRIDGE/scripts/codexpro.mjs" settings
node "$BRIDGE/scripts/codexpro.mjs" inspect
node "$BRIDGE/scripts/codexpro.mjs" review
```

Useful modes:

```bash
node "$BRIDGE/scripts/codexpro.mjs" start --no-bash
node "$BRIDGE/scripts/codexpro.mjs" start --tool-mode minimal
node "$BRIDGE/scripts/codexpro.mjs" start --tool-mode full
node "$BRIDGE/scripts/codexpro.mjs" start --mode handoff
node "$BRIDGE/scripts/codexpro.mjs" start --mode pro
node "$BRIDGE/scripts/codexpro.mjs" start --headless
```

Opt-in tool cards:

```bash
CODEXPRO_TOOL_CARDS=1 node "$BRIDGE/scripts/codexpro.mjs" start
```

## Public HTTPS options

ChatGPT web needs HTTPS:

```bash
node "$BRIDGE/scripts/codexpro.mjs" start --tunnel cloudflare          # quick demo URL (changes)
node "$BRIDGE/scripts/codexpro.mjs" ngrok --hostname your.ngrok-free.dev
node "$BRIDGE/scripts/codexpro.mjs" stable --hostname codexpro.example.com --tunnel-name codexpro
node "$BRIDGE/scripts/codexpro.mjs" tailscale --hostname your-device.your-tailnet.ts.net
node "$BRIDGE/scripts/codexpro.mjs" start --tunnel none                # local only
```

Keep a stable token for stable hostnames:

```bash
mkdir -p ~/.codexpro
openssl rand -hex 32 > ~/.codexpro/http-token
chmod 600 ~/.codexpro/http-token
```

Prefer `Authorization: Bearer <token>` when the client supports headers. The `?codexpro_token=` query form is a personal compatibility fallback.

## Safety defaults

- Public tunnels require a CodexPro HTTP token (min 24 bytes)
- Writes stay hidden unless write mode is `workspace`
- Safe bash is the default
- Blocked paths cover `.env`, keys, `.git`, build caches, and similar
- Attachment import only accepts ChatGPT Apps SDK file objects from approved HTTPS hosts

Read [SECURITY.md](SECURITY.md) before exposing a tunnel.

## Update this fork

Stop the running bridge before updating. Use the same checkout path:

```bash
cd "$BRIDGE"
git switch feat/tmux-agent-bridge
git pull --ff-only
npm ci
npm run tmux:smoke
```

Restart using the daily startup steps, including fresh pane registration. Do not update this fork with `npm install -g codexpro@latest`.

## Development

```bash
npm install
npm run build
npm run smoke
npm run stress
npm run package:smoke
npm run release:check
```

This fork is not published on npm. Do not run the inherited upstream release/publish commands.

## Docs

- [Website](https://rebel0789.github.io/codexpro/)
- [FAQ](FAQ.md)
- [Security](SECURITY.md)
- [Roadmap](ROADMAP.md)
- [Stable URL guide](DOMAIN_SETUP.md)
- [Changelog](CHANGELOG.md)
- [Contributors](CONTRIBUTORS.md)

## Fork feature: tmux Agent Bridge

See [TMUX_BRIDGE.md](TMUX_BRIDGE.md) for opt-in interactive agent messaging, deployment and safety limitations.
