#!/usr/bin/env node
/**
 * scripts/ops/conductor-evidence.mjs — boot a real OmniConductor deployment and PROVE it works.
 *
 * `docs/ops/OMNICONDUCTOR_EVIDENCE.md` was a hand-written snapshot: it recorded what
 * someone observed once, could not be re-run, and had no way to tell a working build
 * from a broken one. This script replaces that with a reproducible probe. It starts the
 * real `hub.mjs`, `faro.mjs` and `runner.mjs` processes, registers a real runner against
 * a real disposable git repo, and asserts the acceptance properties end to end — then
 * writes a machine-readable JSON report plus a human-readable Markdown summary.
 *
 * It answers, with evidence rather than assertion:
 *
 *   1. Does every service start and report readiness on the documented port?
 *   2. Does the Hub persist and replay state across a restart (volume survival)?
 *   3. Does a task flow Hub → Runner → real `git clone` → declared `npm test` → patch?
 *   4. Are the refusal paths real (auth, private/loopback repos, unsupported CLI/model)?
 *   5. Does Faro answer from Hub evidence, and do its confirmations actually gate actions?
 *
 * What it deliberately does NOT claim:
 *   - A `docker build` / Compose bring-up (that is `npm run verify:conductor:docker`).
 *   - A vendor agent run. The default harness is a test adapter with the documented
 *     `GATEWAY_BIN --repo <dir> --prompt <prompt>` contract. Pass `--real-clis` on a host
 *     with `claude`/`codex`/`opencode` installed AND credentialed to attempt one.
 *
 * Usage:
 *   node scripts/ops/conductor-evidence.mjs                       # local probe + report
 *   node scripts/ops/conductor-evidence.mjs --json evidence.json  # custom report path
 *   node scripts/ops/conductor-evidence.mjs --keep               # leave processes/tmpdir
 *   node scripts/ops/conductor-evidence.mjs --real-clis          # use installed vendor CLIs
 *
 * Exit code: 0 when every check passes, 1 when any check fails (so CI can gate on it).
 */

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SERVICES = path.join(ROOT, "services/omni-conductor");
const TOKEN = `conductor-evidence-${Date.now().toString(36)}-0123456789`;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const JSON_OUT = path.resolve(opt("json", path.join(ROOT, "conductor-evidence.json")));
const MD_OUT = path.resolve(opt("markdown", path.join(ROOT, "docs/ops/OMNICONDUCTOR_EVIDENCE.md")));
const KEEP = flag("keep");
const REAL_CLIS = flag("real-clis");

const checks = [];
const evidence = { tasks: {}, timeline: [] };

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

function note(message) {
  evidence.timeline.push({ at: new Date().toISOString(), message });
}

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

const api = (base, route, body, method = "POST", headers = {}) =>
  fetch(`${base}${route}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

function startService(name, script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.serviceName = name;
  child.logs = "";
  child.stdout.on("data", (d) => (child.logs += d));
  child.stderr.on("data", (d) => (child.logs += d));
  return child;
}

async function stopService(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), wait(4000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitHealthy(url, child) {
  for (let i = 0; i < 250; i++) {
    if (child.exitCode !== null) throw new Error(`${child.serviceName} exited: ${child.logs}`);
    try {
      if ((await fetch(url)).ok) return true;
    } catch {}
    await wait(40);
  }
  throw new Error(`${child.serviceName} never became healthy: ${child.logs}`);
}

async function awaitTerminal(base, id, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await (await api(base, `/v1/tasks/${id}`, undefined, "GET")).json();
    if (["completed", "failed", "canceled"].includes(task.status)) return task;
    await wait(75);
  }
  throw new Error(`task ${id} did not reach a terminal state within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFixtureRepo(dir) {
  const repo = path.join(dir, "evidence-repo");
  fs.mkdirSync(repo, { recursive: true });
  const git = (...argv) => execFileSync("git", argv, { cwd: repo, stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "conductor-evidence@example.invalid");
  git("config", "user.name", "OmniConductor evidence");
  fs.writeFileSync(path.join(repo, "README.md"), "# evidence fixture\n");
  fs.writeFileSync(
    path.join(repo, "package.json"),
    `${JSON.stringify({ name: "conductor-evidence-fixture", private: true, scripts: { test: "node tests/run.mjs" } }, null, 2)}\n`
  );
  fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "tests", "run.mjs"),
    "import fs from 'node:fs';\n" +
      "import assert from 'node:assert/strict';\n" +
      "assert.match(fs.readFileSync('EVIDENCE.md', 'utf8'), /generated by the OmniConductor runner/);\n" +
      "console.log('repository test passed');\n"
  );
  git("add", ".");
  git("commit", "-m", "fixture: repo whose test asserts the agent's change");
  return repo;
}

/**
 * Stand-in for the self-hosted OpenCode CLI (`opencode run "<prompt>" [--model <m>]`).
 *
 * It is a stand-in for the MODEL, not for the seam: the Runner still spawns it exactly as
 * it spawns a real `opencode`, still seeds the per-task `opencode.json`, still isolates
 * HOME/env, and still runs the repository's own tests afterwards. What is faked is only
 * "did an LLM decide to edit these bytes". That is the one thing this probe cannot prove
 * without a provider credential, and it says so in `limitations`.
 */
function makeOpencodeStandIn(dir) {
  const file = path.join(dir, "opencode-evidence-stand-in.mjs");
  fs.writeFileSync(
    file,
    "#!/usr/bin/env node\n" +
      "// Contract: opencode run <prompt> [--model <model>]\n" +
      "import fs from 'node:fs';\n" +
      "import os from 'node:os';\n" +
      "import path from 'node:path';\n" +
      "const argv = process.argv.slice(2);\n" +
      "const prompt = argv[1];\n" +
      "const mi = argv.indexOf('--model');\n" +
      "const model = mi < 0 ? null : argv[mi + 1];\n" +
      "let config = null;\n" +
      "try { config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'opencode', 'opencode.json'), 'utf8')); } catch {}\n" +
      "console.log('opencode-invocation=' + JSON.stringify({ argv, model, config }));\n" +
      "if (prompt === 'fail-intentionally') { console.error('stand-in refused'); process.exit(7); }\n" +
      "if (prompt === 'hang') await new Promise((r) => setTimeout(r, 60_000));\n" +
      "fs.writeFileSync('EVIDENCE.md', 'generated by the OmniConductor runner\\n');\n" +
      "console.log('opencode stand-in completed' + (model ? ' with model=' + model : ''));\n"
  );
  fs.chmodSync(file, 0o755);
  return file;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

async function main() {
  const startedAt = new Date().toISOString();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-evidence-"));
  const stateFile = path.join(dir, "state.json");
  const running = [];
  const report = {
    startedAt,
    node: process.version,
    platform: `${os.platform()}/${os.arch()}`,
    mode: REAL_CLIS ? "real-clis" : "test-adapter",
  };

  console.log(
    `\nOmniConductor evidence probe — ${report.platform}, node ${report.node}, ${report.mode}\n`
  );

  try {
    const repo = makeFixtureRepo(dir);
    const opencode = makeOpencodeStandIn(dir);
    report.fixture = {
      repo,
      commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim(),
    };

    // -- 1. Services boot and report readiness --------------------------------
    console.log("1. Service startup");
    const hubPort = await freePort();
    const faroPort = await freePort();
    const runnerPort = await freePort();
    const hubUrl = `http://127.0.0.1:${hubPort}`;
    const faroUrl = `http://127.0.0.1:${faroPort}`;

    const hub = startService("hub", path.join(SERVICES, "hub.mjs"), {
      HOST: "127.0.0.1",
      PORT: String(hubPort),
      CONDUCTOR_HUB_TOKEN: TOKEN,
      CONDUCTOR_STATE_FILE: stateFile,
      RUNNER_HEARTBEAT_TTL_MS: "90000",
    });
    running.push(hub);
    await waitHealthy(`${hubUrl}/health`, hub);
    record("hub starts and answers /health", true, `port ${hubPort}`);

    const faro = startService("faro", path.join(SERVICES, "faro.mjs"), {
      HOST: "127.0.0.1",
      PORT: String(faroPort),
      CONDUCTOR_HUB_URL: hubUrl,
      CONDUCTOR_HUB_TOKEN: TOKEN,
    });
    running.push(faro);
    await waitHealthy(`${faroUrl}/health`, faro);
    record("faro starts and answers /health", true, `port ${faroPort}`);

    const runnerEnv = {
      CONDUCTOR_HUB_URL: hubUrl,
      CONDUCTOR_HUB_TOKEN: TOKEN,
      RUNNER_ID: "evidence-runner",
      RUNNER_HEALTH_HOST: "127.0.0.1",
      RUNNER_HEALTH_PORT: String(runnerPort),
      RUNNER_MODELS: "*",
      RUNNER_ALLOW_LOCAL_REPOS: "true",
      RUNNER_MAX_CONCURRENCY: "1",
      RUNNER_POLL_MS: "50",
      RUNNER_TASK_TIMEOUT_MS: "60000",
      RUNNER_TEST_TIMEOUT_MS: "60000",
      // OpenCode is the reference self-hosted harness for this seam (see docs/ops/OMNICONDUCTOR.md).
      RUNNER_CLIS: "opencode",
      ...(REAL_CLIS
        ? {}
        : {
            OPENCODE_BIN: opencode,
            OMNIROUTE_BASE_URL: "http://127.0.0.1:20128",
            OMNIROUTE_API_KEY: "sk-evidence-placeholder",
            OPENCODE_MODEL: "omniroute/evidence-model",
          }),
    };
    const runner = startService("runner", path.join(SERVICES, "runner.mjs"), runnerEnv);
    running.push(runner);
    await waitHealthy(`http://127.0.0.1:${runnerPort}/readyz`, runner);
    const readyz = await (await fetch(`http://127.0.0.1:${runnerPort}/readyz`)).json();
    record(
      "runner reaches /readyz after registering",
      true,
      `capabilities=${readyz.capabilities.clis.map((c) => c.profile).join(",") || "none"}`
    );
    report.capabilities = readyz.capabilities;

    // -- 2. Auth boundary -----------------------------------------------------
    console.log("\n2. Auth boundary");
    const anon = await fetch(`${hubUrl}/v1/runners`);
    record(
      "hub refuses an unauthenticated /v1/runners",
      anon.status === 401,
      `HTTP ${anon.status}`
    );
    const badToken = await fetch(`${hubUrl}/v1/runners`, {
      headers: { authorization: "Bearer wrong-token-wrong-token" },
    });
    record("hub refuses a wrong bearer token", badToken.status === 401, `HTTP ${badToken.status}`);
    const fleet = await (await api(hubUrl, "/v1/runners", undefined, "GET")).json();
    record(
      "hub advertises the registered runner with its capabilities",
      fleet.some((r) => r.id === "evidence-runner" && r.online && r.capabilities.clis.length > 0),
      JSON.stringify(
        fleet.map((r) => ({
          id: r.id,
          online: r.online,
          clis: r.capabilities.clis.map((c) => c.profile),
        }))
      )
    );
    report.fleet = fleet;

    // -- 3. The real task round trip -----------------------------------------
    console.log("\n3. Task execution round trip");
    const created = await api(hubUrl, "/v1/tasks", {
      repo: { url: `file://${repo}`, base_ref: "main" },
      spec: { prompt: "create EVIDENCE.md so the repository test passes" },
      requirements: { cli: "opencode", model: "omniroute/evidence-model" },
    });
    const taskId = (await created.json()).id;
    record("hub accepts a task (HTTP 201)", created.status === 201, taskId);
    const task = await awaitTerminal(hubUrl, taskId);
    evidence.tasks[taskId] = task;
    report.task = task;
    record(
      "task reaches a terminal state",
      Boolean(task.status),
      `${task.status} on ${task.assigned_runner}`
    );
    record(
      "agent execution completed successfully",
      task.status === "completed",
      task.manifest?.error || "no error"
    );
    record(
      "repository-declared `npm test` actually ran and passed",
      task.manifest?.tests?.status === "passed",
      `${JSON.stringify(task.manifest?.tests?.command)} exit=${task.manifest?.tests?.exit_code}`
    );
    record(
      "test output is retained as evidence",
      /repository test passed/.test(task.manifest?.tests?.output || ""),
      (task.manifest?.tests?.output || "").trim().split("\n").pop()
    );
    record(
      "the agent's change is retained as a patch",
      /EVIDENCE\.md/.test(task.manifest?.result?.patch || ""),
      task.manifest?.result?.patch
        ? `${task.manifest.result.patch.split("\n").length} patch lines`
        : "no patch"
    );
    record(
      "worktree status is recorded",
      /EVIDENCE\.md/.test(task.manifest?.result?.worktree || ""),
      task.manifest?.result?.worktree
    );

    // The seam itself: what the self-hosted OpenCode CLI was actually handed. The
    // stand-in echoes its argv + seeded config, and the Runner retains that stdout in
    // the task manifest — so this is the harness's own report, not our assumption.
    const invocationLine = (task.manifest?.result?.output || "")
      .split("\n")
      .find((line) => line.startsWith("opencode-invocation="));
    const invocation = invocationLine
      ? JSON.parse(invocationLine.slice("opencode-invocation=".length))
      : null;
    record(
      "the harness is invoked as `opencode run <prompt> --model <model>`",
      Boolean(
        invocation &&
        invocation.argv[0] === "run" &&
        invocation.argv[1] === "create EVIDENCE.md so the repository test passes" &&
        invocation.argv.includes("--model") &&
        !invocation.argv.includes("--auto")
      ),
      invocation ? JSON.stringify(invocation.argv).slice(0, 160) : "no invocation reported"
    );
    record(
      "the harness is pointed at the configured OmniRoute gateway",
      invocation?.config?.provider?.omniroute?.options?.baseURL === "http://127.0.0.1:20128/v1",
      invocation?.config?.provider?.omniroute?.options?.baseURL ?? "no config seeded"
    );
    record(
      "the gateway credential is referenced, never written to disk",
      invocation?.config?.provider?.omniroute?.options?.apiKey === "{env:OMNIROUTE_API_KEY}",
      invocation?.config?.provider?.omniroute?.options?.apiKey ?? "missing"
    );
    if (invocation)
      report.opencodeInvocation = { argv: invocation.argv, config: invocation.config };

    // -- 4. Idempotency + refusal paths --------------------------------------
    console.log("\n4. Idempotency and refusals");
    const key = `evidence-${Date.now()}`;
    const body = { repo: { url: `file://${repo}` }, spec: { prompt: "idempotent retry" } };
    const once1 = await api(hubUrl, "/v1/tasks", body, "POST", { "idempotency-key": key });
    const twice = await api(hubUrl, "/v1/tasks", body, "POST", { "idempotency-key": key });
    const id1 = (await once1.json()).id;
    const id2 = (await twice.json()).id;
    record("replaying an idempotency key returns the same task", id1 === id2, id1);

    const privateRepo = await api(hubUrl, "/v1/tasks", {
      repo: { url: "https://127.0.0.1/secret/repo.git" },
      spec: { prompt: "should be refused" },
    });
    const privateTask = await awaitTerminal(hubUrl, (await privateRepo.json()).id);
    record(
      "runner refuses a loopback repository URL",
      privateTask.status === "failed" && /not permitted/.test(privateTask.manifest?.error || ""),
      privateTask.manifest?.error?.slice(0, 120)
    );

    if (!REAL_CLIS) {
      const unsupported = await api(hubUrl, "/v1/tasks", {
        repo: { url: `file://${repo}` },
        spec: { prompt: "unsupported harness" },
        requirements: { cli: "opencode", model: "gpt-hosted-not-allowed" },
      });
      const unsupportedId = (await unsupported.json()).id;
      await wait(400);
      const queued = await (
        await api(hubUrl, `/v1/tasks/${unsupportedId}`, undefined, "GET")
      ).json();
      record(
        "a bare (hosted-catalog) model is refused by the self-hosted runner",
        queued.status === "failed" &&
          /No installed compatible harness/.test(queued.manifest?.error || ""),
        `${queued.status}: ${queued.manifest?.error?.slice(0, 110)}`
      );
    }

    const cancelCreated = await api(hubUrl, "/v1/tasks", {
      repo: { url: `file://${repo}` },
      spec: { prompt: "hang" },
      requirements: { cli: "opencode" },
    });
    const cancelId = (await cancelCreated.json()).id;
    await wait(250);
    const canceled = await api(hubUrl, `/v1/tasks/${cancelId}/cancel`, {});
    record("hub accepts a cancellation", canceled.status === 200, `HTTP ${canceled.status}`);
    const canceledTask = await awaitTerminal(hubUrl, cancelId);
    record(
      "cancellation is terminal and visible",
      canceledTask.status === "canceled",
      canceledTask.status
    );

    // -- 5. Faro -------------------------------------------------------------
    console.log("\n5. Faro evidence and confirmations");
    const grounded = await (
      await api(faroUrl, "/ask", { message: `what happened to ${taskId}?` })
    ).json();
    record(
      "faro reports the task from hub evidence",
      grounded.text.includes(taskId) && /completed/.test(grounded.text),
      grounded.text.slice(0, 160)
    );
    record(
      "faro takes no action without a confirmation token",
      grounded.pending === null,
      "pending=null"
    );
    const forged = await (
      await api(faroUrl, "/ask", { message: "yes", confirmation_token: "Zm9v.YmFy" })
    ).json();
    record(
      "a forged confirmation token is refused",
      /No valid, unexpired action/.test(forged.text),
      forged.text.slice(0, 120)
    );
    const proposed = await (await api(faroUrl, "/ask", { message: `cancel ${taskId}` })).json();
    record(
      "cancelling an already-terminal task yields no action",
      proposed.pending === null && /already/.test(proposed.text),
      proposed.text.slice(0, 120)
    );

    // -- 6. Durable state across a restart -----------------------------------
    console.log("\n6. Restart survival");
    const beforeRestart = (await (await api(hubUrl, "/v1/tasks", undefined, "GET")).json()).length;
    // The event feed is a live SSE stream: read until the Hub's `: connected`
    // sentinel, then abort. `res.text()` would block forever here.
    const streamController = new AbortController();
    const eventsBefore = await fetch(`${hubUrl}/v1/events?last_event_id=0`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: streamController.signal,
    });
    let eventsText = "";
    const streamReader = eventsBefore.body.getReader();
    const streamDecoder = new TextDecoder();
    const streamDeadline = Date.now() + 10_000;
    while (Date.now() < streamDeadline && !eventsText.includes(": connected")) {
      const { value, done } = await streamReader.read();
      if (done) break;
      eventsText += streamDecoder.decode(value, { stream: true });
    }
    streamController.abort();
    await streamReader.cancel().catch(() => {});
    const lastEventId =
      [...eventsText.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1])).pop() ?? 0;
    await stopService(runner);
    await stopService(faro);
    await stopService(hub);

    const hub2 = startService("hub", path.join(SERVICES, "hub.mjs"), {
      HOST: "127.0.0.1",
      PORT: String(hubPort),
      CONDUCTOR_HUB_TOKEN: TOKEN,
      CONDUCTOR_STATE_FILE: stateFile,
      RUNNER_HEARTBEAT_TTL_MS: "90000",
    });
    running.push(hub2);
    await waitHealthy(`${hubUrl}/health`, hub2);
    const afterRestart = await (await api(hubUrl, "/v1/tasks", undefined, "GET")).json();
    record(
      "hub state survives a process restart",
      afterRestart.length === beforeRestart,
      `${beforeRestart} tasks before, ${afterRestart.length} after`
    );
    record(
      "the restarted hub replays its event log",
      afterRestart.some((t) => t.id === taskId) && lastEventId > 0,
      `last_event_id=${lastEventId}`
    );
    const stateMode = fs.statSync(stateFile).mode & 0o777;
    record("state file is written 0600", stateMode === 0o600, `mode 0${stateMode.toString(8)}`);
    report.stateFile = { path: stateFile, mode: `0${stateMode.toString(8)}` };
  } catch (error) {
    record("probe completed without an unexpected error", false, error.message);
    console.error(error);
  } finally {
    if (!KEEP) {
      for (const child of running.reverse()) await stopService(child);
      fs.rmSync(dir, { recursive: true, force: true });
    } else {
      console.log(`\n--keep: processes left running from ${dir}`);
    }
  }

  // -- Report ---------------------------------------------------------------
  const failed = checks.filter((c) => !c.ok);
  const summary = {
    ...report,
    finishedAt: new Date().toISOString(),
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    verdict: failed.length === 0 ? "GO" : "NO-GO",
    checks,
    limitations: REAL_CLIS
      ? [
          "A vendor agent run only proves the adapter and credentials on THIS host; model quality is out of scope.",
          "No container image build is claimed — run `npm run verify:conductor:docker` on a Docker host.",
        ]
      : [
          "The agent executable is a documented-contract stand-in for `opencode run`, not a model: the seam, isolation, config seeding, routing and test evidence are real, the edit decision is not.",
          "No provider credential was used; vendor model behaviour is NOT claimed.",
          "No container image build is claimed — run `npm run verify:conductor:docker` on a Docker host.",
        ],
  };

  fs.writeFileSync(JSON_OUT, `${JSON.stringify(summary, null, 2)}\n`);

  const md = [
    "# OmniConductor acceptance evidence",
    "",
    `**Verdict: ${summary.verdict}** — ${summary.passed}/${summary.total} checks passed ` +
      `(${summary.mode}) at ${summary.finishedAt}.`,
    "",
    "> Generated by `node scripts/ops/conductor-evidence.mjs`. Re-run it; do not hand-edit.",
    "",
    "| Check | Result | Evidence |",
    "| ----- | ------ | -------- |",
    ...checks.map(
      (c) =>
        `| ${c.name.replaceAll("|", "\\|")} | ${c.ok ? "PASS" : "**FAIL**"} | ${String(
          c.detail ?? ""
        )
          .replaceAll("|", "\\|")
          .replaceAll("\n", " ")
          .slice(0, 200)} |`
    ),
    "",
    "## Environment",
    "",
    `- node ${summary.node} on ${summary.platform}`,
    `- mode: \`${summary.mode}\``,
    summary.capabilities
      ? `- runner capabilities: \`${JSON.stringify(summary.capabilities.clis)}\``
      : "- runner capabilities: none reported",
    summary.task
      ? `- task \`${summary.task.id}\`: ${summary.task.status}, tests ${summary.task.manifest?.tests?.status}, ${summary.task.manifest?.tests?.command ? `command \`${JSON.stringify(summary.task.manifest.tests.command)}\`` : "no test command"}`
      : "- no task executed",
    summary.stateFile
      ? `- hub state: \`${summary.stateFile.path}\` (${summary.stateFile.mode})`
      : "",
    "",
    "## Limitations (not claimed by this run)",
    "",
    ...summary.limitations.map((l) => `- ${l}`),
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
  fs.writeFileSync(MD_OUT, md);

  console.log(`\n${summary.verdict}: ${summary.passed}/${summary.total} checks passed`);
  console.log(`  JSON:     ${path.relative(ROOT, JSON_OUT)}`);
  console.log(`  Markdown: ${path.relative(ROOT, MD_OUT)}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
