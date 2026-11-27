import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TmuxBridge, authorizeTmuxWindow, readWindowAuthorization, withWindowAuthorizationLock } from "../dist/tmuxOps.js";
import { writePrivateJson } from "./tmux-lifecycle.mjs";
import { prepareWindows } from "./tmux-windows.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-windows-smoke-"));
const socket = path.join(dir, "tmux.sock"), file = path.join(dir, "test.windows.json");
const panes = new Map([
  ["%0", ["100", "1000", "node", "0", "0", dir, socket, "@1"]],
  ["%1", ["100", "1001", "codex", "0", "0", dir, socket, "@1"]],
  ["%2", ["100", "1002", "devin", "0", "0", dir, socket, "@2"]],
  ["%3", ["100", "1003", "bash", "0", "0", dir, socket, "@2"]],
  ["%4", ["100", "1004", "codex", "0", "0", dir, socket, "@3"]]
]);
const run = (s, args) => {
  if (args[0] === "display-message") {
    const id = args[args.indexOf("-t") + 1];
    if (!panes.has(id)) throw Error("missing pane");
    return [id, ...panes.get(id)].join("\t") + "\n";
  }
  if (args[0] === "list-panes") {
    const window = args[args.indexOf("-t") + 1];
    const ids = [...panes].filter(([,p]) => p[7] === window).map(([id]) => id);
    if (!ids.length) throw Error("missing window");
    return ids.join("\n");
  }
  if (args[0] === "capture-pane") return "Agent ready >";
  return "";
};
try {
  const root = authorizeTmuxWindow("%0", run);
  prepareWindows(file, root);
  const first = readWindowAuthorization(file);
  const bridge = new TmuxBridge("", run, JSON.stringify(root), file);
  assert.deepEqual(bridge.list().map(p=>p.agent), ["%1"]);
  assert.throws(()=>bridge.read(undefined,"%2"), /outside/);
  const data = {...first, windows:[...first.windows,{window:"@2",epoch:randomUUID()}]};
  withWindowAuthorizationLock(file, ()=>writePrivateJson(file,data));
  assert.deepEqual(bridge.list().map(p=>[p.agent,p.window]), [["%1","@1"],["%2","@2"]]);
  for (const bad of ["%0","%3","%4"]) assert.throws(()=>bridge.read(undefined,bad));
  const r=bridge.read(undefined,"%2");
  assert.equal(bridge.send(undefined,"%2","hello",r.revision,true).status,"submitted_to_terminal");
  withWindowAuthorizationLock(file, ()=>assert.throws(()=>bridge.send(undefined,"%2","test",r.revision,true),/locked/));
  const pending=bridge.waitForChange(undefined,"%2",r.revision,2,r.cursor);
  writePrivateJson(file,first);
  await assert.rejects(pending,/authorization changed/);
  assert.throws(()=>bridge.read(undefined,"%2"),/outside/);
  assert.throws(()=>bridge.send(undefined,"%2","test",r.revision,true),/outside/);
  const readded={...first,windows:[...first.windows,{window:"@2",epoch:randomUUID()}]};
  writePrivateJson(file,readded);
  assert.equal(bridge.read(undefined,"%2",r.cursor).delta_mode,"reset");
  assert.throws(()=>bridge.send(undefined,"%2","test",r.revision,true),/changed/);
  prepareWindows(file,root);
  assert.deepEqual(readWindowAuthorization(file),readded);
  panes.get("%2")[7]="@3";
  assert.throws(()=>bridge.read(undefined,"%2"),/outside/);
  panes.delete("%3");
  assert.deepEqual(bridge.list().map(p=>p.agent),["%1"]);
  writePrivateJson(file,{...first,windows:[]});
  assert.deepEqual(bridge.list(),[]);
  assert.throws(()=>bridge.read(undefined,"%1"),/outside/);
  fs.unlinkSync(file);
  assert.throws(()=>bridge.list());
  writePrivateJson(file,{...first,root:{...root,serverPid:"999"}});
  assert.throws(()=>bridge.list(),/does not match/);
  prepareWindows(file,root);
  assert.deepEqual(bridge.list().map(p=>p.agent),["%1"]);
  fs.chmodSync(file,0o644);
  assert.throws(()=>bridge.list(),/private/);
  fs.chmodSync(file,0o600);
  panes.get("%0")[7]="@3";
  assert.throws(()=>bridge.list(),/window changed/);
  console.log("tmux-windows smoke passed");
} finally {fs.rmSync(dir,{recursive:true,force:true});}
