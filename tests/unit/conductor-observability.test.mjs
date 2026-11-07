/**
 * Observability: the Hub's `/metrics` and the event stream the dashboard now consumes.
 *
 * Both exist because the panel was operating blind. It polled the full fleet every 5s
 * and threw away the Hub's `task.*` events, and there was no way to answer "is work
 * backing up?" without eyeballing the task list and counting.
 *
 *   - `/metrics` is auth-gated and reports queue depth *relative to fleet capacity*
 *     (the number an operator can act on), plus retention config and event bookkeeping.
 *   - `/api/conductor/stream` forwards the Hub's own SSE frames, so a client can resume
 *     with `Last-Event-ID` and never miss a transition.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TOKEN = "omni-conductor-observability-token-0123456789";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

function start(script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.logs = "";
  child.stdout.on("data", (d) => (child.logs += d));
  child.stderr.on("data", (d) => (child.logs += d));
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), wait(3000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function healthy(url, child) {
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`hub exited: ${child.logs}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await wait(30);
  }
  throw new Error(`hub did not become healthy: ${child.logs}`);
}

const api = (base, route, body, method = "POST") =>
  fetch(`${base}${route}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test(
  "/metrics reports queue depth against real fleet capacity, behind auth",
  {
    timeout: 30000,
  },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omni-metrics-"));
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    let hub;
    try {
      hub = start("services/omni-conductor/hub.mjs", {
        HOST: "127.0.0.1",
        PORT: String(port),
        CONDUCTOR_HUB_TOKEN: TOKEN,
        CONDUCTOR_STATE_FILE: path.join(dir, "state.json"),
        CONDUCTOR_MAX_TASKS: "123",
        CONDUCTOR_TASK_RETENTION_MS: "456000",
      });
      await healthy(`${url}/health`, hub);

      // 1. Auth: queue depth is fleet information, not public.
      assert.equal((await fetch(`${url}/metrics`)).status, 401);

      // 2. Empty fleet: everything zero, nothing NaN, nothing negative.
      const empty = await (await api(url, "/metrics", undefined, "GET")).json();
      assert.deepEqual(
        {
          total: empty.tasks.total,
          queued: empty.tasks.queued,
          running: empty.tasks.running,
          over: empty.tasks.queued_over_capacity,
        },
        { total: 0, queued: 0, running: 0, over: 0 }
      );
      assert.equal(empty.runners.online, 0);
      assert.equal(empty.tasks.oldest_queued_age_ms, 0, "no queue means no age, not a huge number");
      assert.deepEqual(empty.retention, {
        task_retention_ms: 456000,
        max_tasks: 123,
        max_events: 10000,
      });

      // 3. A runner with capacity 2, then 3 queued tasks: one over capacity.
      await api(url, "/v1/runners/register", {
        id: "metrics-runner",
        max_concurrency: 2,
        capabilities: { name: "metrics-runner", clis: [{ profile: "opencode", models: ["*"] }] },
      });
      for (let i = 0; i < 3; i++)
        await api(url, "/v1/tasks", {
          repo: { url: "https://github.com/acme/r.git" },
          spec: { prompt: `t${i}` },
        });

      // The runner immediately claims up to its capacity, so pin the queued state by
      // reading back and asserting on the invariant rather than a fixed number.
      await wait(150);
      const m = await (await api(url, "/metrics", undefined, "GET")).json();
      assert.equal(m.tasks.total, 3);
      assert.equal(m.tasks.queued + m.tasks.running, 3, "every task is queued or running");
      assert.equal(m.runners.online, 1);
      // The Hub assigns on registration, so `capacity` is what is LEFT (max_concurrency
      // minus assigned work) — assert the relationship, not a snapshot of the scheduler.
      assert.ok(
        m.runners.capacity >= 0 && m.runners.capacity <= 2,
        `capacity ${m.runners.capacity}`
      );
      assert.equal(
        m.runners.capacity,
        Math.max(0, 2 - m.tasks.running),
        "capacity is max_concurrency minus the work already assigned"
      );
      assert.equal(
        m.tasks.queued_over_capacity,
        Math.max(0, m.tasks.queued - m.runners.capacity),
        "over-capacity is derived, not guessed"
      );
      if (m.tasks.queued > 0) assert.ok(m.tasks.oldest_queued_age_ms >= 0);
      // Events are counted so an operator can see the log filling toward its cap.
      assert.ok(m.events.seq > 0);
      assert.equal(m.events.buffered, m.events.seq);
      assert.equal(m.events.subscribers, 0);
      assert.ok(m.uptime_ms > 0);

      // 4. A draining runner is excluded from capacity — it will not take new work.
      await api(url, "/v1/runners/heartbeat", { id: "metrics-runner", draining: true });
      const draining = await (await api(url, "/metrics", undefined, "GET")).json();
      assert.equal(draining.runners.draining, 1);
      assert.equal(draining.runners.capacity, 0, "a draining runner contributes no capacity");
    } finally {
      await stop(hub);
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  "the dashboard event stream forwards hub frames and can resume from Last-Event-ID",
  {
    timeout: 30000,
  },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omni-stream-"));
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    let hub;
    try {
      hub = start("services/omni-conductor/hub.mjs", {
        HOST: "127.0.0.1",
        PORT: String(port),
        CONDUCTOR_HUB_TOKEN: TOKEN,
        CONDUCTOR_STATE_FILE: path.join(dir, "state.json"),
      });
      await healthy(`${url}/health`, hub);

      // One task exists before we subscribe; two more happen while the stream is open.
      const createdBefore = await (
        await api(url, "/v1/tasks", {
          repo: { url: "https://github.com/acme/r.git" },
          spec: { prompt: "before" },
        })
      ).json();

      process.env.CONDUCTOR_HUB_URL = url;
      process.env.CONDUCTOR_HUB_TOKEN = TOKEN;
      const { conductorEventStream } = await import("../../src/lib/conductor/hubProxy.ts");

      const readFrames = async (stream, until, timeoutMs = 8000) => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const { done, value } = await Promise.race([
            reader.read(),
            wait(timeoutMs).then(() => ({ done: true, value: undefined })),
          ]);
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (until(buffer)) break;
        }
        await reader.cancel().catch(() => {});
        return buffer;
      };

      // 1. A fresh subscriber gets the replayed history (the Hub sends from id 0).
      const controller = new AbortController();
      const stream = conductorEventStream(
        new Request("http://local/api/conductor/stream", {
          signal: controller.signal,
        })
      );
      assert.ok(stream, "a configured hub yields a stream");

      const first = await readFrames(stream, (buf) => buf.includes("event: task.created"));
      assert.match(first, /^id: \d+/m, "frames carry the hub's ids so a client can resume");
      assert.match(first, /event: task\.created/);
      assert.match(first, new RegExp(createdBefore.id));

      // 2. Frames produced while subscribed arrive without polling.
      void api(url, "/v1/tasks", {
        repo: { url: "https://github.com/acme/r.git" },
        spec: { prompt: "while streaming" },
      });
      const second = conductorEventStream(new Request("http://local/api/conductor/stream"));
      const seen = await readFrames(
        second,
        (buf) => (buf.match(/event: task\.created/g) || []).length >= 2
      );
      assert.ok(
        (seen.match(/event: task\.created/g) || []).length >= 2,
        `expected both creations, got:\n${seen}`
      );

      // 3. Resuming from the last id does not replay history.
      const resumed = conductorEventStream(
        new Request("http://local/api/conductor/stream", {
          headers: { "last-event-id": "999999" },
        })
      );
      const tail = await readFrames(resumed, (buf) => buf.includes(": connected"), 3000);
      assert.ok(!tail.includes("event: task.created"), `resumed stream must not replay:\n${tail}`);

      // 4. An unconfigured hub degrades instead of throwing.
      const previous = process.env.CONDUCTOR_HUB_URL;
      delete process.env.CONDUCTOR_HUB_URL;
      try {
        assert.equal(
          conductorEventStream(new Request("http://local/api/conductor/stream")),
          null,
          "no hub configured means no stream (the route turns this into an error frame)"
        );
      } finally {
        process.env.CONDUCTOR_HUB_URL = previous;
      }
    } finally {
      await stop(hub);
      await rm(dir, { recursive: true, force: true });
    }
  }
);
