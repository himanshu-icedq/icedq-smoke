---
name: icedq-onboard-service
description: >-
  Onboard a new iCEDQ Java service (or admin-ui) into the icedq-smoke/local-deps
  compose stack so it boots and smoke-tests locally in ~30-60s instead of the
  full k8s/Helm stack. Use when the user asks to "onboard <service>", "add
  <service> to local-deps", "bring up <service> locally", or wants to test a
  fresh build of any iCEDQ Java service (connection, workflow, auditengine,
  datawarehouse, scheduler, notification, etc.) against real dependencies.
  Distilled from actually onboarding admin, connection-repo-service,
  workflow, and ui-platform this session — every step below is empirically
  validated, not theoretical.
---

# Onboarding a new iCEDQ service into local-deps

Stack lives at `icedq-smoke/local-deps/` (github.com/AshishDaga161/icedq-smoke).
Shared deps: `docker-compose.yml` (postgres, rabbitmq, vault-dev, temporal,
keycloak opt-in). Existing examples to copy from: `run-admin.sh` +
`application-local-compose.yaml`, `run-connection.sh` +
`application-local-compose-connection.yaml`, `run-workflow.sh` +
`application-local-compose-workflow.yaml`.

Every fix below was found by **reading the actual crash log's `Caused by:`
chain**, not by guessing property names ahead of time. Don't try to
pre-solve every gotcha before running — run, read the real error, fix that
one thing, rerun. That loop is faster than it sounds; each service took
3-4 iterations this way.

## Two smoke modes — don't conflate them

| Mode | Goal | `:1` stubs OK? | API path |
|---|---|---|---|
| **Boot smoke** | One JAR/image starts against deps; `db.status == UP` | Yes, for outbound URLs the service never calls on boot | N/A |
| **E2E smoke** | Rule/workflow run via UI + gateway (`smoke.mjs`) | **No** for any service container that is up in the stack | All browser/API traffic via `http://localhost:9080` (`run-api-gateway.sh`) |

Boot smoke and E2E smoke are different contracts. Wiring that is fine for
boot-only must be upgraded to real compose hostnames before claiming E2E
passes.

## Anti-patterns — never do these

1. **SQL backfill / sync scripts** that copy operational rows between schemas
   (e.g. `iam.*` → `dqw.icedw_*_dim`). Analytics dims are populated by
   RabbitMQ consumers in the owning services — if FK errors appear in DW logs,
   fix the event pipeline or accept DW noise as out-of-scope for boot smoke;
   do not patch Postgres from smoke scripts.
2. **Stub tables with fake data shape** (e.g. empty `keycloak.user_entity` in
   `init-db.sql` so DW Liquibase passes). If a migration needs another
   service's table, **run that service first** — same rule as cross-schema
   Liquibase coupling in Step 4.
3. **`localhost:<port>` inside container compose yamls** for outbound calls to
   other containers — inside the bridge network, `localhost` is the container
   itself. Use `http://icedq-<service>-smoke:<port>` (the `run-*.sh` container
   name). Reserve `localhost:*` for **host-JVM** IDE profiles only
   (`application-local-*-ide.yaml`).
4. **E2E smoke bypassing the gateway** — UI uses `HTTP_API_URL=http://localhost:9080`;
   `smoke.mjs` must use the same, not direct `:9100/:9200/:9300` splits.
5. **Preferring `/api/v1/internal/*` over public APIs** in E2E tests — the UI
   hits public routes through the gateway; internal-first `firstOk` hides broken
   public paths.

## Step 0: get the real image

```bash
grep -A3 "^image:" icedq/charts/<chart-name>/values.yaml   # in ng-icedq-helm-charts — repo name + default tag
# chart-default tags are often stale — check ACR for what's actually current:
az acr login --name icedq   # or icedqngdev for admin's own registry
az acr repository show-tags --name icedq --repository <repo> --top 10 --orderby time_desc
docker login proxy.icedq.com -u <license-id> --password-stdin   # decode global.localRegistryPullSecret's base64 auth field for creds
docker pull proxy.icedq.com/proxy/icedq/icedq.azurecr.io/<repo>:<tag>
```

## Step 1: find the real local-dev config (don't invent one)

Every service has a real `application-dev*.yaml`/`.yml` in
`src/main/resources/` (sometimes also a `profiles/` dir with more variants,
e.g. `application-dev-82.yaml` for a specific dev box). This is gold — it's
already a working config, just pointed at remote dev-box hostnames. Find it:

```bash
find <service-repo> -iname "application-dev*.yaml" -o -iname "application-dev*.yml"
```

Also check the base `application.yml`/`.yaml` for:
- `spring.profiles.active` default list — **most services need `smi` and
  `smi-hcp` active** (the secret-manager-integration library's HCP profile).
  If the dev-profile filename doesn't already imply this, check explicitly:
  `grep -n "profiles:" -A6 application.yml`. Missing `smi-hcp` produces:
  `NullPointerException: ... SecretManagerProperties.getHcp() is null`.
- `spring.liquibase.parameters` — schema name variables used by the
  changelog (e.g. `rule_schema: ruler`). You need every one of these as a
  real Postgres schema (see Step 4).

## Step 2: confirm the image's entrypoint mechanics

```bash
docker create --name extract-tmp <image>
docker cp extract-tmp:/app/entrypoint.sh /tmp/entrypoint.sh
docker inspect <image> --format '{{.Config.Entrypoint}} {{.Config.Env}}'
docker rm -f extract-tmp
```

Confirms: `MAIN_CLASS` (the real app, not a vault-manager-style sidecar
entrypoint), and that `EXTRA_CLASSPATH` is supported (every service checked
so far supports it — the entrypoint script prepends it to the classpath).
This is how the local-compose profile gets loaded without rebuilding the
image.

## Step 3: derive `application-local-compose-<service>.yaml`

Copy the real dev-profile file, then:
- Swap every remote hostname (`icedqngvm1.eastus...`, `192.168.x.x`, etc.)
  to the compose service name: `postgres`, `rabbitmq`, `vault`, `keycloak`,
  `temporal`.
- `spring.cloud.vault`: switch `authentication: APPROLE` (with hardcoded
  role-id/secret-id) to `authentication: TOKEN` + `token: root`. Dev vault
  has no AppRole to bootstrap — TOKEN auth against the fixed dev root token
  is the whole point of using dev-mode vault.
- `spring.datasource`: point at `postgres:5432/icedq_db`, `dbAdmin` /
  `devpassword` (matches `docker-compose.yml`'s postgres service).
- `spring.rabbitmq`: `rabbitmq` / 5672 / `rabbitmq` / `rabbitmq`.
- **`icedq.outbound-service.*.base-url` — lazy vs real wiring:**
  - Service **is up** in this stack (has a `run-<name>.sh`, listed in
    `services.yaml`): use `http://icedq-<name>-smoke:<port>` — copy from an
    already-fixed yaml (workflow, auditengine, notification, datawarehouse).
  - Service **not** in stack and boot path never calls it eagerly: use
    `http://localhost:1` (lazy placeholder — see Step 6).
  - Service called **eagerly on boot** (replicated, rabbitmq, vault): must be
    a real reachable URL — never `:1`.
  - Check `services.yaml` + existing `run-*.sh` files before defaulting to `:1`.
- Add wide-open actuator at the bottom (useful for AI/human debugging,
  container never leaves the laptop):
  ```yaml
  management:
    endpoints:
      web:
        exposure:
          include: "*"
    endpoint:
      health:
        show-details: always
        show-components: always
  ```
- If the service's security config has a `permitted-endpoints` list, add
  `/actuator/**` to it too (otherwise actuator is exposed by Spring Boot
  but still blocked by the app's own security filter chain).

## Step 4: pre-create every schema the service needs

**Liquibase does not auto-create schemas** (proven: admin's first run
failed with `schema "liquibase" does not exist` until manually created).
There IS a `SchemaConfig` `BeanPostProcessor` class present in most
services (`org.icedq.<service>.configuration.SchemaConfig` or similar,
implements `BeanPostProcessor` on the `DataSource` bean) — but it **only**
creates two hardcoded schemas: `liquibase` and `keycloak`. Every
app-specific schema (`iam`, `conn`, `ruler`, `workengine`, `insta`,
`rulebuild`, `orch`, `dqw`, `bi_test`, `brg`, `notification`, `scheduler`,
...) must be pre-created yourself in `init-db.sql`.

Find the real schema names from the service's `default_schema` (Hibernate)
and `spring.liquibase.parameters` (Liquibase changelog variables) config
keys — don't guess. Add each as `CREATE SCHEMA IF NOT EXISTS <name>;` to
`local-deps/init-db.sql`, then force-recreate postgres to pick it up
(postgres uses tmpfs — a plain `up` won't re-run the init script on an
already-running container):

```bash
docker compose up -d --force-recreate postgres
```

**Cross-service DB coupling is real**: some services' migrations touch
tables owned by a *different* service's schema (e.g. connection-repo-
service's Liquibase changelog has a data-patch changeset that updates
`ruler.ice_object`, a table workflow's own migrations create). If a
changeset fails with `relation "X.Y" does not exist` and creating the bare
schema doesn't help, that table is only created by *another service's* own
migrations — bring that service up first against the same shared postgres,
then retry. Don't hand-craft a stub table; run the real owner service.

## Step 5: static file mounts

Watch for `FileNotFoundException` on a static resource — every service
checked so far needs `icedq-datatypes.json`
(`ng-icedq-helm-charts/icedq/files/icedq-datatypes.json`, already copied
into `local-deps/`), but **the expected path differs per service**:
- admin, connection: `/app/config/icedq-datatypes.json`
- workflow: `/usr/lib/icedq/config/icedq-datatypes.json`

Check the actual `FileNotFoundException` message for the exact path each
service expects — don't assume it matches a previous service.

## Step 6: write `run-<service>.sh`

Copy `run-connection.sh` or `run-workflow.sh` as the template. Change:
`IMAGE` default, `NAME`, the `-p <port>:<port>` mapping (check the chart's
`service.port`), the mounted yaml/json paths, `SPRING_PROFILES_ACTIVE`
(base profile + `smi,smi-hcp` if needed + your new `local-compose-<service>`
profile last so it overrides), and the actuator health-check port in the
polling loop.

## Step 7: the iterate-on-real-errors loop

```bash
docker compose up -d   # deps, if not already up
bash run-<service>.sh <image:tag>
```

When it fails, `docker logs <container-name> 2>&1 | grep -B5 "Caused by:"`
— the root cause is always at the bottom of the chain. Common failure
classes seen so far, roughly in the order they tend to appear:

1. `schema "X" does not exist` → Step 4.
2. `SecretManagerProperties.getHcp() is null` → missing `smi-hcp` in
   `SPRING_PROFILES_ACTIVE`.
3. `FileNotFoundException: .../icedq-datatypes.json` → Step 5, check the
   exact path in the error.
4. `Could not resolve placeholder 'X'` → the property genuinely doesn't
   have a value; add a real or harmless-placeholder one depending on
   whether it's called eagerly or lazily (if unsure, add a real value
   pointing at a compose service if one exists, else a harmless
   `http://localhost:1`-style placeholder and see if boot still needs it
   reachable).
5. AMQP/RabbitMQ timeouts on boot (`TimeoutException` inside a
   `RabbitMQConfig`-style bean factory method) — some services actively
   declare exchanges/queues via AMQP at boot (not just construct a lazy
   client), so rabbitmq host/port must be genuinely reachable and correct,
   not a lazy placeholder. **Root cause found (connection-repo-service):
   the actual bug was forgetting to include the whole `spring.rabbitmq`
   block in the local-compose yaml at all** — with it missing, the base
   `application.yml`'s hardcoded remote hostname silently won (Spring
   profile override only replaces keys that are actually present in the
   higher-priority file), so the app tried to reach a real remote VM from
   inside the container and timed out after 15s with zero trace on the
   local rabbitmq's own log (nothing ever reached it). **The fix, and the
   general lesson**: when a value looks like it's coming from the wrong
   profile/file, check the log line that prints the *actually resolved*
   values (e.g. `CommonRabbitMQConfig.connectionFactory`'s own
   `log.info("Host: {} | Port: {} ...")`) rather than assuming your
   override file is even being read for that key — `grep` your override
   yaml for the section you think should apply; a missing block is a much
   more common bug than a wrong value. Also: check `docker cp
   <container>:/app/icedq-<service>/logs/app.log` for INFO-level logs —
   `docker logs` only shows stdout, and INFO-level application logging in
   these services goes to a file inside the container, not stdout
   (confirmed the pattern holds for admin, connection, and workflow).
6. Anything else: read the `Caused by:` chain fully — it's always more
   informative than the top-level exception, and always traces back to one
   specific config value or missing resource.

## Step 8: verify with real health, not just "container didn't crash"

Pass condition: `curl .../actuator/health` shows `components.db.status ==
"UP"` (and any other components that matter for that service — `rabbit`,
`vault`, etc.). A `200`/`401` on some arbitrary endpoint is a weaker signal
than the real component-level health breakdown.

`status.sh` (the `kubectl get pods` equivalent for this stack) auto-discovers
app services from `run-*.sh` files — no manual wiring needed once
`run-<service>.sh` exists.

## After onboarding: update the shared files

- `init-db.sql`: new **schemas only** (`CREATE SCHEMA IF NOT EXISTS`), comment
  which service owns each. Never add stub tables to satisfy another service's
  Liquibase — run the owner service instead.
- `services.yaml`: add port, `docker_run_script`, `depends_on` if the service
  joins the dev graph.
- `docker-compose.yml`: only touch if the new service needs a shared dep
  not already running (unlikely — postgres/rabbitmq/vault/temporal cover
  everything seen so far).
- `README.md`: add the new service to whatever service-list/table exists.
- If the service participates in E2E (`smoke.mjs`): confirm `api-gateway.conf`
  routes its `/api/v1/*` paths and outbound URLs in peer yamls point at
  `icedq-<service>-smoke`, not `:1` or `localhost:<port>`.
- Run the **5-run stress test pattern** (see `BENCHMARK-compose-5runs.md`
  for why) before trusting a single clean run — two real bugs
  (`rabbitmq.erlang.cookie` race, missing keycloak-boot-dependency
  assumption) were hidden by single clean runs earlier this session and
  only surfaced doing 5 rapid cycles.

## Frontend services (nginx-based, e.g. ui-platform/admin-ui) — different mechanism

Steps 0-8 above are for Java services. A frontend image is nginx serving a
built SPA — no Spring profile, no classpath trick. Instead:

1. `docker inspect <image>` (or `docker create`+`cp`) the REAL pulled image
   for `.Config.Entrypoint` and `.Config.Env` — don't trust the service's own
   repo `Dockerfile`, it can be stale vs. what the current image actually
   bakes in (confirmed: ui-platform's repo Dockerfile differed from the
   golden-image-nginx base actually in the 0.0.477 image).
2. The entrypoint typically `envsubst`s a fixed set of env vars into
   `main*.js` at container start, then runs nginx. Find the real var names
   from `ng-icedq-helm-charts/icedq/templates/ui-configmap.yaml` (or the
   equivalent per-app configmap template) — that's the authoritative list,
   not the chart's own `values.yaml` defaults.
3. **Critical distinction from backend config**: these URLs are consumed by
   the BROWSER (client-side JS), not by nginx server-side. They must be
   host-reachable (`http://localhost:9080` for API, `http://localhost:8090`
   for UI shell), never compose-internal service names (`http://admin:9100`)
   — the browser on your laptop can't resolve compose's internal DNS.
4. **`HTTP_API_URL`/`HTTPS_API_URL` → `http://localhost:9080`** (local API
   gateway from `run-api-gateway.sh`). Prod uses one ingress; locally the
   gateway mirrors path routing to admin `:9100`, connection `:9200`, workflow
   `:9300`. Do **not** point API URL at admin `:9100` directly — connection-ui
   secret/connection calls 404 on admin.
5. Navigation URLs (`CONNECTION_URL`, `RULEREPO_URL`, …) → UI ports/paths the
   browser loads (`:8090`, `:8091/rule-ui`, …). Placeholder (`http://localhost:1`)
   only for modules not onboarded — same lazy-vs-eager judgment as backend.
6. Watch for a log-dir env var (e.g. `NGINX_LOG_DIR`) defaulting to a path
   only writable via a k8s PVC mount (e.g. `/app/<name>/logs`) — override it
   to something writable in a plain container (`/tmp/logs`).
7. Pass condition is weaker than a Java service's `db.status == UP`: plain
   HTTP 200 on `/`, plus (optional but stronger) grepping the served
   `main*.js` for the substituted value to confirm envsubst actually ran:
   `docker exec <container> grep -o 'localhost:9080' /usr/share/nginx/html/main*.js`.
8. **Keycloak / SSO:** boot-only UI smoke does not need Keycloak. Full E2E
   login uses `docker compose --profile oidc up -d` — realm is file-imported
   from `keycloak-realm-iam-icedq.json` (`--import-realm`). Keep realm changes
   in that JSON file, not live admin-API patches.
9. `status.sh` auto-detects frontend vs. Java services by grepping the run
   script for `actuator/health` — no separate wiring needed, and it reads
   the real published port via `docker port` (not the script text) since a
   frontend's host port is often a shell variable, not a literal.
