/**
 * OmniRoute ⇄ OmniConductor Hub — end-to-end contract over a REAL Hub process.
 *
 * `tests/unit/conductor-*.test.ts` exercise the routes and proxies with stubbed
 * `fetch`; `tests/unit/conductor-runtime*.test.mjs` exercise the bundled services
 * against each other. Neither proves the seam in between: that the shapes
 * OmniRoute *sends* are the shapes the Hub *accepts*, that the ids the Hub
 * *returns* are the ids OmniRoute surfaces, or that the whitelisting and auth
 * posture survives contact with the real thing.
 *
 * This suite starts `services/omni-conductor/hub.mjs` as a child process on a
 * free port, points `CONDUCTOR_HUB_URL` at it, and then calls the production
 * route handlers as plain functions (the pattern `api-routes-critical.test.ts`
 * uses). Nothing is stubbed except the runner — the Hub is the real service.
 *
 * A task sits in `queued` for the whole run on purpose: scheduling needs no
 * runner, so the suite stays deterministic and needs no harness credential.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TOKEN = "omniroute-conductor-contract-token-0123456789";
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-conductor-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "test-management-jwt-secret";
process.env.API_KEY_SECRET = "conductor-contract-api-key-secret";
process.env.INITIAL_PASSWORD = "bootstrap-password";

// Imported AFTER DATA_DIR is set so every module binds to the throwaway SQLite file.
const { updateSettings } = await import("../../src/lib/db/settings.ts");
const { getDbInstance } = await import("../../src/lib/db/core.ts");
const fleetRoute = await import("../../src/app/api/conductor/fleet/route.ts");
const tasksRoute = await import("../../src/app/api/conductor/tasks/route.ts");
const taskDetailRoute = await import("../../src/app/api/conductor/tasks/[id]/route.ts");
const cancelRoute = await import("../../src/app/api/conductor/tasks/[id]/cancel/route.ts");
const askRoute = await import("../../src/app/api/conductor/ask/route.ts");
const { createManagementSessionHeaders } = await import("../helpers/managementSession.ts");

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

async function startHub(stateFile) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["services/omni-conductor/hub.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      CONDUCTOR_HUB_TOKEN: TOKEN,
      CONDUCTOR_STATE_FILE: stateFile,
      RUNNER_HEARTBEAT_TTL_MS: "90000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.logs = "";
  child.stdout.on("data", (d) => (child.logs += d));
  child.stderr.on("data", (d) => (child.logs += d));
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error(`hub exited: ${child.logs}`);
    try {
      if ((await fetch(`${url}/health`)).ok) return { url, child };
    } catch {}
    await wait(30);
  }
  throw new Error(`hub never became healthy: ${child.logs}`);
}

async function stopHub(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), wait(3000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function managementRequest(url, init = {}) {
  const headers = await createManagementSessionHeaders(
    init.body ? { "content-type": "application/json" } : undefined
  );
  return new Request(url, {
    ...init,
    headers: {
      ...Object.fromEntries(headers.entries()),
      ...(init.headers ?? {}),
    },
  });
}

const json = async (response) => ({ status: response.status, body: await response.json() });

let hub;
let stateFile;

test.before(async () => {
  stateFile = path.join(TEST_DATA_DIR, "hub-state.json");
  hub = await startHub(stateFile);
  process.env.CONDUCTOR_HUB_URL = hub.url;
  process.env.CONDUCTOR_HUB_TOKEN = TOKEN;
  process.env.CONDUCTOR_SPOKESPERSON_URL = "http://127.0.0.1:1"; // deliberately offline
  await updateSettings({ requireLogin: true, password: "" });
  // The A2A inbound route gates on this flag; the mirror assertions below need it on.
  const db = getDbInstance();
  db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', 'a2aEnabled', 'true')"
  ).run();
});

test.after(async () => {
  await stopHub(hub?.child);
  delete process.env.CONDUCTOR_HUB_URL;
  delete process.env.CONDUCTOR_HUB_TOKEN;
  delete process.env.CONDUCTOR_SPOKESPERSON_URL;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("management auth gates every conductor route before the hub is touched", async () => {
  for (const [name, handler] of [
    ["fleet", () => fleetRoute.GET(new Request("http://localhost/api/conductor/fleet"))],
    [
      "tasks",
      () =>
        tasksRoute.POST(
          new Request("http://localhost/api/conductor/tasks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ repoUrl: "file:///tmp/x", prompt: "p" }),
          })
        ),
    ],
    [
      "detail",
      () =>
        taskDetailRoute.GET(new Request("http://localhost/api/conductor/tasks/task_x"), {
          params: Promise.resolve({ id: "task_x" }),
        }),
    ],
    [
      "cancel",
      () =>
        cancelRoute.POST(
          new Request("http://localhost/api/conductor/tasks/task_x/cancel", { method: "POST" }),
          { params: Promise.resolve({ id: "task_x" }) }
        ),
    ],
    [
      "ask",
      () =>
        askRoute.POST(
          new Request("http://localhost/api/conductor/ask", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: "hello" }),
          })
        ),
    ],
  ]) {
    const { status } = await json(await handler());
    assert.ok(
      status === 401 || status === 403,
      `${name} must refuse an anonymous caller, got ${status}`
    );
  }
});

test("fleet snapshot: degraded when the hub URL is unset, live once it is set", async () => {
  const saved = process.env.CONDUCTOR_HUB_URL;
  delete process.env.CONDUCTOR_HUB_URL;
  try {
    const offline = await json(
      await fleetRoute.GET(await managementRequest("http://localhost/api/conductor/fleet"))
    );
    assert.equal(offline.status, 200);
    assert.deepEqual(offline.body, { offline: true, runners: [], tasks: [] });
  } finally {
    process.env.CONDUCTOR_HUB_URL = saved;
  }
  const live = await json(
    await fleetRoute.GET(await managementRequest("http://localhost/api/conductor/fleet"))
  );
  assert.equal(live.status, 200);
  assert.equal(live.body.offline, false);
  assert.deepEqual(live.body.runners, []);
  assert.deepEqual(live.body.tasks, []);
  // The hub token must never reach the client, in any field.
  assert.ok(!JSON.stringify(live.body).includes(TOKEN));
});

test("create → detail → cancel round-trips through the real hub, keeping requirements", async () => {
  const created = await json(
    await tasksRoute.POST(
      await managementRequest("http://localhost/api/conductor/tasks", {
        method: "POST",
        headers: { "idempotency-key": "contract-create" },
        body: JSON.stringify({
          repoUrl: "https://github.com/acme/contract.git",
          baseRef: "release",
          prompt: "add the missing contract test",
          cli: "codex",
          model: "gpt-5.5",
        }),
      })
    )
  );
  assert.equal(created.status, 201);
  const id = created.body.task_id;
  assert.match(id, /^task_/);

  const detail = await json(
    await taskDetailRoute.GET(
      await managementRequest(`http://localhost/api/conductor/tasks/${id}`),
      { params: Promise.resolve({ id }) }
    )
  );
  assert.equal(detail.status, 200);
  assert.equal(detail.body.id, id);
  assert.equal(detail.body.status, "queued"); // no runner registered: never scheduled
  assert.equal(detail.body.repo, "https://github.com/acme/contract.git");
  assert.equal(detail.body.base_ref, "release");
  assert.equal(detail.body.prompt, "add the missing contract test");
  assert.equal(detail.body.cli, "codex");
  assert.equal(detail.body.model, "gpt-5.5");
  assert.equal(detail.body.runner, null);

  // An idempotent retry returns the SAME task rather than a duplicate.
  const retried = await json(
    await tasksRoute.POST(
      await managementRequest("http://localhost/api/conductor/tasks", {
        method: "POST",
        headers: { "idempotency-key": "contract-create" },
        body: JSON.stringify({
          repoUrl: "https://github.com/acme/contract.git",
          baseRef: "release",
          prompt: "add the missing contract test",
          cli: "codex",
          model: "gpt-5.5",
        }),
      })
    )
  );
  assert.equal(retried.status, 201);
  assert.equal(retried.body.task_id, id);

  const canceled = await json(
    await cancelRoute.POST(
      await managementRequest(`http://localhost/api/conductor/tasks/${id}/cancel`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id }) }
    )
  );
  assert.equal(canceled.status, 200);
  const afterCancel = await json(
    await taskDetailRoute.GET(
      await managementRequest(`http://localhost/api/conductor/tasks/${id}`),
      { params: Promise.resolve({ id }) }
    )
  );
  assert.equal(afterCancel.body.status, "canceled");
});

test("the hub's refusals are forwarded as sanitized errors, never as 5xx", async () => {
  const missing = await json(
    await taskDetailRoute.GET(
      await managementRequest("http://localhost/api/conductor/tasks/task_nope"),
      {
        params: Promise.resolve({ id: "task_nope" }),
      }
    )
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.type, "not_found");

  const badCancel = await json(
    await cancelRoute.POST(
      await managementRequest("http://localhost/api/conductor/tasks/task_nope/cancel", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "task_nope" }) }
    )
  );
  assert.equal(badCancel.status, 404);

  const invalid = await json(
    await tasksRoute.POST(
      await managementRequest("http://localhost/api/conductor/tasks", {
        method: "POST",
        body: JSON.stringify({ repoUrl: "", prompt: "" }),
      })
    )
  );
  assert.equal(invalid.status, 400, "zod rejects before the hub is called");

  // Hub input validation surfaces as a 4xx from the Hub, mirrored faithfully.
  const tooLong = await json(
    await tasksRoute.POST(
      await managementRequest("http://localhost/api/conductor/tasks", {
        method: "POST",
        body: JSON.stringify({ repoUrl: "https://github.com/a/b.git", prompt: "p".repeat(40_001) }),
      })
    )
  );
  assert.equal(tooLong.status, 413);
  assert.equal(tooLong.body.error.type, "invalid_request");
  // The raw upstream body never leaks through.
  assert.ok(!JSON.stringify(tooLong.body).includes("repo.url and spec.prompt are required"));
});

test("Faro is offline here, so /api/conductor/ask degrades to a 503 instead of throwing", async () => {
  const answer = await json(
    await askRoute.POST(
      await managementRequest("http://localhost/api/conductor/ask", {
        method: "POST",
        body: JSON.stringify({ message: "how is the fleet?" }),
      })
    )
  );
  assert.equal(answer.status, 503);
  assert.match(answer.body.error.message, /offline or refused/);

  const invalid = await json(
    await askRoute.POST(
      await managementRequest("http://localhost/api/conductor/ask", {
        method: "POST",
        body: JSON.stringify({ message: "" }),
      })
    )
  );
  assert.equal(invalid.status, 400);
});

test("a task created through OmniRoute reaches the Hub's SSE feed for the A2A mirror", async () => {
  const created = await json(
    await tasksRoute.POST(
      await managementRequest("http://localhost/api/conductor/tasks", {
        method: "POST",
        body: JSON.stringify({
          repoUrl: "https://github.com/acme/events.git",
          prompt: "emit an event",
        }),
      })
    )
  );
  assert.equal(created.status, 201);
  const id = created.body.task_id;

  // Read the feed the way the Conductor bridge does: replay from cursor 0.
  const res = await fetch(`${hub.url}/v1/events?last_event_id=0`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !text.includes(id)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  assert.match(text, /event: task\.created/);
  assert.ok(text.includes(id), `SSE feed did not mention ${id}: ${text.slice(0, 500)}`);
});

/**
 * The last link in the OpenCode seam: the `opencode.json` the Runner seeds points at
 * `/v1` of an OmniRoute deployment, so that endpoint has to serve a catalog OpenCode can
 * resolve models from. This calls the REAL `/v1/models` handler with the same URL shape
 * and Bearer scheme the seeded config produces — a broken or gated catalog here would
 * leave every self-hosted OpenCode task unable to pick a model, which is invisible from
 * the Conductor side (the CLI would simply fail).
 */
test("the seeded OpenCode config's baseURL serves a usable /v1/models catalog", async () => {
  const modelsRoute = await import("../../src/app/api/v1/models/route.ts");
  const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");

  // The seeded config sends `Authorization: Bearer $OMNIROUTE_API_KEY`, exactly like this.
  // Without a key the catalog is gated (management auth is on in this fixture) — that is
  // the correct posture, and worth pinning: a keyless deployment must not serve it.
  const anonymous = await modelsRoute.GET(new Request("http://localhost/v1/models"));
  assert.ok(
    anonymous.status === 401 || anonymous.status === 403,
    `an unauthenticated catalog read must be refused, got ${anonymous.status}`
  );

  const { key } = await apiKeysDb.createApiKey("management", "1234567890abcdef");
  const response = await modelsRoute.GET(
    new Request("http://localhost/v1/models", { headers: { authorization: `Bearer ${key}` } })
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, "list");
  assert.ok(Array.isArray(body.data), "OpenAI-compatible `data` array is required by the AI SDK");
  assert.ok(body.data.length > 0, "an empty catalog means OpenCode cannot resolve any model");
  for (const entry of body.data.slice(0, 5)) {
    assert.equal(typeof entry.id, "string");
    assert.ok(entry.id.length > 0);
  }
  // `omniroute/<model>` is an OpenCode-side prefix: the gateway's own list must expose
  // bare ids, or `opencode run --model omniroute/<id>` would resolve to nothing.
  assert.ok(
    body.data.every((entry) => !entry.id.startsWith("omniroute/")),
    "provider-qualified ids belong to OpenCode, not to the gateway's own list"
  );
});
