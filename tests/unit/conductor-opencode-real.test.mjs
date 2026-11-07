/**
 * REAL OpenCode against the REAL Runner — no stand-in anywhere in the chain.
 *
 * This suite exists because a contract stand-in cannot catch a real CLI disagreeing with
 * us, and it did not: the first version of the OpenCode adapter passed every stand-in test
 * while the actual `opencode` binary (a) needs `--auto` to get past approval prompts, and
 * (b) refuses `--model omniroute/<id>` unless the seeded config declares that id under
 * `provider.omniroute.models` — fetching `/v1/models` is not enough. Both were found only
 * by running the pinned binary.
 *
 * The MODEL is still stubbed (a local OpenAI-compatible server), because that is the one
 * thing needing a provider credential. Everything else is real: the pinned CLI from
 * `services/omni-conductor/node_modules`, the Runner process, task scheduling through a
 * real Hub, the seeded per-task config, the isolated HOME/env, and the repository test
 * pass afterwards.
 *
 * Skips (does not fail) when the pinned CLI is absent — e.g. a checkout where
 * `npm ci --prefix services/omni-conductor` was never run. The evidence probe reports
 * that condition separately so it cannot masquerade as a pass.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TOKEN = "omni-conductor-real-opencode-token-0123456789";
const OPENCODE_BIN = path.join(ROOT, "services/omni-conductor/node_modules/.bin/opencode");
const MODEL_ID = "conductor-real-model";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function hasRealOpencode() {
  try {
    await access(OPENCODE_BIN);
    execFileSync(OPENCODE_BIN, ["--version"], { stdio: "pipe", timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}
const REAL = await hasRealOpencode();
const skip = REAL
  ? false
  : "pinned opencode binary not installed (npm ci --prefix services/omni-conductor)";

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
  await Promise.race([once(child, "exit"), wait(5000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function healthy(url, child) {
  for (let i = 0; i < 250; i++) {
    if (child.exitCode !== null) throw new Error(`service exited: ${child.logs}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await wait(40);
  }
  throw new Error(`service did not become healthy: ${child.logs}`);
}

const api = (base, route, body, method = "POST") =>
  fetch(`${base}${route}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function awaitTask(base, id, ms = 240_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const task = await (await api(base, `/v1/tasks/${id}`, undefined, "GET")).json();
    if (["completed", "failed", "canceled"].includes(task.status)) return task;
    await wait(250);
  }
  throw new Error(`task ${id} did not finish within ${ms}ms`);
}

async function makeRepo(dir) {
  const repo = path.join(dir, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "real-opencode@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Real OpenCode test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo });
  return repo;
}

/** Minimal OpenAI-compatible gateway that records what actually crossed the wire. */
function makeStubGateway(script) {
  const requests = [];
  let step = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = {
      method: req.method,
      url: req.url,
      auth: req.headers.authorization ?? null,
      stream: false,
      body: raw ? JSON.parse(raw) : null,
    };
    request.stream = Boolean(request.body?.stream);
    requests.push(request);
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
    }
    const reply = script[Math.min(step++, script.length - 1)];
    const created = Math.floor(Date.now() / 1000);

    // OpenCode always sends `stream: true`. Answering with a plain JSON body makes the AI
    // SDK reject every response and retry forever (observed: 1238 requests in 120s, then the
    // task timed out) — so the stub must speak SSE, exactly like a real gateway.
    if (req.url?.includes("/chat/completions") && request.body?.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      send({
        id: "chatcmpl-stream",
        object: "chat.completion.chunk",
        created,
        model: MODEL_ID,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: reply.content ?? "" },
            finish_reason: null,
          },
        ],
      });
      send({
        id: "chatcmpl-stream",
        object: "chat.completion.chunk",
        created,
        model: MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
      return res.end("data: [DONE]\n\n");
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: `chatcmpl-${step}`,
        object: "chat.completion",
        created,
        model: MODEL_ID,
        choices: [{ index: 0, message: { role: "assistant", ...reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      })
    );
  });
  return { server, requests };
}

/** Boots a real Hub + a real Runner pointed at a real OpenCode binary. */
async function startFleet(dir, extraEnv, gatewayUrl) {
  const hubPort = await freePort();
  const url = `http://127.0.0.1:${hubPort}`;
  const hub = start("services/omni-conductor/hub.mjs", {
    HOST: "127.0.0.1",
    PORT: String(hubPort),
    CONDUCTOR_HUB_TOKEN: TOKEN,
    CONDUCTOR_STATE_FILE: path.join(dir, "state.json"),
    RUNNER_HEARTBEAT_TTL_MS: "120000",
  });
  await healthy(`${url}/health`, hub);
  const healthPort = await freePort();
  const runner = start("services/omni-conductor/runner.mjs", {
    CONDUCTOR_HUB_URL: url,
    CONDUCTOR_HUB_TOKEN: TOKEN,
    RUNNER_ID: "real-opencode-runner",
    RUNNER_HEALTH_HOST: "127.0.0.1",
    RUNNER_HEALTH_PORT: String(healthPort),
    RUNNER_CLIS: "opencode",
    RUNNER_MODELS: "omniroute/*",
    RUNNER_OPENCODE_MODELS: `omniroute/${MODEL_ID}`,
    OPENCODE_BIN,
    OPENCODE_MODEL: `omniroute/${MODEL_ID}`,
    OMNIROUTE_BASE_URL: gatewayUrl,
    OMNIROUTE_API_KEY: "sk-real-opencode-stub",
    RUNNER_ALLOW_LOCAL_REPOS: "true",
    RUNNER_MAX_CONCURRENCY: "1",
    RUNNER_POLL_MS: "50",
    RUNNER_TASK_TIMEOUT_MS: "180000",
    RUNNER_TEST_TIMEOUT_MS: "60000",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    DO_NOT_TRACK: "1",
    ...extraEnv,
  });
  for (let i = 0; i < 250; i++) {
    if (runner.exitCode !== null) throw new Error(`runner exited: ${runner.logs}`);
    const fleet = await (await api(url, "/v1/runners", undefined, "GET")).json();
    if (fleet.some((r) => r.id === "real-opencode-runner" && r.online)) break;
    await wait(40);
  }
  return { url, hub, runner, healthPort };
}

test(
  "real opencode 1.19.3 runs a task end-to-end through the Runner and calls our gateway",
  { timeout: 300_000, skip },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omni-real-opencode-"));
    const version = execFileSync(OPENCODE_BIN, ["--version"], { encoding: "utf8" }).trim();
    // First scripted reply answers OpenCode's title-generation request; the rest is the turn.
    const { server, requests } = makeStubGateway([
      { content: "Conductor task" },
      { content: "REAL_OPENCODE_REACHED_THE_GATEWAY" },
    ]);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const gatewayUrl = `http://127.0.0.1:${server.address().port}`;

    let hub, runner;
    try {
      const repo = await makeRepo(dir);
      const fleet = await startFleet(dir, {}, gatewayUrl);
      ({ hub, runner } = fleet);

      const created = await api(fleet.url, "/v1/tasks", {
        repo: { url: `file://${repo}`, base_ref: "main" },
        spec: { prompt: "say the marker" },
        requirements: { cli: "opencode", model: `omniroute/${MODEL_ID}` },
      });
      assert.equal(created.status, 201, await created.clone().text());
      const { id } = await created.json();
      const task = await awaitTask(fleet.url, id);

      assert.equal(task.status, "completed", `runner logs:\n${runner.logs}`);
      assert.equal(task.manifest.result.harness, "opencode");

      // 1. The real binary called OUR gateway — bearer auth, provider prefix stripped.
      const completions = requests.filter((r) => r.url?.includes("/chat/completions"));
      assert.ok(completions.length > 0, "real opencode never reached the stub gateway");
      for (const request of completions) {
        assert.equal(request.auth, "Bearer sk-real-opencode-stub");
        assert.equal(request.body.model, MODEL_ID, "the omniroute/ prefix must be stripped");
      }

      // 2. The agent's own reply is retained as evidence.
      assert.match(task.manifest.result.output, /REAL_OPENCODE_REACHED_THE_GATEWAY/);

      // 3. The pinned binary's own reported version is recorded, not assumed.
      assert.equal(task.manifest.result.opencode_version, version);
      assert.match(version, /^1\.19\./);
      // ...and the fleet view carries it too, so an operator can see which binary a
      // runner actually has before submitting work to it.
      const fleetNow = await (await api(fleet.url, "/v1/runners", undefined, "GET")).json();
      const advertised = fleetNow.find((r) => r.id === "real-opencode-runner");
      assert.equal(advertised.capabilities.clis[0].version, version);

      // 4. No test script in the fixture: reported explicitly, never as a pass.
      assert.equal(task.manifest.tests.status, "skipped");
    } finally {
      await stop(runner);
      await stop(hub);
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  "a gateway that errors fails the TASK, and the Runner stays up for the next one",
  { timeout: 300_000, skip },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omni-real-opencode-fail-"));
    // Always-500 gateway: the CLI must surface an error, and the Runner must convert it
    // into a failed TASK while keeping the process (and the rest of the fleet) alive.
    const server = createServer(async (req, res) => {
      for await (const _ of req) void _;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "upstream exploded", type: "server_error" } }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const gatewayUrl = `http://127.0.0.1:${server.address().port}`;

    let hub, runner, healthPort;
    try {
      const repo = await makeRepo(dir);
      const fleet = await startFleet(dir, {}, gatewayUrl);
      ({ hub, runner, healthPort } = fleet);

      const created = await api(fleet.url, "/v1/tasks", {
        repo: { url: `file://${repo}` },
        spec: { prompt: "this will not work" },
        requirements: { cli: "opencode", model: `omniroute/${MODEL_ID}` },
      });
      const { id } = await created.json();
      const task = await awaitTask(fleet.url, id);

      assert.equal(task.status, "failed");
      assert.ok(task.manifest.error, "a failed task must carry an error");
      assert.equal(task.manifest.tests.status, "not_run");

      // The Runner survived and still serves the fleet.
      assert.equal(runner.exitCode, null, `runner died:\n${runner.logs}`);
      const ready = await fetch(`http://127.0.0.1:${healthPort}/readyz`);
      assert.equal(ready.status, 200);
      const fleetNow = await (await api(fleet.url, "/v1/runners", undefined, "GET")).json();
      assert.ok(
        fleetNow.some((r) => r.id === "real-opencode-runner" && r.online),
        "the runner must still be registered after a failed task"
      );
    } finally {
      await stop(runner);
      await stop(hub);
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);
