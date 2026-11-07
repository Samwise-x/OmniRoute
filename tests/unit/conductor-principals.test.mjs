/**
 * Principals: one shared secret is not an auth model.
 *
 * Before this, every party — the orchestrator, every Runner, Faro — carried the same
 * bearer token, so a compromised Runner could create tasks, cancel anyone's work and
 * retry in a loop. The Runner never needs any of those verbs: it registers, heartbeats,
 * claims, reports results and deregisters.
 *
 * These tests pin the boundary from both sides: what each principal *can* do (so the
 * roles are useful, not just restrictive), and what it cannot (so the boundary is real).
 * They also pin the compatibility rule: with the optional tokens unset, one secret still
 * works for everything, because that is what every existing deployment has.
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
const ADMIN = "omni-conductor-admin-token-0123456789";
const RUNNER = "omni-conductor-runner-token-0123456789";
const READONLY = "omni-conductor-readonly-token-012345678";
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

function startHubProcess(env) {
  const child = spawn(process.execPath, ["services/omni-conductor/hub.mjs"], {
    cwd: ROOT,
    env: { ...process.env, HOST: "127.0.0.1", ...env },
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
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {}
    await wait(30);
  }
  throw new Error(`hub did not become healthy: ${child.logs}`);
}

async function boot(dir, extraEnv) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const hub = startHubProcess({
    PORT: String(port),
    CONDUCTOR_HUB_TOKEN: ADMIN,
    CONDUCTOR_STATE_FILE: path.join(dir, "state.json"),
    RUNNER_HEARTBEAT_TTL_MS: "60000",
    ...extraEnv,
  });
  await healthy(url, hub);
  return { url, hub };
}

const call = (base, token, route, body, method = "POST") =>
  fetch(`${base}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const SESSION = "scoped-runner-session";
const runnerRegistration = {
  id: "scoped-runner",
  session_id: SESSION,
  max_concurrency: 1,
  capabilities: { name: "scoped-runner", clis: [{ profile: "opencode", models: ["*"] }] },
};
const aTask = { repo: { url: "https://github.com/acme/r.git" }, spec: { prompt: "scoped" } };

test("a runner-scoped token can do runner work and nothing wider", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omni-principals-"));
  let hub;
  try {
    const fleet = await boot(dir, {
      CONDUCTOR_RUNNER_TOKEN: RUNNER,
      CONDUCTOR_READONLY_TOKEN: READONLY,
    });
    hub = fleet.hub;
    const url = fleet.url;

    // --- The runner role is USEFUL: the whole lifecycle works with it. ---
    assert.equal((await call(url, RUNNER, "/v1/runners/register", runnerRegistration)).status, 200);
    assert.equal(
      (
        await call(url, RUNNER, "/v1/runners/heartbeat", {
          id: "scoped-runner",
          session_id: SESSION,
        })
      ).status,
      200
    );
    assert.equal((await call(url, RUNNER, "/v1/runners", undefined, "GET")).status, 200);

    // A task created by the orchestrator is claimable by the runner.
    const created = await call(url, ADMIN, "/v1/tasks", aTask);
    assert.equal(created.status, 201);
    const { id } = await created.json();
    let claimed = null;
    for (let i = 0; i < 50 && !claimed; i++) {
      const res = await call(url, RUNNER, "/v1/runner/claim", {
        id: "scoped-runner",
        session_id: SESSION,
      });
      if (res.status === 200) claimed = await res.json();
      else await wait(20);
    }
    assert.ok(claimed, "the runner role must be able to claim work");
    assert.equal(claimed.id, id);
    assert.equal(
      (
        await call(url, RUNNER, `/v1/tasks/${id}/result`, {
          runner_id: "scoped-runner",
          session_id: SESSION,
          ok: true,
          summary: "done by scoped runner",
        })
      ).status,
      200,
      "the runner role must be able to report the result"
    );

    // --- ...and NOTHING wider. ---
    const forbidden = [
      ["POST", "/v1/tasks", aTask, "create a task"],
      ["POST", `/v1/tasks/${id}/cancel`, undefined, "cancel a task"],
      ["POST", `/v1/tasks/${id}/retry`, undefined, "retry a task"],
      ["GET", "/v1/tasks", undefined, "list every task"],
      ["GET", "/metrics", undefined, "read fleet metrics"],
    ];
    for (const [method, route, body, what] of forbidden) {
      const res = await call(url, RUNNER, route, body, method);
      assert.equal(res.status, 403, `a runner token must not be able to ${what}`);
      assert.match((await res.json()).error, /may not/);
    }

    // The refusal is authorization, not authentication: the same request from admin works.
    assert.equal((await call(url, ADMIN, "/v1/tasks", aTask)).status, 201);

    // --- Read-only sees everything, changes nothing. ---
    assert.equal((await call(url, READONLY, "/v1/tasks", undefined, "GET")).status, 200);
    assert.equal((await call(url, READONLY, "/metrics", undefined, "GET")).status, 200);
    assert.equal((await call(url, READONLY, "/v1/runners", undefined, "GET")).status, 200);
    assert.equal((await call(url, READONLY, "/v1/tasks", aTask)).status, 403);
    assert.equal(
      (await call(url, READONLY, "/v1/runners/register", runnerRegistration)).status,
      403
    );

    // An unknown token is not a principal at all.
    assert.equal(
      (await call(url, "not-a-real-token-but-long-enough", "/v1/tasks", undefined, "GET")).status,
      401
    );
  } finally {
    await stop(hub);
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "without the optional tokens, one shared secret still works for everything",
  {
    timeout: 30000,
  },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omni-principals-compat-"));
    let hub;
    try {
      // No CONDUCTOR_RUNNER_TOKEN / CONDUCTOR_READONLY_TOKEN: the historical single-secret
      // deployment. Nothing may become stricter or the upgrade breaks running fleets.
      const fleet = await boot(dir, {});
      hub = fleet.hub;
      const url = fleet.url;

      assert.equal(
        (await call(url, ADMIN, "/v1/runners/register", runnerRegistration)).status,
        200
      );
      assert.equal((await call(url, ADMIN, "/v1/tasks", aTask)).status, 201);
      assert.equal((await call(url, ADMIN, "/v1/tasks", undefined, "GET")).status, 200);
      assert.equal((await call(url, ADMIN, "/metrics", undefined, "GET")).status, 200);
      assert.equal((await fetch(`${url}/v1/tasks`)).status, 401);
      assert.equal(
        (await call(url, "wrong-but-long-enough-token-value", "/v1/runners", undefined, "GET"))
          .status,
        401
      );
    } finally {
      await stop(hub);
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  "a deregistering runner hands its work back instead of stranding it",
  {
    timeout: 30000,
  },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omni-deregister-"));
    let hub;
    try {
      const fleet = await boot(dir, {});
      hub = fleet.hub;
      const url = fleet.url;

      await call(url, ADMIN, "/v1/runners/register", runnerRegistration);
      const { id } = await (await call(url, ADMIN, "/v1/tasks", aTask)).json();
      const claimed = await (
        await call(url, ADMIN, "/v1/runner/claim", { id: "scoped-runner", session_id: SESSION })
      ).json();
      assert.equal(claimed.id, id);

      // The runner leaves gracefully: its task returns to the queue at once, rather than
      // sitting pinned to a ghost until the heartbeat TTL expires.
      const gone = await call(url, ADMIN, "/v1/runners/deregister", {
        id: "scoped-runner",
        session_id: SESSION,
      });
      assert.equal(gone.status, 200);
      const body = await gone.json();
      assert.deepEqual(body.requeued, [id]);

      const task = await (await call(url, ADMIN, `/v1/tasks/${id}`, undefined, "GET")).json();
      assert.equal(task.status, "queued");
      assert.equal(task.assigned_runner, null);
      assert.equal(task.claimed_at, undefined);

      const runners = await (await call(url, ADMIN, "/v1/runners", undefined, "GET")).json();
      assert.deepEqual(
        runners.map((r) => r.id),
        [],
        "a deregistered runner is not in the fleet"
      );

      // Deregistering twice is a 404, not a silent success.
      assert.equal(
        (
          await call(url, ADMIN, "/v1/runners/deregister", {
            id: "scoped-runner",
            session_id: SESSION,
          })
        ).status,
        404
      );
    } finally {
      await stop(hub);
      await rm(dir, { recursive: true, force: true });
    }
  }
);
