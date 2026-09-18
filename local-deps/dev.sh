#!/usr/bin/env bash
# ./dev.sh up <service...>
# ./dev.sh up-all
# ./dev.sh down
#
# up: Brings up everything the named service(s) depend on -- containerized,
# via docker compose / their own run-<svc>.sh -- but does NOT run the named
# service(s) themselves. You run those yourself, in your IDE, against the
# now-running deps. This prints the exact IDE run config (profiles, VM
# options) each named service needs.
#
# up-all: Full-stack smoke test -- 3rd-party deps + every java/ui service in
# services.yaml, ALL containerized at their default_image. Nothing to run
# locally. Use this to test the whole app together instead of one service
# against the rest.
#
# down: Tears down everything `up`/`up-all` could have started -- every
# container any run-<svc>.sh creates (named icedq-<svc>-smoke, found by name
# pattern, NOT by reading services.yaml, since that manifest can lag behind
# newly-onboarded services) AND the docker-compose.yml stack (postgres/
# rabbitmq/vault/temporal/replicated/keycloak), including its volumes.
#
# Why this works with no per-pair network wiring: every compose service
# already publishes its port to the host, so your IDE-run process reaches
# every dependency at localhost:<port> exactly like a container would --
# see services.yaml's header comment.
set -euo pipefail

# This file is meant to be copied/symlinked into other repos (e.g. a service
# repo, for running `./dev.sh up <other-services>` alongside it) -- so
# everything it needs (services.yaml, docker-compose.yml, run-*.sh) is
# resolved against icedq-smoke/local-deps specifically, NOT against wherever
# this copy of dev.sh itself happens to live. Override via env var if your
# icedq-smoke checkout is elsewhere.
SCRIPT_DIR="${ICEDQ_LOCAL_DEPS_DIR:-/home/ashishdaga/sandbox/icedq-smoke/local-deps}"
if [ ! -f "$SCRIPT_DIR/services.yaml" ]; then
  echo "[dev] services.yaml not found at $SCRIPT_DIR -- set ICEDQ_LOCAL_DEPS_DIR to your icedq-smoke/local-deps path." >&2
  exit 1
fi
MANIFEST="$SCRIPT_DIR/services.yaml"
THIRD_PARTY="postgres rabbitmq vault keycloak temporal replicated"

usage() {
  local names
  names=$(python3 -c "import yaml; print(' '.join(yaml.safe_load(open('$MANIFEST'))['services'].keys()))")
  echo "Usage: $0 up <service...>   (services: $names)" >&2
  echo "       $0 up-all" >&2
  echo "       $0 down              (remove icedq-*-smoke containers + compose down -v)" >&2
  exit 1
}

get() {
  # get <service> <dotted.path> -> value, or empty if missing
  python3 - "$MANIFEST" "$1" "$2" <<'PYEOF'
import yaml, sys
y = yaml.safe_load(open(sys.argv[1]))
svc, path = sys.argv[2], sys.argv[3]
d = y["services"].get(svc, {})
for k in path.split('.'):
    if not isinstance(d, dict):
        d = ''
        break
    d = d.get(k, '')
print(d if d is not None else '')
PYEOF
}

transitive_deps() {
  # All services reachable via depends_on from the given names, INCLUDING
  # the named services themselves (caller filters those back out).
  python3 - "$MANIFEST" "$@" <<'PYEOF'
import yaml, sys
y = yaml.safe_load(open(sys.argv[1]))
svcs = y["services"]
seen = []
def visit(name):
    if name in seen:
        return
    for dep in svcs.get(name, {}).get("depends_on", []) or []:
        visit(dep)
    seen.append(name)
for name in sys.argv[2:]:
    visit(name)
print(" ".join(seen))
PYEOF
}

run_containerized() {
  local svc="$1" profile script image
  profile=$(get "$svc" compose_profile)
  script=$(get "$svc" docker_run_script)
  if [ -n "$script" ]; then
    image=$(get "$svc" default_image)
    echo "[dev] $svc: $script (containerized)..."
    bash "$SCRIPT_DIR/$script" "$svc" "$image"
  elif [ -n "$profile" ]; then
    (cd "$SCRIPT_DIR" && docker compose --profile "$profile" up -d "$svc")
  else
    (cd "$SCRIPT_DIR" && docker compose up -d "$svc")
  fi
}

print_ide_instructions() {
  local svc="$1" port main_class profiles ide_profile
  port=$(get "$svc" port)
  main_class=$(get "$svc" local.main_class)
  profiles=$(get "$svc" local.spring_profiles)
  ide_profile=$(get "$svc" local.ide_profile)

  echo ""
  echo "=== Run '$svc' yourself now, in your IDE ==="
  if [ -z "$main_class" ]; then
    echo "  (no local: block for '$svc' in services.yaml yet -- add one:"
    echo "   main_class, spring_profiles, ide_profile. See admin's/connection's"
    echo "   entries as a template, and application-local-connection-ide.yaml"
    echo "   as a template profile file.)"
    return
  fi
  echo "  Main class:      $main_class"
  echo "  Active profiles: $profiles"
  if [ -n "$ide_profile" ]; then
    echo "  VM options:      -Dspring.config.additional-location=file:$SCRIPT_DIR/$ide_profile"
  fi
  if [ "$(get "$svc" local.vault_init)" = "True" ] || [ "$(get "$svc" local.vault_init)" = "true" ]; then
    echo "  (vault bootstrap file regenerated into your OS temp dir --"
    echo "   application-local.yaml reads it via \${java.io.tmpdir}, no VM option needed)"
  fi
  local extra
  extra=$(get "$svc" local.extra_system_props | python3 -c "
import sys, ast
try:
    d = ast.literal_eval(sys.stdin.read())
    for k, v in (d or {}).items(): print(f'                   -D{k}={v}')
except Exception:
    pass
" | sed "s#{SCRIPT_DIR}#$SCRIPT_DIR#g")
  [ -n "$extra" ] && echo "$extra"
  echo "  It will listen on :$port and reach every dep below at localhost:<port>."
}

generate_vault_init_json() {
  # Stand-in for what the real vault-manager sidecar produces after
  # initializing/unsealing a REAL Vault: init-vault.json with the root
  # token. Our dev vault auto-initializes with a fixed, already-known
  # token (VAULT_DEV_ROOT_TOKEN_ID in docker-compose.yml) -- no real
  # init/unseal step happens, so nothing else generates this file for us.
  # Reads the token from docker-compose.yml itself (single source of
  # truth) rather than duplicating it here.
  local token
  token=$(grep -oP 'VAULT_DEV_ROOT_TOKEN_ID:\s*\K\S+' "$SCRIPT_DIR/docker-compose.yml" | head -1)

  # Written to a plain /tmp-style location on BOTH sides, independent of any
  # repo checkout -- your IDE (WSL or native Windows) can be pointed at
  # whichever one it can actually see, no dependency on a second icedq-smoke
  # clone being present or in sync.
  mkdir -p /tmp/icedq-dev-generated
  printf '{\n  "rootToken": "%s"\n}\n' "$token" > /tmp/icedq-dev-generated/init-vault.json

  if [ -d /mnt/c/Users ]; then
    # Real Windows %TEMP% (C:\Users\<you>\AppData\Local\Temp), not a made-up
    # path -- found by locating the one real profile dir under C:\Users
    # (excluding the fixed system entries every Windows install has).
    local win_user win_temp
    win_user=$(ls /mnt/c/Users | grep -vxE 'Public|Default|Default User|All Users|desktop\.ini' | head -1)
    if [ -n "$win_user" ]; then
      win_temp="/mnt/c/Users/$win_user/AppData/Local/Temp/icedq-dev-generated"
      mkdir -p "$win_temp" 2>/dev/null && \
        printf '{\n  "rootToken": "%s"\n}\n' "$token" > "$win_temp/init-vault.json"
      WIN_TEMP_DISPLAY="C:\\Users\\$win_user\\AppData\\Local\\Temp\\icedq-dev-generated"
    fi
  fi
}

cmd_up() {
  [ $# -eq 0 ] && usage
  local requested=("$@")
  local all_deps
  all_deps=$(transitive_deps "${requested[@]}")

  echo "[dev] bringing up base deps (postgres/rabbitmq/vault/keycloak/temporal/replicated)..."
  (cd "$SCRIPT_DIR" && docker compose --profile oidc up -d $THIRD_PARTY vault-init)

  if echo "$all_deps" | grep -qw vault; then
    generate_vault_init_json
  fi

  for svc in $all_deps; do
    local is_requested=0
    for r in "${requested[@]}"; do [ "$r" = "$svc" ] && is_requested=1; done
    if [ "$is_requested" = "1" ]; then
      continue  # you run this one yourself
    fi
    case " $THIRD_PARTY " in
      *" $svc "*) continue ;;  # already up above
    esac
    run_containerized "$svc"
  done

  for svc in "${requested[@]}"; do
    print_ide_instructions "$svc"
  done
}

cmd_down() {
  echo "[dev] removing app containers (icedq-*-smoke)..."
  local removed=0
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    echo "[dev]   docker rm -f $name"
    docker rm -f "$name" >/dev/null
    removed=$((removed + 1))
  done < <(docker ps -a --format '{{.Names}}' | grep -E '^icedq-.*-smoke$' || true)
  if [ "$removed" -eq 0 ]; then
    echo "[dev]   (none found)"
  fi

  # --profile oidc: keycloak is profile-gated (opt-in cost) -- without this,
  # `docker compose down` skips it entirely and leaves it running.
  echo "[dev] stopping compose stack (including oidc profile) and removing volumes..."
  (cd "$SCRIPT_DIR" && docker compose --profile oidc down -v)
  echo "[dev] down complete"
}

cmd_up_all() {
  # Full-stack smoke test: 3rd-party + every java/ui service, all
  # containerized at their default_image (latest onboarded tag) -- no IDE
  # step, nothing to run locally. For testing the whole app together
  # rather than one service against the rest.
  echo "[dev] bringing up base deps (postgres/rabbitmq/vault/keycloak/temporal/replicated)..."
  (cd "$SCRIPT_DIR" && docker compose --profile oidc up -d $THIRD_PARTY vault-init)

  # Topological order (via transitive_deps, fed every service), not raw
  # dict-key order -- e.g. connection depends on workflow's liquibase
  # schema, so it must come up after workflow, not just after 3rd-party.
  local all_service_names all_services
  all_service_names=$(python3 -c "import yaml; print(' '.join(yaml.safe_load(open('$MANIFEST'))['services'].keys()))")
  all_services=$(transitive_deps $all_service_names)
  for svc in $all_services; do
    case " $THIRD_PARTY " in
      *" $svc "*) continue ;;  # already up above
    esac
    run_containerized "$svc"
  done
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  up-all) shift; cmd_up_all "$@" ;;
  down) shift; cmd_down "$@" ;;
  *) usage ;;
esac
