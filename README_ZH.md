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

本项目基于 [rebel0789/codexpro](https://github.com/rebel0789/codexpro) 二次开发，已通过 PR #1 合入本 fork 的 `main` 分支（未发布到 npm）。新增 `tmux_list_agents`、`tmux_read_output`、`tmux_send_message`、`tmux_wait_for_change`，保留原版仓库工具。

CodexPro 是本地 MCP server。它连接**你的 ChatGPT 会话**、**你的机器**和**你允许的仓库**。

ChatGPT 可以读取、搜索、编辑、审查、验证、导入附件，并写 handoff 计划。范围始终限制在这些 root 内。

它不是托管 SaaS、模型代理、配额绕过、账号池或远程 shell 服务。

## 安装与启动（tmux 版）

环境要求：Linux/macOS、Git、Node.js 20+、npm、tmux、已安装的 Agent CLI，以及支持自定义 MCP 插件的 ChatGPT 账号。网页版还需要可访问的 HTTPS 隧道。

**不要使用 `npm install -g codexpro` 安装本 fork**，那会安装原版，缺少 tmux 工具。以下命令使用 Bash 或兼容 Shell。

### 1. 克隆并构建

```bash
git clone https://github.com/21hbguo/codexpro_tmux.git
cd codexpro_tmux
npm ci
npm run tmux:smoke
npm run tmux:install
```

`npm run tmux:smoke` 会构建 TypeScript 并运行模拟测试。若失败请先排查，不要继续部署；模拟测试不等同于真实 Agent 联调。

### 2. 启动 tmux-only 模式

在专用 tmux Window 内启动一个或多个 Agent，再新建一个普通 Shell pane，在**任意目录**执行：

```bash
codexpro_tmux setup bridge.example.com
codexpro_tmux
```

将 `bridge.example.com` 换成自己的域名。首次 setup 持久化域名和端口（默认 8790），已有配置直接复用。将 Cloudflare Named Tunnel 或 HTTPS 反向代理指向 `http://127.0.0.1:8790`；工具不会修改 DNS 或隧道。无固定域名时显式使用 `codexpro_tmux --quick-tunnel`，不会自动回退。启动时加 `--read-only` 可禁用发送。保护 MCP URL，不要授权含敏感程序的 Window。

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

在目标 Window 的普通 Shell pane 中执行（任意目录）：

```bash
codexpro_tmux
```

固定域名、端口和 Token 不随工作目录变化。同一 tmux server 的其他 Window 再执行 `codexpro_tmux`，自动加入原服务后退出；也可以显式使用 `codexpro_tmux add`，使用 `codexpro_tmux remove` 移除。重复启动不重启在线服务、不生成新 URL/Token。`codexpro_tmux_update` 在任意目录运行。加 `--read-only` 可禁用发送。直接告诉 ChatGPT pane ID，例如 %1，或让它查询候选 Agent。也可以自行运行 `tmux list-panes`。同 Window 中不同工作目录的 Agent 均可通信，无需注册或重启。发送前先读取并确认空白的 Agent 输入框。

读取支持 cursor 增量快照；新增有限等待工具检测终端输出变化，不将其误判为任务完成。详见 [TMUX_BRIDGE.md](TMUX_BRIDGE.md)。

### 可选：原版仓库模式

原有 `scripts/codexpro.mjs` 保留为单独的高权限模式，继续使用 Workspace 和文件操作工具。仅需 tmux 通信时不要使用。详见 [TMUX_BRIDGE.md](TMUX_BRIDGE.md)。

## 原版 CodexPro 功能（可选仓库模式）

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

## 多项目（原版仓库模式）

一个 CodexPro 进程可以允许多个仓库：

```bash
node "$BRIDGE/scripts/codexpro.mjs" settings set --project ~/code/web --project ~/code/api
node "$BRIDGE/scripts/codexpro.mjs" settings show
node "$BRIDGE/scripts/codexpro.mjs" start
```

让 ChatGPT 对已允许项目执行 `open_workspace`。`open_current_workspace` 切回启动仓库。

两个 ChatGPT 账号或需要硬隔离时，用不同端口和 Server URL 跑两个 CodexPro 进程。

## 命令（原版仓库模式）

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
git switch main
git pull --ff-only
npm ci
npm run tmux:smoke
```

重新执行日常启动步骤，无需注册 pane。不要使用 `npm install -g codexpro@latest` 更新本 fork。

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
