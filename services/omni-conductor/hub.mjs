#!/usr/bin/env node
/** Minimal, durable OmniConductor Hub implementing OmniRoute's existing v1 contract. */
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 7910);
const HOST = process.env.HOST || "0.0.0.0";
const TOKEN = process.env.CONDUCTOR_HUB_TOKEN || process.env.HUB_TOKEN || "";
const STATE_FILE = process.env.CONDUCTOR_STATE_FILE || "/data/conductor-state.json";
const HEARTBEAT_TTL_MS = Number(process.env.RUNNER_HEARTBEAT_TTL_MS || 30_000);
const MAX_EVENTS = Number(process.env.CONDUCTOR_MAX_EVENTS || 10_000);
// Retention: a terminal task is kept for TTL, then dropped. 0 disables pruning entirely
// (keep every task forever) — the durable default is "prune", because an unbounded list is
// what a dashboard eventually dies from.
const TASK_RETENTION_MS = Number(
  process.env.CONDUCTOR_TASK_RETENTION_MS || 7 * 24 * 60 * 60 * 1000
);
const MAX_TASKS = Number(process.env.CONDUCTOR_MAX_TASKS || 5_000);
// `mode` is a closed set. Anything else is a client bug; silently accepting it means the
// dashboard, the events and the runner all disagree about what the task is.
const TASK_MODES = ["solo", "council"];
const TERMINAL = ["completed", "failed", "canceled"];
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const MAX_TASK_RETRIES = Number(process.env.CONDUCTOR_MAX_TASK_RETRIES || 3);
if (!TOKEN || TOKEN.length < 16)
  throw new Error("CONDUCTOR_HUB_TOKEN must contain at least 16 characters");

function loadState() {
  try {
    const value = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      seq: value.seq || 0,
      events: value.events || [],
      tasks: value.tasks || [],
      runners: value.runners || [],
    };
  } catch (e) {
    if (e.code !== "ENOENT") console.error(`state recovery: ${e.message}`);
    return { seq: 0, events: [], tasks: [], runners: [] };
  }
}
let state = loadState();
const subscribers = new Set();
function persist() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}
/**
 * Drop tasks that have been terminal for longer than the retention window, then enforce a
 * hard cap by dropping the oldest terminal tasks. Running work is never pruned. Returns
 * the number dropped so the caller can skip a pointless write.
 */
function pruneTasks() {
  const before = state.tasks.length;
  const cutoff = Date.now() - TASK_RETENTION_MS;
  if (TASK_RETENTION_MS > 0) {
    state.tasks = state.tasks.filter((task) => {
      const ended = Date.parse(task.completed_at || "");
      if (!TERMINAL.includes(task.status) || Number.isNaN(ended)) return true;
      return ended >= cutoff;
    });
  }
  if (MAX_TASKS > 0 && state.tasks.length > MAX_TASKS) {
    const terminal = state.tasks
      .filter((task) => TERMINAL.includes(task.status))
      .sort((a, b) => String(a.completed_at).localeCompare(String(b.completed_at)));
    const excess = state.tasks.length - MAX_TASKS;
    const drop = new Set(terminal.slice(0, Math.min(excess, terminal.length)).map((t) => t.id));
    if (drop.size) state.tasks = state.tasks.filter((task) => !drop.has(task.id));
  }
  return before - state.tasks.length;
}
/**
 * Operational counters. Kept deliberately tiny and JSON (not Prometheus text): the
 * dashboard consumes it, and every counter here answers a question an operator has
 * actually asked — "is work backing up, are runners alive, is anything failing".
 * `/metrics` sits behind the same bearer auth as the rest of `/v1`, because queue
 * depth is fleet information.
 */
function metrics() {
  const now = Date.now();
  const byStatus = {};
  for (const task of state.tasks) byStatus[task.status] = (byStatus[task.status] || 0) + 1;
  const online = state.runners.filter((r) => now - r.last_seen < HEARTBEAT_TTL_MS);
  const requirements = state.tasks.filter((t) => t.status === "queued").length;
  const capacity = online
    .filter((r) => !r.draining)
    .reduce((sum, r) => sum + Math.max(0, (r.max_concurrency || 1) - (r.active || 0)), 0);
  const oldestQueued = state.tasks
    .filter((t) => t.status === "queued")
    .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  return {
    tasks: {
      total: state.tasks.length,
      by_status: byStatus,
      queued: byStatus.queued || 0,
      running: byStatus.working || 0,
      // Depth after capacity: ">0" means nothing can start until a runner frees up.
      queued_over_capacity: Math.max(0, requirements - capacity),
      oldest_queued_age_ms: oldestQueued
        ? Math.max(0, now - Date.parse(oldestQueued.created_at))
        : 0,
      retries: state.tasks.reduce((sum, t) => sum + Number(t.retries || 0), 0),
    },
    runners: {
      total: state.runners.length,
      online: online.length,
      draining: online.filter((r) => r.draining).length,
      capacity,
    },
    events: { buffered: state.events.length, seq: state.seq, subscribers: subscribers.size },
    retention: {
      task_retention_ms: TASK_RETENTION_MS,
      max_tasks: MAX_TASKS,
      max_events: MAX_EVENTS,
    },
    uptime_ms: Math.round(process.uptime() * 1000),
  };
}
function event(type, task, extra = {}) {
  const e = {
    id: String(++state.seq),
    type,
    // Task-scoped events carry their task; lifecycle events (runner.deregistered) pass
    // nulls rather than inventing an id that no task has.
    payload: { task_id: task.id ?? null, mode: task.mode ?? null, ...extra },
    ts: new Date().toISOString(),
  };
  state.events.push(e);
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  persist();
  const frame = `id: ${e.id}\nevent: ${type}\ndata: ${JSON.stringify({ ts: e.ts, payload: e.payload })}\n\n`;
  for (const res of subscribers) res.write(frame);
}
// Principals. One shared secret means a compromised runner can create, cancel and retry
// tasks anywhere in the fleet — it is the same credential the orchestrator uses. These
// are optional: unset, the Hub behaves exactly as before (single shared token), so an
// existing deployment keeps working and can adopt them incrementally.
//
//   CONDUCTOR_HUB_TOKEN             full access (admin/orchestrator)  — required
//   CONDUCTOR_RUNNER_TOKEN          runner-only verbs: register / heartbeat / claim /
//                                   deregister / result. Cannot create or cancel tasks.
//   CONDUCTOR_READONLY_TOKEN        GET only.
const RUNNER_TOKEN = process.env.CONDUCTOR_RUNNER_TOKEN || "";
const READONLY_TOKEN = process.env.CONDUCTOR_READONLY_TOKEN || "";

// Which verbs each principal may use. The runner surface is exactly what `runner.mjs`
// calls; anything wider is deliberately absent.
const RUNNER_ROUTES = new Set([
  "/v1/runners/register",
  "/v1/runners/heartbeat",
  "/v1/runners/deregister",
  "/v1/runner/claim",
]);
const RUNNER_PATTERNS = [/^\/v1\/tasks\/[^/]+\/result$/];

function matches(given, secret) {
  const a = Buffer.from(given),
    b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Resolves the caller's principal from its bearer token, or `null` when unauthorized.
 * Constant-time comparison against every configured secret (no early exit, so timing
 * does not reveal which secret matched).
 */
function principal(req) {
  const given = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!given) return null;
  let found = null;
  if (matches(given, TOKEN)) found = "admin";
  if (RUNNER_TOKEN && matches(given, RUNNER_TOKEN)) found = "runner";
  if (READONLY_TOKEN && matches(given, READONLY_TOKEN)) found = "readonly";
  return found;
}

/** Does `who` get to call `method path`? Admin: everything. Others: a strict subset. */
function authorize(who, method, pathname) {
  if (!who) return false;
  if (who === "admin") return true;
  if (who === "readonly") return method === "GET" || method === "HEAD";
  if (who === "runner") {
    if (method === "GET" && pathname === "/v1/runners") return true;
    if (method !== "POST") return false;
    return RUNNER_ROUTES.has(pathname) || RUNNER_PATTERNS.some((re) => re.test(pathname));
  }
  return false;
}
function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 1_000_000) throw new Error("request body too large");
  }
  return JSON.parse(text || "{}");
}
function cleanRunner(r) {
  return {
    id: r.id,
    online: Date.now() - r.last_seen < HEARTBEAT_TTL_MS,
    draining: !!r.draining,
    capabilities: r.capabilities,
  };
}
/**
 * Does an advertised model pattern cover the requested model?
 *
 * Three shapes are legitimate, and the middle one used to be broken: `*` delegates the
 * name to the CLI, an exact string is the literal name, and `<prefix>/*` is how a
 * gateway-routed harness advertises "everything my gateway serves" (`omniroute/*`).
 * The last one was compared as a literal string, so a task pinned to
 * `omniroute/claude-sonnet-4-5` NEVER matched and sat queued forever with no diagnostic.
 * `*` inside a longer pattern is a glob, so any other `foo*` form keeps working too.
 */
function modelMatches(models, model) {
  if (!Array.isArray(models)) return false;
  if (models.includes("*") || models.includes(model)) return true;
  return models.some((pattern) => {
    if (typeof pattern !== "string" || !pattern.includes("*")) return false;
    const re = new RegExp(
      `^${pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`
    );
    return re.test(model);
  });
}
function eligible(task, runner) {
  const req = task.requirements || {};
  const clis = runner.capabilities.clis || [];
  const matchingProfiles = req.cli
    ? clis.filter((capability) => capability.profile === req.cli)
    : clis;
  return (
    matchingProfiles.length > 0 &&
    (!req.model ||
      matchingProfiles.some((capability) => modelMatches(capability.models, req.model)))
  );
}
function chooseRunner(task) {
  return (
    state.runners
      .filter(
        (r) =>
          !r.draining &&
          Date.now() - r.last_seen < HEARTBEAT_TTL_MS &&
          r.active < r.max_concurrency &&
          eligible(task, r)
      )
      .sort((a, b) => a.id.localeCompare(b.id))[0] || null
  );
}
function assign(task, runner) {
  task.status = "working";
  task.assigned_runner = runner.id;
  task.started_at = new Date().toISOString();
  task.updated_at = task.started_at;
  runner.active++;
  event("task.scheduled", task, { runner_id: runner.id });
  event("runner.started", task, { runner_id: runner.id });
}
// Scheduling is explicit and stable: oldest task first, then runner id lexical order.
function schedule() {
  // A dead runner's lease expires; its interrupted task returns to the queue and can be retried.
  for (const runner of state.runners) {
    if (Date.now() - runner.last_seen > HEARTBEAT_TTL_MS) {
      for (const task of state.tasks.filter(
        (t) => t.status === "working" && t.assigned_runner === runner.id
      )) {
        task.status = "queued";
        task.assigned_runner = null;
        delete task.claimed_at;
        delete task.claimed_session_id;
        task.updated_at = new Date().toISOString();
      }
      runner.active = 0;
    }
  }
  for (const task of state.tasks
    .filter((t) => t.status === "queued")
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    const runner = chooseRunner(task);
    if (runner) assign(task, runner);
  }
  persist();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && ["/health", "/healthz", "/readyz"].includes(url.pathname))
    return json(res, 200, {
      status: "ok",
      service: "omni-conductor-hub",
      tasks: state.tasks.length,
      runners: state.runners.filter((r) => Date.now() - r.last_seen < HEARTBEAT_TTL_MS).length,
    });
  const who = principal(req);
  if (!who) return json(res, 401, { error: "unauthorized" });
  if (!authorize(who, req.method, url.pathname))
    return json(res, 403, { error: `principal '${who}' may not ${req.method} ${url.pathname}` });
  try {
    // Queue depth is fleet information: behind the same bearer gate as /v1/*.
    if (req.method === "GET" && url.pathname === "/metrics") return json(res, 200, metrics());
    if (req.method === "GET" && url.pathname === "/v1/runners")
      return json(res, 200, state.runners.map(cleanRunner));
    if (req.method === "GET" && url.pathname === "/v1/tasks") {
      // Keyset pagination on (created_at, id): `?limit=&cursor=&status=&mode=`.
      // A plain array is still returned when no cursor/limit is asked for, so existing
      // clients keep working; asking for a page switches to `{ tasks, next_cursor }`.
      const limitRaw = url.searchParams.get("limit");
      const paginated =
        limitRaw !== null ||
        url.searchParams.has("cursor") ||
        url.searchParams.has("status") ||
        url.searchParams.has("mode");
      const limit = Math.min(
        Math.max(
          Number.isFinite(Number(limitRaw)) && Number(limitRaw) > 0
            ? Number(limitRaw)
            : DEFAULT_LIST_LIMIT,
          1
        ),
        MAX_LIST_LIMIT
      );
      const status = url.searchParams.get("status");
      const mode = url.searchParams.get("mode");
      if (status && ![...TERMINAL, "queued", "running"].includes(status))
        return json(res, 400, { error: "invalid status filter" });
      if (mode && !TASK_MODES.includes(mode))
        return json(res, 400, { error: `mode must be one of: ${TASK_MODES.join(", ")}` });

      let rows = state.tasks.slice();
      if (status) rows = rows.filter((t) => t.status === status);
      if (mode) rows = rows.filter((t) => t.mode === mode);
      rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));

      if (!paginated) return json(res, 200, rows);

      const cursor = url.searchParams.get("cursor");
      if (cursor) {
        let decoded;
        try {
          decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        } catch {
          return json(res, 400, { error: "invalid cursor" });
        }
        if (typeof decoded?.created_at !== "string" || typeof decoded?.id !== "string")
          return json(res, 400, { error: "invalid cursor" });
        const { created_at, id } = decoded;
        rows = rows.filter(
          (t) => t.created_at < created_at || (t.created_at === created_at && t.id < id)
        );
      }
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const next_cursor =
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString(
              "base64url"
            )
          : null;
      return json(res, 200, { tasks: page, next_cursor });
    }
    if (req.method === "GET" && url.pathname === "/v1/events") {
      const cursor = Number(url.searchParams.get("last_event_id") || 0);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const e of state.events.filter((e) => Number(e.id) > cursor))
        res.write(
          `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify({ ts: e.ts, payload: e.payload })}\n\n`
        );
      res.write(": connected\n\n");
      subscribers.add(res);
      const keep = setInterval(() => {
        if (!res.destroyed) res.write(": ping\n\n");
      }, 15_000);
      req.on("close", () => {
        clearInterval(keep);
        subscribers.delete(res);
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/tasks") {
      const input = await body(req);
      if (
        typeof input.repo?.url !== "string" ||
        !input.repo.url.trim() ||
        typeof input.spec?.prompt !== "string" ||
        !input.spec.prompt.trim()
      )
        return json(res, 400, { error: "repo.url and spec.prompt are required" });
      if (input.spec.prompt.length > 40_000 || input.repo.url.length > 2_000)
        return json(res, 413, { error: "task input too large" });
      const mode = input.mode || "solo";
      if (!TASK_MODES.includes(mode))
        return json(res, 400, { error: `mode must be one of: ${TASK_MODES.join(", ")}` });
      const idempotencyKey = req.headers["idempotency-key"];
      if (idempotencyKey && (typeof idempotencyKey !== "string" || idempotencyKey.length > 200))
        return json(res, 400, { error: "invalid idempotency key" });
      const prior = idempotencyKey && state.tasks.find((t) => t.idempotency_key === idempotencyKey);
      if (prior) {
        const same =
          prior.repo.url === input.repo.url.trim() &&
          prior.repo.base_ref === (input.repo.base_ref || "main") &&
          prior.spec.prompt === input.spec.prompt &&
          prior.mode === mode &&
          JSON.stringify(prior.requirements || {}) === JSON.stringify(input.requirements || {});
        return same
          ? json(res, 200, { id: prior.id })
          : json(res, 409, { error: "idempotency key already used for a different task" });
      }
      const id = `task_${randomUUID()}`;
      const now = new Date().toISOString();
      const task = {
        id,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
        status: "queued",
        mode,
        repo: { url: input.repo.url.trim(), base_ref: input.repo.base_ref || "main" },
        spec: { prompt: input.spec.prompt },
        requirements: input.requirements || {},
        assigned_runner: null,
        manifest: null,
        created_at: now,
        updated_at: now,
      };
      state.tasks.push(task);
      persist();
      event("task.created", task);
      schedule();
      return json(res, 201, { id });
    }
    if (req.method === "POST" && url.pathname === "/v1/runners/register") {
      const input = await body(req);
      if (
        !/^[a-zA-Z0-9._-]{1,128}$/.test(input.id || "") ||
        (input.session_id !== undefined && !/^[a-zA-Z0-9._-]{1,128}$/.test(input.session_id)) ||
        !input.capabilities ||
        !Array.isArray(input.capabilities.clis)
      )
        return json(res, 400, { error: "runner id and capabilities.clis are required" });
      let runner = state.runners.find((r) => r.id === input.id);
      if (!runner) {
        runner = { id: input.id, active: 0 };
        state.runners.push(runner);
      }
      const sessionId = typeof input.session_id === "string" ? input.session_id : "";
      if (sessionId && runner.session_id !== sessionId) {
        runner.active = 0;
        for (const task of state.tasks.filter(
          (task) => task.status === "working" && task.assigned_runner === runner.id
        )) {
          task.status = "queued";
          task.assigned_runner = null;
          delete task.claimed_at;
          delete task.claimed_session_id;
          task.updated_at = new Date().toISOString();
          event("task.recovered", task, { runner_id: runner.id, reason: "runner_restarted" });
        }
        runner.session_id = sessionId;
      }
      runner.capabilities = {
        name: String(input.capabilities.name || input.id),
        // Preserve the harness versions the Runner reported: an operator needs to know
        // which binary a task actually ran on, and the fleet view is where they look.
        clis: input.capabilities.clis.map((cli) => ({
          profile: cli.profile,
          models: cli.models,
          ...(cli.version ? { version: cli.version } : {}),
        })),
        skills: input.capabilities.skills || [],
      };
      runner.max_concurrency = Math.max(1, Math.min(32, Number(input.max_concurrency) || 1));
      runner.draining = !!input.draining;
      runner.last_seen = Date.now();
      persist();
      schedule();
      return json(res, 200, { id: runner.id, registered: true });
    }
    if (req.method === "POST" && url.pathname === "/v1/runners/heartbeat") {
      const input = await body(req);
      const runner = state.runners.find((r) => r.id === input.id);
      if (!runner) return json(res, 404, { error: "runner not registered" });
      if (runner.session_id && input.session_id !== runner.session_id)
        return json(res, 409, { error: "runner session is stale" });
      runner.last_seen = Date.now();
      if (typeof input.draining === "boolean") runner.draining = input.draining;
      persist();
      schedule();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/v1/runners/deregister") {
      // Graceful shutdown: a Runner that is going away says so, instead of leaving its
      // work pinned to a ghost until the heartbeat TTL expires (up to a full interval of
      // a stuck queue). Its in-flight work is returned to the queue immediately and is
      // eligible for any other runner on the next schedule pass.
      const input = await body(req);
      const runner = state.runners.find((r) => r.id === input.id);
      if (!runner) return json(res, 404, { error: "runner not registered" });
      if (runner.session_id && input.session_id !== runner.session_id)
        return json(res, 409, { error: "runner session is stale" });
      const requeued = [];
      for (const task of state.tasks.filter(
        (t) => t.status === "working" && t.assigned_runner === runner.id
      )) {
        task.status = "queued";
        task.assigned_runner = null;
        delete task.claimed_at;
        delete task.claimed_session_id;
        task.updated_at = new Date().toISOString();
        requeued.push(task.id);
        event("task.recovered", task, { runner_id: runner.id, reason: "runner_deregistered" });
      }
      runner.active = 0;
      state.runners = state.runners.filter((r) => r.id !== runner.id);
      persist();
      event("runner.deregistered", { id: null, mode: null }, { runner_id: runner.id, requeued });
      schedule();
      return json(res, 200, { id: runner.id, deregistered: true, requeued });
    }
    if (req.method === "POST" && url.pathname === "/v1/runner/claim") {
      const input = await body(req);
      const runner = state.runners.find(
        (r) => r.id === input.id && Date.now() - r.last_seen < HEARTBEAT_TTL_MS
      );
      if (!runner) return json(res, 404, { error: "runner not registered or offline" });
      if (runner.session_id && input.session_id !== runner.session_id)
        return json(res, 409, { error: "runner session is stale" });
      schedule();
      const task = state.tasks.find(
        (t) => t.status === "working" && t.assigned_runner === runner.id && !t.claimed_at
      );
      if (!task) {
        res.writeHead(204);
        return res.end();
      }
      task.claimed_at = new Date().toISOString();
      if (runner.session_id) task.claimed_session_id = runner.session_id;
      persist();
      return json(res, 200, task);
    }
    const match = url.pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/(cancel|result|retry))?$/);
    if (match) {
      const task = state.tasks.find((t) => t.id === decodeURIComponent(match[1]));
      if (!task) return json(res, 404, { error: "task not found" });
      if (req.method === "GET" && !match[2]) return json(res, 200, task);
      if (req.method === "POST" && match[2] === "retry") {
        // Re-queue a terminal task, in place, under the same id: the dashboard already
        // holds that id, and a fresh id would orphan its event history. Non-terminal
        // tasks are refused — retrying something already running is a double execution.
        if (!TERMINAL.includes(task.status))
          return json(res, 409, { error: "task is not terminal; nothing to retry" });
        const retries = Number(task.retries || 0) + 1;
        if (retries > MAX_TASK_RETRIES)
          return json(res, 409, {
            error: `retry limit reached (${MAX_TASK_RETRIES})`,
            retries: task.retries || 0,
          });
        const previous = {
          status: task.status,
          error: task.manifest?.error ?? null,
          completed_at: task.completed_at ?? null,
        };
        task.status = "queued";
        task.claimed_at = null;
        task.claimed_session_id = null;
        task.assigned_runner = null;
        task.completed_at = null;
        task.manifest = null;
        task.retries = retries;
        task.updated_at = new Date().toISOString();
        task.retry_history = [...(task.retry_history || []), previous].slice(-MAX_TASK_RETRIES);
        persist();
        event("task.retried", task, { retries, previous_status: previous.status });
        schedule();
        return json(res, 200, { id: task.id, status: task.status, retries });
      }
      if (req.method === "POST" && match[2] === "cancel") {
        if (["completed", "failed", "canceled"].includes(task.status))
          return json(res, 409, { error: "task is already terminal" });
        if (task.assigned_runner) {
          const r = state.runners.find((r) => r.id === task.assigned_runner);
          if (r) r.active = Math.max(0, r.active - 1);
        }
        task.status = "canceled";
        task.updated_at = new Date().toISOString();
        persist();
        event("task.canceled", task);
        schedule();
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && match[2] === "result") {
        const input = await body(req);
        const runner = state.runners.find((r) => r.id === task.assigned_runner);
        if (!runner || input.runner_id !== runner.id)
          return json(res, 403, { error: "result runner mismatch" });
        if (
          (runner.session_id && input.session_id !== runner.session_id) ||
          (task.claimed_session_id && input.session_id !== task.claimed_session_id)
        )
          return json(res, 403, { error: "result runner session mismatch" });
        if (task.status === "canceled") return json(res, 409, { error: "task canceled" });
        if (task.status !== "working") return json(res, 409, { error: "task not working" });
        runner.active = Math.max(0, runner.active - 1);
        const success = input.ok === true;
        task.status = success ? "completed" : "failed";
        task.updated_at = new Date().toISOString();
        task.completed_at = task.updated_at;
        task.manifest = {
          summary: String(
            input.summary || (success ? "Execution completed" : "Execution failed")
          ).slice(0, 4_000),
          branch: input.branch || null,
          error: success ? null : String(input.error || "Runner execution failed").slice(0, 4_000),
          tests: input.tests ?? null,
          result: input.result ?? null,
        };
        persist();
        const eventManifest = {
          summary: task.manifest.summary,
          branch: task.manifest.branch,
          error: task.manifest.error,
          tests: task.manifest.tests,
        };
        event(success ? "task.completed" : "task.failed", task, { manifest: eventManifest });
        schedule();
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 404, { error: "not found" });
  } catch (error) {
    console.error(error);
    return json(res, 400, { error: "invalid request" });
  }
});
if (pruneTasks()) persist();
const pruneTimer = setInterval(() => {
  if (pruneTasks()) persist();
}, 60_000);
pruneTimer.unref?.();

server.listen(PORT, HOST, () =>
  console.log(`OmniConductor Hub listening on ${HOST}:${PORT}; state=${STATE_FILE}`)
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    for (const res of subscribers) res.end();
    server.close(() => process.exit(0));
  });
