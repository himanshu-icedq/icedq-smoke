#!/usr/bin/env bash
# Generic replacement for the 14 near-identical run-<svc>.sh scripts this
# repo used to have -- one script, driven entirely by the `container:`
# block services.yaml carries for each app service (see services.yaml's
# header comment for the schema). Runs a service's image against the
# already-running compose stack and polls its health until it's actually
# up, not just "container exists".
#
# Usage:
#   ./run-service.sh <service-name> [image:tag]
#   (image defaults to services.yaml's default_image if omitted -- needed
#   for api-gateway, which always runs a fixed nginx:1.27-alpine.)

set -euo pipefail

SVC="${1:?usage: $0 <service-name> [image:tag]}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$SCRIPT_DIR/services.yaml"
NETWORK_NAME="icedq-smoke-deps_default"
NAME="icedq-${SVC}-smoke"

cfg() {
  # cfg <dotted.path> -> value (python-repr'd for scalars, JSON for
  # lists/dicts), or empty if missing/null.
  python3 - "$MANIFEST" "$SVC" "$1" <<'PYEOF'
import yaml, json, sys
y = yaml.safe_load(open(sys.argv[1]))
svc, path = sys.argv[2], sys.argv[3]
d = y["services"].get(svc, {})
for k in path.split('.'):
    if not isinstance(d, dict):
        d = None
        break
    d = d.get(k)
if d is None:
    print('')
elif isinstance(d, (dict, list)):
    print(json.dumps(d))
else:
    print(d)
PYEOF
}

PORT=$(cfg port)
TYPE=$(cfg container.type)
if [ -z "$TYPE" ]; then
  echo "[run-service] $SVC has no container.type in services.yaml -- can't run generically." >&2
  exit 1
fi
IMAGE="${2:-$(cfg default_image)}"
if [ -z "$IMAGE" ]; then
  echo "[run-service] $SVC has no default_image in services.yaml and none was passed -- usage: $0 $SVC <image:tag>" >&2
  exit 1
fi
NETWORK_MODE=$(cfg container.network)
SPRING_PROFILES=$(cfg container.spring_profiles)
CONFIG_FILE=$(cfg container.config_file)

docker rm -f "$NAME" >/dev/null 2>&1 || true

DOCKER_ARGS=(-d --name "$NAME")
if [ "$NETWORK_MODE" = "host" ]; then
  DOCKER_ARGS+=(--network host)
else
  DOCKER_ARGS+=(--network "$NETWORK_NAME")
  case "$TYPE" in
    frontend) DOCKER_ARGS+=(-p "$PORT:8080") ;;
    *)        DOCKER_ARGS+=(-p "$PORT:$PORT") ;;
  esac
fi

# tmpfs mounts (java_* types only, some services need writable log dirs the
# image itself can't write to as a non-root user)
while IFS= read -r spec; do
  [ -n "$spec" ] && DOCKER_ARGS+=(--tmpfs "$spec")
done < <(cfg container.tmpfs | python3 -c "import json,sys; d=sys.stdin.read().strip(); print('\n'.join(json.loads(d)) if d else '')")

# extra_mounts: [{host, container}] -- host resolved relative to SCRIPT_DIR
# unless already absolute
while IFS=$'\t' read -r host_path container_path; do
  [ -z "$host_path" ] && continue
  case "$host_path" in
    /*) resolved="$host_path" ;;
    *)  resolved="$SCRIPT_DIR/$host_path" ;;
  esac
  DOCKER_ARGS+=(-v "$resolved:$container_path:ro")
done < <(cfg container.extra_mounts | python3 -c "
import json,sys
d=sys.stdin.read().strip()
for m in (json.loads(d) if d else []):
    print(f\"{m['host']}\t{m['container']}\")
")

# config_file mount + activation env var, per type
case "$TYPE" in
  java_extra_classpath)
    DOCKER_ARGS+=(-v "$SCRIPT_DIR/$CONFIG_FILE:/app/extra-config/$CONFIG_FILE:ro")
    DOCKER_ARGS+=(-e "EXTRA_CLASSPATH=/app/extra-config")
    DOCKER_ARGS+=(-e "SPRING_PROFILES_ACTIVE=$SPRING_PROFILES")
    DOCKER_ARGS+=(-e "SERVER_SSL_ENABLE=false" -e "OTEL_JAVAAGENT_ENABLED=false")
    ;;
  java_spring_config_location)
    DOCKER_ARGS+=(-v "$SCRIPT_DIR/$CONFIG_FILE:/app/extra-config/$CONFIG_FILE:ro")
    DOCKER_ARGS+=(-e "SPRING_CONFIG_ADDITIONAL_LOCATION=file:/app/extra-config/$CONFIG_FILE")
    DOCKER_ARGS+=(-e "SPRING_PROFILES_ACTIVE=$SPRING_PROFILES")
    DOCKER_ARGS+=(-e "SERVER_SSL_ENABLE=false" -e "OTEL_JAVAAGENT_ENABLED=false")
    ;;
  java_baked_profile)
    DOCKER_ARGS+=(-e "SPRING_PROFILES_ACTIVE=$SPRING_PROFILES")
    DOCKER_ARGS+=(-e "SERVER_SSL_ENABLE=false" -e "OTEL_JAVAAGENT_ENABLED=false")
    ;;
  gateway)
    DOCKER_ARGS+=(-v "$SCRIPT_DIR/$CONFIG_FILE:/etc/nginx/conf.d/default.conf:ro")
    ;;
  frontend)
    # Fixed golden-image-nginx env var list (ui-platform/ruleui share this
    # verbatim -- both apps are one bundle, split across two browser ports
    # since there's no single local ingress). See run-ui-platform.sh's old
    # header comment (git history) for the full rationale if this needs
    # revisiting.
    DOCKER_ARGS+=(
      -e "OTEL_ENABLED=false" -e "OTEL_ENABLED_NGINX=false" -e "SSL_ENABLED_NGINX=false"
      -e "NGINX_LOG_DIR=/tmp/logs"
      -e "HTTP_API_URL=http://localhost:9080" -e "HTTPS_API_URL=http://localhost:9080"
      -e "ADMIN_URL=http://localhost:8090" -e "API_VERSION=api/v1"
      -e "CLIENT_ID=icedq.admin-ui" -e "CLIENT_SECRET=iam.icedq"
      -e "KEYCLOAK_URL=http://localhost:8081/auth"
      -e "CONNECTION_URL=http://localhost:8090/connection-ui"
      -e "WORKFLOW_URL=http://localhost:8091/orchestration-ui"
      -e "SCHEDULER_URL=http://localhost:8090/schedule-ui"
      -e "DASHBOARD_URL=http://localhost:8090/dashboard-ui"
      -e "DATASET_URL=http://localhost:8091/rule-ui"
      -e "RULEREPO_URL=http://localhost:8091/rule-ui"
      -e "RULEGEN_URL=http://localhost:8091/rulegen-ui"
      -e "BIRULE_URL=http://localhost:8091/birule-ui"
      -e "BI_WORKFLOW_URL=http://localhost:8091/bi-orchestration-ui"
      -e "MONITORING_URL=http://localhost:8091/monitoring-ui"
      -e "MONITORING_WORKFLOW_URL=http://localhost:8091/monitoring-orchestration-ui"
      -e "DATACATALOG_URL=http://localhost:1" -e "INCIDENT_URL=http://localhost:1"
      -e "DMO_URL=http://localhost:1" -e "KNOWLEDGEGRAPH_URL=http://localhost:1"
      -e "APP_VERSION=local" -e "BUILD_NUMBER=local" -e "BUILD_DATE=local"
      -e "COPYRIGHT_CONTENT=Copyright (c) ICEDQ"
    )
    ;;
  *)
    echo "[run-service] $SVC: unknown container.type '$TYPE'" >&2
    exit 1
    ;;
esac

# extra_env: {VAR: value} -- applied last so it can override type baselines
# (e.g. admin's ICEDQ_PROPERTIES_LOCATION, auditengine's LOGGER_PATH)
while IFS=$'\t' read -r k v; do
  [ -z "$k" ] && continue
  DOCKER_ARGS+=(-e "$k=$v")
done < <(cfg container.extra_env | python3 -c "
import json,sys
d=sys.stdin.read().strip()
for k,v in (json.loads(d) if d else {}).items():
    print(f'{k}\t{v}')
")

echo "[run-service] $SVC: starting $IMAGE (--network ${NETWORK_MODE:-bridge})..."
docker run "${DOCKER_ARGS[@]}" "$IMAGE"

HEALTH_TYPE=$(cfg container.health.type)
echo "[run-service] $SVC: waiting for health ($HEALTH_TYPE)..."
n=0
until [ "$n" -ge 60 ]; do
  case "$HEALTH_TYPE" in
    actuator_db|actuator_status)
      health=$(curl -sk --max-time 3 "http://localhost:$PORT/actuator/health" 2>/dev/null || echo '{}')
      if [ "$HEALTH_TYPE" = "actuator_db" ]; then
        result=$(echo "$health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('components',{}).get('db',{}).get('status','?'))" 2>/dev/null || echo '?')
      else
        result=$(echo "$health" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null || echo '?')
      fi
      if [ "$result" = "UP" ]; then
        echo "[run-service] PASS — $SVC is alive. Full health:"
        echo "$health" | python3 -m json.tool 2>/dev/null || echo "$health"
        exit 0
      fi
      ;;
    http_get)
      path=$(cfg container.health.path)
      code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:$PORT${path}" 2>/dev/null || echo 000)
      if [ "$code" = "200" ]; then
        echo "[run-service] PASS — $SVC serving on http://localhost:$PORT${path} (HTTP $code)"
        exit 0
      fi
      ;;
    http_probe)
      path=$(cfg container.health.path)
      method=$(cfg container.health.method)
      body=$(cfg container.health.body)
      codes=$(cfg container.health.codes)
      code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:$PORT${path}" -X "$method" -H 'Content-Type: application/json' -d "$body" 2>/dev/null || echo 000)
      if echo "$codes" | python3 -c "import json,sys; sys.exit(0 if int('$code') in json.load(sys.stdin) else 1)" 2>/dev/null; then
        echo "[run-service] PASS — $SVC routing on http://localhost:$PORT${path} (HTTP $code)"
        exit 0
      fi
      ;;
  esac
  if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
    echo "[run-service] $SVC container exited. Logs:" >&2
    docker logs "$NAME" 2>&1 | tail -60 >&2
    exit 1
  fi
  sleep 2
  n=$((n+1))
done

echo "[run-service] $SVC timed out waiting for health. Last logs:" >&2
docker logs "$NAME" 2>&1 | tail -60 >&2
exit 1
