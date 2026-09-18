// Shared bricks for icedq-smoke scripts — small, single-purpose, composable.
// Every smoke script (smoke.mjs, smoke-user.mjs, and new ones) should build on these
// instead of re-implementing login/api/search/delete/reporting from scratch.
//
// Pattern: a script defines its own `scenarios` (or, for a linear flow like smoke.mjs,
// its own ordered `steps`) built out of these bricks, plus a small runner. See
// seat-enforcement-e2e.mjs (ng-icedq-admin-service session) for the scenario-runner shape
// this was lifted from.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

export function env(name, fallback = "") {
  return process.env[name] ?? fallback;
}

export function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

export function itemsOf(json) {
  if (!json || typeof json !== "object") return [];
  return json.items || json.results || json.content || (Array.isArray(json) ? json : []);
}

export function idOf(json) {
  return json?.id || json?.resourceId || itemsOf(json)[0]?.id || "";
}

export function snippet(res) {
  const j = res.json;
  if (!j) return res.text?.slice(0, 180) || "";
  if (Array.isArray(j)) return j[0]?.message || j[0]?.status || j[0]?.id || JSON.stringify(j).slice(0, 180);
  return j.message || j.detail || j.code || j.id || j.instanceId || j.userName || JSON.stringify(j).slice(0, 180);
}

// Login via Playwright (Keycloak), capture the Bearer token the UI uses, then close the browser.
// `postLoginPath` is a UI route to visit after sign-in so the app actually issues an API call
// carrying the token (some routes don't fire one on their own) — pass whatever route the
// calling script's login previously navigated to.
export async function login({ base, user, pass, postLoginPath = "/#/home", settleMs = 2000 }) {
  const launch = {
    headless: env("HEADED") !== "1",
    ignoreHTTPSErrors: true,
    args: ["--ignore-certificate-errors", "--no-sandbox", "--disable-dev-shm-usage"],
  };
  const chrome = env("PLAYWRIGHT_CHROME");
  if (chrome) launch.executablePath = chrome;
  const browser = await chromium.launch(launch);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  let bearer = "";
  page.on("request", (req) => {
    const a = req.headers()["authorization"];
    if (a?.startsWith("Bearer ")) bearer = a;
  });
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByRole("textbox", { name: /Username or email/i }).waitFor({ timeout: 30000 });
  await page.getByRole("textbox", { name: /Username or email/i }).fill(user);
  await page.getByRole("textbox", { name: /^Password$/i }).fill(pass);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/#\/home|rule-ui|icedq|#\//, { timeout: 30000 }).catch(() => {});
  if (postLoginPath) {
    await page.goto(`${base}${postLoginPath}`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  }
  await page.waitForTimeout(settleMs);
  await browser.close();
  if (!bearer) throw new Error("No Bearer token after login (Keycloak/UI failed)");
  const token = bearer.replace(/^Bearer\s+/i, "");
  return { bearer: token, userId: jwtSub(token) };
}

export function jwtSub(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return payload.sub || "";
  } catch {
    return "";
  }
}

export function jwtRoles(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return payload.realm_access?.roles || [];
  } catch {
    return [];
  }
}

// One call, one concern: method/path/body/headers in, {status,json,text} out.
// NOTE: POST/PUT/PATCH always send Content-Type + a JSON body (defaulting to `{}` when the
// caller passes no body) — several endpoints (e.g. workflow :validate/:publish) 415 without a
// Content-Type even on an empty-body POST. DELETE never forces a body/Content-Type. This
// matches the original smoke.mjs api() exactly — don't "simplify" it, it was already minimal
// and a stricter mutating-includes-DELETE version broke workflow publish in live testing.
export function api(base, bearer) {
  return async function call(method, path, body, extraHeaders = {}) {
    const mutating = method === "POST" || method === "PUT" || method === "PATCH";
    const headers = {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json, text/plain, */*",
      "Org-Id": env("ICEDQ_ORG_ID", "org-icedq"),
      ...extraHeaders,
    };
    if (mutating) headers["Content-Type"] = "application/json";
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: mutating ? JSON.stringify(body ?? {}) : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 300) };
    }
    return { status: res.status, json, text };
  };
}

// Try each attempt in order, keep the first that satisfies `ok` (default: 2xx). Composes with
// `call` from api() — pass a list of `() => call(...)` thunks, e.g. for an endpoint whose path
// has drifted between /api/v1/x and /api/v1/internal/x across environments.
export async function firstOk(attempts, ok = (r) => r.status >= 200 && r.status < 300) {
  let last = { status: 0, json: null, text: "" };
  for (const attempt of attempts) {
    last = await attempt();
    if (ok(last)) return last;
  }
  return last;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Delete dispatch: one entry point for every resource kind's delete-path fallback chain,
// plus a "getPath" fallback that treats a 404 as already-gone (idempotent cleanup).
const DELETE_PATHS = {
  workflow: (id) => [
    ["DELETE", `/api/v1/workflows/${id}`],
    ["DELETE", `/api/v1/internal/workflows/${id}`],
    ["POST", `/api/v1/internal/workflows/${id}:delete`, {}],
    ["POST", `/api/v1/internal/workflows:delete`, { ids: [id] }],
  ],
  rule: (id) => [
    ["DELETE", `/api/v1/rules/${id}`],
    ["POST", `/api/v1/internal/rules/${id}:delete`, {}],
    ["POST", `/api/v1/internal/rules:delete`, { ids: [id] }],
    ["POST", `/api/v1/internal/rules:delete`, [id]],
    ["DELETE", `/api/v1/internal/rules/${id}`],
  ],
  connection: (id) => [
    ["DELETE", `/api/v1/connections/${id}`],
    ["POST", `/api/v1/connections:delete`, { ids: [id] }],
  ],
  secret: (id) => [
    ["DELETE", `/api/v1/secret/${id}`],
    ["DELETE", `/api/v1/internal/secret/${id}`],
  ],
  folder: (id) => [
    ["DELETE", `/api/v1/folders/${id}`],
    ["POST", `/api/v1/folders:delete`, { ids: [id] }],
  ],
  workspace: (id) => [["DELETE", `/api/v1/workspaces/${id}`]],
  account: (id) => [["DELETE", `/api/v1/accounts/${id}`]],
  user: (id) => [["POST", `/api/v1/users:batchDelete`, [{ resource: "User", id }]]],
};

const GET_PATH = {
  workflow: (id) => `/api/v1/workflows/${id}`,
  rule: (id) => `/api/v1/rules/${id}`,
  connection: (id) => `/api/v1/connections/${id}`,
  secret: (id) => `/api/v1/secret/${id}`,
  folder: (id) => `/api/v1/folders/${id}`,
  workspace: (id) => `/api/v1/workspaces/${id}`,
  account: (id) => `/api/v1/accounts/${id}`,
  user: (id) => `/api/v1/users/${id}`,
};

// `call` is an api() closure. `extraHeaders` carries whatever Account-Id/Folder-Id/etc. the
// resource kind needs — same contract as every other brick here, nothing magic per-kind.
export async function remove(call, kind, id, extraHeaders = {}) {
  if (kind === "rule") {
    const got = await call("GET", `/api/v1/rules/${id}`, undefined, extraHeaders);
    if (got.status === 404 || got.json?.code === "ResultsNotFound") {
      return { status: 200, json: { code: "already gone" }, text: "" };
    }
    if (got.status >= 200 && got.status < 300 && got.json) {
      const del = await call("POST", "/api/v1/rules:batchDelete", [got.json], extraHeaders);
      if (del.status >= 200 && del.status < 300) return del;
    }
  }
  const attempts = (DELETE_PATHS[kind]?.(id) || []).map(
    ([method, path, body]) => () => call(method, path, body, extraHeaders)
  );
  const res = await firstOk(attempts);
  if (res.status >= 200 && res.status < 300) return res;
  const getPath = GET_PATH[kind]?.(id);
  if (getPath) {
    const g = await call("GET", getPath, undefined, extraHeaders);
    if (g.status === 404 || g.json?.code === "ResultsNotFound") {
      return { status: 200, json: { code: "already gone" }, text: "" };
    }
  }
  return res;
}

// Result recording + console line, shared across every smoke script so PASS/FAIL output and
// the JSON report shape stay identical no matter which script produced them.
export function makeRecorder() {
  const results = [];
  function note(name, status, pass, detail = "") {
    const row = { name, status, pass, detail: String(detail).slice(0, 240) };
    results.push(row);
    console.log(`${pass ? "PASS" : "FAIL"}  ${status}  ${name}${row.detail ? "  — " + row.detail : ""}`);
    return row;
  }
  return { results, note };
}

// Writes the standard `out/<prefix>-<timestamp>.json` report and returns its path.
export function writeReport(prefix, payload) {
  const outDir = join(process.cwd(), "out");
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}
