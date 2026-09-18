# iceDQ smoke

Repeatable iceDQ UI smoke for any lab host. `smoke.mjs` logs in with Playwright (Keycloak), then calls the same REST APIs the UI uses: create fixtures → test Oracle → run a pushdown rule and workflow → delete them.

No iceDQ CLI, no MCP, no Java source. Self-signed lab TLS is ignored. Do not point this at the public internet. Never run `Millions_Workflow`.

## Structure — shared bricks, not copy-paste

`lib/bricks.mjs` holds the small, single-purpose pieces every script here composes: `login`
(Playwright → Bearer token), `api` (fetch wrapper), `firstOk` (try N endpoint variants, keep the
first success), `idOf`/`itemsOf`/`snippet` (response parsing), `remove` (per-resource-kind delete
with fallback paths and idempotent 404-handling), `makeRecorder`/`writeReport` (PASS/FAIL
console output + the `out/*.json` report). Every script — `smoke.mjs`, `smoke-user.mjs`,
`smoke-connections.mjs`, and any new ticket-specific script under a `<TICKET-ID>/` folder — builds
on these instead of reimplementing login/api/delete/reporting from scratch.

- `smoke.mjs` / `smoke-user.mjs` / `smoke-connections.mjs` compose bricks into either a fixed-order
  **pipeline** (`smoke.mjs` — rule/workflow E2E; `smoke-connections.mjs` — catalog entries in
  sequence) or a **scenario list** (`smoke-user.mjs` — each scenario is self-contained, runnable
  alone via `ICEDQ_ONLY=<name>`).
- `lib/smoke-config.mjs` — shared CLI/env parsing and multi-base API routing (`apiBaseFor`).
- `lib/smoke-session.mjs` — Playwright login + `ctx.call` / `hdr()` for authenticated requests.
- `lib/smoke-workspace.mjs` — account/workspace bootstrap and leftover sweeps.
- `lib/connection-bricks.mjs` — connector meta lookup, secret/connection create + `:test`, catalog runner.
- `lib/connections-catalog.mjs` — regression DB endpoints verified green on the target cluster.
- Ticket-specific smokes live in their own folder (e.g. `dso-2224/`) and import `../lib/bricks.mjs`
  rather than duplicating the login/api plumbing. Add a new one the same way: a folder named for
  the ticket, its own domain bricks + scenarios on top of the shared ones.

## Setup (once)

```bash
git clone git@github.com:AshishDaga161/icedq-smoke.git
cd icedq-smoke
npm install
npx playwright install chromium
```

Passwords stay in the environment (copy `.env.example` → `.env`). Do not put them in files you commit.

## Run

Creates a tagged account (when the license allows), grants the login user **Owner**, creates a workspace, then secret / folder / Oracle connection / pushdown rule / workflow. Tests the connection, runs the rule and the workflow, then deletes only those objects.

If `POST /api/v1/accounts` returns “Account creation limit reached”, smoke reuses an existing account (`ICEDQ_ACCOUNT`, else the first listed) and grants **Owner on the new workspace only**. It does not add Owner on a reused account. Names `mcp-demo` and `mcp-workspace` are never deleted.

```bash
cd icedq-smoke

ICEDQ_URL=https://HOST:32222 \
ICEDQ_USER=admin ICEDQ_PASS='…' \
ICEDQ_DB_HOST=192.168.100.126 ICEDQ_DB_PORT=1521 \
ICEDQ_DB_NAME=orcl ICEDQ_DB_USER=regression_database \
ICEDQ_DB_PASS='…' \
node smoke.mjs
```

Proven green (23/23): `https://192.168.100.69:32222/`, `https://192.168.100.90:32222/`, and
`https://192.168.100.44:32222/` against Oracle `192.168.100.126:1521/orcl` (`regression_database`).

## Connection-matrix smoke

Creates and tests each connection in `lib/connections-catalog.mjs` (verified green on `.44`: DB2, Greenplum, Denodo, MySQL, Oracle, PostgreSQL, ClickHouse).

```bash
cd icedq-smoke

ICEDQ_URL=https://192.168.100.44:32222 \
ICEDQ_USER=admin ICEDQ_PASS='…' \
ICEDQ_CONN_05_DB2_PASS='…' ICEDQ_CONN_08_GREENPLUM_PASS='…' \
ICEDQ_CONN_10_DENODO_PASS='…' ICEDQ_CONN_14_MYSQL_PASS='…' \
ICEDQ_DB_PASS='…' ICEDQ_CONN_16_POSTGRESQL_PASS='…' \
ICEDQ_CONN_24_CLICKHOUSE_PASS='…' \
node smoke-connections.mjs
```

| Env / flag | Meaning |
| --- | --- |
| `ICEDQ_ONLY=15-oracle-up,14-mysql` | Run specific catalog ids |
| `ICEDQ_SR=15` | Run all catalog entries for one SR row |
| `ICEDQ_TEST=0` | Create connections only; skip `:test` |
| `ICEDQ_KEEP=1` | Skip cleanup |
| `ICEDQ_REUSE_WORKSPACE=1` | Reuse an existing workspace instead of creating one |
| `ICEDQ_ACCOUNT` / `--account` | Fallback account when license blocks create (same as `smoke.mjs`) |
| `ICEDQ_CONN_<ID>_PASS` | DB password for catalog entry `<id>` (e.g. `ICEDQ_CONN_05_DB2_PASS`) |
| `ICEDQ_DB_PASS` | Oracle password for catalog entry `15-oracle-up` (same as `smoke.mjs`) |

Proven green (40/40): seven connections on `https://192.168.100.44:32222/` — DB2, Greenplum,
Denodo, MySQL, Oracle, PostgreSQL, ClickHouse. Add a row to `lib/connections-catalog.mjs` only
after create + `:test` pass on the target host.

## User-admin smoke (quick)

Creates a unique `smk*` user, finds it, then deletes it. No Oracle / workspace needed. APIs were captured from Administration → Users on `.69`.

```bash
cd ~/tools/icedq-smoke

ICEDQ_URL=https://192.168.100.69:32222 \
ICEDQ_USER=admin ICEDQ_PASS='…' \
node smoke-user.mjs
```

`ICEDQ_KEEP=1` skips delete. `firstName` / `lastName` stay alphabetic (`Smoke` / `User`); only `userName` uses the `smk*` tag. Built as two scenarios (`sweep-leftover-smoke-users`, `create-get-search-delete-user`) — `ICEDQ_ONLY=<name>` runs just one.

## DSO-2224 (seat-limit enforcement)

`dso-2224/seat-audit.mjs` — read-only pre-flight check: computes the same full-access/read-only
seat counts `UserSeatLicenseValidator` will, before/without enforcing, so you know whether a
tenant is already over its license limit before flipping `icedq.license.seat-enforcement-enabled`
on for it.

`dso-2224/seat-enforcement-e2e.mjs` — lego-brick E2E suite against the real enforcement behavior
once it ships (won't pass until then). `ICEDQ_ONLY=<scenario-name>` runs one scenario; see the
file header for the full list (full-access grant, reader grant, batch promotions, Reader→Owner
upgrade consuming a seat, group-only no-op, service-account exclusion).

Both import `../lib/bricks.mjs` for login/api and add their own seat-counting/grant bricks on top.

JSON reports land in `out/` (gitignored).

## Flags

| Env / flag | Default | Meaning |
| --- | --- | --- |
| `ICEDQ_URL` / `--url` | required | UI base, e.g. `https://192.168.100.90:32222` |
| `ICEDQ_USER` / `--user` | `admin` | Keycloak login |
| `ICEDQ_PASS` / `--pass` | required | Keycloak password |
| `ICEDQ_DB_HOST` | `192.168.100.126` | Oracle host for the smoke connection |
| `ICEDQ_DB_PORT` | `1521` | |
| `ICEDQ_DB_NAME` | `orcl` | SID / service |
| `ICEDQ_DB_USER` | `regression_database` | |
| `ICEDQ_DB_PASS` | required | Oracle password (vault key `oracle_UNP`) |
| `ICEDQ_ACCOUNT` / `--account` | first listed | Fallback account when license blocks create |
| `ICEDQ_WORKSPACE` / `--workspace` | — | Used only with reuse |
| `ICEDQ_REUSE_WORKSPACE=1` / `--reuse-workspace` | off | Skip account/workspace create; use `ICEDQ_WORKSPACE` |
| `ICEDQ_KEEP=1` / `--keep` | off | Skip cleanup (debug) |
| `HEADED=1` | off | Show the Chromium window |
| `PLAYWRIGHT_CHROME` | Playwright's Chromium | Optional path to a Chrome binary |

### What it calls

1. Playwright login → capture `Authorization: Bearer`
2. `POST /api/v1/accounts` `{ name, description }` — on 403 license limit, search and reuse
3. `POST /api/v1/accounts/{id}:grantAccess` `[{ id, type: "User", role: "Owner", resource: "User" }]` — only if smoke created the account
4. `POST /api/v1/workspaces` with `Account-Id` header
5. `POST /api/v1/workspaces/{id}:grantAccess` same Owner body
6. Re-login so the JWT contains `wksc-….Owner`
7. Secret, folder, Oracle connection (`useVault: true`), `:test`
8. Pushdown rule `SELECT 1 AS X FROM DUAL WHERE 1=0`, publish
9. Sequential workflow, validate, publish
10. `POST /api/v1/workflow:trigger` for the rule and the workflow; poll run + logs for `Total Exit Code: 0`
11. Delete workflow → rule (`rules:batchDelete`) → connection → secret → folder → workspace → account (account only if smoke created it)
