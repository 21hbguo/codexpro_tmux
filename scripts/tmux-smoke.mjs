import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import path from "node:path";
import { TmuxBridge, registerTmuxAgent, tmuxToolEnabled, authorizeTmuxWindow, tmuxOnlyMode } from "../dist/tmuxOps.js";

const root = realpathSync(".");
const socket = path.join(root, "fake-tmux.sock");
let serverPid = "100", panePid = "200", command = "node", dead = "0", mode = "0", screen = "Agent ready >";
let cwd = root;
const calls = [];
const run = (s, args, input) => {
  calls.push({ s, args, input });
  if (args[0] === "display-message") return ["%1", serverPid, panePid, command, dead, mode, cwd, socket, "@1"].join("\t") + "\n";
  if (args[0] === "capture-pane") return screen;
  return "";
};
const registry = JSON.stringify({ executor: registerTmuxAgent(root, "%1", run) });
const bridge = new TmuxBridge(registry, run);
assert.equal(bridge.list(root)[0].status, "connected");
assert.equal(bridge.list(path.dirname(root)).length, 0);
assert.throws(() => bridge.read(root, "%1"), /not registered/);
assert.throws(() => bridge.read(path.dirname(root), "executor"), /not registered/);
const r = bridge.read(root, "executor");
assert.equal(r.output, screen);
assert.equal(r.delta_mode, "full");
assert.equal(bridge.read(root, "executor", r.cursor).delta_mode, "unchanged");
assert.equal(bridge.read(root, "executor", "unknown").delta_mode, "reset");
assert.throws(() => bridge.send(root, "executor", "bad\nline", r.revision, true), /single-line/);
assert.throws(() => bridge.send(root, "executor", "\u001b[201~", r.revision, true), /single-line/);
screen = "Changed";
assert.throws(() => bridge.send(root, "executor", "test", r.revision, true), /changed/i);
assert.equal(calls.some(c => c.args[0] === "paste-buffer"), false);
screen = "Agent ready >";
const literal = "Check $HOME; echo 'hello' & < >";
const sent = bridge.send(root, "executor", literal, r.revision, true);
assert.equal(sent.status, "submitted_to_terminal");
assert.equal(sent.acknowledged, false);
assert.equal(calls.find(c => c.args[0] === "load-buffer").input, literal);
assert(calls.some(c => c.args[0] === "paste-buffer"));
assert(calls.some(c => c.args.join(" ") === "send-keys -t %1 Enter"));
calls.length = 0;
assert.equal(bridge.send(root, "executor", "draft", r.revision, false).status, "pasted_to_terminal");
assert(!calls.some(c => c.args[0] === "send-keys"));
mode = "1";
assert.throws(() => bridge.send(root, "executor", "test", bridge.read(root, "executor").revision, true), /copy mode/);
mode = "0";
command = "bash";
assert.throws(() => bridge.read(root, "executor"), /identity changed/);
assert.throws(() => registerTmuxAgent(root, "%1", run), /shell/);
command = "node";
serverPid = "101";
assert.throws(() => bridge.read(root, "executor"), /identity changed/);
serverPid = "100";
panePid = "201";
assert.throws(() => bridge.read(root, "executor"), /identity changed/);
panePid = "200";
cwd = path.dirname(root);
assert.throws(() => bridge.read(root, "executor"), /outside/);
cwd = root;
// Reconstruct patches exactly, including suffix deletion and trailing empty lines.
function applyView(previous, next) {
  if (next.delta_mode === "unchanged") return previous;
  if (next.delta_mode !== "patch") return next.output;
  const kept = previous.split("\n").slice(next.drop_prefix_lines, next.drop_prefix_lines + next.replace_from_line);
  if (next.line_count > kept.length) kept.push(...next.output.split("\n"));
  return kept.join("\n");
}
screen = "line 1\nline 2\nline 3\nold footer";
const v1 = bridge.read(root, "executor");
screen = "line 1\nline 2\nline 3\nnew footer\n";
const v2 = bridge.read(root, "executor", v1.cursor);
assert.equal(v2.delta_mode, "patch");
assert.equal(applyView(v1.output, v2), screen);
screen = "line 2\nline 3\nnew footer\n\nnext";
const v3 = bridge.read(root, "executor", v2.cursor);
assert.equal(applyView(screen === v2.output ? v2.output : applyView(v1.output, v2), v3), screen);
screen = "line 2\nline 3";
const v4 = bridge.read(root, "executor", v3.cursor);
assert.equal(applyView(applyView(applyView(v1.output, v2), v3), v4), screen);
screen = "entire screen replaced";
assert.equal(bridge.read(root, "executor", v4.cursor).delta_mode, "reset");
const w1 = bridge.read(root, "executor");
setTimeout(() => { screen = "changed by timer"; }, 50);
const w2 = await bridge.waitForChange(root, "executor", w1.revision, 2, w1.cursor);
assert.equal(w2.event, "changed");
assert.equal(w2.output, screen);
const w3 = await bridge.waitForChange(root, "executor", w2.revision, 1, w2.cursor);
assert.equal(w3.event, "timeout");
assert.equal(w3.delta_mode, "unchanged");
await assert.rejects(bridge.waitForChange(root, "executor", w3.revision, 16), /timeout/);
screen = "OPENAI_API_KEY=sk-realSecretValue123";
assert(!bridge.read(root, "executor").output.includes("sk-realSecretValue123"));
assert.throws(() => new TmuxBridge("{}", run), /Register/);
assert.throws(() => new TmuxBridge(JSON.stringify({ a: JSON.parse(registry).executor, b: JSON.parse(registry).executor }), run), /Duplicate/);
delete process.env.CODEXPRO_TMUX_ONLY;
delete process.env.CODEXPRO_TMUX_AGENTS;
delete process.env.CODEXPRO_TMUX_WINDOW;
delete process.env.CODEXPRO_TMUX_ALLOW_SEND;
const config = { connectionTest: false, writeMode: "workspace" };
assert.equal(tmuxToolEnabled(config, "tmux_list_agents"), false);
process.env.CODEXPRO_TMUX_AGENTS = registry;
assert.equal(tmuxToolEnabled(config, "tmux_list_agents"), true);
assert.equal(tmuxToolEnabled(config, "tmux_send_message"), false);
process.env.CODEXPRO_TMUX_ALLOW_SEND = "1";
assert.equal(tmuxToolEnabled(config, "tmux_send_message"), true);
assert.equal(tmuxToolEnabled({ ...config, writeMode: "off" }, "tmux_send_message"), false);
assert.equal(tmuxToolEnabled({ ...config, connectionTest: true }, "tmux_list_agents"), false);
delete process.env.CODEXPRO_TMUX_AGENTS;
const panes = new Map([
  ["%0", ["100", "1000", "node", "0", "0", root, socket, "@1"]],
  ["%1", ["100", "1001", "codex", "0", "0", root, socket, "@1"]],
  ["%2", ["100", "1002", "bash", "0", "0", root, socket, "@1"]],
  ["%3", ["100", "1003", "codex", "0", "0", root, socket, "@2"]],
  ["%4", ["100", "1004", "codex", "0", "0", path.dirname(root), socket, "@1"]]
]);
const windowCalls = [];
const windowRun = (s, args, input) => {
  windowCalls.push({ s, args, input });
  if (args[0] === "display-message") {
    const id = args[args.indexOf("-t") + 1];
    if (!panes.has(id)) throw Error("missing pane");
    return [id, ...panes.get(id)].join("\t") + "\n";
  }
  if (args[0] === "list-panes") {
    assert.equal(args[args.indexOf("-t") + 1], "@1");
    return [...panes].filter(([, p]) => p[7] === "@1").map(([id]) => id).join("\n");
  }
  if (args[0] === "capture-pane") return "Agent input >";
  return "";
};
const scope = JSON.stringify(authorizeTmuxWindow("%0", windowRun));
const windowBridge = new TmuxBridge("", windowRun, scope);
assert.deepEqual(windowBridge.list().map(p => p.agent), ["%1", "%4"]);
assert.deepEqual(windowBridge.list(path.dirname(root)).map(p => p.agent), ["%1", "%4"]);
for (const bad of ["%0", "%2", "%3", "some:window", "%1;kill-server"]) {
  assert.throws(() => windowBridge.read(root, bad));
}
assert(!windowCalls.some(c => c.args[0] === "capture-pane"));
const first = windowBridge.read(root, "%1");
assert.equal(windowBridge.send(root, "%1", "hello", first.revision, true).status, "submitted_to_terminal");
panes.set("%5", ["100", "1005", "opencode", "0", "0", root, socket, "@1"]);
assert.deepEqual(windowBridge.list().map(p => p.agent), ["%1", "%4", "%5"]);
const cross = windowBridge.read(undefined, "%4");
assert.equal(windowBridge.read(undefined, "%4", first.cursor).delta_mode, "reset");
assert.equal(windowBridge.send(undefined, "%4", "cross-directory test", cross.revision, true).status, "submitted_to_terminal");
panes.get("%1")[1] = "2001";
assert.throws(() => windowBridge.send(root, "%1", "stale", first.revision, true), /changed/i);
panes.get("%1")[7] = "@2";
assert.throws(() => windowBridge.read(root, "%1"), /outside/);
panes.get("%0")[7] = "@2";
assert.throws(() => windowBridge.list(root), /window changed/);
assert.throws(() => new TmuxBridge(registry, windowRun, scope), /Choose window mode/);
process.env.CODEXPRO_TMUX_WINDOW = scope;
assert.equal(tmuxToolEnabled(config, "tmux_list_agents"), true);
assert.equal(tmuxToolEnabled(config, "tmux_send_message"), true);
process.env.CODEXPRO_TMUX_ONLY = "1";
assert.equal(tmuxOnlyMode(), true);
assert.equal(tmuxToolEnabled({ ...config, writeMode: "off" }, "tmux_send_message"), true);
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { createCodexProServer } = await import("../dist/server.js");
const { loadConfig } = await import("../dist/config.js");
async function checkSurface(allowSend, expected) {
  process.env.CODEXPRO_TMUX_ALLOW_SEND = allowSend ? "1" : "0";
  const mcp = createCodexProServer(loadConfig(["--root", root, "--write", "off", "--bash", "off", "--tool-mode", "full"]));
  const client = new Client({ name: "tmux-test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await mcp.connect(st);
    await client.connect(ct);
    const result = await client.listTools();
    assert.deepEqual(result.tools.map(t => t.name).sort(), expected.sort());
    for (const tool of result.tools) assert(!Object.hasOwn(tool.inputSchema.properties ?? {}, "workspace_id"));
  } finally {
    await client.close();
    await mcp.close();
  }
}
await checkSurface(true, ["tmux_list_agents", "tmux_read_output", "tmux_send_message", "tmux_wait_for_change"]);
await checkSurface(false, ["tmux_list_agents", "tmux_read_output", "tmux_wait_for_change"]);
delete process.env.CODEXPRO_TMUX_ONLY;
delete process.env.CODEXPRO_TMUX_WINDOW;
delete process.env.CODEXPRO_TMUX_ALLOW_SEND;
console.log("tmux bridge mock smoke passed");
