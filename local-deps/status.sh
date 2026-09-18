#!/usr/bin/env bash
# "kubectl get pods" equivalent for this compose stack — one command, real
# health, not just "container exists". Checks both the shared deps
# (postgres/rabbitmq/vault/temporal/keycloak, via `docker compose ps` so it's
# scoped to THIS stack — no collisions with unrelated containers on the
# same host) and any app services started via run-<service>.sh. App service
# names/ports are discovered from run-*.sh itself, not duplicated here.
#
# Usage: ./status.sh

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

printf "%-24s %-10s %-8s %s\n" "NAME" "STATE" "PORT" "HEALTH"
printf "%-24s %-10s %-8s %s\n" "----" "-----" "----" "------"

health_of() {
  local url="$1" jq_expr="$2"
  local resp
  resp=$(curl -sk --max-time 2 "$url" 2>/dev/null)
  [ -z "$resp" ] && { echo "unreachable"; return; }
  echo "$resp" | python3 -c "import json,sys
try:
    d=json.load(sys.stdin)
    print($jq_expr)
except Exception:
    print('bad-response')" 2>/dev/null || echo "bad-response"
}

# Host-side published port for a compose service (container port -> host port).
# docker-compose.yml remaps some services (postgres 15432:5432, keycloak
# 8081:8080) — always use the published port for localhost health checks.
host_port_of() {
  local name="$1" container_port="$2"
  docker port "$name" "${container_port}/tcp" 2>/dev/null | head -1 | grep -oP '(?<=:)\d+$'
}

keycloak_health() {
  local port="$1"
  local code
  # IceDQ keycloak uses KC_HTTP_RELATIVE_PATH=/auth; vanilla /health/ready
  # does not exist on this image. Realm endpoint is a reliable liveness probe.
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 2 "http://localhost:${port}/auth/realms/iam.icedq" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then
    echo "UP"
  elif [ "$code" = "000" ]; then
    echo "unreachable"
  else
    echo "http $code"
  fi
}

docker_health_of() {
  local name="$1"
  local st
  st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$name" 2>/dev/null)
  case "$st" in
    healthy) echo "healthy" ;;
    unhealthy) echo "unhealthy" ;;
    starting) echo "starting" ;;
    no-healthcheck) echo "up (no health endpoint checked)" ;;
    *) echo "$st" ;;
  esac
}

gateway_health() {
  local port="$1"
  local code
  # nginx has no / route — probe a path that must reach admin upstream.
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 2 \
    -X POST "http://localhost:${port}/api/v1/accounts/search" \
    -H 'Content-Type: application/json' -d '{}' 2>/dev/null || echo 000)
  case "$code" in
    200|401|403) echo "UP (routing ok)" ;;
    000) echo "unreachable" ;;
    *) echo "http $code" ;;
  esac
}

java_health() {
  local port="$1" no_db="${2:-0}"
  local resp overall db down_parts
  resp=$(curl -sk --max-time 2 "http://localhost:${port}/actuator/health" 2>/dev/null)
  [ -z "$resp" ] && { echo "unreachable"; return; }
  overall=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo "?")
  if [ "$no_db" = "1" ]; then
    [ "$overall" = "UP" ] && echo "UP" || echo "$overall"
    return
  fi
  db=$(echo "$resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('components',{}).get('db',{}).get('status','?'))" 2>/dev/null || echo "?")
  if [ "$db" = "?" ] && [ "$overall" = "UP" ]; then
    echo "UP"
  elif [ "$db" = "UP" ] && [ "$overall" = "UP" ]; then
    echo "UP"
  elif [ "$db" = "UP" ] && [ "$overall" != "UP" ]; then
    down_parts=$(echo "$resp" | python3 -c "
import json,sys
d=json.load(sys.stdin)
down=[k for k,v in (d.get('components') or {}).items() if isinstance(v,dict) and v.get('status')=='DOWN']
print(','.join(down) if down else 'other')
" 2>/dev/null || echo "other")
    echo "db:UP (actuator ${overall}: ${down_parts})"
  else
    echo "$overall (db:${db})"
  fi
}

# --- shared deps: docker compose ps, scoped to this project's compose file ---
while IFS=$'\t' read -r name service state; do
  [ -z "$name" ] && continue
  health="-"
  port="-"
  if [ "$state" = "running" ]; then
    case "$service" in
      postgres)
        port=$(host_port_of "$name" 5432)
        health=$(docker_health_of "$name")
        ;;
      rabbitmq)
        port=$(host_port_of "$name" 5672)
        health=$(docker_health_of "$name")
        ;;
      vault)
        port=$(host_port_of "$name" 8200)
        health=$(health_of "http://localhost:${port}/v1/sys/health" "'sealed=' + str(d.get('sealed'))")
        ;;
      keycloak)
        port=$(host_port_of "$name" 8080)
        health=$(keycloak_health "$port")
        ;;
      temporal)
        port=$(host_port_of "$name" 7233)
        health=$(docker_health_of "$name")
        ;;
      replicated)
        port=$(host_port_of "$name" 3000)
        code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 2 "http://localhost:${port}/api/v1/license/info" 2>/dev/null || echo 000)
        if [ "$code" = "200" ]; then health="UP"; elif [ "$code" = "000" ]; then health="unreachable"; else health="http $code"; fi
        ;;
      vault-init) port="-" ;;
    esac
    if [ "$health" = "-" ] && [ "$port" != "-" ] && [ "$port" != "?" ]; then
      health="up (no health endpoint checked)"
    fi
  elif [ "$service" = "vault-init" ] && [ "$state" = "exited" ]; then
    exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$name" 2>/dev/null || echo "?")
    health=$([ "$exit_code" = "0" ] && echo "done" || echo "failed ($exit_code)")
  fi
  printf "%-24s %-10s %-8s %s\n" "$name" "$state" "$port" "$health"
done < <(docker compose ps -a --format '{{.Name}}\t{{.Service}}\t{{.State}}' 2>/dev/null)

echo ""

# --- app services: discover container NAME from run-<service>.sh's naming
# convention (icedq-<svc>-smoke), then get the real published host port from
# the running container itself via `docker port` — not by parsing the script
# text, since the host port can be a shell variable there (e.g.
# ui-platform's -p "$PORT:8080"), not a literal. Java services expose
# actuator/health; frontends (nginx-based) don't, so detect which check
# applies by grepping the run script for "actuator/health". ---
app_row() {
  local name="$1" svc="$2" has_actuator="$3" no_db="$4"
  local state
  state=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null)
  if [ -z "$state" ]; then
    printf "%-24s %-10s %-8s %s\n" "$name" "absent" "-" "-"
    return
  fi
  local port="-" health="-"
  if [ "$state" = "running" ]; then
    port=$(docker port "$name" 2>/dev/null | head -1 | grep -oP '(?<=:)\d+$')
    [ -z "$port" ] && port="?"
    if [ "$svc" = "api-gateway" ]; then
      health=$(gateway_health "$port")
    elif [ "$has_actuator" = "1" ]; then
      health=$(java_health "$port" "$no_db")
    elif [ "$svc" = "ruleui" ]; then
      code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 2 "http://localhost:$port/rule-ui/" 2>/dev/null || echo 000)
      health="http $code"
    else
      code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 2 "http://localhost:$port/" 2>/dev/null || echo 000)
      health="http $code"
    fi
  fi
  printf "%-24s %-10s %-8s %s\n" "$name" "$state" "$port" "$health"
}

for run_script in "$SCRIPT_DIR"/run-*.sh; do
  [ -e "$run_script" ] || continue
  svc=$(basename "$run_script" .sh | sed 's/^run-//')
  has_actuator=0
  no_db=0
  grep -q "actuator/health" "$run_script" && has_actuator=1
  grep -qiE 'no-database|no db component|no spring\.datasource' "$run_script" && no_db=1
  app_row "icedq-${svc}-smoke" "$svc" "$has_actuator" "$no_db"
done

echo ""
echo "HEALTH column:"
echo "  Java services with DB — db UP + which actuator components are DOWN (mail is expected locally);"
echo "  Java services without DB (auditengine, scriptengine) — actuator overall status only;"
echo "  api-gateway — POST /api/v1/accounts/search (401/403 = routing OK; GET / returns 404);"
echo "  frontends — HTTP status of / (or /rule-ui/ for ruleui)."
echo "Full breakdown: curl -s http://localhost:<port>/actuator/health | python3 -m json.tool"
