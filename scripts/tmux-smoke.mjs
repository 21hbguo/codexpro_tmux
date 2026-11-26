import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import path from "node:path";
import { TmuxBridge, registerTmuxAgent, tmuxToolEnabled, authorizeTmuxWindow } from "../dist/tmuxOps.js";

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
screen = "OPENAI_API_KEY=sk-realSecretValue123";
assert(!bridge.read(root, "executor").output.includes("sk-realSecretValue123"));
assert.throws(() => new TmuxBridge("{}", run), /Register/);
assert.throws(() => new TmuxBridge(JSON.stringify({ a: JSON.parse(registry).executor, b: JSON.parse(registry).executor }), run), /Duplicate/);
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
const scope = JSON.stringify(authorizeTmuxWindow(root, "%0", windowRun));
const windowBridge = new TmuxBridge("", windowRun, scope);
assert.deepEqual(windowBridge.list(root).map(p => p.agent), ["%1"]);
assert.deepEqual(windowBridge.list(path.dirname(root)), []);
for (const bad of ["%0", "%2", "%3", "%4", "some:window", "%1;kill-server"]) {
  assert.throws(() => windowBridge.read(root, bad));
}
assert(!windowCalls.some(c => c.args[0] === "capture-pane"));
const first = windowBridge.read(root, "%1");
assert.equal(windowBridge.send(root, "%1", "hello", first.revision, true).status, "submitted_to_terminal");
panes.set("%5", ["100", "1005", "opencode", "0", "0", root, socket, "@1"]);
assert.deepEqual(windowBridge.list(root).map(p => p.agent), ["%1", "%5"]);
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
delete process.env.CODEXPRO_TMUX_WINDOW;
console.log("tmux bridge mock smoke passed");
