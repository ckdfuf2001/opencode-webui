#!/usr/bin/env node
// Vendored from ckdfuf2001/agent-browser branch proxy/session-isolation
// (release proxy-v2.2.0) + opencode-webui 2.3.0 addition: sweep-time daemon
// supervision (liveness probe + stale sidecar cleanup, lazy recovery).
// See agent-browser_arch-to-be.html for the design.
// agent-browser MCP proxy - concurrent-session safe (no external deps).
//
// Design (same shape as Playwright / Chrome-DevTools MCP):
// - SMALL tool surface (~35 focused tools). Less schema = fewer LLM mistakes.
// - STATELESS per call: each tool runs `agent-browser --namespace NS --session S ...`
//   as a short-lived CLI subprocess. No long-lived upstream server to hang.
//   Browser state lives in the single agent-browser daemon (pinned namespace),
//   keyed by session, so concurrent calls with DIFFERENT sessions drive
//   DIFFERENT browsers and never steal each other's tabs/refs.
// - `session` is REQUIRED (schema + runtime): one unique session per task.
// - ONE daemon total: namespace is server-pinned (single daemon). A per-call
//   namespace would fork a daemon per namespace, so non-default namespaces
//   are rejected with guidance. Isolation unit = session (one browser each).
//   Registry key = pinned-namespace + session.
// - Sweeper + LRU close only IDLE sessions with zero in-flight calls.
//   Active work is NEVER closed or evicted, even under cap pressure.
//
// Env / flags:
//   --cli <path>      agent-browser binary (env AGENT_BROWSER_BIN/AGENT_BROWSER_CLI)
//   --namespace <ns>  DEFAULT namespace (env AGENT_BROWSER_NAMESPACE, default "opencode")
//   SESSION_TTL_MS    idle time before auto-close (default "600000" = 10m)
//   SESSION_MAX       registry cap, LRU over idle sessions only (default "16")
//   SESSION_SWEEP_MS  sweeper interval (default "60000")
//   CALL_TIMEOUT_MS   default per-call timeout (default "60000")

import { spawn, execSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const CLI = flag("--cli") || process.env.AGENT_BROWSER_BIN || process.env.AGENT_BROWSER_CLI || "agent-browser";
const DEFAULT_NS = flag("--namespace") || process.env.AGENT_BROWSER_NAMESPACE || "opencode";
const TTL_MS = Number(process.env.SESSION_TTL_MS || "600000");
const SWEEP_MS = Number(process.env.SESSION_SWEEP_MS || "60000");
const MAX_SESSIONS = Number(process.env.SESSION_MAX || "16");
const CALL_TIMEOUT = Number(process.env.CALL_TIMEOUT_MS || "60000");
const PROTOCOL = "2025-03-26";
const log = (...a) => console.error("[agent-browser-proxy]", ...a);

// ---------------------------------------------------------------- sessions
const sessions = new Map(); // key -> { ns, name, lastSeen, createdAt, inFlight, fails }
const ASCII_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UNI_RE = /^[\p{L}\p{N}_-]{1,64}$/u;
// CLI/daemon accept ASCII only (sockets, dirs). Non-ASCII (e.g. Korean) names
// are deterministically encoded; ASCII names pass through unchanged and readable.
function toSafe(str) {
  if (ASCII_RE.test(str)) return str;
  const hex = Buffer.from(str, "utf8").toString("hex");
  if (hex.length <= 62) return "u" + hex;
  return "u" + createHash("sha256").update(str, "utf8").digest("hex").slice(0, 61);
}
const keyOf = (ns, name) => ns + "" + name;

function suggestSession(prefix = "task") {
  const p = String(prefix || "task").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 20) || "task";
  return p + "-" + randomBytes(3).toString("hex");
}
function sessionProblem(name) {
  if (name === undefined || name === null || String(name).trim() === "")
    return "Missing `session`. Every task needs its own isolated browser: call `agent_browser_session_ensure` first, then reuse that SAME value for all follow-up calls. Example: `task-checkout-a1b2c3`.";
  if (name === "default")
    return "The `session` \"default\" is shared by everyone and causes tab/ref collisions. Mint your own via `agent_browser_session_ensure`.";
  if (!UNI_RE.test(name))
    return "Invalid `session` \"" + name + "\". Use only letters (Korean ok), numbers, `-`, `_` (max 64 chars).";
  return null;
}
function nsOf(a) {
  return DEFAULT_NS; // single-daemon pin: namespace is server-fixed, not per-call
}
function nsProblem(ns) {
  if (!UNI_RE.test(ns))
    return "Invalid `namespace` \"" + ns + "\". Use only letters (Korean ok), numbers, `-`, `_` (max 64 chars).";
  return null;
}
const STORE_PATH = process.env.SESSION_STORE ||
  (os.tmpdir() + "/agent-browser-proxy-sessions.json");

function loadStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    const now = Date.now();
    for (const e of arr) {
      if (!e || !e.ns || !e.name) continue;
      if (now - (e.lastSeen || 0) > TTL_MS) continue; // stale: let daemon idle-exit handle it
      sessions.set(keyOf(e.ns, e.name), {
        ns: e.ns, name: e.name, safeNs: toSafe(e.ns), safeName: toSafe(e.name),
        lastSeen: e.lastSeen || now, createdAt: e.createdAt || e.lastSeen || now,
        inFlight: 0, fails: 0,
      });
    }
    if (sessions.size) log("restored " + sessions.size + " tracked sessions from store");
  } catch (e) { /* first run: no store yet */ }
}
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      // merge: keep file entries we don't track (other proxy instances), overlay ours
      let file = [];
      try { file = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) || []; } catch (e) { file = []; }
      const merged = new Map();
      for (const e of file) {
        if (e && e.ns && e.name) merged.set(keyOf(e.ns, e.name), e);
      }
      for (const [k, m] of sessions) {
        merged.set(k, { ns: m.ns, name: m.name, safeNs: m.safeNs, safeName: m.safeName, lastSeen: m.lastSeen, createdAt: m.createdAt });
      }
      fs.writeFileSync(STORE_PATH, JSON.stringify(Array.from(merged.values())));
    } catch (e) { log("store save failed:", String((e && e.message) || e).slice(0, 150)); }
  }, 2000);
  if (saveTimer.unref) saveTimer.unref();
}
function touch(ns, n) {
  const key = keyOf(ns, n);
  const now = Date.now();
  const p = sessions.get(key);
  sessions.set(key, { ns, name: n, safeNs: toSafe(ns), safeName: toSafe(n), lastSeen: now, createdAt: p ? p.createdAt : now, inFlight: p ? p.inFlight : 0, fails: p ? p.fails : 0 });
  if (sessions.size > MAX_SESSIONS) {
    let oldestKey = null;
    let oldest = null;
    for (const [k, v] of sessions) {
      if (v.inFlight > 0) continue; // never evict active sessions
      if (!oldest || v.lastSeen < oldest.lastSeen) { oldestKey = k; oldest = v; }
    }
    if (oldestKey) {
      sessions.delete(oldestKey);
      closeSession(oldest.ns, oldest.name).catch(() => {});
      log("LRU dropped idle session " + oldest.ns + "/" + oldest.name + " (cap " + MAX_SESSIONS + ")");
    }
  }
  scheduleSave();
}

function runCli(args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(kill); resolve(r); } };
    const kill = setTimeout(() => { child.kill("SIGKILL"); finish({ code: 124, out, err: err + "\n[TIMEOUT]" }); }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", (code) => finish({ code, out: out.trim(), err: err.trim() }));
    child.on("error", (e) => finish({ code: 127, out: "", err: String((e && e.message) || e) }));
  });
}

async function closeSession(ns, name) {
  return runCli(["--namespace", toSafe(ns), "--session", toSafe(name), "close", "--json"], 25000);
}

async function sweep() {
  try { await superviseDaemon(); } catch (e) { log("daemon check:", (e && e.message) || e); }
  const now = Date.now();
  for (const [key, m] of Array.from(sessions)) {
    if (m.inFlight > 0) continue; // active: never touch
    if (now - m.lastSeen > TTL_MS) {
      const r = await closeSession(m.ns, m.name);
      if (r.code !== 0 && r.code !== 124) {
        m.fails = (m.fails || 0) + 1;
        if (m.fails < 3) continue; // retry later
      }
      sessions.delete(key);
      scheduleSave();
      log("swept idle session " + m.ns + "/" + m.name + " (idle>" + Math.round(TTL_MS / 1000) + "s)");
    }
  }
}
setInterval(() => { sweep().catch((e) => log("sweep:", (e && e.message) || e)); }, SWEEP_MS);

// ------------------------------------------------------- daemon supervision
// The CLI owns daemon lifetime (ensure_daemon), but a dead daemon leaves
// stale sidecars behind: the next call then reads a zombie port and fails
// with 10060 instead of respawning. Each sweep verifies the pinned namespace
// daemon (pid alive + port connectable) and removes stale sidecars so the
// next call recovers lazily. Never launches a browser here.
function socketBaseDir() {
  const override = process.env.AGENT_BROWSER_SOCKET_DIR;
  if (override) return override;
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return path.join(runtime, "agent-browser");
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  if (home) return path.join(home, ".agent-browser");
  return path.join(os.tmpdir(), "agent-browser");
}
function daemonRunDir() {
  return path.join(socketBaseDir(), "namespaces", toSafe(DEFAULT_NS), "run");
}
function readSidecarInt(dir, key, suffix) {
  try {
    const n = parseInt(fs.readFileSync(path.join(dir, key + "." + suffix), "utf8").trim(), 10);
    return isNaN(n) ? null : n;
  } catch (e) { return null; }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === "EPERM"; }
}
function killPidTree(pid) {
  try {
    if (process.platform === "win32") execSync("taskkill /PID " + pid + " /T /F", { stdio: "ignore", timeout: 15000 });
    else process.kill(pid, "SIGKILL");
    return true;
  } catch (e) { return false; }
}
function portOpen(port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (ok) => { try { s.destroy(); } catch (e) {} resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs || 3000);
    if (timer.unref) timer.unref();
    s.on("connect", () => { clearTimeout(timer); done(true); });
    s.on("error", () => { clearTimeout(timer); done(false); });
  });
}
const DAEMON_SIDECARS = ["pid", "port", "config", "version", "stream"];
async function superviseDaemon() {
  const dir = daemonRunDir();
  const key = toSafe(DEFAULT_NS);
  const pid = readSidecarInt(dir, key, "pid");
  if (pid === null) return; // nothing recorded: ensure_daemon owns creation (lazy)
  if (!pidAlive(pid)) {
    for (const s of DAEMON_SIDECARS) { try { fs.unlinkSync(path.join(dir, key + "." + s)); } catch (e) {} }
    log("daemon dead (pid " + pid + "); removed stale sidecars for " + DEFAULT_NS);
    return;
  }
  const port = readSidecarInt(dir, key, "port");
  if (port !== null && !(await portOpen(port))) {
    // pid는 살아있는데 포트가 닫힘 = 귀먹은 좀비. 사이드카만 지우면 프로세스가
    // 남아 다음 호출도 망가뜨리므로 직접 죽인다.
    const killed = pid !== null ? killPidTree(pid) : false;
    for (const s of DAEMON_SIDECARS) { try { fs.unlinkSync(path.join(dir, key + "." + s)); } catch (e) {} }
    log("daemon port " + port + " unreachable (pid " + pid + " alive); killed=" + killed + ", removed stale sidecars for " + DEFAULT_NS);
  }
}

// ----------------------------------------------------------------- helpers
function fixSelector(sel) {
  if (typeof sel !== "string") return { value: sel, fixed: false };
  const t = sel.trim();
  if (/^e\d+$/i.test(t)) return { value: "@e" + t.slice(1), fixed: true };
  if (t !== sel) return { value: t, fixed: true };
  return { value: sel, fixed: false };
}
function hintFor(text) {
  if (/tab_gone/i.test(text)) return "Hint: the tab is gone. Call agent_browser_tab_list, then tab_new or tab_switch, then snapshot again.";
  if (/stale|unknown ref|no element|not found|@e\d+/i.test(text)) return "Hint: refs expire after navigation/tab switch. Call agent_browser_snapshot again and use the NEW refs.";
  if (/dialog/i.test(text)) return "Hint: a JS dialog is blocking the page.";
  if (/timeout|timed out/i.test(text)) return "Hint: page is slow. Call agent_browser_wait_load (networkidle), then snapshot.";
  if (/covered/i.test(text)) return "Hint: another element covers the target. Dismiss it (banner/modal), snapshot again, retry.";
  return "";
}

// -------------------------------------------------------------- tool table
// build(args) -> CLI argv AFTER global flags, BEFORE --json.
const S = {
  type: "string",
  description: "REQUIRED. Unique isolated browser session for your task (e.g. task-checkout-a1b2c3, Korean ok). Get one from agent_browser_session_ensure and reuse it for EVERY call in this task. Never share across tasks, never use \"default\".",
};
const NS = {
  type: "string",
  description: "REQUIRED on every call. Namespace of the single shared daemon (always the pinned value, e.g. \"opencode\"). At least one of `namespace`/`session` must be stated explicitly every call - in practice pass BOTH every time.",
};
const SEL = { type: "string", description: "Element ref from snapshot (@e2) or CSS selector (#submit). Snapshot first: refs expire after navigation/tab switch." };
const TMO = { type: "integer", minimum: 1000, description: "Max wait for this call in ms (default 60000)." };
const WF = "Workflow: open -> snapshot -> interact with fresh @refs. ";

const TOOLS = [
  { name: "agent_browser_open", title: "Open page", needSession: true,
    description: "Launch the session's browser and navigate to a URL (or about:blank staging). " + WF + "Always snapshot after navigating before clicking/typing.",
    schema: { url: { type: "string", description: "URL to open. Omit to launch on about:blank." }, timeoutMs: TMO },
    build: (a) => (a.url ? ["open", a.url] : ["open"]) },
  { name: "agent_browser_snapshot", title: "Snapshot", needSession: true,
    description: "Accessibility tree with element refs (@e1, @e2...). Call after EVERY navigation/tab switch and before EVERY click/fill: old refs are invalid.",
    schema: { interactive: { type: "boolean", description: "Only interactive elements (default true)." }, compact: { type: "boolean" }, timeoutMs: TMO },
    build: (a) => ["snapshot", ...(a.interactive === false ? [] : ["-i"]), ...(a.compact ? ["--compact"] : [])] },
  { name: "agent_browser_click", title: "Click", needSession: true,
    description: "Click an element. " + WF,
    schema: { selector: SEL, timeoutMs: TMO }, required: ["selector"],
    build: (a) => ["click", a.selector] },
  { name: "agent_browser_fill", title: "Fill input", needSession: true,
    description: "Clear then fill an input/textarea. " + WF,
    schema: { selector: SEL, text: { type: "string" }, timeoutMs: TMO }, required: ["selector", "text"],
    build: (a) => ["fill", a.selector, a.text] },
  { name: "agent_browser_type", title: "Type", needSession: true,
    description: "Type into an element without clearing. " + WF,
    schema: { selector: SEL, text: { type: "string" }, timeoutMs: TMO }, required: ["selector", "text"],
    build: (a) => ["type", a.selector, a.text] },
  { name: "agent_browser_press", title: "Press key", needSession: true,
    description: "Press a key: Enter, Tab, Escape, Control+a, etc.",
    schema: { key: { type: "string" }, timeoutMs: TMO }, required: ["key"],
    build: (a) => ["press", a.key] },
  { name: "agent_browser_check", title: "Check", needSession: true, description: "Check a checkbox. " + WF,
    schema: { selector: SEL, timeoutMs: TMO }, required: ["selector"], build: (a) => ["check", a.selector] },
  { name: "agent_browser_uncheck", title: "Uncheck", needSession: true, description: "Uncheck a checkbox. " + WF,
    schema: { selector: SEL, timeoutMs: TMO }, required: ["selector"], build: (a) => ["uncheck", a.selector] },
  { name: "agent_browser_select", title: "Select option", needSession: true, description: "Select a dropdown option by value or visible label. " + WF,
    schema: { selector: SEL, value: { type: "string" }, timeoutMs: TMO }, required: ["selector", "value"],
    build: (a) => ["select", a.selector, a.value] },
  { name: "agent_browser_scroll", title: "Scroll", needSession: true, description: "Scroll up/down/left/right, optionally by pixels.",
    schema: { direction: { type: "string", enum: ["up", "down", "left", "right"] }, pixels: { type: "integer" }, timeoutMs: TMO }, required: ["direction"],
    build: (a) => ["scroll", a.direction, ...(a.pixels ? [String(a.pixels)] : [])] },
  { name: "agent_browser_eval", title: "Run JavaScript", needSession: true, description: "Run JavaScript in the page. For scraping extras that snapshot/get_* cannot return.",
    schema: { code: { type: "string", description: "JS expression to evaluate." }, timeoutMs: TMO }, required: ["code"],
    build: (a) => ["eval", a.code] },
  { name: "agent_browser_wait_ms", title: "Wait time", needSession: true, description: "Wait a fixed time. Prefer wait_load/wait_text for slow pages.",
    schema: { ms: { type: "integer", minimum: 100, description: "Milliseconds to wait." }, timeoutMs: TMO }, required: ["ms"],
    build: (a) => ["wait", String(a.ms)] },
  { name: "agent_browser_wait_selector", title: "Wait for element", needSession: true, description: "Wait until an element/selector appears.",
    schema: { selector: SEL, timeoutMs: TMO }, required: ["selector"], build: (a) => ["wait", a.selector] },
  { name: "agent_browser_wait_text", title: "Wait for text", needSession: true, description: "Wait until text appears on the page (substring).",
    schema: { text: { type: "string" }, timeoutMs: TMO }, required: ["text"], build: (a) => ["wait", "--text", a.text] },
  { name: "agent_browser_wait_load", title: "Wait for load", needSession: true, description: "Wait for a load state. Use networkidle after navigation on slow/SPA pages, then snapshot.",
    schema: { state: { type: "string", enum: ["load", "domcontentloaded", "networkidle"] }, timeoutMs: TMO }, required: ["state"],
    build: (a) => ["wait", "--load", a.state] },
  { name: "agent_browser_get_text", title: "Get text", needSession: true, description: "Get text content of an element (or omit selector for page text).",
    schema: { selector: { type: "string", description: "Optional @ref or CSS selector." }, timeoutMs: TMO },
    build: (a) => (a.selector ? ["get", "text", a.selector] : ["get", "text"]) },
  { name: "agent_browser_get_url", title: "Get URL", needSession: true, description: "Get the current page URL.",
    schema: { timeoutMs: TMO }, build: () => ["get", "url"] },
  { name: "agent_browser_get_title", title: "Get title", needSession: true, description: "Get the page title.",
    schema: { timeoutMs: TMO }, build: () => ["get", "title"] },
  { name: "agent_browser_read", title: "Read text", needSession: false,
    description: "Fetch agent-readable text of a URL WITHOUT launching a browser, or read the active tab when url is omitted (then session IS used). Cheap first step for articles/docs.",
    schema: { url: { type: "string", description: "URL to fetch. Omit to read the active tab of your session." }, filter: { type: "string" }, outline: { type: "boolean" }, timeoutMs: TMO },
    build: (a) => ["read", ...(a.url ? [a.url] : []), ...(a.filter ? ["--filter", a.filter] : []), ...(a.outline ? ["--outline"] : [])] },
  { name: "agent_browser_screenshot", title: "Screenshot", needSession: true, description: "Screenshot the page. Omit path to get an auto-saved temp path back.",
    schema: { path: { type: "string" }, full: { type: "boolean", description: "Full-page screenshot." }, timeoutMs: TMO },
    build: (a) => ["screenshot", ...(a.path ? [a.path] : []), ...(a.full ? ["--full"] : [])] },
  { name: "agent_browser_back", title: "Back", needSession: true, description: "Go back. Snapshot after.",
    schema: { timeoutMs: TMO }, build: () => ["back"] },
  { name: "agent_browser_forward", title: "Forward", needSession: true, description: "Go forward. Snapshot after.",
    schema: { timeoutMs: TMO }, build: () => ["forward"] },
  { name: "agent_browser_reload", title: "Reload", needSession: true, description: "Reload the page. Snapshot after.",
    schema: { timeoutMs: TMO }, build: () => ["reload"] },
  { name: "agent_browser_tab_new", title: "New tab", needSession: true, description: "Open a new tab (optionally labeled/URL). Labels are stable handles: prefer label for multi-tab tasks. Snapshot after switching.",
    schema: { url: { type: "string" }, label: { type: "string" }, timeoutMs: TMO },
    build: (a) => ["tab", "new", ...(a.label ? ["--label", a.label] : []), ...(a.url ? [a.url] : [])] },
  { name: "agent_browser_tab_list", title: "List tabs", needSession: true, description: "List open tabs with stable ids (t1, t2...) and labels.",
    schema: { timeoutMs: TMO }, build: () => ["tab", "list"] },
  { name: "agent_browser_tab_switch", title: "Switch tab", needSession: true, description: "Switch to a tab by id (t2) or label. Snapshot after: refs are per-tab.",
    schema: { tab: { type: "string", description: "Tab id (t2) or label." }, timeoutMs: TMO }, required: ["tab"],
    build: (a) => ["tab", a.tab] },
  { name: "agent_browser_tab_close", title: "Close tab", needSession: true, description: "Close a tab by id/label (default: active tab).",
    schema: { tab: { type: "string" }, timeoutMs: TMO }, build: (a) => ["tab", "close", ...(a.tab ? [a.tab] : [])] },
  { name: "agent_browser_close", title: "Close browser", needSession: true, description: "Close THIS session's browser when the task is done. Never closes other sessions.",
    schema: { timeoutMs: TMO }, build: () => ["close"] },
  { name: "agent_browser_session_list", title: "List sessions", needSession: false, description: "List active browser sessions in a namespace (debugging only).",
    schema: {}, build: () => ["session", "list"] },
  { name: "agent_browser_cookies_get", title: "Get cookies", needSession: true, description: "Get all cookies of the session.",
    schema: { timeoutMs: TMO }, build: () => ["cookies", "get"] },
  { name: "agent_browser_cookies_set", title: "Set cookie", needSession: true, description: "Set a cookie (e.g. auth before navigation).",
    schema: { name: { type: "string" }, value: { type: "string" }, domain: { type: "string" }, timeoutMs: TMO }, required: ["name", "value"],
    build: (a) => ["cookies", "set", a.name, a.value, ...(a.domain ? ["--domain", a.domain] : [])] },
  { name: "agent_browser_cookies_clear", title: "Clear cookies", needSession: true, description: "Clear the session's cookies.",
    schema: { timeoutMs: TMO }, build: () => ["cookies", "clear"] },
  { name: "agent_browser_skills_get", title: "Get skill guide", needSession: false,
    description: "Load the version-matched usage guide (\"core\" first when unsure). Prefer this over guessing commands.",
    schema: { name: { type: "string", description: "Skill name (default \"core\")." } },
    build: (a) => ["skills", "get", a.name || "core"] },
  { name: "agent_browser_session_ensure", title: "Ensure session", needSession: false, local: true,
    description: "Mint/validate an isolated session name in a namespace. Call ONCE per task, reuse the same namespace+session for every call. Idle sessions auto-close after TTL.",
    schema: { task: { type: "string", description: "Short slug, e.g. \"checkout\"." }, session: { type: "string" }, reuse: { type: "boolean", description: "Pass true ONLY to adopt a live session the EXISTS report showed you (confirms it is YOUR browser)." } } },
  { name: "agent_browser_session_cleanup", title: "Cleanup sessions", needSession: false, local: true,
    description: "Close idle sessions (or all tracked idle with all:true). Sessions with in-flight calls are NEVER touched: safe while others work.",
    schema: { all: { type: "boolean" }, maxIdleMs: { type: "integer", minimum: 0 } } },
];
for (const t of TOOLS) {
  t.schema = Object.assign({}, t.schema, { namespace: NS }, t.needSession
    ? { session: S }
    : { session: { type: "string", description: "Optional session (used only when reading the active tab)." } });
  const req = (t.required || []).slice();
  if (t.needSession && req.indexOf("session") < 0) req.push("session");
  if (req.indexOf("namespace") < 0) req.push("namespace");
  t.inputSchema = { type: "object", additionalProperties: false, properties: t.schema };
  if (req.length) t.inputSchema.required = req;
}
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// 죽은 데몬 target 연결 실패 패턴: 세션 target 사이드카가 가리키는 곳이
// 없으면 여기로 떨어진다. 스냅샷 ref stale(@e…)과는 무관하므로 재시도 안 함.
const STALE_TARGET_RE = /10061|ECONNREFUSED|WSAETIMEDOUT|10060|no active page|target (gone|closed|crashed|not found)|CDP\W*connect|connect\W*CDP|browser (closed|crashed|disconnected)/i;
function clearSessionTarget(ns, s) {
  try {
    const dir = path.join(socketBaseDir(), "namespaces", toSafe(ns), "run");
    for (const suffix of ["target", "engine"]) {
      try { fs.unlinkSync(path.join(dir, toSafe(s) + "." + suffix)); } catch (e) {}
    }
  } catch (e) {}
}

// ---------------------------------------------------------------- MCP wire
function send(o) { process.stdout.write(JSON.stringify(o) + "\n"); }
function txt(text, isError) { return { content: [{ type: "text", text }], isError: !!isError }; }

async function execTool(def, a, ns, session, opts) {
  opts = opts || {};
  const key = session ? keyOf(ns, session) : null;
  const meta = key ? sessions.get(key) : null;
  if (meta) { meta.inFlight = (meta.inFlight || 0) + 1; meta.lastSeen = Date.now(); }
  try {
    const tmo = Math.max(1000, Number(opts.timeoutMs || a.timeoutMs) || CALL_TIMEOUT);
    const argv = ["--namespace", toSafe(ns)];
    if (session) argv.push("--session", toSafe(session));
    argv.push("--idle-timeout", "15m");
    const cmdArgs = def.build(a);
    for (const c of cmdArgs) argv.push(c);
    argv.push("--json");
    const runOnce = () => runCli(argv, tmo + 10000);
    const finish = (rr) => {
      const b = rr.out || rr.err || "(empty output, exit " + rr.code + ")";
      if (rr.code === 124) return { timeout: true, text: b };
      if (rr.code !== 0) {
        const h = hintFor(b);
        return txt("Command failed (exit " + rr.code + "):\n" + b.slice(0, 3000) + (h ? "\n" + h : ""), true);
      }
      return txt(b.slice(0, 12000));
    };
    const r = await runOnce();
    if (r.code !== 0 && session) {
      const probe = r.out || r.err || "";
      if (STALE_TARGET_RE.test(probe)) {
        // 죽은 데몬의 target에 묶인 세션 (open 성공 / snapshot·tab 10061 비대칭의
        // 주범). 세션 target/engine 사이드카를 지우고 1회만 재시도한다.
        clearSessionTarget(ns, session);
        touch(ns, session);
        log("stale target cleared for " + ns + "/" + session + ", retrying once");
        return finish(await runOnce());
      }
    }
    return finish(r);
  } finally {
    const m2 = sessions.get(key);
    if (m2) { m2.inFlight = Math.max(0, (m2.inFlight || 1) - 1); m2.lastSeen = Date.now(); }
  }
}

// Cold-start quirk: the first `open` that launches a browser may never return
// (upstream bug - the browser DOES launch underneath). Bound it, verify with a
// cheap get_url on the now-warm daemon, and report success either way.
// Cold Chrome 첫 기동은 Windows에서 25초를 넘기기 쉽다. 여기서 SIGKILL로
// 자르면 데몬에 반쯤 태어난 브라우저가 남아 target churn + CDP 10060
// 악순환이 된다. v0.35+ 파이프 행은 해소됐으니 충분히 기다린다.
async function execOpenWithVerify(def, a, ns, session) {
  const firstMs = Math.min(Math.max(90000, Number(a.timeoutMs) || CALL_TIMEOUT), 120000);
  const r = await execTool(def, a, ns, session, { timeoutMs: firstMs });
  if (!r.timeout) return r;
  const verify = await execTool(BY_NAME.get("agent_browser_get_url"), { timeoutMs: 15000 }, ns, session);
  const vtext = (!verify.isError && verify.content && verify.content[0]) ? verify.content[0].text : "";
  if (/https?:\/\//.test(vtext)) {
    return txt("Opened \"" + (a.url || "about:blank") + "\" in session \"" + session + "\" (namespace \"" + ns + "\"). NOTE: first launch needed extra time; the page IS loaded - snapshot next. Verified URL: " + vtext.slice(0, 400));
  }
  return txt("Open timed out after ~" + firstMs + "ms and verification failed in session \"" + session + "\" (namespace \"" + ns + "\"). The browser may still be starting: wait, then agent_browser_snapshot again with the SAME session and SAME namespace. Do NOT retry open with a different session (that leaks a browser).", true);
}

// Live daemon probes (fast when daemon healthy; bounded when sick).
// EXISTS 경로에서만 쓰이므로 타임아웃을 짧게: opencode 쪽 타임아웃보다
// 먼저 터져야 "ensure 무응답"으로 보이지 않는다.
async function daemonSessions(ns) {
  try {
    const r = await runCli(["--namespace", toSafe(ns), "session", "list", "--json"], 8000);
    if (r.code !== 0) return [];
    const j = JSON.parse(r.out);
    const arr = (j && j.data && j.data.sessions) || j.sessions || [];
    return arr.map((e) => (typeof e === "string" ? e : e && e.name)).filter(Boolean);
  } catch (e) { return []; }
}
async function sessionTabs(ns, s) {
  try {
    const r = await runCli(["--namespace", toSafe(ns), "--session", toSafe(s), "tab", "list", "--json"], 8000);
    if (r.code !== 0) return "(tab list unavailable)";
    const text = r.out.slice(0, 1500);
    try {
      const j = JSON.parse(r.out);
      const tabs = (j && j.data && j.data.tabs) || j.tabs || [];
      if (!tabs.length) return "(no open tabs)";
      return tabs.slice(0, 10).map((t) => {
        if (typeof t === "string") return "- " + t;
        return "- " + (t.id || t.tabId || "?") + (t.label ? " [" + t.label + "]" : "") + (t.url ? " " + t.url : "") + (t.title ? " (" + t.title + ")" : "");
      }).join("\n");
    } catch (e) { return text || "(no open tabs)"; }
  } catch (e) { return "(tab list unavailable)"; }
}

async function onCall(name, rawArgs, id) {
  const def = BY_NAME.get(name);
  if (!def) return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown tool: " + name } });
  const a = (rawArgs && typeof rawArgs === "object") ? Object.assign({}, rawArgs) : {};

  // Scope is explicit on EVERY call: namespace is REQUIRED (single-daemon
  // pinned value) and session identifies the task browser. At least one must
  // be stated; in practice pass BOTH every time.
  const rawNs = a.namespace;
  if (rawNs === undefined || rawNs === null || String(rawNs).trim() === "")
    return send({ jsonrpc: "2.0", id, result: txt("`namespace` is REQUIRED on every call. Pass \"" + DEFAULT_NS + "\" explicitly (single shared daemon), together with your task `session`.", true) });
  const ns = String(rawNs);
  if (ns !== DEFAULT_NS)
    return send({ jsonrpc: "2.0", id, result: txt("Single-daemon proxy: namespace is pinned to \"" + DEFAULT_NS + "\". Isolate work with `session`, not `namespace`. Retry with namespace \"" + DEFAULT_NS + "\".", true) });

  if (name === "agent_browser_session_ensure") {
    let s = String(a.session || "").trim();
    if (!s) s = suggestSession(a.task || "task");
    const p = sessionProblem(s);
    if (p) return send({ jsonrpc: "2.0", id, result: txt(p, true) });
    const wantReuse = a.reuse === true;
    if (sessions.has(keyOf(ns, s))) {
      touch(ns, s);
      return send({ jsonrpc: "2.0", id, result: txt(
        "session ready: \"" + s + "\" (namespace \"" + ns + "\", already tracked here, idle TTL " + Math.round(TTL_MS / 1000) + "s).\n" +
        "RULES: use this SAME namespace+session for EVERY call in this task. Flow: open -> snapshot -> click/fill (fresh @refs) -> snapshot. " +
        "Refs die on navigation/tab switch. End with agent_browser_close when done.") });
    }
    const live = await daemonSessions(ns);
    if (live.indexOf(toSafe(s)) >= 0 && !wantReuse) {
      const tabs = await sessionTabs(ns, s);
      return send({ jsonrpc: "2.0", id, result: txt(
        "EXISTS: namespace \"" + ns + "\" already has a live session \"" + s + "\" with open tabs:\n" +
        tabs + "\n" +
        "Is this YOUR browser from earlier work? If YES, re-call agent_browser_session_ensure with the same namespace+session plus reuse:true to adopt it. " +
        "If NO (another task owns it), pick a different session name.", true) });
    }
    touch(ns, s);
    return send({ jsonrpc: "2.0", id, result: txt(
      (wantReuse ? "adopted existing live session" : "session ready:") + " \"" + s + "\" (namespace \"" + ns + "\", idle TTL " + Math.round(TTL_MS / 1000) + "s).\n" +
      "RULES: use this SAME namespace+session for EVERY call in this task. Flow: open -> snapshot -> click/fill (fresh @refs) -> snapshot. " +
      "Refs die on navigation/tab switch. End with agent_browser_close when done.") });
  }
  if (name === "agent_browser_session_cleanup") {
    if (a.namespace && String(a.namespace) !== DEFAULT_NS) return send({ jsonrpc: "2.0", id, result: txt('Single-daemon proxy: namespace is pinned to "' + DEFAULT_NS + '". Isolate work with `session`, not `namespace`. Retry without `namespace`.', true) });




    const ttl = a.all ? 0 : Number(a.maxIdleMs != null ? a.maxIdleMs : TTL_MS);
    const now = Date.now();
    const closed = [];
    const skipped = [];
    for (const [key, m] of Array.from(sessions)) {

      if (m.inFlight > 0) { skipped.push(m.ns + "/" + m.name); continue; } // never touch active work
      if (now - m.lastSeen >= ttl) {
        const r = await closeSession(m.ns, m.name);
        closed.push(r.code === 0 ? (m.ns + "/" + m.name) : (m.ns + "/" + m.name + "(exit " + r.code + ")"));
        sessions.delete(key);
      }
    }
    const rest = Array.from(sessions.values()).map((m) => m.ns + "/" + m.name);
    return send({ jsonrpc: "2.0", id, result: txt(
      "cleanup: closed " + closed.length + " [" + (closed.join(", ") || "none") + "]; " +
      "skipped active " + skipped.length + " [" + (skipped.join(", ") || "none") + "]; " +
      "tracked remaining " + rest.length + " [" + (rest.join(", ") || "none") + "].") });
  }

  // session-gated tools: the pair must be tracked (ensured) first, so a caller
  // can never silently attach to a stranger's live browser.
  const session = a.session;
  const unknownPairMsg = "Unknown pair: namespace \"" + ns + "\" + session \"" + (session || "(none)") + "\" is not tracked here (proxy restarted? never ensured?). Call agent_browser_session_ensure with this namespace+session FIRST - if a live browser already exists there, it shows its tabs and asks for reuse:true. Do NOT guess session names.";
  if (def.needSession) {
    const p = sessionProblem(session);
    if (p) return send({ jsonrpc: "2.0", id, result: txt(p, true) });
    if (!sessions.has(keyOf(ns, session)))
      return send({ jsonrpc: "2.0", id, result: txt(unknownPairMsg, true) });
  } else if (session) {
    const p = sessionProblem(session);
    if (p) return send({ jsonrpc: "2.0", id, result: txt(p, true) });
    if (!sessions.has(keyOf(ns, session)))
      return send({ jsonrpc: "2.0", id, result: txt(unknownPairMsg, true) });
  }
  const effSession = session || null;

  if (typeof a.selector === "string") {
    const f = fixSelector(a.selector);
    if (f.fixed) a.selector = f.value;
  }
  const selNote = (typeof (rawArgs && rawArgs.selector) === "string" && fixSelector(rawArgs.selector).fixed)
    ? " (auto-fixed selector to \"" + a.selector + "\")"
    : "";

  try {
    if (name === "agent_browser_session_list" && !effSession) {
      const res = await execTool(def, a, ns, null);
      if (res.content && res.content[0] && res.content[0].text) {
        const notes = [];
        for (const m of sessions.values()) {
          if (m.safeName !== m.name && res.content[0].text.indexOf(m.safeName) >= 0)
            notes.push(m.safeName + "  =  \"" + m.name + "\"");
        }
        if (notes.length) res.content.push({ type: "text", text: "Known original names:\n" + notes.join("\n") });
      }
      return send({ jsonrpc: "2.0", id, result: res });
    }
    const res = (name === "agent_browser_open")
      ? await execOpenWithVerify(def, a, ns, effSession)
      : await execTool(def, a, ns, effSession);
    if (selNote && res.content) res.content.push({ type: "text", text: selNote });
    return send({ jsonrpc: "2.0", id, result: res });
  } catch (e) {
    return send({ jsonrpc: "2.0", id, error: { code: -32603, message: "agent-browser CLI failed (" + CLI + "): " + String((e && e.message) || e).slice(0, 500) } });
  }
}

async function onMessage(m) {
  if (!m || m.jsonrpc !== "2.0") return;
  const id = m.id;
  const method = m.method;
  const params = m.params || {};
  try {
    if (method === "initialize") return send({ jsonrpc: "2.0", id, result: {
      protocolVersion: params.protocolVersion || PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: "agent-browser-session-proxy", title: "agent-browser (session-safe)", version: "2.3.0" },
      instructions: "Session-isolated browser on ONE shared daemon. Concurrent tasks MUST use different sessions (call agent_browser_session_ensure first). Flow per task: open -> snapshot -> interact with fresh @refs. Idle sessions auto-close; in-flight work is never interrupted.",
    } });
    if (typeof method === "string" && method.indexOf("notifications/") === 0) return;
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") {
      const all = TOOLS.map((t) => {
        const c = Object.assign({}, t);
        delete c.build;
        return c;
      });
      const pageSize = 50;
      const cur = params.cursor ? Number(params.cursor) : 0;
      const page = all.slice(cur, cur + pageSize);
      const r = { tools: page };
      if (cur + pageSize < all.length) r.nextCursor = String(cur + pageSize);
      return send({ jsonrpc: "2.0", id, result: r });
    }
    if (method === "tools/call") return await onCall(params.name, params.arguments, id);
    if (method === "resources/list" || method === "prompts/list") return send({ jsonrpc: "2.0", id, result: { resources: [], prompts: [] } });
    if (id !== undefined) return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
  } catch (e) {
    log("handler:", (e && e.message) || e);
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32603, message: String((e && e.message) || e).slice(0, 500) } });
  }
}

let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  stdinBuf += c;
  let i;
  while ((i = stdinBuf.indexOf("\n")) >= 0) {
    const line = stdinBuf.slice(0, i).trim();
    stdinBuf = stdinBuf.slice(i + 1);
    if (!line) continue;
    try { onMessage(JSON.parse(line)); } catch (e) { log("bad JSON:", String((e && e.message) || e).slice(0, 150)); }
  }
});
process.stdin.on("end", () => process.exit(0));
loadStore();
// 복구된 세션 검증: 데몬 사이드카가 없거나 닿지 않으면 이전 부팅의 잔해이므로
// 비운다. 검증 없이 쓰면 죽은 데몬 target으로 첫 호출이 10061 난다.
setImmediate(() => { validateRestoredSessions().catch((e) => log("store validate:", (e && e.message) || e)); });
async function validateRestoredSessions() {
  if (!sessions.size) return;
  const dir = daemonRunDir();
  const key = toSafe(DEFAULT_NS);
  // 사이드카 자체가 하나도 없으면(이번 부팅에 데몬이 뜬 적 없음) 이전 잔해 확정 → 파기.
  // 파일은 있는데 닿지 않으면 기동 중/좀비라서 유지한다: 좀비는 sweep이 죽이고,
  // 호출 실패는 stale-target 재시도가 살린다. 여기서 파기하면 멀쩡한 세션까지
  // Unknown-pair로 내몬다 (slow-start 레이스).
  let anySidecar = false;
  for (const suffix of [...DAEMON_SIDECARS, "target"]) {
    try {
      const entries = fs.readdirSync(dir).filter((f) => f.endsWith("." + suffix));
      if (entries.length > 0) { anySidecar = true; break; }
    } catch (e) { /* run dir 없음 = 사이드카 없음 */ }
  }
  if (!anySidecar) {
    const n = sessions.size;
    sessions.clear();
    try { fs.unlinkSync(STORE_PATH); } catch (e) {}
    log("dropped " + n + " restored sessions: no daemon sidecars (fresh boot)");
    return;
  }
  try {
    const pid = readSidecarInt(dir, key, "pid");
    const port = readSidecarInt(dir, key, "port");
    const alive = pid !== null && pidAlive(pid);
    const open = alive && port !== null && (await portOpen(port));
    log("kept " + sessions.size + " restored sessions (sidecars present, daemon reachable=" + open + ")");
  } catch (e) {
    log("kept " + sessions.size + " restored sessions (validate skipped)");
  }
}
log("proxy v2.3 starting (cli=" + CLI + ", default-ns=" + DEFAULT_NS + ", ttl=" + TTL_MS + "ms, max=" + MAX_SESSIONS + ", tools=" + TOOLS.length + ")");
