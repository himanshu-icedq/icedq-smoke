# iCEDQ Feature Map

Confirmed API surface — endpoint, method, required headers, shape — captured live via Chrome
DevTools or a running `lib/bricks.mjs`-based script, not from reading source. Update this whenever
a verification script confirms something new; check here before guessing at a shape.

Each entry: what it's for, the call, required headers, and which script exercises it.

## Auth

- **Login**: Playwright fills Keycloak's hosted login form (`Username or email` / `Password`
  fields, `Sign In` button) at `{BASE}/`, then captures the `Authorization: Bearer` header off the
  first API request the app makes post-login. No direct token endpoint call — the UI flow is the
  only confirmed path. See `lib/bricks.mjs#login`.

## Accounts

- `POST /api/v1/accounts` — create. Body: `{ name, description }`. Headers: bearer + `Org-Id`. On
  license-limit 403/400 (`"Account creation limit reached"` or similar in the body), no free slot
  — caller should reuse an existing account. See `smoke.mjs`.
- `POST /api/v1/accounts/search?pageNo=1&pageSize=5000&sort=updatedTimestamp:desc` — list. Body
  `{}` for all. See `lib/bricks.mjs` callers, `seat-audit.mjs`.
- `DELETE /api/v1/accounts/{id}` — delete. Headers: bearer + `Account-Id`. **Known quirk**: has
  returned `403` in this session even for an account the caller just created and granted Owner on
  — confirmed present on unmodified `master`/original scripts too, not script-specific. Cause not
  yet root-caused; treat as a known flake, not a script bug.
- `POST /api/v1/accounts/{id}:grantAccess` — grant. Body: `[{ id, type: "User"|"Group", role,
  resource: "User"|"Group" }]`. Headers: bearer + `Account-Id`. `resource` mirrors `type`.
- `GET /api/v1/accounts/{id}/memberList` — list current members (users + groups) with role. Used
  for seat-counting; confirmed live.

## Workspaces

- `POST /api/v1/workspaces` — create. Body: `{ name, accountId, type, ownership, description }`.
  `type` values seen: `"data-testing"`. Headers: bearer + `Account-Id`.
- `POST /api/v1/workspaces/search?...` — list, same shape as accounts search. **Not independently
  confirmed live** for the exact filter shape — `seat-audit.mjs`/`smoke.mjs` assume symmetry with
  the accounts search endpoint; flag if it ever behaves differently.
- `POST /api/v1/workspaces/{id}:grantAccess` — grant, same body shape as account grant. Headers:
  bearer + `Account-Id` + `Workspace-Id`.
- `GET /api/v1/workspaces/{id}/memberList` — same shape as account memberList.
- `DELETE /api/v1/workspaces/{id}` — delete. Headers: bearer + `Account-Id`. Confirmed reliable
  (unlike account delete above).

## Users

- `POST /api/v1/users` — create. Body: `{ userName, firstName, lastName, email, tempCredential }`.
- `GET /api/v1/users/{id}` — fetch one.
- `POST /api/v1/users/search?pageNo=1&pageSize=100&sort=updatedTimestamp:desc&includeRoles=true` —
  search, body `{}` for all, or `{ search: [{ attribute, operator: "Like", value }] }` for filtered.
- `POST /api/v1/users:batchDelete` — delete. Body: `[{ resource: "User", id }]` (note: POST, not
  DELETE, and the array wraps `resource`+`id`, not just an id list).

## Groups / Service Accounts (read-only, confirmed for seat-counting only)

- `GET /api/v1/groups/{id}/userList` — expand a group to its member users.
- `POST /api/v1/groups/search?...` / `POST /api/v1/serviceaccounts/search?...` — list, same search
  shape as accounts.

## Rules / Workflows / Connections / Secrets / Folders

See `smoke.mjs` for confirmed create/publish/trigger/delete shapes for: pushdown rules, sequential
workflows, Oracle connections (`connectorId: "oracle"`, `useVault: true`), internal secrets
(`vaultType: "internal"`), and folders. Not yet extracted into this map in full detail — read the
script directly for now; extract the shapes here on the next ticket that touches this surface.

## Backend/JVM debugging (Spring Boot Actuator) — the pstack-equivalent for this stack

iCEDQ's backend is Spring Boot, developed in IntelliJ — no Chrome DevTools equivalent applies here.
This is the actual debugging surface, confirmed present via `spring-boot-starter-actuator` in
`ng-icedq-admin-service/pom.xml` and `management.endpoints.web.exposure.include` in
`application.yaml` (`loggers,info,health,threaddump,metrics,prometheus,profiler`).

**Path prefix confirmed live**: `https://{host}:32222/admin-api/actuator/*` returns `401` (real
endpoint, auth-gated) — NOT `https://{host}:32222/actuator/*` (that 404s; the yaml's own
`permitted-endpoints: /actuator/**` entry does not reflect the real external routing, likely an
nginx/ingress path rewrite). Use the Bearer token from `lib/bricks.mjs#login` to authenticate.

- `GET /admin-api/actuator/health` — liveness + component health (`show-details: always`).
- `GET /admin-api/actuator/threaddump` — full JVM thread dump. **This is the direct `pstack`/`jstack`
  equivalent** — use it to see what every thread is doing right now (stuck request, deadlock,
  thread-pool exhaustion). Confirmed configured, not yet confirmed authenticated-live (need a
  bearer token in the curl — do that as the first real use of this section).
- `GET /admin-api/actuator/loggers/{logger-name}` — read/change a logger's level live, e.g.
  `org.icedq.admin`, without a redeploy. `POST` with `{"configuredLevel":"DEBUG"}` to change it.
- `GET /admin-api/actuator/metrics`, `/admin-api/actuator/prometheus` — JVM/HTTP metrics.
- `POST /admin-api/actuator/profiler/execute?command=...` — async-profiler wrapper (CPU/wall/
  alloc/lock profiling → flamegraph or JFR file). Full command reference:
  `ng-icedq-commons/.cursor/commands/profiler.md`. Quick reference:
  - High CPU: `command=start,event=cpu,flamegraph,file=/tmp/cpu.html` → wait → `command=stop,flamegraph,file=/tmp/cpu.html`
  - Slow requests (recommended default): `event=wall` instead of `event=cpu`
  - Memory leaks: `event=alloc,alloc=10m,live,jfr,file=/tmp/leak.jfr`
  - Lock contention: `event=lock,flamegraph,file=/tmp/lock.html`

**Not yet done**: an actual authenticated live call to `/admin-api/actuator/threaddump` or
`/profiler/execute` against a real environment — the 401 above only proves the path exists and is
gated, not that it works end-to-end with a real bearer token. Do this the next time backend/JVM
debugging is actually needed for a ticket, and update this entry with the confirmed result.

**IntelliJ-side**: standard remote JVM debug attach (`-agentlib:jdwp=...` / IntelliJ's "Remote JVM
Debug" run configuration) is the IDE-side complement to the actuator endpoints above, for stepping
through code live rather than just observing thread/metric state — not yet set up/documented for
any icedq lab environment; ask before assuming a debug port is open on a shared lab host.

## Known environment quirks (per-host, not code bugs)

- **`192.168.100.69:32222` (as of the `7.2.308-SNAPSHOT-DSO-2224` deploy, 2026-09-01): `POST
  /api/v1/users` (createUser) always fails with `{"code":"RequestBodyInvalid","message":"Id must
  not be empty."}`, HTTP 400 — confirmed a genuine server-side bug on this build/host, NOT a
  client payload issue.** Verified two independent ways: (1) the script sent the standard
  `{userName, firstName, lastName, email, tempCredential}` body, 400 either way whether or not an
  explicit `id` was added; (2) reproduced through the **real production UI** (Chrome DevTools,
  Administration → Users → New User) with a normal, complete, valid form submission — captured the
  exact request body (`{"userName":"...","firstName":"...","lastName":"...","email":"...",
  "tempCredential":"..."}`, 134 bytes) and got the byte-identical error response. Since the actual
  UI and an independent script both produce the same failure with a valid payload, this is broken
  in admin-service or Keycloak on this host, not a request-shape problem. Confirmed NOT caused by
  DSO-2224 (zero diff in `UserServiceImpl.java` between `master` and that branch). Needs backend
  investigation (server logs / actuator threaddump / Keycloak admin console on the affected pod) —
  out of scope for browser-side verification alone. **Workaround for live verification when
  createUser is broken on a host**: grant a role to the already-logged-in admin's own user id
  (from `login()`'s returned `userId`) against a throwaway account/workspace instead of creating a
  new user — exercises the same `grantAccess` → validator → `assignRole` path without needing
  Keycloak user creation to work.
- Response headers on `.69` now show `licensestatus: LICENSE_OK` (previously the Replicate DNS
  resolution was failing) — confirms the cluster DNS fix (searching `local` domain fixed,
  `replicated.default.svc.cluster.local` now resolvable) restored real license connectivity on
  this host as of 2026-09-01.
- **Every request logs a DNS resolution error for `replicated.default.svc.cluster.local`** (seen
  on `.69`'s server log) — the Replicate/license backend isn't reachable via k8s DNS on this
  environment. Logged as `ERROR` per-request but does not fail the request (consistent with
  `LicenseFieldReader`'s fail-open design) — noise, not a functional blocker, but expect
  `getIntField(key, fallback)` to always return the fallback on hosts with this issue.
- **`DELETE /api/v1/accounts/{id}` intermittently `403`s**, even for an account the caller just
  created and granted Owner on. Confirmed present on `192.168.100.81` AND `192.168.100.69`, and on
  an unmodified `master` build too (side-by-side comparison during the `lib/bricks.mjs`
  extraction) — not script-specific, not DSO-2224-specific. Root cause not yet investigated;
  leftover un-deletable test accounts (named `smk*`/`dbg*`/ticket-tag-prefixed) are expected
  residue on any host this has been tested against.

## Not yet mapped

Everything outside the above — extend this file as `icedq-verify` runs against new tickets,
instead of re-deriving shapes from scratch each session.
