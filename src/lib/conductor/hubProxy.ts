/**
 * Server-side proxy to the OmniConductor hub (Conductor PRD RF3).
 *
 * The browser NEVER talks to the hub: these helpers run only in API routes,
 * authenticate with the server-side env token, and return WHITELISTED shapes —
 * runner/hub tokens can never leak to the client. Fail-open: hub unset/offline
 * yields a degraded snapshot ({offline: true}) instead of an error.
 */

import { z } from "zod";

import { emit } from "@/lib/events/eventBus";

// ============ Whitelisted client-facing shapes ============

export interface FleetRunner {
  id: string;
  name: string;
  clis: string[];
  online: boolean;
  draining: boolean;
}

export interface FleetTask {
  id: string;
  status: string;
  mode: string;
  repo: string | null;
  runner: string | null;
  summary: string | null;
  branch: string | null;
  error: string | null;
  updated_at: string | null;
}

export interface FleetSnapshot {
  offline: boolean;
  runners: FleetRunner[];
  tasks: FleetTask[];
}

export interface ConductorTaskDetail extends FleetTask {
  prompt: string | null;
  base_ref: string | null;
  tests: unknown;
  result: unknown;
  council: unknown;
  created_at: string | null;
  /** Runner profile the task was pinned to (hub `requirements.cli`), `null` when unconstrained. */
  cli: string | null;
  /** Model the task was pinned to (hub `requirements.model`), `null` when unconstrained. */
  model: string | null;
}

// ============ Untrusted hub shapes (parse only what we read) ============

const hubRunnerSchema = z.object({
  id: z.string(),
  online: z.boolean().optional(),
  draining: z.boolean().optional(),
  capabilities: z.object({
    name: z.string().optional(),
    clis: z.array(z.object({ profile: z.string() })).optional(),
  }),
});

const hubTaskSchema = z.object({
  id: z.string(),
  status: z.string(),
  mode: z.string().optional(),
  repo: z.object({ url: z.string().optional(), base_ref: z.string().optional() }).nullish(),
  spec: z.object({ prompt: z.string().optional() }).nullish(),
  assigned_runner: z.string().nullish(),
  manifest: z
    .object({
      summary: z.string().nullish(),
      branch: z.string().nullish(),
      error: z.string().nullish(),
      tests: z.unknown().optional(),
      result: z.unknown().optional(),
    })
    .nullish(),
  // The hub echoes back the `requirements` object `createConductorTask` sends on creation.
  // `.catch(null)` keeps an unexpected shape from failing the WHOLE task parse — a single odd
  // requirement must not blank the fleet snapshot (the list parses with this same schema).
  requirements: z
    .object({ cli: z.string().nullish(), model: z.string().nullish() })
    .nullish()
    .catch(null),
  council: z.unknown().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export interface HubProxyOptions {
  fetchImpl?: typeof fetch;
}

function hubConfig(): { url: string; token: string } | null {
  const url = process.env.CONDUCTOR_HUB_URL?.trim();
  if (!url) return null;
  return { url, token: process.env.CONDUCTOR_HUB_TOKEN?.trim() ?? "" };
}

async function hubGet(path: string, opts: HubProxyOptions): Promise<unknown | null> {
  const cfg = hubConfig();
  if (!cfg) return null;
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${cfg.url}${path}`, {
    headers: { authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

function toFleetTask(t: z.infer<typeof hubTaskSchema>): FleetTask {
  return {
    id: t.id,
    status: t.status,
    mode: t.mode ?? "solo",
    repo: t.repo?.url ?? null,
    runner: t.assigned_runner ?? null,
    summary: t.manifest?.summary ?? null,
    branch: t.manifest?.branch ?? null,
    error: t.manifest?.error ?? null,
    updated_at: t.updated_at ?? null,
  };
}

// ============ Fleet task mirror (Orchestration Canvas Fase 2, Task B3) ============
//
// Module-level cache of the last known status per fleet task, so `getFleetSnapshot` can
// diff-on-fetch and mirror Conductor task transitions into the `agents` WS channel without a
// dedicated poller — it piggybacks on the dashboard's existing poll. `null` means "no snapshot
// observed yet" (first-ever call): that call only seeds the cache, it never emits, since the
// dashboard already fetches the full snapshot on its initial poll. An offline snapshot never
// touches this cache (see call site below), so a hub flap does not cause a re-seed burst once
// the hub comes back — only the real delta since the last successful snapshot is emitted.
let lastFleetTaskStates: Map<string, string> | null = null;

function emitFleetTransitions(tasks: FleetTask[]): void {
  const next = new Map(tasks.map((t) => [t.id, t.status]));
  if (lastFleetTaskStates) {
    for (const [id, status] of next) {
      if (lastFleetTaskStates.get(id) !== status) {
        try {
          emit("agent.task.updated", {
            source: "conductor",
            taskId: id,
            state: status,
            timestamp: Date.now(),
          });
        } catch {
          /* best-effort */
        }
      }
    }
  }
  lastFleetTaskStates = next;
}

/** Test-only seam: resets the fleet task mirror cache so tests are order-independent. */
export function __resetFleetMirrorForTests(): void {
  lastFleetTaskStates = null;
}

/** Fleet snapshot for the dashboard panel. Degraded ({offline: true}) on any failure. */
export async function getFleetSnapshot(opts: HubProxyOptions = {}): Promise<FleetSnapshot> {
  try {
    const [rawRunners, rawTasks] = await Promise.all([
      hubGet("/v1/runners", opts),
      hubGet("/v1/tasks", opts),
    ]);
    if (rawRunners === null || rawTasks === null) return { offline: true, runners: [], tasks: [] };
    const runners = z
      .array(hubRunnerSchema)
      .parse(rawRunners)
      .map((r) => ({
        id: r.id,
        name: r.capabilities.name ?? "?",
        clis: (r.capabilities.clis ?? []).map((c) => c.profile),
        online: r.online !== false,
        draining: r.draining === true,
      }));
    const tasks = z.array(hubTaskSchema).parse(rawTasks).map(toFleetTask);
    emitFleetTransitions(tasks);
    return { offline: false, runners, tasks };
  } catch {
    return { offline: true, runners: [], tasks: [] };
  }
}

/** Full whitelisted detail of one task (manifest, prompt, council funnel data). */
export async function getConductorTaskDetail(
  taskId: string,
  opts: HubProxyOptions = {}
): Promise<ConductorTaskDetail | null> {
  try {
    const raw = await hubGet(`/v1/tasks/${encodeURIComponent(taskId)}`, opts);
    if (raw === null) return null;
    const t = hubTaskSchema.parse(raw);
    return {
      ...toFleetTask(t),
      prompt: t.spec?.prompt ?? null,
      base_ref: t.repo?.base_ref ?? null,
      tests: t.manifest?.tests ?? null,
      result: t.manifest?.result ?? null,
      council: t.council ?? null,
      created_at: t.created_at ?? null,
      cli: t.requirements?.cli ?? null,
      model: t.requirements?.model ?? null,
    };
  } catch {
    return null;
  }
}
export interface DelegationInput {
  repoUrl: string;
  prompt: string;
  baseRef?: string;
  /** Closed set, mirroring the Hub (`solo` | `council`). */
  mode?: "solo" | "council";
  cli?: string;
  model?: string;
  idempotencyKey?: string;
}

/**
 * Delegates work to the fleet: translates an external A2A task into the hub's
 * `POST /v1/tasks` (Conductor PRD RF5). Uses the orchestrator credential when
 * set (CONDUCTOR_ORCHESTRATOR_TOKEN), falling back to the hub token. States
 * flow back through the RF1 mirror — this call only creates.
 */
export async function createConductorTask(
  input: DelegationInput,
  opts: HubProxyOptions = {}
): Promise<{ ok: boolean; status: number; task_id?: string }> {
  const cfg = hubConfig();
  if (!cfg) return { ok: false, status: 503 };
  const token = process.env.CONDUCTOR_ORCHESTRATOR_TOKEN?.trim() || cfg.token;
  const body: Record<string, unknown> = {
    repo: { url: input.repoUrl, base_ref: input.baseRef?.trim() || "main" },
    spec: { prompt: input.prompt },
    mode: input.mode ?? "solo",
  };
  const requirements: Record<string, string> = {};
  if (input.cli?.trim()) requirements.cli = input.cli.trim();
  if (input.model?.trim()) requirements.model = input.model.trim();
  if (Object.keys(requirements).length) body.requirements = requirements;
  try {
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(`${cfg.url}/v1/tasks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const created = z.object({ id: z.string() }).parse(await res.json());
    return { ok: true, status: res.status, task_id: created.id };
  } catch {
    return { ok: false, status: 503 };
  }
}

/** Cancels a task on the hub. Returns the hub's verdict without leaking its body on error. */
export async function cancelConductorTask(
  taskId: string,
  opts: HubProxyOptions = {}
): Promise<{ ok: boolean; status: number }> {
  const cfg = hubConfig();
  if (!cfg) return { ok: false, status: 503 };
  try {
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(`${cfg.url}/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}` },
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 503 };
  }
}

/**
 * Asks the hub to re-queue a terminal task under the same id (Conductor RF5).
 *
 * Retry is *in place*: the dashboard already holds `taskId`, and minting a new one
 * would orphan its event history and its deep link. The hub enforces the retry cap,
 * so a client cannot loop forever by calling this repeatedly.
 */
export async function retryConductorTask(
  taskId: string,
  opts: HubProxyOptions = {}
): Promise<{ ok: boolean; status: number; retries?: number; error?: string }> {
  const cfg = hubConfig();
  if (!cfg) return { ok: false, status: 503 };
  const token = process.env.CONDUCTOR_ORCHESTRATOR_TOKEN?.trim() || cfg.token;
  try {
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(`${cfg.url}/v1/tasks/${encodeURIComponent(taskId)}/retry`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { retries?: number };
      return { ok: true, status: res.status, retries: data.retries };
    }
    // Forward the hub's own refusal (retry cap / not terminal) as a sanitized message.
    const data = (await res.json().catch(() => ({}))) as { error?: unknown };
    return {
      ok: false,
      status: res.status,
      error: typeof data.error === "string" ? data.error.slice(0, 300) : undefined,
    };
  } catch {
    return { ok: false, status: 503 };
  }
}

/**
 * Streams the Hub's own event feed to a browser as SSE (`/api/conductor/stream`).
 *
 * The dashboard used to learn about task transitions by re-fetching the whole fleet
 * every 5s, which meant the `task.updated` events the Hub already emits were produced
 * and then thrown away. This forwards them instead, so the panel reacts to a task
 * finishing instead of waiting up to a full poll interval — and stops paying for a
 * fleet fetch per client per 5s.
 *
 * The upstream connection is opened with the server-side token (never exposed) and is
 * aborted when the client goes away, so a closed tab cannot leak a Hub subscription.
 */
export function conductorEventStream(
  request: Request,
  opts: HubProxyOptions = {}
): ReadableStream<Uint8Array> | null {
  const cfg = hubConfig();
  if (!cfg) return null;
  const encoder = new TextEncoder();
  const abort = new AbortController();
  const lastEventId = request.headers.get("last-event-id");
  request.signal?.addEventListener("abort", () => abort.abort(), { once: true });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: string) => {
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          /* client already gone */
        }
      };
      try {
        const doFetch = opts.fetchImpl ?? fetch;
        const res = await doFetch(
          `${cfg.url}/v1/events${lastEventId ? `?last_event_id=${encodeURIComponent(lastEventId)}` : ""}`,
          {
            headers: { authorization: `Bearer ${cfg.token}`, accept: "text/event-stream" },
            signal: abort.signal,
          }
        );
        if (!res.ok || !res.body) {
          send(
            `event: error\ndata: ${JSON.stringify({ error: "hub event feed unavailable" })}\n\n`
          );
          controller.close();
          return;
        }
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // Forward Hub frames verbatim: the browser wants the Hub's own event names
          // and ids (so it can resume with Last-Event-ID), not a re-encoded copy.
          send(new TextDecoder().decode(value));
        }
        controller.close();
      } catch {
        send(`event: error\ndata: ${JSON.stringify({ error: "hub event feed interrupted" })}\n\n`);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });
}
