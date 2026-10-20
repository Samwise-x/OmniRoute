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
function event(type, task, extra = {}) {
  const e = {
    id: String(++state.seq),
    type,
    payload: { task_id: task.id, mode: task.mode, ...extra },
    ts: new Date().toISOString(),
  };
  state.events.push(e);
  if (state.events.length > 10_000) state.events.splice(0, state.events.length - 10_000);
  persist();
  const frame = `id: ${e.id}\nevent: ${type}\ndata: ${JSON.stringify({ ts: e.ts, payload: e.payload })}\n\n`;
  for (const res of subscribers) res.write(frame);
}
function auth(req) {
  const given = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given),
    b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
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
function eligible(task, runner) {
  const req = task.requirements || {};
  const clis = runner.capabilities.clis || [];
  const matchingProfiles = req.cli
    ? clis.filter((capability) => capability.profile === req.cli)
    : clis;
  return (
    matchingProfiles.length > 0 &&
    (!req.model ||
      matchingProfiles.some(
        (capability) => capability.models?.includes(req.model) || capability.models?.includes("*")
      ))
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
  if (!auth(req)) return json(res, 401, { error: "unauthorized" });
  try {
    if (req.method === "GET" && url.pathname === "/v1/runners")
      return json(res, 200, state.runners.map(cleanRunner));
    if (req.method === "GET" && url.pathname === "/v1/tasks")
      return json(
        res,
        200,
        state.tasks.slice().sort((a, b) => b.created_at.localeCompare(a.created_at))
      );
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
      const idempotencyKey = req.headers["idempotency-key"];
      if (idempotencyKey && (typeof idempotencyKey !== "string" || idempotencyKey.length > 200))
        return json(res, 400, { error: "invalid idempotency key" });
      const prior = idempotencyKey && state.tasks.find((t) => t.idempotency_key === idempotencyKey);
      if (prior) {
        const same =
          prior.repo.url === input.repo.url.trim() &&
          prior.repo.base_ref === (input.repo.base_ref || "main") &&
          prior.spec.prompt === input.spec.prompt &&
          prior.mode === (input.mode || "solo") &&
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
        mode: input.mode || "solo",
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
        clis: input.capabilities.clis,
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
    const match = url.pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/(cancel|result))?$/);
    if (match) {
      const task = state.tasks.find((t) => t.id === decodeURIComponent(match[1]));
      if (!task) return json(res, 404, { error: "task not found" });
      if (req.method === "GET" && !match[2]) return json(res, 200, task);
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
server.listen(PORT, HOST, () =>
  console.log(`OmniConductor Hub listening on ${HOST}:${PORT}; state=${STATE_FILE}`)
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    for (const res of subscribers) res.end();
    server.close(() => process.exit(0));
  });
