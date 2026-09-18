# icedq-smoke/local-deps

Smoke-test a freshly built iCEDQ Java service image — boot it against real
dependencies and prove it actually comes up — on a laptop, in about a minute,
with one command to bring up deps and one to run the image. No Kong, no UI,
no k8s, no Helm chart at all.

## Services covered so far

| Service | Script | Port | Status |
|---|---|---|---|
| admin-service | `run-admin.sh` | 9100 | working |
| connection-repo-service | `run-connection.sh` | 9200 | working |
| workflow | `run-workflow.sh` | 9300 | working |
| ui-platform (admin-ui frontend) | `run-ui-platform.sh` | 8090 | working |

## Checking what's up (`kubectl get pods` equivalent)

```bash
./status.sh
```

Shows every shared dep (postgres/rabbitmq/vault/temporal/keycloak, scoped to
this stack via `docker compose ps` — no false matches against unrelated
containers on the host) and every app service (`icedq-<name>-smoke`), each
with real state (running/exited/absent) and real health (actuator's
`db.status` for app services, `sealed` for vault) — not just "container
exists".

To onboard another one (auditengine, datawarehouse, scheduler,
notification-service, ...): see the `icedq-onboard-service` skill
(`.claude/skills/icedq-onboard-service/SKILL.md`, repo root) or run
`./onboard-service.sh <name> <port>` to scaffold the two files it needs.

This exists because doing the equivalent in the real k8s/Helm setup (see
`ng-icedq-helm-charts/scripts/`) is correct but slow and heavy: a kind
cluster, Helm chart dependency fetching, ~15 pods, and — worst of all — a
real race condition in admin's own vault-manager bootstrap that can crash-loop
the pod indefinitely on a cluster with any prior state. This stack sidesteps
all of that structurally, not by working around it.

## Quick start

```bash
docker compose up -d              # ~11s: postgres, rabbitmq, vault, temporal
./run-admin.sh <image:tag>         # ~27-30s: Spring Boot cold start, then a real health check
# total: ~40s, empirically measured (n=3, stdev 1.4s)
```

Example:
```bash
./run-admin.sh icedqngdev.azurecr.io/admin-service:7.2.308-SNAPSHOT-DSO-2224
```

That's it — no manual steps. `docker compose up -d` includes a one-shot
`vault-init` job that sets up everything vault-side automatically.

## Why it's fast

- **postgres/rabbitmq**: alpine images, fsync/durability off, tmpfs data dirs.
  Safe because this stack is thrown away after every run — nothing here
  needs to survive a restart.
- **keycloak**: not started by default. Empirically confirmed admin-service
  doesn't need a live keycloak to boot — `icedq.security.oidc.base-url` is
  validated lazily, per-request, same as the other `icedq.outbound-service.*`
  URLs. It was the single biggest bottleneck in this stack (~35s of a 73s
  total, 48%). Bring it up only if a test specifically needs real OIDC/JWT
  validation: `docker compose --profile oidc up -d`.
- **vault**: `-dev` mode — auto-initializes and auto-unseals with a fixed
  root token on boot. **This is the single biggest win.** admin's own
  vault-manager bootstrap logic has a real bug: it decides whether to
  init-or-unseal by reading a stale flag, not vault's live state, and that
  race ate most of a day in the k8s setup. Dev mode has no check-then-act
  window at all — there's nothing to race. Confirmed healthy in ~6s, every
  time.
- **temporal**: official `auto-setup` image — bundles frontend, history,
  matching, and worker into one container, runs its own schema setup on
  first boot (idempotent — a few seconds on reruns against the same
  postgres).
- **admin itself**: runs as a single plain `docker run`, no init container
  step at all. In k8s, a separate "vault-manager" container (the *same*
  image, different entrypoint class) does AppRole/transit-engine/KEK
  bootstrapping before admin starts. Here, Spring Cloud Vault talks to dev
  vault with **TOKEN auth** (root token) instead of AppRole — dev vault has
  no AppRole to bootstrap in the first place, and none is needed for a boot
  smoke test.

## How admin gets its config

`application-local-compose.yaml` is a **real Spring profile file** — derived
from `ng-icedq-admin-service/profiles/application-dev-smi.yaml` (an existing
local-dev profile already in the app's own source repo), with hostnames
swapped to this compose stack's service names. It's mounted into the
container and added to the classpath via `EXTRA_CLASSPATH` — a mechanism the
image's own `entrypoint.sh` already supports — then activated as the last
Spring profile (`qa,smi,smi-hcp,local-compose`) so it overrides the earlier
profiles' defaults.

This is deliberately *not* dozens of individual `-e` env var overrides.
Early iterations tried that and it turned into slow, error-prone guessing at
property names (Spring relaxed-binding rules, nested config classes, a
secret-manager library that ships its own bundled defaults inside its jar
under the `smi-hcp` profile). Reusing a real, working profile file wholesale
sidesteps all of that — it can't drift from what the app actually expects
because it *is* what the app actually expects, just re-pointed.

Vault base paths (`icedq-secretvault`, `icedq-encryption`/`icedq-kek`) match
the real defaults baked into `secret-manager-integration-*.jar`'s
`application-smi-hcp.yaml` — extracted directly from the image
(`docker create` + `docker cp`) to confirm the real property names and
values rather than guessing.

The same pattern extends cleanly to other services (`run-connection.sh`,
`run-workflow.sh`) — each has its own real `application-dev*.yaml` in its
source repo's `src/main/resources/`, derived the same way. Full checklist
and every gotcha found onboarding them (schema pre-creation, per-service
static-file mount paths, `smi-hcp` profile requirement, cross-service DB
coupling) is in the `icedq-onboard-service` skill.

## What you get for debugging

Actuator is wide open in `application-local-compose.yaml` (this container
never leaves your laptop, so there's no reason to lock it down) — `health`
with full component detail, `beans`, `env`, `configprops`, `conditions`,
`loggers`, `threaddump`, `metrics`, `mappings`, `liquibase`,
`scheduledtasks`, and more, all unauthenticated:

```
http://localhost:9100/actuator
http://localhost:9100/actuator/health   # shows db/rabbit/vault/mail status individually
```

`run-admin.sh`'s pass condition is `components.db.status == UP` in
`/actuator/health` — a real signal, not just "didn't crash yet."

## Frontend (ui-platform)

Different mechanism than the Java services — not a Spring profile, an nginx
image whose entrypoint (`golden-image-nginx`'s `run.sh`, confirmed via
`docker inspect`/`docker create`+`cp` on the real pulled image — its own
source repo's `Dockerfile` is stale vs what's actually baked in) `envsubst`s
a fixed set of env vars into `main*.js` at container start, then serves it
with nginx on :8080.

These URLs are consumed by the **browser** (client-side JS), not nginx
server-side, so they must be host-reachable (`http://localhost:9080` for API,
`http://localhost:8090` for UI), not compose-internal service names like
`http://admin:9100`.

**API routing:** Prod uses a single ingress URL for all `/api/v1/*` paths. Locally
there is no ingress — `HTTP_API_URL` must point at the local API gateway
(`./run-api-gateway.sh`, port **9080**), which forwards secret/connection paths
to `:9200`, rules/workflows to `:9300`, and everything else to admin `:9100`.
Without the gateway, connection-ui secret/connection calls hit admin and return
404.

```bash
./run-api-gateway.sh          # start first (or after admin/connection/workflow)
./run-ui-platform.sh <image:tag>
# http://localhost:8090/
```

Real env var names come from `ng-icedq-helm-charts/icedq/templates/
ui-configmap.yaml`. `HTTP_API_URL`/`HTTPS_API_URL` point at the API gateway
(`:9080`); navigation URLs (`CONNECTION_URL`, `WORKFLOW_URL`, etc.) point at
UI ports — same lazy vs. eager judgment call as backend `outbound-service` URLs. `NGINX_LOG_DIR`
must be a writable path (`/tmp/logs`) — the image's built-in default
(`/app/icedq-adminui/logs`) isn't writable without the PVC mount k8s
provides. Login/Keycloak flow isn't wired up (no realm imported into dev
keycloak) — this proves the image boots and serves, not full SSO.

## Iterating on your build

```bash
./run-admin.sh <your-registry>/<image>:<new-tag>
```

Deps stay up; only admin restarts. No cluster/stack rebuild needed — this is
the fast inner loop, meant to run right after unit/mutation tests pass and
you have a fresh image to prove out.

## Tearing down

```bash
./dev.sh down
```

Or manually:

```bash
docker rm -f icedq-admin-smoke
docker compose down -v
```

## Known limitation

This is a smoke test, not a full integration environment. It proves admin
boots and reaches postgres/rabbitmq/vault/temporal — it does not exercise
Kong routing, other microservices, or UI. It's also not representative of
prod ordering/networking (that's what the k8s setup in
`ng-icedq-helm-charts/scripts/` is for, when you need that level of
fidelity). Use whichever tool matches what you're actually trying to verify.
