#!/usr/bin/env node
/**
 * Quick user-admin smoke (from Chrome DevTools HAR on .69).
 *
 * Creates a unique smk* user, finds it via search, then batch-deletes it.
 * Playwright login only. No Oracle / workspace required.
 *
 * Captured from Administration → Users → New User / Delete:
 *   POST /api/v1/users
 *   POST /api/v1/users/search?...
 *   POST /api/v1/users:batchDelete
 *
 *   ICEDQ_URL=https://192.168.100.69:32222 \
 *   ICEDQ_USER=admin ICEDQ_PASS='…' \
 *   node smoke-user.mjs
 *
 * ICEDQ_KEEP=1  — skip delete (debug)
 * ICEDQ_TEMP_PASS  — temp password for the new user (default SmokeTemp1!)
 * ICEDQ_ONLY=<scenario-name>  — run just one scenario by name
 *
 * Built from lib/bricks.mjs — see that file for the shared login/api/remove/report bricks
 * every smoke script here composes.
 */
import * as bricks from "./lib/bricks.mjs";
import { parseSmokeConfig } from "./lib/smoke-config.mjs";
import { createSmokeSession } from "./lib/smoke-session.mjs";

const config = parseSmokeConfig();
const { ctx, relogin, login } = createSmokeSession(config);
const TEMP_PASS = bricks.env("ICEDQ_TEMP_PASS", "SmokeTemp1!");
const userName = config.tag;

// ============================================================================
// Local bricks — specific to this script's domain (users), on top of lib/bricks.mjs
// ============================================================================

async function searchUsers(call, extraBody = {}) {
  return call(
    "POST",
    "/api/v1/users/search?pageNo=1&pageSize=100&sort=updatedTimestamp:desc&includeRoles=true",
    extraBody
  );
}

async function createUser(call, name, tempPass) {
  const body = {
    userName: name,
    firstName: "Smoke",
    lastName: "User",
    email: `${name}@example.com`,
    tempCredential: tempPass,
  };
  return call("POST", "/api/v1/users", body);
}

async function findUser(call, name, id) {
  const found = await searchUsers(call, { search: [{ attribute: "userName", operator: "Like", value: name }] });
  let hit = bricks.itemsOf(found.json).find((u) => u.userName === name || u.id === id);
  if (hit) return { res: found, hit };
  const broad = await searchUsers(call, { search: [{ attribute: "firstName", operator: "Like", value: name }] });
  hit = bricks.itemsOf(broad.json).find((u) => u.userName === name || u.id === id);
  if (hit) return { res: broad, hit };
  const all = await searchUsers(call, {});
  hit = bricks.itemsOf(all.json).find((u) => u.userName === name || u.id === id);
  return { res: all, hit };
}

// ============================================================================
// SCENARIOS — each composes bricks, self-contained enough to run via ICEDQ_ONLY
// ============================================================================

const scenarios = [];

scenarios.push({
  name: "sweep-leftover-smoke-users",
  async run({ call, note }) {
    const listed = await searchUsers(call, {});
    const leftovers = bricks
      .itemsOf(listed.json)
      .filter((u) => /^smk/i.test(u.userName || "") && u.userName !== "admin");
    for (const u of leftovers) {
      const del = await bricks.remove(call, "user", u.id);
      const ok = del.status >= 200 && del.status < 300;
      note("sweep user", del.status, ok, `${u.userName} ${u.id}`);
      if (!ok) throw new Error(`sweep failed for ${u.userName}`);
    }
    return `swept ${leftovers.length} leftover user(s)`;
  },
});

scenarios.push({
  name: "create-get-search-delete-user",
  async run({ call, note }) {
    let userId = "";
    try {
      const created = await createUser(call, userName, TEMP_PASS);
      userId = created.json?.id || "";
      const createOk = created.status >= 200 && created.status < 300 && userId;
      note("create user", created.status, createOk, createOk ? `${userName} ${userId}` : bricks.snippet(created));
      if (!createOk) throw new Error(`create user failed: ${bricks.snippet(created)}`);

      const got = await call("GET", `/api/v1/users/${userId}`);
      const getOk = got.status >= 200 && got.status < 300 && got.json?.userName === userName;
      note("get user", got.status, getOk, bricks.snippet(got));
      if (got.status >= 500) throw new Error(`get user 5xx: ${bricks.snippet(got)}`);

      const { res: found, hit } = await findUser(call, userName, userId);
      const searchOk = Boolean(hit);
      note("search user", found.status, searchOk, searchOk ? `found ${hit.userName} ${hit.id}` : bricks.snippet(found));
      if (!searchOk) throw new Error("search user did not find the created user");

      return `created, fetched, and found ${userName} (${userId})`;
    } finally {
      if (userId && !config.keep) {
        const del = await bricks.remove(call, "user", userId);
        const ok = del.status >= 200 && del.status < 300;
        note("delete user", del.status, ok, `${userName} ${userId} ${bricks.snippet(del)}`);
        if (!ok) throw new Error(`delete user failed: ${bricks.snippet(del)}`);
      } else if (config.keep && userId) {
        console.log(`KEEP=1 — left behind user ${userName} ${userId}`);
      }
    }
  },
});

// ============================================================================
// RUNNER
// ============================================================================

async function main() {
  console.log(
    `tag=${config.tag} host=${config.base} keep=${config.keep} user=${config.user}${config.only ? ` only=${config.only}` : ""}`
  );

  const { note, results } = bricks.makeRecorder();
  const adminLogin = () =>
    bricks.login({
      base: config.base,
      user: config.user,
      pass: config.pass,
      postLoginPath: "/#/admin/users",
      settleMs: 3000,
    });
  await relogin(adminLogin);
  const runCtx = { call: ctx.call, note };

  // Each scenario records its own sub-step PASS/FAIL rows via `note` (same granularity the
  // original single-flow script had — one row per REST call, not one row per scenario). The
  // runner only adds a row when a scenario throws, so an aborted scenario is still visible.
  let failed = false;
  for (const s of scenarios) {
    if (config.only && s.name !== config.only) continue;
    try {
      await s.run(runCtx);
    } catch (err) {
      note(`scenario:${s.name}`, 0, false, err.message || String(err));
      failed = true;
    }
  }

  const report = bricks.writeReport("smoke-user", {
    base: config.base,
    tag: config.tag,
    userName,
    keep: config.keep,
    results,
  });
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed. Report: ${report}`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exitCode = 1;
});
