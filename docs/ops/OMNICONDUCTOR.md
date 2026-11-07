# Self-hosted OmniConductor runtime

This repository now includes a standalone Hub, polling Runner and evidence-first Faro service at `services/omni-conductor/`. They implement the v1 HTTP/SSE contract consumed by OmniRoute's existing `/api/conductor/*` routes; the browser still talks only to OmniRoute. The services use Node's built-in HTTP APIs and a durable, atomically replaced JSON state file. No private image or unpublished service is required.

## Deploy

Requirements: Docker Engine + Docker Compose v2, outbound access to npm and the git hosts used for repositories, and a supported agent CLI credential for each enabled harness. From the repository root:

```sh
cp .env.omniconductor.example .env.omniconductor
openssl rand -hex 32  # put the output in CONDUCTOR_HUB_TOKEN
# Add an Anthropic/OpenAI/OpenRouter credential for the harnesses you plan to use.
docker compose --env-file .env.omniconductor -f docker-compose.omniconductor.yml up --build -d --scale runner=2
```

That command deploys the Conductor services independently. To launch OmniRoute and Conductor in the **same Compose project/network**, first copy `.env.example` to `.env` and set these values in `.env` (use the same strong token for Hub and OmniRoute):

```dotenv
CONDUCTOR_HUB_TOKEN=<same random secret as CONDUCTOR_ORCHESTRATOR_TOKEN>
CONDUCTOR_HUB_URL=http://hub:7910
CONDUCTOR_ORCHESTRATOR_TOKEN=<same random secret as CONDUCTOR_HUB_TOKEN>
CONDUCTOR_SPOKESPERSON_URL=http://faro:7920
```

Then merge the existing OmniRoute Compose stack and the companion services. Replace `base` with another existing OmniRoute profile (`web`, `cli`, or `host`) as needed:

```sh
docker compose --env-file .env -f docker-compose.yml -f docker-compose.omniconductor.yml --profile base up --build -d --scale runner=2
```

This combined invocation puts `hub`, `faro`, both `runner` replicas and the selected OmniRoute service on the same Compose network; the browser still reaches only OmniRoute's management-authenticated routes. For a separately hosted OmniRoute process, use the host-reachable settings in the next section instead.

The runner image installs the public Claude Code, Codex and OpenCode CLIs at the exact versions pinned by `services/omni-conductor/package-lock.json` (and the build fails if the pinned `opencode` cannot start, so a green image cannot ship a Runner that advertises nothing). It advertises only installed harnesses. Scaling creates independently identified runners; the Hub reports live capability and heartbeat state. `gateway` can be enabled by setting `RUNNER_CLIS=...,gateway` and supplying a compatible executable as `GATEWAY_BIN` in a custom runner deployment; its invocation contract is `GATEWAY_BIN --repo <working-directory> --prompt <task-prompt>`. No default Gateway executable is assumed.

Connect the OmniRoute process to the deployment. With OmniRoute running on the Docker host, use:

```dotenv
CONDUCTOR_HUB_URL=http://127.0.0.1:7910
CONDUCTOR_HUB_TOKEN=<same secret>
CONDUCTOR_ORCHESTRATOR_TOKEN=<same secret>
CONDUCTOR_SPOKESPERSON_URL=http://127.0.0.1:7920
```

If OmniRoute itself runs in Compose, put it on the same network and use `http://hub:7910` and `http://faro:7920` instead. The dashboard API remains protected by OmniRoute management auth.

### Credentials: one secret, or least-privilege principals

`CONDUCTOR_HUB_TOKEN` is the full-access secret and is always required. Two optional secrets narrow what the other parties can do; leaving both unset preserves the original single-secret behaviour, so adopting them is incremental:

| Variable | Principal | May do |
| --- | --- | --- |
| `CONDUCTOR_HUB_TOKEN` | admin / orchestrator | Everything: create, cancel, retry, list, metrics, register |
| `CONDUCTOR_RUNNER_TOKEN` | runner | Register, heartbeat, claim, report a result, deregister, and read `/v1/runners` |
| `CONDUCTOR_READONLY_TOKEN` | read-only | `GET` only — dashboards, scrapers, on-call |

Set `CONDUCTOR_RUNNER_TOKEN` on the Hub and pass the same value to each Runner as its `CONDUCTOR_RUNNER_TOKEN` (the Runner prefers it over the shared secret). A Runner then cannot create tasks, cancel anyone's work, or retry in a loop — the verbs a compromised Runner would want. Refusals are `403` with the offending principal and route; an unknown token is `401`.

Check service health and runner registration. Runner `/readyz` only returns healthy after registration and a recent successful Hub contact; `/health` is internal to its container and is not published on the host.

```sh
docker compose --env-file .env.omniconductor -f docker-compose.omniconductor.yml ps
curl -fsS http://127.0.0.1:7910/health
curl -fsS -H "Authorization: Bearer $CONDUCTOR_HUB_TOKEN" http://127.0.0.1:7910/v1/runners
```

Hub and Faro are bound to loopback on the host by default. Do not expose these ports publicly without TLS and an appropriate network policy. Hub state (including prompts, execution summaries and bounded patches) persists in plaintext in the `conductor-data` volume; the Hub writes its state file with mode `0600`. Treat volume contents and backups as source-code-sensitive data, keep secrets out of task prompts, and protect backups accordingly. Stop gracefully with `docker compose ... down` (do not add `-v` unless intentionally deleting all task history).

## Operating the Hub

**Reading the task list.** `GET /v1/tasks` is keyset-paginated so a long-lived fleet cannot produce an unbounded response. Without query parameters it keeps returning a plain array (existing clients keep working). With `limit`, `cursor`, `status` or `mode` it returns `{ tasks, next_cursor }`, newest first, walking by `(created_at, id)`. `limit` defaults to 50 and is clamped to 200. `status` accepts `queued|working|completed|failed|canceled` and `mode` accepts `solo|council`; an unknown value is `400`, never a silently empty list. `mode` is a closed set at creation time for the same reason: a typo used to produce a task whose mode nothing could render.

```sh
curl -fsS -H "Authorization: Bearer $CONDUCTOR_HUB_TOKEN" \
  "http://127.0.0.1:7910/v1/tasks?status=failed&limit=50"
```

**Retention.** Terminal tasks are dropped after `CONDUCTOR_TASK_RETENTION_MS` (default 7 days) and the list is additionally capped at `CONDUCTOR_MAX_TASKS` (default 5000) by dropping the oldest terminal tasks first. Running work is never pruned. `CONDUCTOR_MAX_EVENTS` (default 10000) bounds the replayable event log. Set the retention to `0` to keep task history forever.

**Metrics.** `GET /metrics` (authenticated) answers the operational questions directly: task counts by status, queue depth *relative to live fleet capacity* (`queued_over_capacity > 0` means nothing can start until a runner frees up), how long the oldest queued task has waited, online/draining runner counts, event-log occupancy, and the active retention settings. Queue depth is fleet information, so it sits behind the same bearer gate as `/v1/*`.

**Live updates.** The dashboard subscribes to `GET /api/conductor/stream` (OmniRoute, management-authenticated), which forwards the Hub's own SSE frames including their ids, so a reconnect resumes from `Last-Event-ID` and no transition is missed. With the stream open, the panel's 5-second poll drops to a 60-second safety net, and the UI shows whether it is `live` or `polling`.

## Execution model and safety

Task creation validates required fields, persists the request, then schedules queued work by creation time and task ID. Eligible live runners are ordered lexically by runner ID; capability constraints (`requirements.cli` and `requirements.model`) are checked explicitly. `RUNNER_MODELS` advertises an allowlist on each available profile; its default `*` delegates model-name validation to the selected native CLI. `RUNNER_CLAUDE_MODELS`, `RUNNER_CODEX_MODELS`, `RUNNER_OPENCODE_MODELS`, and `RUNNER_GATEWAY_MODELS` can override model allowlists per harness. Routing and runner-side harness choice both require the requested CLI/model pair to match that same advertised profile. The choice is deterministic for the same state. Runner leases are renewed by heartbeat; work held by a runner past the configured heartbeat expiry is re-queued on a subsequent scheduling pass. Each runner process also registers a fresh session ID, so its replacement immediately requeues work claimed by the prior process incarnation instead of renewing a stale lease forever. Heartbeats, claims, and results from an older session are rejected after replacement. During graceful shutdown a Runner marks itself draining, stops claiming new tasks, and continues heartbeating until its active tasks finish. Recovery is still at-least-once: an abruptly killed harness may have executed side effects before losing its lease.

Each execution gets a fresh temporary clone and HOME, a task-specific local branch, explicit API-key environment forwarding, a timeout, bounded output, and cleanup. After the agent exits successfully, the runner executes the repository's declared `npm test` when present, or `pytest -q` when a pytest configuration and executable are available. Set `RUNNER_TEST_COMMAND` to a JSON argv array for other project test runners. Test outcomes (`passed`, `failed`, `skipped`, or `not_run`), command, exit code, duration, and bounded output are persisted in the task manifest and shown in task detail. A detected test failure marks the task failed; a skipped test run is reported explicitly rather than represented as a pass. Runners do not push branches or open pull requests: the temporary clone is removed after reporting, while the Hub retains the summary and a bounded binary patch (up to 300 KB) for authenticated task detail and the dashboard. The branch name is local metadata, not a remote ref. Repository URLs must use HTTPS, resolve to public addresses, and may be restricted further with `RUNNER_ALLOWED_REPO_HOSTS`. Do not put credentials in repository URLs or task prompts. Optional `RUNNER_GIT_TOKEN` is scoped to the exact `RUNNER_GIT_HOST` and supplied only to the HTTPS `git clone` subprocess; it is not forwarded to the agent CLI or retained in the clone. The container does not mount the host filesystem, Docker socket, or host credentials; only the configured provider API keys are passed to the CLI. Treat task prompts and repository code as untrusted. The runner container has no added Linux capabilities, a read-only root, resource limits and no-new-privileges; for higher-assurance workloads, add network egress policy and run each task in a separate VM/container boundary.

Cancellation sets a terminal Hub state; active runners poll the task state and terminate the child process. A terminal task can be retried in place with `POST /v1/tasks/<id>/retry`: the id is preserved (so dashboards, links and event history survive), the prior outcome is appended to `retry_history`, and a retry counter caps how many times (default 3, `CONDUCTOR_MAX_TASK_RETRIES`) so a client cannot loop forever. A retry is only accepted for a terminal task — retrying queued or running work would double-execute it. On graceful shutdown a Runner calls `POST /v1/runners/deregister`, which removes it from the fleet and returns its in-flight work to the queue immediately instead of waiting for the heartbeat TTL. Task completion/failure, scheduling, cancellation and retries are durable and replayable from `GET /v1/events?last_event_id=...`. Faro's `/ask` reads live Hub task/runner data and reports those records; it does not invent execution outcomes. Task creation (`create task https://host/repo.git | <prompt>`) and cancellation (`cancel task task_<id>`) are parsed deterministically and require a signed, expiring confirmation token. Optional open-ended chat can use OmniRoute's OpenAI-compatible router by setting `OMNIROUTE_BASE_URL`, `OMNIROUTE_API_KEY`, and `FARO_MODEL`; the model receives a bounded Hub evidence snapshot and cannot perform actions. Without those settings Faro remains deterministic and evidence-based. The OmniRoute bridge can replay the SSE event cursor after restart.

The runner supports `claude`, `codex`, `opencode` and a configurable `gateway` adapter. A CLI is reported as a capability only when its executable is installed. Provider credentials, model availability, and native CLI behavior remain dependent on operator configuration. `gateway` is not represented as a fictitious built-in executable.

### OpenCode is the reference self-hosted harness

`RUNNER_CLIS` defaults to `opencode`. Two properties make it the harness this seam is standardized on:

- **It runs our models, not OpenCode's.** With `OMNIROUTE_BASE_URL` set, the Runner writes a per-task `$HOME/.config/opencode/opencode.json` whose only provider is `omniroute`, with `baseURL: <OMNIROUTE_BASE_URL>/v1` and the key referenced as `{env:OMNIROUTE_API_KEY}` — the credential is read from the process environment at run time and never written into the workspace, the patch, or the state volume. A repo-supplied `opencode.json` in the clone still wins, because OpenCode merges project config after the global one.
- **It cannot silently leave self-hosting.** A model pinned to a bare name (e.g. `gpt-5.5`) would be served by OpenCode's own hosted catalog, so the Runner refuses it and fails the task closed with an explicit error. Only `omniroute/<model>` (the prefix `omniroute setup-opencode` writes) is eligible by default. Set `RUNNER_OPENCODE_ALLOW_HOSTED_MODELS=true` to opt in deliberately.

Invocation is `opencode run "<prompt>" --auto [--model <model>]` — the form documented in [`docs/reference/CLI-TOOLS.md`](../reference/CLI-TOOLS.md) and used by `omniroute setup-opencode`. `OPENCODE_MODEL` supplies the default `--model` when a task pins none, so an unpinned task still lands on your gateway.

Two properties of the pinned binary (verified against `opencode-ai` 1.19.3, not assumed) shape that contract:

- **`--auto` is required.** Without it, a task with no TTY blocks on an approval prompt until the task timeout. The flag exists in the release (`opencode run --help`, "auto-approve permissions that are not explicitly denied").
- **The seeded config must declare the model.** Pointing `baseURL`+`apiKey` at the gateway is not enough: the CLI fetches `/v1/models` successfully and still fails `ProviderModelNotFoundError`. The Runner therefore writes a `provider.omniroute.models` map naming each advertised model, which is what makes the wire call carry the model the operator asked for.

Recommended deployment variables:

```dotenv
RUNNER_CLIS=opencode
OMNIROUTE_BASE_URL=http://omniroute:20128   # or the host-reachable gateway URL
OMNIROUTE_API_KEY=sk-your-omniroute-key     # an inference key, not a management token
OPENCODE_MODEL=omniroute/claude-sonnet-4-5  # default when the task pins none
```

## Verification

Four commands, cheapest first. All of them are wired into CI (`OmniConductor Hub (runtime evidence)`), and none needs a provider credential.

```sh
npm run test:conductor            # real hub + faro + runner processes, incl. the OpenCode seam
npm run test:conductor:contract   # OmniRoute's production route handlers against a real Hub
npm run verify:conductor          # GO/NO-GO report → conductor-evidence.json + docs/ops/OMNICONDUCTOR_EVIDENCE.md
npm run verify:conductor:docker   # image build + Compose bring-up (needs a Docker host; exits NO-GO when absent)
```

`npm run verify:conductor` regenerates [`OMNICONDUCTOR_EVIDENCE.md`](OMNICONDUCTOR_EVIDENCE.md) from what it actually observed, so that document is a result rather than a claim. Add `-- --real-clis` on a credentialed host to run the installed vendor CLIs instead of the contract stand-in; the report records which mode produced it.

### What the evidence does and does not prove

`npm run verify:conductor` proves, on this machine, that the three services start, authenticate, route, execute, retain a patch, run the repository's own tests, survive a restart, and refuse the inputs they are supposed to refuse — including that the OpenCode harness is invoked with the documented argv and handed a config pointing at your gateway. It does **not** prove model quality, because the stand-in for `opencode run` decides the edit; `--real-clis` closes that gap on a credentialed host. It does not prove the images build; `verify:conductor:docker` does, and fails loudly on a host without an engine instead of reporting a hollow pass.

### Manual validation of a real deployment

For end-to-end validation with real credentials, deploy, then submit a task from the OmniRoute dashboard or `POST /api/conductor/tasks` with `cli: "opencode"` and an `omniroute/<model>` pin, and read the retained manifest: `tests.command`, `tests.exit_code`, `tests.output`, `result.patch` and `result.worktree` are the evidence. `GET /api/conductor/tasks/<id>` returns them, and `GET /api/a2a/tasks?skill=conductor` shows the mirrored state.
