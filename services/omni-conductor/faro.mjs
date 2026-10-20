#!/usr/bin/env node
/** Hub-evidence Faro with signed confirmations and optional OmniRoute-routed chat. */
import http from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || 7920);
const HOST = process.env.HOST || "0.0.0.0";
const HUB = (process.env.CONDUCTOR_HUB_URL || "http://hub:7910").replace(/\/$/, "");
const TOKEN = process.env.CONDUCTOR_HUB_TOKEN || "";
const CONFIRM_TTL_MS = 2 * 60_000;
if (!TOKEN || TOKEN.length < 16) throw new Error("CONDUCTOR_HUB_TOKEN required");

function authorized(req) {
  const v = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(v),
    b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function hub(path, init = {}) {
  const res = await fetch(`${HUB}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Hub returned HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}
function signConfirmation(action) {
  const encoded = Buffer.from(
    JSON.stringify({ ...action, expires_at: Date.now() + CONFIRM_TTL_MS })
  ).toString("base64url");
  const signature = createHmac("sha256", TOKEN).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}
function readConfirmation(token) {
  if (typeof token !== "string" || token.length > 12_000) return null;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = createHmac("sha256", TOKEN).update(encoded).digest();
  let actual;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return payload.expires_at > Date.now() ? payload : null;
  } catch {
    return null;
  }
}
function describeTask(t) {
  const m = t.manifest || {};
  const testText = t.manifest?.tests?.status ? ` Tests: ${t.manifest.tests.status}.` : "";
  return `Task ${t.id}: ${t.status}${t.assigned_runner ? ` on runner ${t.assigned_runner}` : ""}. Repository: ${t.repo?.url || "unknown"}.${m.summary ? ` Result: ${m.summary}` : ""}${m.branch ? ` Branch: ${m.branch}` : ""}${testText}${m.error ? ` Error: ${m.error}` : ""}`;
}
function extractAction(message, tasks) {
  const cancel =
    message.match(/\b(?:cancel|stop|abort|cancelar|parar|detener)\b[\s\S]*?\b(task_[\w-]+)\b/i) ||
    message.match(/\b(task_[\w-]+)\b[\s\S]*?\b(?:cancel|stop|abort|cancelar|parar|detener)\b/i);
  if (cancel) {
    const task = tasks.find((t) => t.id === cancel[1]);
    if (!task) return { response: `Hub has no task with ID ${cancel[1]}.` };
    if (["completed", "failed", "canceled"].includes(task.status))
      return { response: `Task ${task.id} is already ${task.status}; no action was taken.` };
    return {
      action: { kind: "cancel_task", task_id: task.id },
      response: `Confirm cancellation of ${task.id}? This cannot be undone.`,
    };
  }
  const create = message.match(
    /^\s*(?:run|create|start|submit|criar|iniciar|executar)\s+(?:a\s+)?(?:task\s+)?(https:\/\/[^\s|]+)\s*\|\s*([\s\S]{1,4000})\s*$/i
  );
  if (create) {
    let repo;
    try {
      repo = new URL(create[1]);
    } catch {
      return { response: "The repository URL is invalid." };
    }
    if (repo.protocol !== "https:" || repo.username || repo.password)
      return { response: "Task repositories must use HTTPS without credentials in the URL." };
    const prompt = create[2].trim();
    return {
      action: {
        kind: "create_task",
        repo_url: repo.toString(),
        base_ref: "main",
        prompt,
        idempotency_key: `faro-${randomUUID()}`,
      },
      response: `Confirm task submission for ${repo.hostname}? Prompt: ${prompt.slice(0, 500)}`,
    };
  }
  return null;
}
async function confirmAction(action) {
  if (action.kind === "cancel_task" && typeof action.task_id === "string") {
    const task = await hub(`/v1/tasks/${encodeURIComponent(action.task_id)}`);
    if (["completed", "failed", "canceled"].includes(task.status))
      return `Task ${task.id} is already ${task.status}; no action was taken.`;
    await hub(`/v1/tasks/${encodeURIComponent(action.task_id)}/cancel`, { method: "POST" });
    return `Cancellation confirmed. Task ${action.task_id} is canceled in Hub.`;
  }
  if (
    action.kind === "create_task" &&
    typeof action.repo_url === "string" &&
    typeof action.prompt === "string"
  ) {
    const response = await hub("/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": action.idempotency_key },
      body: JSON.stringify({
        repo: { url: action.repo_url, base_ref: action.base_ref || "main" },
        spec: { prompt: action.prompt },
        mode: "solo",
      }),
    });
    return `Task submitted to Hub with ID ${response.id}. Repository: ${action.repo_url}`;
  }
  return "The requested confirmation action is invalid; no action was taken.";
}
function deterministicAnswer(message, tasks, runners) {
  const q = message.toLowerCase();
  const id = (message.match(/task_[\w-]+/i) || [])[0];
  if (id) {
    const task = tasks.find((t) => t.id === id);
    return task ? describeTask(task) : `I checked the Hub task records; task ${id} was not found.`;
  }
  if (/runner|fleet|available|online|frota|corredor|runner[s]?\s+online/.test(q)) {
    const online = runners.filter((r) => r.online && !r.draining);
    const details = online
      .map(
        (r) =>
          `${r.capabilities?.name || r.id} (${(r.capabilities?.clis || []).map((c) => `${c.profile}${c.models?.length ? `: ${c.models.join("/")}` : ""}`).join(", ") || "no harness"})`
      )
      .join("; ");
    return `Hub reports ${online.length} available runner(s) out of ${runners.length}. ${details || "No runner is currently available."}`;
  }
  if (
    /task|tasks|status|result|finished|completed|failed|working|tarefa|tarefas|resultado|conclu|falhou|andamento/.test(
      q
    )
  ) {
    const words = q.split(/\s+/).filter((word) => word.length > 4);
    const matching = tasks.filter((t) =>
      words.some((word) => t.repo?.url?.toLowerCase().includes(word))
    );
    const list = matching.length
      ? matching
      : tasks
          .slice()
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(0, 5);
    return list.length ? list.map(describeTask).join("\n") : "Hub has no tasks to report.";
  }
  return null;
}
async function modelAnswer(message, tasks, runners) {
  const base = process.env.OMNIROUTE_BASE_URL?.trim().replace(/\/$/, "");
  const model = process.env.FARO_MODEL?.trim();
  const key = process.env.OMNIROUTE_API_KEY?.trim();
  if (!base || !model || !key) return null;
  const evidence = {
    tasks: tasks.slice(0, 25).map((t) => ({
      id: t.id,
      status: t.status,
      repo: t.repo?.url,
      runner: t.assigned_runner,
      summary: t.manifest?.summary,
      error: t.manifest?.error,
      tests: t.manifest?.tests?.status,
    })),
    runners: runners.map((r) => ({
      id: r.id,
      online: r.online,
      draining: r.draining,
      capabilities: r.capabilities,
    })),
  };
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: "system",
            content: `You are Faro, OmniRoute's coding-fleet spokesperson. Answer in the user's language. Ground every claim only in the Hub evidence JSON below; if it lacks an answer, explicitly say so. Never claim an action happened unless the evidence confirms it. Do not issue or simulate actions. Hub evidence: ${JSON.stringify(evidence)}`,
          },
          { role: "user", content: message },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === "string" && text.trim() ? text.trim().slice(0, 4_000) : null;
  } catch {
    return null;
  }
}
async function answer(message, confirmationToken) {
  const [tasks, runners] = await Promise.all([hub("/v1/tasks"), hub("/v1/runners")]);
  const normalized = message.trim().toLowerCase();
  if (/^(yes|y|confirm|sim|sí|si|confirmar|affirmative)$/.test(normalized)) {
    const action = readConfirmation(confirmationToken);
    return {
      text: action
        ? await confirmAction(action)
        : "No valid, unexpired action is awaiting confirmation.",
      pending: null,
    };
  }
  if (/^(no|n|não|nao|cancel|nein)$/.test(normalized))
    return { text: "Understood. No action was taken.", pending: null };
  const intent = extractAction(message, tasks);
  if (intent?.action) {
    const token = signConfirmation(intent.action);
    return { text: intent.response, pending: { token, action: intent.action.kind } };
  }
  if (intent?.response) return { text: intent.response, pending: null };
  const grounded = deterministicAnswer(message, tasks, runners);
  if (grounded) return { text: grounded, pending: null };
  const model = await modelAnswer(message, tasks, runners);
  return {
    text:
      model ||
      `I can report verified Hub task and runner state. Hub currently has ${tasks.length} task(s) and ${runners.filter((r) => r.online).length} online runner(s). Ask about a task ID, task status, results, or runner availability.`,
    pending: null,
  };
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  res.setHeader("content-type", "application/json; charset=utf-8");
  if (req.method === "GET" && ["/health", "/healthz", "/readyz"].includes(url.pathname)) {
    try {
      await hub("/health");
      res.writeHead(200);
      return res.end(JSON.stringify({ status: "ok", service: "omni-conductor-faro" }));
    } catch {
      res.writeHead(503);
      return res.end(JSON.stringify({ status: "degraded" }));
    }
  }
  if (req.method !== "POST" || url.pathname !== "/ask") {
    res.writeHead(404);
    return res.end(JSON.stringify({ error: "not found" }));
  }
  if (!authorized(req)) {
    res.writeHead(401);
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }
  try {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 16_000) throw new Error("body too large");
    }
    const input = JSON.parse(raw || "{}");
    if (
      typeof input.message !== "string" ||
      !input.message.trim() ||
      input.message.length > 4_000 ||
      (input.confirmation_token !== undefined && typeof input.confirmation_token !== "string")
    ) {
      res.writeHead(400);
      return res.end(
        JSON.stringify({
          error: "message must be 1-4000 characters; confirmation_token must be a string",
        })
      );
    }
    const result = await answer(input.message, input.confirmation_token);
    res.writeHead(200);
    res.end(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    res.writeHead(503);
    res.end(JSON.stringify({ error: "Hub evidence unavailable" }));
  }
});
server.listen(PORT, HOST, () => console.log(`OmniConductor Faro listening on ${HOST}:${PORT}`));
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => server.close(() => process.exit(0)));
