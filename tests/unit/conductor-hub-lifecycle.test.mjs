/**
 * The Hub's task *lifecycle* surface: listing at scale, retention, `mode`, and retry.
 *
 * These are the differences between "the Hub can run a task" and "the Hub can be
 * operated". Each test here fails against the Hub as it was before this change:
 *
 *   - `GET /v1/tasks` returned every task it had ever accepted, unbounded. A fleet with
 *     a real history answers with a body that only grows.
 *   - Nothing pruned tasks. The event log was capped; the task list was not.
 *   - `mode` was any string. A typo produced a task the UI renders as a mode that does
 *     not exist, and events carried it onward.
 *   - There was no retry. A task that failed transiently could only be cancelled and
 *     re-created by hand — under a new id, losing the history that explains the failure.
 *
 * Everything here drives real Hub processes over HTTP; nothing is mocked or stubbed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TOKEN = "omni-conductor-lifecycle-token-0123456789";
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

async function startHub(dir, extraEnv = {}) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const hub = start("services/omni-conductor/hub.mjs", {
    HOST: "127.0.0.1",
    PORT: String(port),
    CONDUCTOR_HUB_TOKEN: TOKEN,
    CONDUCTOR_STATE_FILE: path.join(dir, "state.json"),
    RUNNER_HEARTBEAT_TTL_MS: "60000",
    ...extraEnv,
  });
  await healthy(`${url}/health`, hub);
  return { url, hub };
}

/** Creates a task and returns its id. No runner is registered, so it stays `queued`. */
async function createTask(url, prompt, extra = {}) {
  const res = await api(url, "/v1/tasks", {
    repo: { url: "https://github.com/acme/repo.git" },
    spec: { prompt },
    ...extra,
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).id;
}

test("GET /v1/tasks is bounded, filterable and keyset-paginated", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omni-lifecycle-list-"));
  let hub;
  try {
    const fleet = await startHub(dir);
    hub = fleet.hub;
    const url = fleet.url;

    const ids = [];
    for (let i = 0; i < 7; i++) ids.push(await createTask(url, `task ${i}`));

    // 1. No query parameters: the legacy bare array is still served, so an existing
    //    client that ignores pagination keeps working.
    const all = await (await api(url, "/v1/tasks", undefined, "GET")).json();
    assert.ok(Array.isArray(all), "a request without paging params still gets a plain array");
    assert.equal(all.length, 7);
    assert.deepEqual(
      all.map((t) => t.id).sort(),
      [...ids].sort(),
      "the unpaged list is complete, not truncated"
    );

    // 2. Asking for a page switches shape and bounds the result.
    const first = await (await api(url, "/v1/tasks?limit=3", undefined, "GET")).json();
    assert.equal(first.tasks.length, 3);
    assert.ok(first.next_cursor, "a full page with more behind it must return a cursor");

    // 3. Walking the cursor yields every task exactly once, then terminates.
    const seen = [...first.tasks.map((t) => t.id)];
    let cursor = first.next_cursor;
    let pages = 1;
    while (cursor) {
      const page = await (
        await api(url, `/v1/tasks?limit=3&cursor=${encodeURIComponent(cursor)}`, undefined, "GET")
      ).json();
      seen.push(...page.tasks.map((t) => t.id));
      cursor = page.next_cursor;
      pages += 1;
      assert.ok(pages < 10, "pagination must terminate");
    }
    assert.equal(seen.length, new Set(seen).size, "no task may appear on two pages");
    assert.deepEqual([...seen].sort(), [...ids].sort());

    // 4. Filters narrow the set; the shape stays the paginated one.
    const queued = await (
      await api(url, "/v1/tasks?status=queued&limit=200", undefined, "GET")
    ).json();
    assert.equal(queued.tasks.length, 7);
    const completed = await (await api(url, "/v1/tasks?status=completed", undefined, "GET")).json();
    assert.deepEqual(completed.tasks, []);
    const council = await (await api(url, "/v1/tasks?mode=council", undefined, "GET")).json();
    assert.deepEqual(council.tasks, [], "no council tasks have been created yet");

    // 5. Bad input is a 400 with a reason, never an empty list that looks like "none".
    assert.equal((await api(url, "/v1/tasks?status=whatever", undefined, "GET")).status, 400);
    assert.equal((await api(url, "/v1/tasks?mode=whatever", undefined, "GET")).status, 400);
    assert.equal((await api(url, "/v1/tasks?cursor=not-a-cursor", undefined, "GET")).status, 400);
    assert.equal(
      (
        await api(
          url,
          `/v1/tasks?cursor=${Buffer.from(JSON.stringify({ id: "x" })).toString("base64url")}`,
          undefined,
          "GET"
        )
      ).status,
      400,
      "a structurally valid but incomplete cursor is still rejected"
    );

    // 6. `limit` is clamped, so one client cannot ask for an unbounded page.
    const clamped = await (await api(url, "/v1/tasks?limit=100000", undefined, "GET")).json();
    assert.ok(clamped.tasks.length <= 200, "limit is clamped to the documented maximum");
  } finally {
    await stop(hub);
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "terminal tasks are pruned by age and by cap, and running work never is",
  {
    timeout: 30000,
  },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omni-lifecycle-retain-"));
    let hub;
    try {
      const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const base = (id, status, extra = {}) => ({
        id,
        status,
        mode: "solo",
        repo: { url: "https://github.com/acme/repo.git", base_ref: "main" },
        spec: { prompt: id },
        requirements: {},
        assigned_runner: null,
        manifest: null,
        created_at: old,
        updated_at: old,
        ...extra,
      });
      // Seeded state: one ancient terminal task, one ancient *unfinished* task, one fresh
      // terminal task. Only the first may disappear.
      await writeFile(
        path.join(dir, "state.json"),
        JSON.stringify({
          seq: 3,
          events: [],
          runners: [],
          tasks: [
            base("task_ancient_done", "completed", { completed_at: old }),
            base("task_ancient_running", "working", { claimed_at: old }),
            base("task_fresh_done", "failed", { completed_at: new Date().toISOString() }),
          ],
        })
      );

      const fleet = await startHub(dir, { CONDUCTOR_TASK_RETENTION_MS: String(60 * 1000) });
      hub = fleet.hub;

      const remaining = (await (await api(fleet.url, "/v1/tasks", undefined, "GET")).json()).map(
        (t) => t.id
      );
      assert.deepEqual(remaining.sort(), ["task_ancient_running", "task_fresh_done"]);

      // The prune is durable, not just an in-memory view.
      const onDisk = JSON.parse(
        await (await import("node:fs/promises")).readFile(path.join(dir, "state.json"), "utf8")
      );
      assert.deepEqual(
        onDisk.tasks.map((t) => t.id).sort(),
        ["task_ancient_running", "task_fresh_done"],
        "the state file is rewritten without the pruned task"
      );

      // A dedicated hard cap drops the oldest terminal tasks first.
      await stop(hub);
      hub = null;
      await rm(path.join(dir, "state.json"));
      const capDir = await mkdtemp(path.join(os.tmpdir(), "omni-lifecycle-cap-"));
      try {
        const now = new Date().toISOString();
        await writeFile(
          path.join(capDir, "state.json"),
          JSON.stringify({
            seq: 4,
            events: [],
            runners: [],
            tasks: [
              base("task_cap_old", "completed", { completed_at: old }),
              base("task_cap_new", "completed", { completed_at: now }),
              base("task_cap_live", "queued"),
            ],
          })
        );
        const capped = await startHub(capDir, {
          CONDUCTOR_MAX_TASKS: "2",
          CONDUCTOR_TASK_RETENTION_MS: "0", // age pruning disabled: isolate the cap
        });
        hub = capped.hub;
        const kept = (await (await api(capped.url, "/v1/tasks", undefined, "GET")).json()).map(
          (t) => t.id
        );
        assert.deepEqual(
          kept.sort(),
          ["task_cap_live", "task_cap_new"],
          "oldest terminal goes first"
        );
      } finally {
        await rm(capDir, { recursive: true, force: true });
      }
    } finally {
      await stop(hub);
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test("`mode` is a closed set at create time", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omni-lifecycle-mode-"));
  let hub;
  try {
    const fleet = await startHub(dir);
    hub = fleet.hub;

    const ok = await api(fleet.url, "/v1/tasks", {
      repo: { url: "https://github.com/acme/repo.git" },
      spec: { prompt: "council work" },
      mode: "council",
    });
    assert.equal(ok.status, 201);
    const { id } = await ok.json();
    const stored = await (await api(fleet.url, `/v1/tasks/${id}`, undefined, "GET")).json();
    assert.equal(stored.mode, "council", "the accepted mode is what the hub stores");

    const bad = await api(fleet.url, "/v1/tasks", {
      repo: { url: "https://github.com/acme/repo.git" },
      spec: { prompt: "typo mode" },
      mode: "solo-council",
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /mode must be one of/);

    // Nothing was created by the refused request.
    const all = await (await api(fleet.url, "/v1/tasks", undefined, "GET")).json();
    assert.equal(all.length, 1);
  } finally {
    await stop(hub);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a terminal task can be retried in place, up to the cap", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omni-lifecycle-retry-"));
  let hub;
  try {
    const fleet = await startHub(dir, { CONDUCTOR_MAX_TASK_RETRIES: "2" });
    hub = fleet.hub;
    const id = await createTask(fleet.url, "flaky");

    // A task that is still queued cannot be retried: that would double-execute it.
    const running = await api(fleet.url, `/v1/tasks/${id}/retry`);
    assert.equal(running.status, 409);
    assert.match((await running.json()).error, /not terminal/);

    const detail = (t) => api(fleet.url, `/v1/tasks/${t}`, undefined, "GET").then((r) => r.json());

    for (let attempt = 1; attempt <= 2; attempt++) {
      await api(fleet.url, `/v1/tasks/${id}/cancel`);
      const retried = await api(fleet.url, `/v1/tasks/${id}/retry`);
      assert.equal(retried.status, 200, await retried.clone().text());
      const body = await retried.json();
      assert.equal(body.id, id, "retry keeps the id so dashboard links and events survive");
      assert.equal(body.status, "queued");
      assert.equal(body.retries, attempt);
      const task = await detail(id);
      assert.equal(task.status, "queued");
      assert.equal(task.manifest, null, "a retried task carries no stale manifest");
      assert.equal(task.retry_history.length, attempt);
      assert.equal(task.retry_history.at(-1).status, "canceled", "the prior outcome is preserved");
    }

    // Past the cap the hub refuses, so a client cannot loop forever.
    await api(fleet.url, `/v1/tasks/${id}/cancel`);
    const capped = await api(fleet.url, `/v1/tasks/${id}/retry`);
    assert.equal(capped.status, 409);
    assert.match((await capped.json()).error, /retry limit reached/);
    assert.equal((await detail(id)).status, "canceled", "a refused retry leaves the task terminal");

    // An unknown task is a 404, not a silent success.
    assert.equal((await api(fleet.url, "/v1/tasks/task_missing/retry")).status, 404);
  } finally {
    await stop(hub);
    await rm(dir, { recursive: true, force: true });
  }
});
