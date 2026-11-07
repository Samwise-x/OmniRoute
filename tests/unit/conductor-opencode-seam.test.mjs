/**
 * OpenCode is the reference self-hosted harness for the OmniConductor Runner seam.
 *
 * These tests drive the real `runner.mjs` process with a stand-in `opencode` binary on
 * `OPENCODE_BIN`, which is enough to pin down everything the seam has to get right:
 *
 *   1. argv — `opencode run "<prompt>" --auto [--model <m>]`, matching
 *      `docs/reference/CLI-TOOLS.md` / `omniroute setup-opencode`. `--auto` is required:
 *      without it a TTY-less task stalls on an approval prompt until it times out
 *      (verified against the pinned binary — `opencode run --help`, v1.19.3).
 *   2. routing — the CLI is handed a config that points at OUR gateway, so a
 *      self-hosted deployment never silently falls back to OpenCode's hosted catalog.
 *   3. the credential is referenced through `{env:OMNIROUTE_API_KEY}`, never written.
 *   4. model gating — `requirements.model` can only select an `omniroute/`-qualified
 *      model on a self-hosted runner, unless the operator opts into hosted models.
 *   5. the fresh per-task HOME still holds (nothing from the host leaks in).
 *
 * The stand-in never talks to a provider: this is interface-level evidence, the same
 * posture the repo takes for every CLI adapter without credentials.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile, readdir, access } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TOKEN = "omni-conductor-opencode-token-0123456789";
const GATEWAY = "http://omniroute.test:20128";
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
  for (let i = 0; i < 150; i++) {
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

async function awaitTask(base, id) {
  for (let i = 0; i < 300; i++) {
    const task = await (await api(base, `/v1/tasks/${id}`, undefined, "GET")).json();
    if (["completed", "failed", "canceled"].includes(task.status)) return task;
    await wait(35);
  }
  throw new Error(`task ${id} did not finish`);
}

async function makeRepo(dir) {
  const repo = path.join(dir, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "opencode-test@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "OpenCode seam test"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo });
  return repo;
}

/**
 * Stand-in for the released `opencode` CLI. Records argv + the environment and config it
 * was actually handed, then produces the file change a real run would.
 */
async function makeOpencodeStandIn(dir) {
  const file = path.join(dir, "opencode-stand-in.mjs");
  const out = path.join(dir, "opencode-invocation.json");
  await writeFile(
    file,
    `#!/usr/bin/env node\n` +
      `import fs from 'node:fs';\n` +
      `import os from 'node:os';\n` +
      `import path from 'node:path';\n` +
      `const argv = process.argv.slice(2);\n` +
      // The Runner probes `--version` for capability discovery; that is not an execution,
      // so it must not overwrite the recorded invocation.
      `if (argv[0] === '--version') { console.log('1.19.3'); process.exit(0); }\n` +
      `const configPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');\n` +
      `let config = null;\n` +
      `try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}\n` +
      `const prompt = argv[1];\n` +
      `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({\n` +
      `  argv,\n` +
      `  cwd: process.cwd(),\n` +
      `  home: os.homedir(),\n` +
      `  config,\n` +
      `  configExists: config !== null,\n` +
      `  env: {\n` +
      `    OMNIROUTE_BASE_URL: process.env.OMNIROUTE_BASE_URL ?? null,\n` +
      `    OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY ?? null,\n` +
      `    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,\n` +
      `    HOST_SECRET_SHOULD_NOT_LEAK: process.env.HOST_SECRET_SHOULD_NOT_LEAK ?? null,\n` +
      `  },\n` +
      `}));\n` +
      `if (prompt === 'fail') process.exit(9);\n` +
      `fs.writeFileSync(path.join(process.cwd(), 'opencode-changed.txt'), 'done by opencode stand-in\\n');\n` +
      `console.log('opencode stand-in completed');\n`
  );
  await chmod(file, 0o755);
  return { file, out };
}

async function startFleet(dir, { standIn, extraRunnerEnv = {} }) {
  const hubPort = await freePort();
  const url = `http://127.0.0.1:${hubPort}`;
  const hub = start("services/omni-conductor/hub.mjs", {
    HOST: "127.0.0.1",
    PORT: String(hubPort),
    CONDUCTOR_HUB_TOKEN: TOKEN,
    CONDUCTOR_STATE_FILE: path.join(dir, "state.json"),
  });
  await healthy(`${url}/health`, hub);
  const healthPort = await freePort();
  const runner = start("services/omni-conductor/runner.mjs", {
    CONDUCTOR_HUB_URL: url,
    CONDUCTOR_HUB_TOKEN: TOKEN,
    RUNNER_ID: "opencode-runner",
    RUNNER_HEALTH_HOST: "127.0.0.1",
    RUNNER_HEALTH_PORT: String(healthPort),
    RUNNER_CLIS: "opencode",
    RUNNER_MODELS: "*",
    OPENCODE_BIN: standIn.file,
    RUNNER_ALLOW_LOCAL_REPOS: "true",
    RUNNER_MAX_CONCURRENCY: "1",
    RUNNER_POLL_MS: "40",
    RUNNER_TASK_TIMEOUT_MS: "20000",
    RUNNER_TEST_TIMEOUT_MS: "20000",
    OMNIROUTE_BASE_URL: GATEWAY,
    OMNIROUTE_API_KEY: "sk-test-gateway-key",
    // Must never reach the agent CLI: the per-task HOME/env isolation is the guarantee.
    HOST_SECRET_SHOULD_NOT_LEAK: "leaked-host-value",
    ...extraRunnerEnv,
  });
  for (let i = 0; i < 150; i++) {
    if (runner.exitCode !== null) throw new Error(`runner exited: ${runner.logs}`);
    const fleet = await (await api(url, "/v1/runners", undefined, "GET")).json();
    if (fleet.some((r) => r.id === "opencode-runner" && r.online)) break;
    await wait(40);
  }
  return { url, hub, runner, healthPort };
}

async function submit(url, body) {
  const created = await api(url, "/v1/tasks", body);
  assert.equal(created.status, 201);
  return awaitTask(url, (await created.json()).id);
}

test(
  "OpenCode runs with the documented argv and is pointed at our gateway",
  { timeout: 45000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omni-opencode-seam-"));
    const standIn = await makeOpencodeStandIn(dir);
    const { url, hub, runner } = await startFleet(dir, { standIn });
    try {
      const repo = await makeRepo(dir);
      const task = await submit(url, {
        repo: { url: `file://${repo}`, base_ref: "main" },
        spec: { prompt: "add a note to the fixture" },
        requirements: { cli: "opencode" },
      });
      assert.equal(task.status, "completed", runner.logs);
      assert.equal(task.manifest.result.harness, "opencode");

      const invocation = JSON.parse(await readFile(standIn.out, "utf8"));
      assert.equal(invocation.argv[0], "run", "uses `opencode run`, not a subcommand-less call");
      assert.equal(invocation.argv[1], "add a note to the fixture", "the task prompt is argv[1]");
      assert.ok(
        invocation.argv.includes("--auto"),
        "`--auto` is required so a TTY-less task cannot block on an approval prompt"
      );
      // No model pinned and no OPENCODE_MODEL default: no --model at all.
      assert.deepEqual(invocation.argv, ["run", "add a note to the fixture", "--auto"]);

      // Routing: the CLI was given a config for OUR gateway, keyed by env ref.
      assert.equal(invocation.configExists, true, "the runner seeds an opencode.json");
      const provider = invocation.config.provider.omniroute;
      assert.equal(provider.npm, "@ai-sdk/openai-compatible");
      assert.equal(provider.options.baseURL, `${GATEWAY}/v1`);
      assert.equal(provider.options.apiKey, "{env:OMNIROUTE_API_KEY}");
      assert.equal(invocation.config.autoupdate, false);

      // Credential + isolation posture.
      assert.equal(invocation.env.OMNIROUTE_BASE_URL, GATEWAY);
      assert.equal(invocation.env.OMNIROUTE_API_KEY, "sk-test-gateway-key");
      assert.equal(
        invocation.env.HOST_SECRET_SHOULD_NOT_LEAK,
        null,
        "unrelated host env must not reach the agent CLI"
      );
      assert.ok(
        invocation.home.includes("omni-task-"),
        `private per-task HOME, got ${invocation.home}`
      );
      assert.ok(task.manifest.result.patch.includes("opencode-changed.txt"));
    } finally {
      await stop(runner);
      await stop(hub);
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  "A pinned gateway model reaches OpenCode as --model, including OPENCODE_MODEL defaults",
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omni-opencode-model-"));
    const standIn = await makeOpencodeStandIn(dir);
    const { url, hub, runner } = await startFleet(dir, {
      standIn,
      extraRunnerEnv: {
        RUNNER_OPENCODE_MODELS: "omniroute/claude-sonnet-4-5",
        OPENCODE_MODEL: "omniroute/claude-sonnet-4-5",
      },
    });
    try {
      const repo = await makeRepo(dir);
      const pinned = await submit(url, {
        repo: { url: `file://${repo}` },
        spec: { prompt: "pinned" },
        requirements: { cli: "opencode", model: "omniroute/claude-sonnet-4-5" },
      });
      assert.equal(pinned.status, "completed", runner.logs);
      let invocation = JSON.parse(await readFile(standIn.out, "utf8"));
      assert.deepEqual(invocation.argv, [
        "run",
        "pinned",
        "--auto",
        "--model",
        "omniroute/claude-sonnet-4-5",
      ]);

      // With no pin, OPENCODE_MODEL supplies the default so the CLI never falls back
      // to OpenCode's own hosted catalog.
      const defaulted = await submit(url, {
        repo: { url: `file://${repo}` },
        spec: { prompt: "defaulted" },
        requirements: { cli: "opencode" },
      });
      assert.equal(defaulted.status, "completed", runner.logs);
      invocation = JSON.parse(await readFile(standIn.out, "utf8"));
      assert.deepEqual(invocation.argv, [
        "run",
        "defaulted",
        "--auto",
        "--model",
        "omniroute/claude-sonnet-4-5",
      ]);
    } finally {
      await stop(runner);
      await stop(hub);
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  "A bare (non-gateway) model never selects the self-hosted OpenCode runner",
  { timeout: 45000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omni-opencode-gate-"));
    const standIn = await makeOpencodeStandIn(dir);
    const { url, hub, runner } = await startFleet(dir, { standIn });
    try {
      const repo = await makeRepo(dir);
      const created = await api(url, "/v1/tasks", {
        repo: { url: `file://${repo}` },
        spec: { prompt: "hosted model" },
        requirements: { cli: "opencode", model: "gpt-5.5" },
      });
      const id = (await created.json()).id;
      await wait(500);
      const task = await (await api(url, `/v1/tasks/${id}`, undefined, "GET")).json();
      // The Hub still schedules it (its capability list is a literal `*`), but the
      // Runner refuses to hand a hosted model to the CLI — so it fails closed with an
      // explicit error instead of silently using OpenCode's catalog.
      assert.equal(task.status, "failed", runner.logs);
      assert.match(task.manifest.error, /No installed compatible harness|hosted/i);
      const invocation = await readFile(standIn.out, "utf8").catch(() => null);
      assert.equal(invocation, null, "the CLI must not be invoked for a hosted model");
    } finally {
      await stop(runner);
      await stop(hub);
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  "a harness that does not report a real version gets no version, not a guess",
  { timeout: 45000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omni-opencode-version-"));
    // A wrapper that ignores argv and prints its usual chatter exits 0 — the Runner must
    // not record that as the harness version (it did, before this guard: the evidence
    // report ended up claiming the version was "opencode stand-in completed").
    const bin = path.join(dir, "chatty-opencode");
    await writeFile(bin, `#!/usr/bin/env node\nconsole.log('opencode stand-in completed');\n`);
    await chmod(bin, 0o755);
    const standIn = { file: bin, out: path.join(dir, "invocation.json") };
    const { url, hub, runner } = await startFleet(dir, { standIn });
    try {
      const task = await submit(url, {
        repo: { url: `file://${await makeRepo(dir)}`, base_ref: "main" },
        spec: { prompt: "no version here" },
        requirements: { cli: "opencode" },
      });
      assert.equal(task.status, "completed", runner.logs);
      assert.equal(
        task.manifest.result.opencode_version,
        null,
        "chatter is not a version; record nothing rather than something false"
      );
      const fleet = await (await api(url, "/v1/runners", undefined, "GET")).json();
      assert.equal(
        fleet[0].capabilities.clis[0].version,
        undefined,
        "the fleet must not advertise an invented version"
      );
    } finally {
      await stop(runner);
      await stop(hub);
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  "the capability probe runs in a sandbox, not in the Runner's own directory",
  { timeout: 45000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omni-opencode-probe-"));
    // A harness that writes wherever it is started. The probe spawns it at boot, so this
    // used to litter the Runner's working directory (the evidence run left an EVIDENCE.md
    // in the repo root) — and would simply fail on the container's read-only filesystem.
    const marker = "probe-litter.txt";
    const bin = path.join(dir, "littering-opencode");
    await writeFile(
      bin,
      `#!/usr/bin/env node\n` +
        `import fs from 'node:fs';\n` +
        `fs.writeFileSync(${JSON.stringify(marker)}, 'probe wrote here');\n` +
        `console.log('1.19.3');\n`
    );
    await chmod(bin, 0o755);
    const standIn = { file: bin, out: path.join(dir, "invocation.json") };
    const { url, hub, runner } = await startFleet(dir, { standIn });
    try {
      // Wait for registration, which is when the probe runs.
      for (let i = 0; i < 100; i++) {
        const fleet = await (await api(url, "/v1/runners", undefined, "GET")).json();
        if (fleet.some((r) => r.online)) break;
        await wait(40);
      }
      const leaked = await access(path.join(ROOT, marker)).then(
        () => true,
        () => false
      );
      assert.equal(leaked, false, "the probe must not write into the Runner's working directory");
      // The probe's own output is still used as the version.
      const fleet = await (await api(url, "/v1/runners", undefined, "GET")).json();
      assert.equal(fleet[0].capabilities.clis[0].version, "1.19.3");
      assert.equal(runner.exitCode, null);
    } finally {
      await stop(runner);
      await stop(hub);
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test("The operator can opt into hosted models explicitly", { timeout: 45000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omni-opencode-hosted-"));
  const standIn = await makeOpencodeStandIn(dir);
  const { url, hub, runner } = await startFleet(dir, {
    standIn,
    extraRunnerEnv: { RUNNER_OPENCODE_ALLOW_HOSTED_MODELS: "true" },
  });
  try {
    const repo = await makeRepo(dir);
    const task = await submit(url, {
      repo: { url: `file://${repo}` },
      spec: { prompt: "hosted ok" },
      requirements: { cli: "opencode", model: "gpt-5.5" },
    });
    assert.equal(task.status, "completed", runner.logs);
    const invocation = JSON.parse(await readFile(standIn.out, "utf8"));
    assert.deepEqual(invocation.argv, ["run", "hosted ok", "--auto", "--model", "gpt-5.5"]);
  } finally {
    await stop(runner);
    await stop(hub);
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "Without OMNIROUTE_BASE_URL no config is fabricated (no silent misrouting)",
  { timeout: 45000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omni-opencode-nocfg-"));
    const standIn = await makeOpencodeStandIn(dir);
    const { url, hub, runner } = await startFleet(dir, {
      standIn,
      extraRunnerEnv: { OMNIROUTE_BASE_URL: "" },
    });
    try {
      const repo = await makeRepo(dir);
      const task = await submit(url, {
        repo: { url: `file://${repo}` },
        spec: { prompt: "no gateway configured" },
        requirements: { cli: "opencode" },
      });
      assert.equal(task.status, "completed", runner.logs);
      const invocation = JSON.parse(await readFile(standIn.out, "utf8"));
      assert.equal(
        invocation.configExists,
        false,
        "with no gateway URL the runner must not invent a provider block"
      );
      const homeConfig = await readdir(path.join(invocation.home, ".config")).catch(() => []);
      assert.ok(!homeConfig.includes("opencode"));
    } finally {
      await stop(runner);
      await stop(hub);
      await rm(dir, { recursive: true, force: true });
    }
  }
);

test(
  "An OpenCode failure is reported with the CLI's exit code, not swallowed",
  { timeout: 45000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "omni-opencode-fail-"));
    const standIn = await makeOpencodeStandIn(dir);
    const { url, hub, runner } = await startFleet(dir, { standIn });
    try {
      const repo = await makeRepo(dir);
      const task = await submit(url, {
        repo: { url: `file://${repo}` },
        spec: { prompt: "fail" },
        requirements: { cli: "opencode" },
      });
      assert.equal(task.status, "failed", runner.logs);
      assert.match(task.manifest.error, /exited with code 9/);
      assert.equal(task.manifest.tests.status, "not_run");
    } finally {
      await stop(runner);
      await stop(hub);
      await rm(dir, { recursive: true, force: true });
    }
  }
);
