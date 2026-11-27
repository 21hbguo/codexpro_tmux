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

This is an experimental fork of [rebel0789/codexpro](https://github.com/rebel0789/codexpro). It adds `tmux_list_agents`, `tmux_read_output`, `tmux_send_message`, and `tmux_wait_for_change` on the `main` branch (merged from PR #1), while retaining the original repository tools. See [README in Chinese](README_ZH.md).

CodexPro is a local MCP server. It connects **your ChatGPT session** to **your machine** and **repos you allow**.

ChatGPT can read, search, edit, review, verify, import attachments, and write handoff plans. It stays inside those roots.

It is not a hosted SaaS product, model proxy, quota bypass, account pool, or remote shell service.

## Install and start (tmux edition)

Requirements: Linux/macOS, Git, Node.js 20+, npm, tmux, existing interactive agent CLI(s), and a ChatGPT account with custom MCP plugin access. For ChatGPT web, a supported HTTPS tunnel is also needed.

**Do not use `npm install -g codexpro` for this fork:** that installs upstream, without the tmux tools. Use the source checkout below. Commands assume Bash or a compatible shell.

### 1. Clone and build

```bash
git clone https://github.com/21hbguo/codexpro_tmux.git
cd codexpro_tmux
npm ci
npm run tmux:smoke
npm run tmux:install
```

`npm run tmux:smoke` builds the TypeScript and runs mock bridge checks. Stop if it fails. This does not replace testing with a real agent pane.

### 2. Launch tmux-only mode

Start one or more agents in a dedicated tmux window and open a separate shell pane in that window. From **any directory**:

```bash
codexpro_tmux setup bridge.example.com
codexpro_tmux
```

Replace bridge.example.com with your hostname. Setup saves the domain and port (default 8790); existing fixed configuration is reused. Configure your named tunnel or HTTPS reverse proxy to http://127.0.0.1:8790; DNS and tunnel changes are not performed by the CLI. Without a configured domain, explicitly use `codexpro_tmux --quick-tunnel`. Use `--read-only` at startup to disable sending. Keep the MCP URL private.

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

In a shell pane in the desired window (any directory):

```bash
codexpro_tmux
```

Hostname, port and token do not depend on the working directory. Use `codexpro_tmux add` or `codexpro_tmux remove` in another window; run `codexpro_tmux_update` from any directory. Add `--read-only` to disable sending. Tell ChatGPT a pane ID (e.g. %1), or ask it to list candidates. No alias or workspace required. Optional local discovery: `tmux list-panes`. Agents can work in different directories. Read the target output and verify its empty agent prompt before sending.

Incremental reads accept a cursor; bounded waits detect output changes, not agent completion. See [TMUX_BRIDGE.md](TMUX_BRIDGE.md).

### Optional original repository mode

The original `scripts/codexpro.mjs` is a separate higher-privilege mode with workspace controls and file tools. Use only when explicitly needed. See [TMUX_BRIDGE.md](TMUX_BRIDGE.md).

## Original CodexPro features (optional mode only)

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

## Multiple projects (original repository mode)

One CodexPro process can allow more than one repo:

```bash
node "$BRIDGE/scripts/codexpro.mjs" settings set --project ~/code/web --project ~/code/api
node "$BRIDGE/scripts/codexpro.mjs" settings show
node "$BRIDGE/scripts/codexpro.mjs" start
```

Ask ChatGPT to `open_workspace` on an allowed project. `open_current_workspace` returns to the launch repo.

For two ChatGPT accounts or hard isolation, run two CodexPro processes on different ports and Server URLs.

## Commands (original repository mode)

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
git switch main
git pull --ff-only
npm ci
npm run tmux:smoke
```

Restart using the daily startup steps, without pane registration. Do not update this fork with `npm install -g codexpro@latest`.

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
