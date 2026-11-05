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

If OmniRoute itself runs in Compose, put it on the same network and use `http://hub:7910` and `http://faro:7920` instead. `CONDUCTOR_ORCHESTRATOR_TOKEN` may be a separately managed credential in deployments with peer-level credential support; this bundled Hub currently uses one shared bearer secret. The dashboard API remains protected by OmniRoute management auth.

Check service health and runner registration. Runner `/readyz` only returns healthy after registration and a recent successful Hub contact; `/health` is internal to its container and is not published on the host.

```sh
docker compose --env-file .env.omniconductor -f docker-compose.omniconductor.yml ps
curl -fsS http://127.0.0.1:7910/health
curl -fsS -H "Authorization: Bearer $CONDUCTOR_HUB_TOKEN" http://127.0.0.1:7910/v1/runners
```

Hub and Faro are bound to loopback on the host by default. Do not expose these ports publicly without TLS and an appropriate network policy. Hub state (including prompts, execution summaries and bounded patches) persists in plaintext in the `conductor-data` volume; the Hub writes its state file with mode `0600`. Treat volume contents and backups as source-code-sensitive data, keep secrets out of task prompts, and protect backups accordingly. Stop gracefully with `docker compose ... down` (do not add `-v` unless intentionally deleting all task history).

## Execution model and safety

Task creation validates required fields, persists the request, then schedules queued work by creation time and task ID. Eligible live runners are ordered lexically by runner ID; capability constraints (`requirements.cli` and `requirements.model`) are checked explicitly. `RUNNER_MODELS` advertises an allowlist on each available profile; its default `*` delegates model-name validation to the selected native CLI. `RUNNER_CLAUDE_MODELS`, `RUNNER_CODEX_MODELS`, `RUNNER_OPENCODE_MODELS`, and `RUNNER_GATEWAY_MODELS` can override model allowlists per harness. Routing and runner-side harness choice both require the requested CLI/model pair to match that same advertised profile. The choice is deterministic for the same state. Runner leases are renewed by heartbeat; work held by a runner past the configured heartbeat expiry is re-queued on a subsequent scheduling pass. Each runner process also registers a fresh session ID, so its replacement immediately requeues work claimed by the prior process incarnation instead of renewing a stale lease forever. Heartbeats, claims, and results from an older session are rejected after replacement. During graceful shutdown a Runner marks itself draining, stops claiming new tasks, and continues heartbeating until its active tasks finish. Recovery is still at-least-once: an abruptly killed harness may have executed side effects before losing its lease.

Each execution gets a fresh temporary clone and HOME, a task-specific local branch, explicit API-key environment forwarding, a timeout, bounded output, and cleanup. After the agent exits successfully, the runner executes the repository's declared `npm test` when present, or `pytest -q` when a pytest configuration and executable are available. Set `RUNNER_TEST_COMMAND` to a JSON argv array for other project test runners. Test outcomes (`passed`, `failed`, `skipped`, or `not_run`), command, exit code, duration, and bounded output are persisted in the task manifest and shown in task detail. A detected test failure marks the task failed; a skipped test run is reported explicitly rather than represented as a pass. Runners do not push branches or open pull requests: the temporary clone is removed after reporting, while the Hub retains the summary and a bounded binary patch (up to 300 KB) for authenticated task detail and the dashboard. The branch name is local metadata, not a remote ref. Repository URLs must use HTTPS, resolve to public addresses, and may be restricted further with `RUNNER_ALLOWED_REPO_HOSTS`. Do not put credentials in repository URLs or task prompts. Optional `RUNNER_GIT_TOKEN` is scoped to the exact `RUNNER_GIT_HOST` and supplied only to the HTTPS `git clone` subprocess; it is not forwarded to the agent CLI or retained in the clone. The container does not mount the host filesystem, Docker socket, or host credentials; only the configured provider API keys are passed to the CLI. Treat task prompts and repository code as untrusted. The runner container has no added Linux capabilities, a read-only root, resource limits and no-new-privileges; for higher-assurance workloads, add network egress policy and run each task in a separate VM/container boundary.

Cancellation sets a terminal Hub state; active runners poll the task state and terminate the child process. Task completion/failure, scheduling and cancellation are durable and replayable from `GET /v1/events?last_event_id=...`. Faro's `/ask` reads live Hub task/runner data and reports those records; it does not invent execution outcomes. Task creation (`create task https://host/repo.git | <prompt>`) and cancellation (`cancel task task_<id>`) are parsed deterministically and require a signed, expiring confirmation token. Optional open-ended chat can use OmniRoute's OpenAI-compatible router by setting `OMNIROUTE_BASE_URL`, `OMNIROUTE_API_KEY`, and `FARO_MODEL`; the model receives a bounded Hub evidence snapshot and cannot perform actions. Without those settings Faro remains deterministic and evidence-based. The OmniRoute bridge can replay the SSE event cursor after restart.

The runner supports `claude`, `codex`, `opencode` and a configurable `gateway` adapter. A CLI is reported as a capability only when its executable is installed. Provider credentials, model availability, and native CLI behavior remain dependent on operator configuration. `gateway` is not represented as a fictitious built-in executable.

### OpenCode is the reference self-hosted harness

`RUNNER_CLIS` defaults to `opencode`. Two properties make it the harness this seam is standardized on:

- **It runs our models, not OpenCode's.** With `OMNIROUTE_BASE_URL` set, the Runner writes a per-task `$HOME/.config/opencode/opencode.json` whose only provider is `omniroute`, with `baseURL: <OMNIROUTE_BASE_URL>/v1` and the key referenced as `{env:OMNIROUTE_API_KEY}` — the credential is read from the process environment at run time and never written into the workspace, the patch, or the state volume. A repo-supplied `opencode.json` in the clone still wins, because OpenCode merges project config after the global one.
- **It cannot silently leave self-hosting.** A model pinned to a bare name (e.g. `gpt-5.5`) would be served by OpenCode's own hosted catalog, so the Runner refuses it and fails the task closed with an explicit error. Only `omniroute/<model>` (the prefix `omniroute setup-opencode` writes) is eligible by default. Set `RUNNER_OPENCODE_ALLOW_HOSTED_MODELS=true` to opt in deliberately.

Invocation is `opencode run "<prompt>" [--model <model>]` — the form documented in [`docs/reference/CLI-TOOLS.md`](../reference/CLI-TOOLS.md) and used by `omniroute setup-opencode`. `OPENCODE_MODEL` supplies the default `--model` when a task pins none, so an unpinned task still lands on your gateway.

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
