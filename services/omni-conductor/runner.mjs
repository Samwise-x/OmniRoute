#!/usr/bin/env node
/** Isolated polling runner. Harness adapters invoke installed native CLIs without a shell. */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import dns from "node:dns/promises";
import { isIP } from "node:net";
import { spawn } from "node:child_process";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const HUB = (process.env.CONDUCTOR_HUB_URL || "http://hub:7910").replace(/\/$/, "");
const TOKEN = process.env.CONDUCTOR_HUB_TOKEN || "";
const ID = process.env.RUNNER_ID || `${os.hostname()}-${process.pid}`;
const SESSION_ID = randomUUID();
const POLL_MS = Number(process.env.RUNNER_POLL_MS || 1000),
  TIMEOUT_MS = Number(process.env.RUNNER_TASK_TIMEOUT_MS || 20 * 60_000),
  TEST_TIMEOUT_MS = Number(process.env.RUNNER_TEST_TIMEOUT_MS || 5 * 60_000);
const PROFILES = (process.env.RUNNER_CLIS || "claude,codex,opencode")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const MAX_CONCURRENCY = Math.max(1, Number(process.env.RUNNER_MAX_CONCURRENCY || 1));
const HEALTH_HOST = process.env.RUNNER_HEALTH_HOST || "0.0.0.0";
const HEALTH_PORT = Number(process.env.RUNNER_HEALTH_PORT || 7930);
if (!TOKEN || TOKEN.length < 16)
  throw new Error("CONDUCTOR_HUB_TOKEN must contain at least 16 characters");
const authHeaders = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
async function api(route, data, method = "POST") {
  const res = await fetch(`${HUB}${route}`, {
    method,
    headers: authHeaders,
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
  return res.json();
}
async function commandExists(bin) {
  return new Promise((resolve) => {
    const p = spawn("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "--", bin], {
      stdio: "ignore",
    });
    p.on("close", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
}
const adapters = {
  claude: {
    bin: process.env.CLAUDE_BIN || "claude",
    args: (prompt, _repo, model) => [
      "-p",
      prompt,
      "--output-format",
      "text",
      "--dangerously-skip-permissions",
      ...(model ? ["--model", model] : []),
    ],
  },
  codex: {
    bin: process.env.CODEX_BIN || "codex",
    args: (prompt, _repo, model) => [
      "exec",
      "--full-auto",
      ...(model ? ["--model", model] : []),
      prompt,
    ],
  },
  opencode: {
    bin: process.env.OPENCODE_BIN || "opencode",
    args: (prompt, _repo, model) => ["run", "--auto", ...(model ? ["--model", model] : []), prompt],
  },
  gateway: {
    bin: process.env.GATEWAY_BIN || "omniroute-agent",
    args: (prompt, repoDir, model) => [
      "--repo",
      repoDir,
      "--prompt",
      prompt,
      ...(model ? ["--model", model] : []),
    ],
  },
};
function modelsFor(profile) {
  const key = `RUNNER_${profile.toUpperCase()}_MODELS`;
  return (process.env[key] || process.env.RUNNER_MODELS || "*")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}
async function capabilities() {
  const clis = [];
  for (const profile of PROFILES) {
    const a = adapters[profile];
    if (a && (await commandExists(a.bin))) clis.push({ profile, models: modelsFor(profile) });
  }
  return { name: process.env.RUNNER_NAME || ID, clis, skills: [] };
}
let stopping = false,
  current = null;
const active = new Set();
async function execute(task) {
  const required = task.requirements?.cli;
  const candidates = required ? [required] : PROFILES;
  const requiredModel = task.requirements?.model;
  const profile = candidates.find((candidate) => {
    const capability = capabilityByProfile.get(candidate);
    return (
      !!capability &&
      (!requiredModel ||
        capability.models.includes("*") ||
        capability.models.includes(requiredModel))
    );
  });
  if (!profile || !adapters[profile])
    throw new Error(`No installed compatible harness${required ? `: ${required}` : ""}`);
  const tmp = await fs.mkdtemp(
    path.join(process.env.RUNNER_WORK_ROOT || os.tmpdir(), "omni-task-")
  );
  const repoDir = path.join(tmp, "repo"),
    home = path.join(tmp, "home");
  await fs.mkdir(home, { mode: 0o700 });
  let child = null,
    canceled = false,
    timeout = false;
  const started = Date.now();
  try {
    const repoUrl = task.repo.url;
    let parsedRepo;
    try {
      parsedRepo = new URL(repoUrl);
    } catch {
      throw new Error("Repository must be an HTTPS git URL");
    }
    const allowedHosts = (process.env.RUNNER_ALLOWED_REPO_HOSTS || "")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    const hostname = parsedRepo.hostname.toLowerCase();
    const localFileAllowed =
      process.env.RUNNER_ALLOW_LOCAL_REPOS === "true" &&
      parsedRepo.protocol === "file:" &&
      !parsedRepo.hostname;
    const resolved =
      parsedRepo.protocol === "https:"
        ? isIP(hostname.replace(/^\[|\]$/g, ""))
          ? [
              {
                address: hostname.replace(/^\[|\]$/g, ""),
                family: isIP(hostname.replace(/^\[|\]$/g, "")),
              },
            ]
          : await dns.lookup(hostname, { all: true }).catch(() => [])
        : [];
    const privateAddress = (address) =>
      address.family === 4
        ? /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address) ||
          address.address === "0.0.0.0"
        : /^(::1|fc|fd|fe80:)/i.test(address.address);
    const safeHttps =
      parsedRepo.protocol === "https:" &&
      !parsedRepo.username &&
      !parsedRepo.password &&
      resolved.length > 0 &&
      !resolved.some(privateAddress) &&
      !["localhost", "localhost.localdomain"].includes(hostname) &&
      !hostname.endsWith(".localhost") &&
      (!allowedHosts.length || allowedHosts.includes(hostname));
    if (!safeHttps && !localFileAllowed)
      throw new Error(
        "Repository URL is not permitted (HTTPS only; host must resolve publicly or be explicitly allowed)"
      );
    const cloneEnv = isolatedEnv(home);
    const gitToken = process.env.RUNNER_GIT_TOKEN;
    const gitHost = (process.env.RUNNER_GIT_HOST || "github.com").toLowerCase();
    if (gitToken && hostname === gitHost) {
      cloneEnv.GIT_CONFIG_COUNT = "1";
      cloneEnv.GIT_CONFIG_KEY_0 = `http.https://${gitHost}/.extraheader`;
      cloneEnv.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${gitToken}`).toString("base64")}`;
    }
    await run(
      "git",
      ["clone", "--depth", "1", "--branch", task.repo.base_ref || "main", "--", repoUrl, repoDir],
      { cwd: tmp, env: cloneEnv, timeoutMs: 120_000 }
    );
    const branch = `conductor/${task.id.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80)}`;
    await run("git", ["checkout", "-b", branch], {
      cwd: repoDir,
      env: isolatedEnv(home),
      timeoutMs: 20_000,
    });
    const adapter = adapters[profile];
    // Always use a private per-task HOME. Only explicit model API keys cross this boundary.
    const env = isolatedEnv(home);
    for (const key of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "OMNIROUTE_BASE_URL",
      "OMNIROUTE_API_KEY",
    ])
      if (process.env[key]) env[key] = process.env[key];
    const result = await run(
      adapter.bin,
      adapter.args(task.spec.prompt, repoDir, task.requirements?.model),
      {
        cwd: repoDir,
        env,
        timeoutMs: TIMEOUT_MS,
        onChild: (p) => {
          child = p;
          let cancellationRequested = false;
          const cancelWatch = setInterval(async () => {
            try {
              const latest = await api(
                `/v1/tasks/${encodeURIComponent(task.id)}`,
                undefined,
                "GET"
              );
              if (latest.status === "canceled" && !cancellationRequested) {
                cancellationRequested = true;
                signalTree(p, "SIGTERM");
                const forceKill = setTimeout(() => signalTree(p, "SIGKILL"), 2_000);
                forceKill.unref();
                p.once("close", () => clearTimeout(forceKill));
              }
            } catch {}
          }, 1000);
          cancelWatch.unref();
          p.once("close", () => clearInterval(cancelWatch));
        },
      }
    );
    const testOutcome = await runRepositoryTests(repoDir, env);
    await run("git", ["add", "--intent-to-add", "--", "."], {
      cwd: repoDir,
      env,
      timeoutMs: 10_000,
    });
    const worktree = await run("git", ["status", "--short"], {
      cwd: repoDir,
      env,
      timeoutMs: 10_000,
    });
    const patch = await run("git", ["diff", "--binary", "HEAD"], {
      cwd: repoDir,
      env,
      timeoutMs: 20_000,
      maxOutput: 300_000,
    });
    const ok = testOutcome.status !== "failed";
    await report(task, {
      ok,
      summary: ok
        ? (result.stdout || "Harness finished successfully").trim().slice(-3000)
        : "Harness finished, but repository tests failed",
      error: ok ? null : `Repository tests failed (exit ${testOutcome.exit_code ?? "unknown"})`,
      branch,
      tests: testOutcome,
      result: {
        harness: profile,
        duration_ms: Date.now() - started,
        output: (result.stdout || "").slice(-8000),
        worktree: worktree.stdout.trim(),
        patch: patch.stdout.length < 300_000 ? patch.stdout : null,
        patch_truncated: patch.stdout.length >= 300_000,
      },
    });
  } catch (error) {
    canceled = error.code === "CANCELED";
    timeout = error.code === "TIMEOUT";
    await report(task, {
      ok: false,
      summary: canceled
        ? "Execution canceled"
        : timeout
          ? "Execution timed out"
          : "Execution failed",
      error: `${error.message}${error.stderr ? `: ${error.stderr.slice(-2000)}` : ""}`,
      tests: { status: "not_run", reason: "runner_execution_failed" },
      result: { harness: profile, duration_ms: Date.now() - started },
    }).catch((e) => console.error("report failed", e.message));
  } finally {
    if (child && !child.killed) signalTree(child, "SIGTERM");
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    current = null;
  }
  function isolatedEnv(h) {
    return {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: h,
      USER: process.env.USER || "runner",
      LANG: "C.UTF-8",
      CI: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
  }
  async function report(t, result) {
    await api(`/v1/tasks/${encodeURIComponent(t.id)}/result`, {
      runner_id: ID,
      session_id: SESSION_ID,
      ...result,
    });
  }
  async function runRepositoryTests(directory, testEnv) {
    const startedAt = Date.now();
    let command;
    if (process.env.RUNNER_TEST_COMMAND) {
      try {
        command = JSON.parse(process.env.RUNNER_TEST_COMMAND);
      } catch {
        return {
          status: "failed",
          command: [],
          exit_code: null,
          output: "RUNNER_TEST_COMMAND must be a JSON argv array",
        };
      }
      if (
        !Array.isArray(command) ||
        !command.length ||
        command.some((part) => typeof part !== "string")
      )
        return {
          status: "failed",
          command: [],
          exit_code: null,
          output: "RUNNER_TEST_COMMAND must be a non-empty JSON argv array",
        };
    } else {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
        if (typeof pkg.scripts?.test === "string" && pkg.scripts.test.trim())
          command = ["npm", "test"];
      } catch {}
      if (!command) {
        const pytestInstalled = await commandExists("pytest");
        const hasPythonTests =
          (await fs.access(path.join(directory, "pytest.ini")).then(
            () => true,
            () => false
          )) ||
          (await fs.access(path.join(directory, "pyproject.toml")).then(
            () => true,
            () => false
          ));
        if (pytestInstalled && hasPythonTests) command = ["pytest", "-q"];
      }
    }
    if (!command)
      return {
        status: "skipped",
        command: [],
        exit_code: null,
        output: "No supported repository test command was detected",
      };
    try {
      const result = await run(command[0], command.slice(1), {
        cwd: directory,
        env: testEnv,
        timeoutMs: TEST_TIMEOUT_MS,
        maxOutput: 60_000,
      });
      return {
        status: "passed",
        command,
        exit_code: 0,
        duration_ms: Date.now() - startedAt,
        output: `${result.stdout}${result.stderr}`.slice(-60_000),
      };
    } catch (error) {
      return {
        status: "failed",
        command,
        exit_code: error.exitCode ?? null,
        duration_ms: Date.now() - startedAt,
        output: `${error.message}\n${error.stderr || ""}`.slice(-60_000),
      };
    }
  }
}
// Cache installed profiles; capability discovery occurs at registration and every heartbeat.
const availableCapabilities = await capabilities();
const capabilityByProfile = new Map(
  availableCapabilities.clis.map((capability) => [capability.profile, capability])
);
let registered = false;
let lastHubContact = 0;
const healthServer = http.createServer((req, res) => {
  const route = new URL(req.url, "http://localhost").pathname;
  if (req.method !== "GET" || !["/health", "/healthz", "/readyz"].includes(route)) {
    res.writeHead(404).end();
    return;
  }
  const healthy =
    registered && Date.now() - lastHubContact < Math.max(10_000, POLL_MS * 5) && !stopping;
  res.writeHead(healthy ? 200 : 503, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(
    JSON.stringify({
      status: healthy ? "ok" : "degraded",
      runner_id: ID,
      active: active.size,
      capabilities: availableCapabilities,
    })
  );
});
function signalTree(child, signal) {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}
function run(bin, args, { cwd, env, timeoutMs, onChild, maxOutput = 100_000 }) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    onChild?.(p);
    let stdout = "",
      stderr = "",
      settled = false;
    let forceKill;
    let timeoutError;
    const timer = setTimeout(() => {
      signalTree(p, "SIGTERM");
      forceKill = setTimeout(() => signalTree(p, "SIGKILL"), 2_000);
      forceKill.unref();
      const e = new Error(`command timed out after ${timeoutMs}ms`);
      e.code = "TIMEOUT";
      timeoutError = e;
    }, timeoutMs);
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(value);
    };
    p.stdout.on("data", (d) => (stdout = (stdout + d).slice(-maxOutput)));
    p.stderr.on("data", (d) => (stderr = (stderr + d).slice(-30_000)));
    p.on("error", finish);
    p.on("close", (code) => {
      if (forceKill) clearTimeout(forceKill);
      timeoutError
        ? finish(timeoutError)
        : code === 0
          ? finish(null, { stdout, stderr })
          : finish(
              Object.assign(new Error(`${bin} exited with code ${code}`), {
                stderr,
                exitCode: code,
              })
            );
    });
  });
}
async function loop() {
  const caps = await capabilities();
  if (!caps.clis.length)
    console.warn(`No harness CLIs installed; configured=${PROFILES.join(",")}`);
  await api("/v1/runners/register", {
    id: ID,
    session_id: SESSION_ID,
    capabilities: caps,
    max_concurrency: MAX_CONCURRENCY,
  });
  registered = true;
  lastHubContact = Date.now();
  console.log(
    `Registered runner ${ID}; harnesses=${caps.clis.map((c) => c.profile).join(",") || "none"}`
  );
  while (!stopping || active.size > 0) {
    try {
      await api("/v1/runners/heartbeat", { id: ID, session_id: SESSION_ID, draining: stopping });
      lastHubContact = Date.now();
      if (!stopping && !current && active.size < MAX_CONCURRENCY) {
        current = await api("/v1/runner/claim", { id: ID, session_id: SESSION_ID });
        if (current) {
          const task = current;
          active.add(task.id);
          void execute(task).finally(() => active.delete(task.id));
          current = null;
        }
      }
    } catch (e) {
      console.error(`hub unavailable: ${e.message}`);
    }
    await delay(POLL_MS);
  }
  registered = false;
  await Promise.allSettled([...active]);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
    if (current) console.log("draining");
  });
healthServer.listen(HEALTH_PORT, HEALTH_HOST, () =>
  console.log(`Runner health listening on ${HEALTH_HOST}:${HEALTH_PORT}`)
);
loop()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => healthServer.close());
