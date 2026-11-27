import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { realpathSync, openSync, closeSync, fstatSync, readFileSync, lstatSync, constants, mkdirSync, rmdirSync } from "node:fs";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { CodexProError, isSubpath } from "./guard.js";
import { hasSecretValue, redactSensitiveText } from "./redact.js";

export const TMUX_TOOLS = ["tmux_list_agents", "tmux_read_output", "tmux_send_message", "tmux_wait_for_change"] as const;
const CACHE_LIMIT = 64;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CAPTURE_CHARS = 12000;
let activeWaits = 0;
const MAX_ACTIVE_WAITS = 8;
const ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const PANE = /^%[0-9]+$/;
const WINDOW = /^@[0-9]+$/;
const PID = /^[1-9][0-9]*$/;
const SHELL = /^(?:-)?(?:bash|sh|dash|zsh|fish|ksh|csh|tcsh|ash|nu|nushell|xonsh|pwsh|powershell|cmd(?:\.exe)?|login|sudo|su|tmux|busybox)(?:\.exe)?$/i;
const FORMAT = ["#{pane_id}", "#{pid}", "#{pane_pid}", "#{pane_current_command}", "#{pane_dead}", "#{pane_in_mode}", "#{pane_current_path}", "#{socket_path}", "#{window_id}"].join("\t");
type Runner = (socket: string | undefined, args: string[], input?: string) => string;
type Pane = { pane: string; serverPid: string; panePid: string; command: string; dead: string; inMode: string; cwd: string; socket: string; window: string };
type Binding = { pane: string; serverPid: string; panePid: string; command: string; socket: string; workspace?: string; window?: string; epoch?: string };
export type WindowScope = { anchor: string; serverPid: string; anchorPid: string; socket: string; window: string };
export type WindowAuthorization = { version: 1; root: WindowScope; windows: { window: string; epoch: string }[] };
const MAX_WINDOWS = 32;
const EPOCH = /^[a-f0-9-]{36}$/;
type Snapshot = { raw: string; revision: string; inMode: string };
type CachedView = { identity: string; output: string; revision: string; createdAt: number };


function fail(message: string): never {
  throw new CodexProError(message);
}

export function tmuxOnlyMode(): boolean { return process.env.CODEXPRO_TMUX_ONLY === "1"; }

export function tmuxToolEnabled(config: CodexProConfig, name: string): boolean {
  if (config.connectionTest || (!process.env.CODEXPRO_TMUX_AGENTS?.trim() && !process.env.CODEXPRO_TMUX_WINDOW?.trim())) return false;
  if (name === "tmux_send_message") return (tmuxOnlyMode() || config.writeMode !== "off") && process.env.CODEXPRO_TMUX_ALLOW_SEND === "1";
  return name === "tmux_list_agents" || name === "tmux_read_output" || name === "tmux_wait_for_change";
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

function requireAgent(pane: Pane, workspace?: string): void {
  if (pane.dead !== "0" || SHELL.test(path.basename(pane.command))) fail("Pane is dead or appears to be a shell; start the agent first.");
  if (workspace === undefined) return;
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
export function authorizeTmuxWindow(anchor: string, run: Runner = runTmux, socket?: string): WindowScope {
  if (!PANE.test(anchor)) fail("Start the bridge inside a tmux shell pane (TMUX_PANE is missing or invalid).");
  const p = paneInfo(run, socket, anchor);
  if (p.dead !== "0") fail("Launcher pane is dead.");
  return { anchor: p.pane, serverPid: p.serverPid, anchorPid: p.panePid, socket: p.socket, window: p.window };
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
      typeof s.socket !== "string" || !path.isAbsolute(s.socket)) fail("Invalid local tmux window authorization.");
  return s as WindowScope;
}

export function sameWindowScope(a: WindowScope, b: WindowScope): boolean {
  return a.anchor === b.anchor && a.anchorPid === b.anchorPid && a.serverPid === b.serverPid && a.socket === b.socket && a.window === b.window;
}

// Path is selected by the local launcher only. Missing/invalid state fails closed.
export function readWindowAuthorization(file: string): WindowAuthorization {
  if (!path.isAbsolute(file) || !file.endsWith(".windows.json")) fail("Invalid local window authorization path.");
  const parent = lstatSync(path.dirname(file));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (process.getuid && parent.uid !== process.getuid()) || (parent.mode & 0o077)) fail("Invalid private window authorization directory.");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (process.getuid && st.uid !== process.getuid()) || (st.mode & 0o077) || st.size > 8192) fail("Invalid private window authorization file.");
    const data = JSON.parse(readFileSync(fd, "utf8")) as WindowAuthorization;
    if (!data || data.version !== 1 || !Array.isArray(data.windows) || data.windows.length > MAX_WINDOWS) fail("Invalid window authorization list.");
    const root = parseWindowScope(JSON.stringify(data.root));
    const seen = new Set<string>();
    for (const w of data.windows) {
      if (!w || typeof w.window !== "string" || !WINDOW.test(w.window) || typeof w.epoch !== "string" || !EPOCH.test(w.epoch) || seen.has(w.window)) fail("Invalid or duplicate window authorization.");
      seen.add(w.window);
    }
    return { version: 1, root, windows: data.windows.map(w => ({ window: w.window, epoch: w.epoch })) };
  } finally { closeSync(fd); }
}

// Serialize mutations and sends across processes; never hold the lock across a wait.
export function withWindowAuthorizationLock<T>(file: string, fn: () => T): T {
  const lock = file.replace(/\.json$/, ".lock");
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { return fail("Window authorization is locked; retry locally or inspect a stale lock."); }
  try { return fn(); } finally { rmdirSync(lock); }
}
export function verifyLocalWindowRoot(root: WindowScope): void {
  const current = authorizeTmuxWindow(root.anchor, runTmux, root.socket);
  if (!sameWindowScope(root, current)) fail("Launcher window changed; restart the local bridge.");
}
export function liveLocalWindowIds(root: WindowScope): Set<string> {
  verifyLocalWindowRoot(root);
  return new Set(runTmux(root.socket, ["list-windows", "-a", "-F", "#{window_id}"]).split(/\r?\n/).filter(id => WINDOW.test(id)));
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
  // Per MCP bridge/session; only bounded, redacted terminal views are retained.
  private readonly views = new Map<string, CachedView>();
  constructor(registry: string, private readonly run: Runner = runTmux, windowAuthorization = "", private readonly authorizationFile = "") {
    if (registry.trim() && windowAuthorization.trim()) fail("Choose window mode or explicit registry, not both.");
    this.scope = windowAuthorization.trim() ? parseWindowScope(windowAuthorization) : undefined;
    if (this.authorizationFile && !this.scope) fail("Dynamic window authorization requires local window mode.");
    this.bindings = this.scope ? new Map() : parseBindings(registry);
  }

  static fromEnvironment(): TmuxBridge {
    if (tmuxOnlyMode() && (!process.env.CODEXPRO_TMUX_WINDOW?.trim() || process.env.CODEXPRO_TMUX_AGENTS?.trim())) fail("tmux-only mode requires a locally authorized window.");
    const file = process.env.CODEXPRO_TMUX_WINDOWS_FILE ?? "";
    if (file && !tmuxOnlyMode()) fail("Dynamic window authorization requires tmux-only mode.");
    return new TmuxBridge(process.env.CODEXPRO_TMUX_AGENTS ?? "", runTmux, process.env.CODEXPRO_TMUX_WINDOW ?? "", file);
  }

  private verifyWindow(scope: WindowScope): void {
    const p = paneInfo(this.run, scope.socket, scope.anchor);
    if (p.socket !== scope.socket || p.serverPid !== scope.serverPid || p.panePid !== scope.anchorPid ||
        p.window !== scope.window || p.dead !== "0") fail("Authorized tmux window changed; restart the local bridge.");
  }

  private authorizedWindows(): WindowAuthorization["windows"] {
    if (!this.scope || !this.authorizationFile) fail("Dynamic window authorization is not enabled.");
    this.verifyWindow(this.scope);
    const data = readWindowAuthorization(this.authorizationFile);
    if (!sameWindowScope(this.scope, data.root)) fail("Window authorization does not match the local launcher.");
    return data.windows;
  }

  private windowBinding(scope: WindowScope, agent: string): Binding {
    if (!PANE.test(agent) || agent === scope.anchor) fail("Target is not an authorized agent pane in this window.");
    this.verifyWindow(scope);
    const p = paneInfo(this.run, scope.socket, agent);
    const authorization = this.authorizationFile ? this.authorizedWindows().find(w => w.window === p.window) : undefined;
    if (p.socket !== scope.socket || p.serverPid !== scope.serverPid || (this.authorizationFile ? !authorization : p.window !== scope.window)) fail("Target pane is outside the authorized tmux windows.");
    requireAgent(p);
    return { pane: p.pane, serverPid: p.serverPid, panePid: p.panePid, command: p.command, socket: p.socket, window: p.window, ...(authorization ? { epoch: authorization.epoch } : {}) };
  }

  private binding(workspace: string | undefined, agent: string): Binding {
    if (this.scope) return this.windowBinding(this.scope, agent);
    const b = this.bindings.get(agent);
    if (!b || workspace === undefined || b.workspace !== workspace) return fail("Agent is not registered for the selected workspace.");
    return b;
  }

  private verify(b: Binding): Pane {
    if (this.scope) this.verifyWindow(this.scope);
    if (this.authorizationFile && !this.authorizedWindows().some(w => w.window === b.window && w.epoch === b.epoch)) fail("Window authorization changed; read again after local add.");
    const p = paneInfo(this.run, b.socket, b.pane);
    if (p.socket !== b.socket || p.serverPid !== b.serverPid || p.panePid !== b.panePid ||
        p.command !== b.command || (b.window !== undefined && p.window !== b.window)) fail("Pane identity changed; read again or re-register locally.");
    requireAgent(p, b.workspace);
    return p;
  }

  list(workspace?: string) {
    if (this.scope) {
      const scope = this.scope;
      this.verifyWindow(scope);
      const windows = this.authorizationFile ? this.authorizedWindows().map(w => w.window) : [scope.window];
      const ids: string[] = [];
      for (const window of windows) {
        let panes: string;
        try { panes = this.run(scope.socket, ["list-panes", "-t", window, "-F", "#{pane_id}"]); }
        catch (error) { if (!this.authorizationFile) throw error; continue; }
        ids.push(...panes.split(/\r?\n/).filter(id => PANE.test(id) && id !== scope.anchor));
        if (ids.length > 64) fail("Too many panes in the authorized windows; remove unused windows.");
      }
      if (ids.length > 64) fail("Too many panes in the authorized window; use a dedicated smaller window.");
      return ids.flatMap(agent => {
        try {
          const b = this.windowBinding(scope, agent);
          const p = this.verify(b);
          return [{ agent, pane: p.pane, command: p.command, ...(this.authorizationFile ? { window: p.window } : {}), status: p.inMode === "0" ? "connected" : "copy_mode", activity: "unknown" }];
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

  private snapshot(b: Binding): Snapshot {
    const p = this.verify(b);
    const raw = this.run(b.socket, ["capture-pane", "-p", "-t", b.pane, "-S", "-100"]);
    this.verify(b);
    const revision = createHash("sha256").update(JSON.stringify([b, p.inMode, raw])).digest("hex");
    return { raw, revision, inMode: p.inMode };
  }

  private view(b: Binding, agent: string, s: Snapshot, previousCursor?: string) {
    const now = Date.now();
    for (const [cursor, entry] of this.views) {
      if (now - entry.createdAt > CACHE_TTL_MS) this.views.delete(cursor);
    }
    const clean = redactSensitiveText(s.raw);
    const full = clean.slice(-MAX_CAPTURE_CHARS);
    const identity = JSON.stringify(b);
    const previous = previousCursor ? this.views.get(previousCursor) : undefined;
    let deltaMode: "full" | "reset" | "unchanged" | "patch" = previousCursor ? "reset" : "full";
    let output = full;
    let replaceFromLine: number | undefined;
    let dropPrefixLines: number | undefined;
    if (previous?.identity === identity) {
      if (previous.output === full) {
        deltaMode = "unchanged";
        output = "";
      } else {
        const before = previous.output.split("\n");
        const after = full.split("\n");
        let prefix = 0;
        while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
        // A TUI may rewrite old lines. A patch replaces a suffix, not necessarily new output.
        // Exact prefix/suffix matching is used only to reconstruct the current view, never to infer completion.
        let drop = 0;
        let keep = prefix;
        // Bounded work: search at most 256 offsets for scrollback shifts.
        for (let offset = 1; offset <= Math.min(before.length - 1, 256); offset++) {
          if (before[offset] !== after[0]) continue;
          let overlap = 0;
          while (offset + overlap < before.length && overlap < after.length && before[offset + overlap] === after[overlap]) overlap++;
          // The matching prefix may end before the old footer: the patch discards that suffix.
          if (overlap >= 3 && overlap > keep) {
            drop = offset;
            keep = overlap;
          }
        }
        if (keep > 0) {
          const suffix = after.slice(keep).join("\n");
          if (suffix.length < full.length) {
            deltaMode = "patch";
            output = suffix;
            replaceFromLine = keep;
            dropPrefixLines = drop;
          }
        }
      }
    }
    const cursor = randomUUID();
    this.views.set(cursor, { identity, output: full, revision: s.revision, createdAt: now });
    while (this.views.size > CACHE_LIMIT) this.views.delete(this.views.keys().next().value!);
    return {
      agent, pane: b.pane, revision: s.revision, cursor,
      delta_mode: deltaMode, base_cursor: deltaMode === "patch" || deltaMode === "unchanged" ? previousCursor : undefined,
      drop_prefix_lines: dropPrefixLines, replace_from_line: replaceFromLine,
      line_count: full.split("\n").length, output, truncated: clean.length > MAX_CAPTURE_CHARS,
      activity: "unknown", copy_mode: s.inMode === "1",
      visible_changed: previous?.identity === identity ? previous.output !== full : undefined
    };
  }

  read(workspace: string | undefined, agent: string, cursor?: string) {
    const b = this.binding(workspace, agent);
    return this.view(b, agent, this.snapshot(b), cursor);
  }

  async waitForChange(workspace: string | undefined, agent: string, expectedRevision: string, timeoutSeconds = 10, cursor?: string) {
    if (!/^[a-f0-9]{64}$/.test(expectedRevision) ||
        !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 15) fail("A valid revision and timeout of 1–15 seconds are required.");
    if (activeWaits >= MAX_ACTIVE_WAITS) fail("Too many active tmux waits; retry later.");
    const b = this.binding(workspace, agent);
    activeWaits++;
    try {
      const deadline = Date.now() + timeoutSeconds * 1000;
      for (;;) {
        const snapshot = this.snapshot(b);
        const changed = snapshot.revision !== expectedRevision;
        if (changed || Date.now() >= deadline) {
          return { event: changed ? "changed" : "timeout", ...this.view(b, agent, snapshot, cursor) };
        }
        await sleep(Math.min(500, Math.max(1, deadline - Date.now())));
      }
    } finally {
      activeWaits--;
    }
  }

  send(workspace: string | undefined, agent: string, message: string, expectedRevision: string, submit: boolean) {
    const perform = () => this.sendUnlocked(workspace, agent, message, expectedRevision, submit);
    return this.authorizationFile ? withWindowAuthorizationLock(this.authorizationFile, perform) : perform();
  }

  private sendUnlocked(workspace: string | undefined, agent: string, message: string, expectedRevision: string, submit: boolean) {
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
