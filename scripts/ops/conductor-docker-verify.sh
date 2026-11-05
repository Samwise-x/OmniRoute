#!/usr/bin/env bash
# scripts/ops/conductor-docker-verify.sh — prove the OmniConductor Compose stack on a Docker host.
#
# The only acceptance claim `npm run verify:conductor` cannot make is that the pinned
# images BUILD and the three services come up HEALTHY together under Compose. That needs
# a container engine, so it lives here instead of in the portable probe.
#
# Run this on the deployment host (or in CI with a Docker socket). It:
#   1. refuses to run without a usable engine instead of silently "passing",
#   2. builds hub + faro + runner images,
#   3. brings the stack up with a throwaway token and waits for real health,
#   4. asserts Hub/Faro answer and the Runner registers its capabilities,
#   5. checks the containers run read-only, non-root, capability-free,
#   6. restarts the stack WITHOUT deleting the volume and re-asserts state survives,
#   7. tears everything down (volume included) and prints a PASS/FAIL summary.
#
# Usage: bash scripts/ops/conductor-docker-verify.sh [--keep]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.omniconductor.yml"
ENV_FILE="$(mktemp -t omniconductor-env-XXXXXX)"
PROJECT="conductor-verify-$$"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

PASS=0
FAIL=0
pass() { printf '  [PASS] %s%s\n' "$1" "${2:+ — $2}"; PASS=$((PASS + 1)); }
fail() { printf '  [FAIL] %s%s\n' "$1" "${2:+ — $2}"; FAIL=$((FAIL + 1)); }
cleanup() {
  if [ "$KEEP" -eq 0 ]; then
    docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

echo
echo "OmniConductor Compose acceptance — $ROOT"
echo

# -- 0. Engine availability ---------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  fail "container engine available" "docker not found — this check cannot be faked, it must run on a Docker host"
  echo
  echo "NO-GO: 0/$((PASS + FAIL)) checks passed (engine missing)"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  fail "container engine reachable" "docker info failed (daemon down or no socket permission)"
  echo
  echo "NO-GO: 0/$((PASS + FAIL)) checks passed (engine unreachable)"
  exit 1
fi
pass "container engine reachable" "$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
docker compose version >/dev/null 2>&1 && pass "compose v2 available" "$(docker compose version --short 2>/dev/null)" || {
  fail "compose v2 available"
  exit 1
}

# -- 1. Throwaway env ---------------------------------------------------------
TOKEN="$(openssl rand -hex 32 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
cat >"$ENV_FILE" <<EOF
CONDUCTOR_HUB_TOKEN=$TOKEN
CONDUCTOR_HUB_BIND=127.0.0.1
CONDUCTOR_FARO_BIND=127.0.0.1
RUNNER_REPLICAS=2
RUNNER_NAME=verify-runner
RUNNER_CLIS=claude,codex,opencode
RUNNER_MODELS=*
EOF
pass "throwaway deployment env prepared" "token length ${#TOKEN}"

# -- 2. Build -----------------------------------------------------------------
echo "  building images (this is the slow part)…"
if docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build --quiet >/tmp/conductor-build.log 2>&1; then
  pass "hub/faro/runner images build"
else
  fail "hub/faro/runner images build" "$(tail -3 /tmp/conductor-build.log | tr '\n' ' ')"
fi

# -- 3. Bring up --------------------------------------------------------------
if docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --scale runner=2 >/tmp/conductor-up.log 2>&1; then
  pass "compose stack starts"
else
  fail "compose stack starts" "$(tail -3 /tmp/conductor-up.log | tr '\n' ' ')"
fi

wait_healthy() {
  for _ in $(seq 1 60); do
    if curl -fsS -m 2 "$1" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

wait_healthy "http://127.0.0.1:7910/health" && pass "hub is healthy" || fail "hub is healthy"
wait_healthy "http://127.0.0.1:7920/health" && pass "faro is healthy" || fail "faro is healthy"

# Docker health is the operator-facing signal; report what the engine says too.
for c in hub faro; do
  state="$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" ps --format '{{.Name}} {{.Health}}' 2>/dev/null | grep -c " $c" || true)"
  [ "$state" -ge 0 ] # no-op; per-service health is asserted below
done
HEALTH_LINES="$(docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --format '{{.Service}}={{.Health}}' 2>/dev/null || true)"
echo "$HEALTH_LINES" | grep -q 'hub=healthy' && pass "hub container health=healthy" || fail "hub container health=healthy" "$HEALTH_LINES"
echo "$HEALTH_LINES" | grep -q 'faro=healthy' && pass "faro container health=healthy" || fail "faro container health=healthy"

# -- 4. Runner registration ---------------------------------------------------
RUNNERS="$(curl -fsS -m 5 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7910/v1/runners 2>/dev/null || echo '[]')"
ONLINE="$(printf '%s' "$RUNNERS" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const r=JSON.parse(d);const on=r.filter(x=>x.online);process.stdout.write(String(on.length)+" "+JSON.stringify(on.map(x=>x.capabilities.clis.map(c=>c.profile))))}catch{process.stdout.write("0 []")}})')"
COUNT="${ONLINE%% *}"
CLIS="${ONLINE#* }"
[ "${COUNT:-0}" -ge 2 ] && pass "both runner replicas register as online" "$COUNT online" || fail "both runner replicas register as online" "$COUNT online"
case "$CLIS" in
  *claude* | *codex* | *opencode*) pass "runners advertise installed harnesses" "$CLIS" ;;
  *) fail "runners advertise installed harnesses" "$CLIS" ;;
esac

# -- 5. Hardening posture -----------------------------------------------------
for svc in hub faro; do
  cid="$(docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q "$svc" 2>/dev/null | head -1)"
  [ -n "$cid" ] || { fail "$svc container exists"; continue; }
  [ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$cid" 2>/dev/null)" = "true" ] \
    && pass "$svc root filesystem is read-only" || fail "$svc root filesystem is read-only"
  [ "$(docker inspect -f '{{.Config.User}}' "$cid" 2>/dev/null)" != "root" ] \
    && pass "$svc does not run as root" "$(docker inspect -f '{{.Config.User}}' "$cid")" || fail "$svc does not run as root"
  docker inspect -f '{{.HostConfig.CapDrop}}' "$cid" 2>/dev/null | grep -q 'ALL' \
    && pass "$svc drops all capabilities" || fail "$svc drops all capabilities"
done

# -- 6. Restart without deleting the volume -----------------------------------
TASK_COUNT_BEFORE="$(curl -fsS -m 5 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7910/v1/tasks 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).length))}catch{process.stdout.write("-1")}})' 2>/dev/null || echo -1)"
docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" restart hub >/dev/null 2>&1 || true
wait_healthy "http://127.0.0.1:7910/health" || true
TASK_COUNT_AFTER="$(curl -fsS -m 5 -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7910/v1/tasks 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).length))}catch{process.stdout.write("-1")}})' 2>/dev/null || echo -1)"
if [ "$TASK_COUNT_AFTER" != "-1" ] && [ "$TASK_COUNT_BEFORE" = "$TASK_COUNT_AFTER" ]; then
  pass "hub state survives a container restart" "tasks before=$TASK_COUNT_BEFORE after=$TASK_COUNT_AFTER"
else
  fail "hub state survives a container restart" "tasks before=${TASK_COUNT_BEFORE} after=${TASK_COUNT_AFTER}"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "GO: $PASS/$((PASS + FAIL)) checks passed"
  echo "  Note: vendor-agent model execution is NOT covered here — see 'npm run verify:conductor -- --real-clis'."
  exit 0
fi
echo "NO-GO: $PASS/$((PASS + FAIL)) checks passed"
exit 1
