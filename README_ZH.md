<p align="center">
  <img src="docs/favicon.svg" width="72" height="72" alt="CodexPro logo">
</p>

<h1 align="center">CodexPro TMUX</h1>

<p align="center">
  让网页版 ChatGPT 直接向本地 tmux Agent 发送消息、读取输出，并使用原有仓库工具。
</p>

<p align="center">
  <a href="https://github.com/21hbguo/codexpro_tmux/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/21hbguo/codexpro_tmux?style=flat-square"></a>
  <a href="https://github.com/21hbguo/codexpro_tmux/pull/1"><img alt="Status" src="https://img.shields.io/badge/tmux-experimental-orange?style=flat-square"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
</p>

<p align="center">
  <a href="README.md">English</a>
  ·
  <a href="https://rebel0789.github.io/codexpro/zh.html">中文网站</a>
  ·
  <a href="FAQ_ZH.md">中文 FAQ</a>
  ·
  <a href="SECURITY.md">安全说明</a>
</p>

## 它是什么

本项目基于 [rebel0789/codexpro](https://github.com/rebel0789/codexpro) 二次开发。tmux 功能目前位于 `feat/tmux-agent-bridge` 分支（PR #1），并未发布到 npm 或合并到本 fork 的 main。新增 `tmux_list_agents`、`tmux_read_output`、`tmux_send_message`，保留原版仓库工具。

CodexPro 是本地 MCP server。它连接**你的 ChatGPT 会话**、**你的机器**和**你允许的仓库**。

ChatGPT 可以读取、搜索、编辑、审查、验证、导入附件，并写 handoff 计划。范围始终限制在这些 root 内。

它不是托管 SaaS、模型代理、配额绕过、账号池或远程 shell 服务。

## 安装与启动（tmux 版）

环境要求：Linux/macOS、Git、Node.js 20+、npm、tmux、已安装的 Agent CLI，以及支持自定义 MCP 插件的 ChatGPT 账号。网页版还需要可访问的 HTTPS 隧道。

**不要使用 `npm install -g codexpro` 安装本 fork**，那会安装原版，缺少 tmux 工具。以下命令使用 Bash 或兼容 Shell。

### 1. 克隆并构建

```bash
git clone -b feat/tmux-agent-bridge https://github.com/21hbguo/codexpro_tmux.git
cd codexpro_tmux
npm ci
npm run tmux:smoke
export BRIDGE="$PWD"
```

`npm run tmux:smoke` 会构建 TypeScript 并运行模拟测试。若失败请先排查，不要继续部署；模拟测试不等同于真实 Agent 联调。

### 2. 启动 Agent 并查询 pane ID

在专用 tmux pane 中打开研究项目，启动 Codex、OpenCode 或 Claude Code 等交互式 Agent。使用同一个系统用户及 tmux server，在另一个终端中执行：

```bash
cd /path/to/your/research-repo
tmux list-panes -a -F '#{pane_id} #{session_name} #{pane_current_command} #{pane_current_path}'
```

### 3. 注册 Agent 并启动本 fork

将 `%1`、`%2` 换成真实 pane ID；只用一个 Agent 时可以省略第二个注册项。别名可自定义。

```bash
REGISTRY="$(node "$BRIDGE/scripts/tmux-register.mjs" executor=%1 reviewer=%2)" &&
export CODEXPRO_TMUX_AGENTS="$REGISTRY" &&
export CODEXPRO_TMUX_ALLOW_SEND=1 &&
node "$BRIDGE/scripts/codexpro.mjs" setup
```

若仅需读取终端，启动前不要设置 `CODEXPRO_TMUX_ALLOW_SEND`（或执行 `unset CODEXPRO_TMUX_ALLOW_SEND`）。要发送消息，服务的 write mode 不能为 off。

setup 输出的 MCP Server URL 含认证 token，不要公开。接下来连接 ChatGPT。

## 在 ChatGPT 中连接

1. `Settings -> Security and login` → 打开 **Developer mode**（保持 CSP 开启）。
2. `Settings -> Plugins` → Plugins 标签页 → 搜索框旁的 **+**。
3. 创建名为 `CodexPro TMUX` 的插件。
4. 连接方式：**Server URL** → 粘贴 CodexPro 复制的 URL。
5. 认证：**No Authentication / None**（表单可能默认 OAuth，创建前改掉）。

CodexPro 的认证就在这个 URL 里的 token。不要分享该 URL。

| 打开 Plugins 并点击 `+` | 填写 New Plugin 表单 |
| --- | --- |
| ![打开 Plugins 并点击加号](docs/images/chatgpt-plugins-add.png) | ![填写 New Plugin 表单](docs/images/chatgpt-plugin-details.png) |

### 日常启动

启动 Agent 后，在每个新的服务启动终端重新设置实际安装路径和 pane ID：

```bash
export BRIDGE="/absolute/path/to/codexpro_tmux"
cd /path/to/your/research-repo
REGISTRY="$(node "$BRIDGE/scripts/tmux-register.mjs" executor=%1 reviewer=%2)" &&
export CODEXPRO_TMUX_AGENTS="$REGISTRY" &&
export CODEXPRO_TMUX_ALLOW_SEND=1 &&
node "$BRIDGE/scripts/codexpro.mjs" start
```

连接失败时可以运行 `node "$BRIDGE/scripts/codexpro.mjs" doctor` 或 `node "$BRIDGE/scripts/codexpro.mjs" connection-test`。连接测试模式本身不暴露 tmux 工具。若 ChatGPT 缓存旧工具列表，请刷新或重新连接插件。

### 验证是否成功

先让 ChatGPT 调用 `tmux_list_agents` 查询别名，再调用 `tmux_read_output` 读取某个 Agent。确认终端显示空闲且空白的输入框后，使用返回的 revision 和 `submit: true` 发送一条无害测试消息，并在真实 pane 中确认是否收到。成功回执仅表示终端提交，不代表 Agent 已确认或完成任务。

完整参数、安全边界与限制见 [TMUX_BRIDGE.md](TMUX_BRIDGE.md)。

## ChatGPT 能做什么

在 workspace write 模式（常规 agent 设置）下：

- 使用有边界的代码智能读取、搜索和检查仓库
- 用 `write`、`edit` 或受保护的 `apply_patch` 编辑
- 用 `import_file` 导入 ChatGPT 附件
- 用 `bash` 运行白名单检查
- 用 `show_changes` 审查 diff 及可能的影响范围
- 在 `.ai-bridge` 下写计划
- 为不能调工具的会话导出 context bundle

### 内置仓库智能

CodexPro 不只是原始文件搜索：

- `inspect_workspace` 会映射语言、项目类型、入口、区域、符号和内部关系。
- `search` 除普通文本和正则搜索外，还支持 `symbol`、`references` 和 `impact` 意图。
- `show_changes` 会给出受影响区域、可能的依赖方、相关测试、风险信号和建议验证命令。
- 可识别 TypeScript/JavaScript、Python、Go、Rust、Swift、Java、C#、C 和 C++ 声明；其他语言仍可安全清点和词法搜索。

分析完全在本地运行，受明确上限约束，并按工作区指纹缓存。它不需要额外的模型 API key、语言服务器守护进程、向量数据库或 embedding 服务。覆盖不完整或关系仅为推断时，结果会明确标示，而不会伪装成确定结论。

### 产品重点

CodexPro 专注于一个清晰流程：把 ChatGPT 连接到明确允许的本地仓库，完成可审查的修改，运行验证，并保留交接记录。项目优先保证：

- 明确的工作区边界，以及读取、写入、命令、会话和交接的独立控制
- 无需把仓库发送到独立索引服务，也能获得实用代码导航
- 在支持的 Node.js 版本上进行跨平台安装和发布验证
- 紧凑、有边界的工具结果，让长时间 ChatGPT 会话仍然可用

后续可靠性、代码导航和工作流改进见[路线图](ROADMAP.md)。

## 多项目

一个 CodexPro 进程可以允许多个仓库：

```bash
node "$BRIDGE/scripts/codexpro.mjs" settings set --project ~/code/web --project ~/code/api
node "$BRIDGE/scripts/codexpro.mjs" settings show
node "$BRIDGE/scripts/codexpro.mjs" start
```

让 ChatGPT 对已允许项目执行 `open_workspace`。`open_current_workspace` 切回启动仓库。

两个 ChatGPT 账号或需要硬隔离时，用不同端口和 Server URL 跑两个 CodexPro 进程。

## 命令

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

常用模式：

```bash
node "$BRIDGE/scripts/codexpro.mjs" start --no-bash
node "$BRIDGE/scripts/codexpro.mjs" start --tool-mode minimal
node "$BRIDGE/scripts/codexpro.mjs" start --tool-mode full
node "$BRIDGE/scripts/codexpro.mjs" start --mode handoff
node "$BRIDGE/scripts/codexpro.mjs" start --mode pro
node "$BRIDGE/scripts/codexpro.mjs" start --headless
```

可选工具卡片：

```bash
CODEXPRO_TOOL_CARDS=1 node "$BRIDGE/scripts/codexpro.mjs" start
```

## 公网 HTTPS

ChatGPT Web 需要 HTTPS：

```bash
node "$BRIDGE/scripts/codexpro.mjs" start --tunnel cloudflare
node "$BRIDGE/scripts/codexpro.mjs" ngrok --hostname your.ngrok-free.dev
node "$BRIDGE/scripts/codexpro.mjs" stable --hostname codexpro.example.com --tunnel-name codexpro
node "$BRIDGE/scripts/codexpro.mjs" tailscale --hostname your-device.your-tailnet.ts.net
node "$BRIDGE/scripts/codexpro.mjs" start --tunnel none
```

稳定主机名请固定 token：

```bash
mkdir -p ~/.codexpro
openssl rand -hex 32 > ~/.codexpro/http-token
chmod 600 ~/.codexpro/http-token
```

客户端支持 header 时优先用 `Authorization: Bearer <token>`。`?codexpro_token=` 只是个人兼容回退。

## 安全默认

- 公网 tunnel 需要 CodexPro HTTP token（至少 24 bytes）
- 非 workspace write 模式不暴露写入工具
- 默认 safe bash
- 拦截 `.env`、密钥、`.git`、构建缓存等路径
- 附件导入只接受已批准 HTTPS 主机上的 ChatGPT Apps SDK 文件对象

公网暴露前先读 [SECURITY.md](SECURITY.md)。

## 更新本 fork

先停止正在运行的 bridge，然后在同一安装目录中：

```bash
cd "$BRIDGE"
git switch feat/tmux-agent-bridge
git pull --ff-only
npm ci
npm run tmux:smoke
```

重新执行日常启动步骤及 pane 注册。不要使用 `npm install -g codexpro@latest` 更新本 fork。

## 文档

- [中文网站](https://rebel0789.github.io/codexpro/zh.html)
- [中文 FAQ](FAQ_ZH.md)
- [Security](SECURITY.md)
- [路线图](ROADMAP.md)
- [稳定 URL 指南](DOMAIN_SETUP.md)
- [Changelog](CHANGELOG.md)
- [Contributors](CONTRIBUTORS.md)

## 本 fork：tmux Agent Bridge

支持向本地明确注册的 tmux Agent pane 读取输出、发送消息。默认关闭；部署、权限和限制见 [tmux bridge 指南](TMUX_BRIDGE.md)。
