import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { CodexProError, isSubpath } from "./guard.js";
import { hasSecretValue, redactSensitiveText } from "./redact.js";

export const TMUX_TOOLS = ["tmux_list_agents", "tmux_read_output", "tmux_send_message"] as const;
const ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const PANE = /^%[0-9]+$/;
const WINDOW = /^@[0-9]+$/;
const PID = /^[1-9][0-9]*$/;
const SHELL = /^(?:-)?(?:bash|sh|dash|zsh|fish|ksh|csh|tcsh|ash|nu|nushell|xonsh|pwsh|powershell|cmd(?:\.exe)?|login|sudo|su|tmux|busybox)(?:\.exe)?$/i;
const FORMAT = ["#{pane_id}", "#{pid}", "#{pane_pid}", "#{pane_current_command}", "#{pane_dead}", "#{pane_in_mode}", "#{pane_current_path}", "#{socket_path}", "#{window_id}"].join("\t");
type Runner = (socket: string | undefined, args: string[], input?: string) => string;
type Pane = { pane: string; serverPid: string; panePid: string; command: string; dead: string; inMode: string; cwd: string; socket: string; window: string };
type Binding = { pane: string; serverPid: string; panePid: string; command: string; socket: string; workspace: string; window?: string };
type WindowScope = { anchor: string; serverPid: string; anchorPid: string; socket: string; window: string; workspace: string };

function fail(message: string): never {
  throw new CodexProError(message);
}

export function tmuxToolEnabled(config: CodexProConfig, name: string): boolean {
  if (config.connectionTest || (!process.env.CODEXPRO_TMUX_AGENTS?.trim() && !process.env.CODEXPRO_TMUX_WINDOW?.trim())) return false;
  if (name === "tmux_send_message") return config.writeMode !== "off" && process.env.CODEXPRO_TMUX_ALLOW_SEND === "1";
  return name === "tmux_list_agents" || name === "tmux_read_output";
}

// No shell, no caller-controlled executable, arguments, socket or target selector.
// Socket and target are bounded by local window authorization or explicit registration.
const runTmux: Runner = (socket, args, input) => {
  const result = spawnSync("tmux", [...(socket ? ["-S", socket] : []), ...args], {
    encoding: "utf8", input, timeout: 4000, maxBuffer: 512 * 1024,
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true
  });
  if (result.error || result.status !== 0) fail("tmux operation failed or timed out: " + args[0]);
  return result.stdout;
};

function paneInfo(run: Runner, socket: string | undefined, id: string): Pane {
  if (!PANE.test(id)) fail("Invalid registered pane ID.");
  const values = run(socket, ["display-message", "-p", "-t", id, FORMAT]).replace(/\r?\n$/, "").split("\t");
  if (values.length !== 9) fail("Unexpected tmux pane metadata.");
  const [pane, serverPid, panePid, command, dead, inMode, cwd, actualSocket, window] = values;
  if (pane !== id || !PID.test(serverPid) || !PID.test(panePid) || !command ||
      !path.isAbsolute(cwd) || !path.isAbsolute(actualSocket) || !WINDOW.test(window) ||
      !/^[01]$/.test(dead) || !/^[01]$/.test(inMode)) fail("Invalid or unavailable tmux pane.");
  return { pane, serverPid, panePid, command, dead, inMode, cwd, socket: actualSocket, window };
}

function requireAgent(pane: Pane, workspace: string): void {
  if (pane.dead !== "0" || SHELL.test(path.basename(pane.command))) fail("Pane is dead or appears to be a shell; start the agent first.");
  let cwd: string;
  try { cwd = realpathSync(pane.cwd); } catch { return fail("Pane working directory is unavailable."); }
  if (!isSubpath(cwd, workspace)) fail("Pane is outside its registered workspace.");
}

export function registerTmuxAgent(workspace: string, paneId: string, run: Runner = runTmux): Binding {
  const root = realpathSync(workspace);
  const pane = paneInfo(run, undefined, paneId);
  requireAgent(pane, root);
  if (pane.inMode !== "0") fail("Exit tmux copy mode before registering.");
  return { pane: pane.pane, serverPid: pane.serverPid, panePid: pane.panePid, command: pane.command, socket: pane.socket, workspace: root };
}

// Created by a local launcher before the public MCP server starts, never via MCP.
export function authorizeTmuxWindow(workspace: string, anchor: string, run: Runner = runTmux): WindowScope {
  if (!PANE.test(anchor)) fail("Start the bridge inside a tmux shell pane (TMUX_PANE is missing or invalid).");
  const root = realpathSync(workspace);
  const p = paneInfo(run, undefined, anchor);
  if (p.dead !== "0" || !isSubpath(realpathSync(p.cwd), root)) fail("Launch the bridge from the intended workspace inside tmux.");
  return { anchor: p.pane, serverPid: p.serverPid, anchorPid: p.panePid, socket: p.socket, window: p.window, workspace: root };
}

function parseWindowScope(raw: string): WindowScope {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail("Invalid local tmux window authorization."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid local tmux window authorization.");
  const s = value as Partial<WindowScope>;
  if (typeof s.anchor !== "string" || !PANE.test(s.anchor) ||
      typeof s.serverPid !== "string" || !PID.test(s.serverPid) ||
      typeof s.anchorPid !== "string" || !PID.test(s.anchorPid) ||
      typeof s.window !== "string" || !WINDOW.test(s.window) ||
      typeof s.socket !== "string" || !path.isAbsolute(s.socket) ||
      typeof s.workspace !== "string" || !path.isAbsolute(s.workspace)) fail("Invalid local tmux window authorization.");
  return s as WindowScope;
}

function parseBindings(raw: string): Map<string, Binding> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail("CODEXPRO_TMUX_AGENTS must be a JSON object generated by tmux-register."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid tmux registry.");
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 16) fail("Register 1–16 tmux agents.");
  const bindings = new Map<string, Binding>();
  const targets = new Set<string>();
  for (const [alias, data] of entries) {
    if (!ALIAS.test(alias) || !data || typeof data !== "object" || Array.isArray(data)) fail("Invalid tmux agent registration.");
    const b = data as Partial<Binding>;
    if (typeof b.pane !== "string" || !PANE.test(b.pane) ||
        typeof b.serverPid !== "string" || !PID.test(b.serverPid) ||
        typeof b.panePid !== "string" || !PID.test(b.panePid) ||
        typeof b.command !== "string" || !b.command || SHELL.test(path.basename(b.command)) ||
        typeof b.socket !== "string" || !path.isAbsolute(b.socket) ||
        typeof b.workspace !== "string" || !path.isAbsolute(b.workspace)) fail("Invalid tmux binding; regenerate the registry.");
    const target = JSON.stringify([b.socket, b.pane]);
    if (targets.has(target)) fail("Duplicate registered tmux pane.");
    targets.add(target);
    bindings.set(alias, b as Binding);
  }
  return bindings;
}

export class TmuxBridge {
  private readonly bindings: Map<string, Binding>;
  private readonly scope?: WindowScope;
  constructor(registry: string, private readonly run: Runner = runTmux, windowAuthorization = "") {
    if (registry.trim() && windowAuthorization.trim()) fail("Choose window mode or explicit registry, not both.");
    this.scope = windowAuthorization.trim() ? parseWindowScope(windowAuthorization) : undefined;
    this.bindings = this.scope ? new Map() : parseBindings(registry);
  }

  static fromEnvironment(): TmuxBridge {
    return new TmuxBridge(process.env.CODEXPRO_TMUX_AGENTS ?? "", runTmux, process.env.CODEXPRO_TMUX_WINDOW ?? "");
  }

  private verifyWindow(scope: WindowScope): void {
    const p = paneInfo(this.run, scope.socket, scope.anchor);
    if (p.socket !== scope.socket || p.serverPid !== scope.serverPid || p.panePid !== scope.anchorPid ||
        p.window !== scope.window || p.dead !== "0") fail("Authorized tmux window changed; restart the local bridge.");
  }

  private windowBinding(scope: WindowScope, workspace: string, agent: string): Binding {
    if (workspace !== scope.workspace || !PANE.test(agent) || agent === scope.anchor) fail("Target is not an authorized agent pane for this workspace.");
    this.verifyWindow(scope);
    const p = paneInfo(this.run, scope.socket, agent);
    if (p.socket !== scope.socket || p.serverPid !== scope.serverPid || p.window !== scope.window) fail("Target pane is outside the authorized tmux window.");
    requireAgent(p, scope.workspace);
    return { pane: p.pane, serverPid: p.serverPid, panePid: p.panePid, command: p.command, socket: p.socket, workspace: scope.workspace, window: p.window };
  }

  private binding(workspace: string, agent: string): Binding {
    if (this.scope) return this.windowBinding(this.scope, workspace, agent);
    const b = this.bindings.get(agent);
    if (!b || b.workspace !== workspace) return fail("Agent is not registered for the selected workspace.");
    return b;
  }

  private verify(b: Binding): Pane {
    if (this.scope) this.verifyWindow(this.scope);
    const p = paneInfo(this.run, b.socket, b.pane);
    if (p.socket !== b.socket || p.serverPid !== b.serverPid || p.panePid !== b.panePid ||
        p.command !== b.command || (b.window !== undefined && p.window !== b.window)) fail("Pane identity changed; read again or re-register locally.");
    requireAgent(p, b.workspace);
    return p;
  }

  list(workspace: string) {
    if (this.scope) {
      const scope = this.scope;
      if (workspace !== scope.workspace) return [];
      this.verifyWindow(scope);
      const ids = this.run(scope.socket, ["list-panes", "-t", scope.window, "-F", "#{pane_id}"]).split(/\r?\n/).filter(id => PANE.test(id) && id !== scope.anchor);
      if (ids.length > 64) fail("Too many panes in the authorized window; use a dedicated smaller window.");
      return ids.flatMap(agent => {
        try {
          const b = this.windowBinding(scope, workspace, agent);
          const p = this.verify(b);
          return [{ agent, pane: p.pane, command: p.command, status: p.inMode === "0" ? "connected" : "copy_mode", activity: "unknown" }];
        } catch { return []; }
      });
    }
    return [...this.bindings.entries()].filter(([, b]) => b.workspace === workspace).map(([agent, b]) => {
      try {
        const p = this.verify(b);
        return { agent, pane: p.pane, command: p.command, status: p.inMode === "0" ? "connected" : "copy_mode", activity: "unknown" };
      } catch {
        return { agent, pane: b.pane, status: "unavailable_or_changed", activity: "unknown" };
      }
    });
  }

  private snapshot(b: Binding) {
    const p = this.verify(b);
    const raw = this.run(b.socket, ["capture-pane", "-p", "-t", b.pane, "-S", "-100"]);
    this.verify(b);
    const revision = createHash("sha256").update(JSON.stringify([b, p.inMode, raw])).digest("hex");
    return { raw, revision, inMode: p.inMode };
  }

  read(workspace: string, agent: string) {
    const b = this.binding(workspace, agent);
    const s = this.snapshot(b);
    const clean = redactSensitiveText(s.raw);
    return { agent, pane: b.pane, revision: s.revision, output: clean.slice(-12000), truncated: clean.length > 12000, activity: "unknown" };
  }

  send(workspace: string, agent: string, message: string, expectedRevision: string, submit: boolean) {
    if (typeof message !== "string" || !message.trim() || message.length > 4000 ||
        /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(message)) fail("Use a nonempty single-line message (max 4000 characters), without control characters.");
    if (hasSecretValue(message)) fail("Message appears to contain a secret.");
    if (!/^[a-f0-9]{64}$/.test(expectedRevision) || typeof submit !== "boolean") fail("A fresh revision and explicit submit choice are required.");
    const b = this.binding(workspace, agent);
    const s = this.snapshot(b);
    if (s.inMode !== "0" || s.revision !== expectedRevision) fail("Pane changed or is in copy mode; read the output again before sending.");

    const id = randomUUID();
    const buffer = "codexpro-" + id;
    let pasted = false;
    try {
      // Literal data via stdin, not tmux command arguments or a shell.
      this.run(b.socket, ["load-buffer", "-b", buffer, "-"], message);
      const fresh = this.snapshot(b);
      if (fresh.inMode !== "0" || fresh.revision !== expectedRevision) fail("Pane changed before paste; no message submitted.");
      this.run(b.socket, ["paste-buffer", "-d", "-p", "-b", buffer, "-t", b.pane]);
      pasted = true;
      if (submit) {
        if (this.verify(b).inMode !== "0") fail("Pane entered copy mode after paste.");
        this.run(b.socket, ["send-keys", "-t", b.pane, "Enter"]);
      }
      console.error("[CodexProTmux] " + JSON.stringify({ id, agent, pane: b.pane, submitted: submit, at: new Date().toISOString() }));
      return { message_id: id, agent, pane: b.pane, status: submit ? "submitted_to_terminal" : "pasted_to_terminal", acknowledged: false, completed: false };
    } catch (error) {
      if (pasted) fail("Message was pasted; submission may be incomplete. Inspect pane before any retry.");
      throw error;
    } finally {
      try { this.run(b.socket, ["delete-buffer", "-b", buffer]); } catch { /* paste-buffer -d normally deletes it */ }
    }
  }
}
