#!/usr/bin/env node
/**
 * Seat-limit audit for DSO-2224 — runs the SAME logic UserSeatLicenseValidator will run,
 * against a real environment, before any Java code exists. Two jobs:
 *
 *   1. Pre-flight check: "if I flip icedq.license.seat-enforcement-enabled on for this
 *      tenant today, would it already be over users_full_access / users_read_only?"
 *      This is the AUDIT-mode tool the DSO-2224 plan's rollout flag needs.
 *
 *   2. Quantifies the GROUP-type scope gap with real numbers: reports full-access/read-only
 *      counts two ways — "USER-grants only" (what v1 will actually check) vs
 *      "USER + GROUP-expanded" (what a complete check would see) — so the gap isn't
 *      just a documented sentence, it's a measured delta on this environment.
 *
 * Read-only. Makes zero grantAccess/write calls. Endpoints confirmed live via Chrome DevTools
 * against 192.168.100.81:
 *   POST /api/v1/accounts/search, GET /api/v1/accounts/{id}/memberList
 *   POST /api/v1/workspaces/search (assumed symmetric), GET /api/v1/workspaces/{id}/memberList
 *   GET /api/v1/groups/{id}/userList (to expand GROUP-type grants)
 *
 *   ICEDQ_URL=https://192.168.100.81:32222 \
 *   ICEDQ_USER=admin ICEDQ_PASS='…' \
 *   node seat-audit.mjs
 *
 * ICEDQ_LIMIT_FULL=10 ICEDQ_LIMIT_READONLY=10   — override for a "what-if I set the limit to N" check
 *
 * Built from ../lib/bricks.mjs — see that file for the shared login/api bricks.
 */
import * as bricks from "../lib/bricks.mjs";

const BASE = bricks.env("ICEDQ_URL").replace(/\/$/, "");
const USER = bricks.env("ICEDQ_USER", "admin");
const PASS = bricks.env("ICEDQ_PASS");
const LIMIT_FULL = parseInt(bricks.env("ICEDQ_LIMIT_FULL", "10"), 10);
const LIMIT_READONLY = parseInt(bricks.env("ICEDQ_LIMIT_READONLY", "10"), 10);

if (!BASE) { console.error("Set ICEDQ_URL"); process.exit(2); }
if (!PASS) { console.error("Set ICEDQ_PASS"); process.exit(2); }

async function searchAll(call, kind) {
  const res = await call("POST", `/api/v1/${kind}/search?pageNo=1&pageSize=5000&sort=updatedTimestamp:desc`, {});
  if (res.status >= 400) return [];
  return bricks.itemsOf(res.json);
}

async function memberList(call, kind, id) {
  const res = await call("GET", `/api/v1/${kind}/${id}/memberList`);
  if (res.status >= 400) return null; // e.g. workspaces endpoint not confirmed live — degrade gracefully
  return Array.isArray(res.json) ? res.json : [];
}

const groupMemberCache = new Map();
async function expandGroup(call, groupId) {
  if (groupMemberCache.has(groupId)) return groupMemberCache.get(groupId);
  const res = await call("GET", `/api/v1/groups/${groupId}/userList`);
  const users = res.status < 400 && Array.isArray(res.json) ? res.json : [];
  groupMemberCache.set(groupId, users);
  return users;
}

const READER = "Reader";

function classify(map) {
  let fullAccess = 0, readOnly = 0;
  for (const [, roles] of map) {
    const onlyReader = [...roles].every((r) => r === READER);
    if (onlyReader) readOnly++; else fullAccess++;
  }
  return { fullAccess, readOnly, totalDistinctUsers: map.size };
}

function record(map, userName, role) {
  if (!map.has(userName)) map.set(userName, new Set());
  map.get(userName).add(role);
}

async function main() {
  console.log(`Logging into ${BASE} as ${USER}...`);
  const { bearer } = await bricks.login({ base: BASE, user: USER, pass: PASS, postLoginPath: "/#/admin/system/accounts", settleMs: 2000 });
  const call = bricks.api(BASE, bearer);
  console.log("Logged in.\n");

  const accounts = await searchAll(call, "accounts");
  const workspaces = await searchAll(call, "workspaces");
  console.log(`Found ${accounts.length} account(s), ${workspaces.length} workspace(s).\n`);

  const roleByUser = new Map();
  const roleByUserWithGroups = new Map();
  const groupGrants = [];
  const skippedResources = [];

  const resources = [
    ...accounts.map((a) => ({ kind: "accounts", id: a.id, name: a.name })),
    ...workspaces.map((w) => ({ kind: "workspaces", id: w.id, name: w.name })),
  ];

  for (const r of resources) {
    const members = await memberList(call, r.kind, r.id);
    if (members === null) {
      skippedResources.push(`${r.kind}/${r.name} (memberList endpoint not available)`);
      continue;
    }
    for (const m of members) {
      if (m.type === "User" && m.userName) {
        record(roleByUser, m.userName, m.role);
        record(roleByUserWithGroups, m.userName, m.role);
      } else if (m.type === "Group") {
        groupGrants.push({ resourceKind: r.kind, resourceName: r.name, groupName: m.name, role: m.role, groupId: m.id });
      }
    }
  }

  for (const g of groupGrants) {
    const users = await expandGroup(call, g.groupId);
    for (const u of users) {
      const uname = u.userName || u.username;
      if (!uname) continue;
      record(roleByUserWithGroups, uname, g.role);
    }
  }

  const userOnly = classify(roleByUser);
  const withGroups = classify(roleByUserWithGroups);

  console.log("=== Seat count: USER-grants only (what v1 UserSeatLicenseValidator will actually see) ===");
  console.log(`  full-access: ${userOnly.fullAccess}   read-only: ${userOnly.readOnly}   distinct users: ${userOnly.totalDistinctUsers}`);
  console.log(`  vs configured limits — users_full_access=${LIMIT_FULL}: ${userOnly.fullAccess > LIMIT_FULL ? `OVER by ${userOnly.fullAccess - LIMIT_FULL}` : "within limit"}`);
  console.log(`                          users_read_only=${LIMIT_READONLY}: ${userOnly.readOnly > LIMIT_READONLY ? `OVER by ${userOnly.readOnly - LIMIT_READONLY}` : "within limit"}`);

  console.log("\n=== Seat count: USER + GROUP-expanded (what a complete check would see) ===");
  console.log(`  full-access: ${withGroups.fullAccess}   read-only: ${withGroups.readOnly}   distinct users: ${withGroups.totalDistinctUsers}`);
  console.log(`  delta from group-expansion: +${withGroups.totalDistinctUsers - userOnly.totalDistinctUsers} distinct users newly visible`);

  console.log(`\n=== Group grants found (${groupGrants.length}) — invisible to v1's USER-only check ===`);
  for (const g of groupGrants) {
    console.log(`  ${g.groupName} → ${g.role} on ${g.resourceKind}/${g.resourceName}`);
  }

  if (skippedResources.length) {
    console.log(`\n=== Skipped (endpoint not confirmed live) ===`);
    skippedResources.forEach((s) => console.log(`  ${s}`));
  }

  console.log("\n=== Verdict ===");
  if (userOnly.fullAccess > LIMIT_FULL || userOnly.readOnly > LIMIT_READONLY) {
    console.log("  DO NOT enable icedq.license.seat-enforcement-enabled for this tenant yet —");
    console.log("  it is already over at least one limit and would be locked out of granting any new access.");
    process.exitCode = 1;
  } else {
    console.log("  Safe to enable seat-enforcement for this tenant against these limits today.");
  }
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exitCode = 1;
});
