#!/usr/bin/env node
/**
 * Lego-brick end-to-end test suite for DSO-2224 (UserSeatLicenseValidator).
 *
 * Won't pass against today's server — nothing enforces these fields yet. Point it at a
 * deployed build once Steps 0-5 ship, with icedq.license.seat-enforcement-enabled=true.
 *
 * Design: shared bricks from ../lib/bricks.mjs (login, api) + local domain bricks
 * (createUser, grantAccountRole, grantWorkspaceRole, countSeats) + a scenario runner. Each
 * scenario is a short function built out of bricks, not a monolithic script — add a new
 * scenario by composing existing bricks, not copy-pasting.
 *
 * Outcomes are PREDICTED from live state before acting (reuses seat-audit's counting logic as a
 * brick), not hardcoded "assume under limit" — real tenants can already be over (see seat-audit.mjs
 * findings: 192.168.100.81 was 40 over the default). A scenario that needs "definitely under limit"
 * room creates its own throwaway account/workspace so it isn't fighting the tenant's existing state.
 *
 *   ICEDQ_URL=https://host:32222 ICEDQ_USER=admin ICEDQ_PASS='…' node seat-enforcement-e2e.mjs
 *
 * ICEDQ_KEEP=1   — skip cleanup (debug)
 * ICEDQ_ONLY=<scenario-name>  — run just one scenario by name
 */
import * as lib from "../lib/bricks.mjs";

const BASE = lib.env("ICEDQ_URL").replace(/\/$/, "");
const USER = lib.env("ICEDQ_USER", "admin");
const PASS = lib.env("ICEDQ_PASS");
const KEEP = lib.env("ICEDQ_KEEP") === "1";
const ONLY = lib.env("ICEDQ_ONLY", "");
const TAG = `seat${Date.now().toString(36).slice(-6)}`;

if (!BASE) { console.error("Set ICEDQ_URL"); process.exit(2); }
if (!PASS) { console.error("Set ICEDQ_PASS"); process.exit(2); }

// ============================================================================
// DOMAIN BRICKS — specific to seat-limit testing, on top of ../lib/bricks.mjs's generic ones
// ============================================================================

const bricks = {};

bricks.createUser = async function createUser(call, suffix) {
  const userName = `${TAG}_${suffix}`;
  const res = await call("POST", "/api/v1/users", {
    userName,
    firstName: "Seat",
    lastName: "Test",
    email: `${userName}@example.com`,
    tempCredential: "SeatTest1!",
  });
  const id = res.json?.id;
  if (res.status >= 300 || !id) throw new Error(`createUser(${suffix}) failed: ${res.status} ${JSON.stringify(res.json)}`);
  return { id, userName };
};

bricks.deleteUser = async function deleteUser(call, id) {
  return lib.remove(call, "user", id);
};

bricks.createAccount = async function createAccount(call, suffix) {
  const name = `${TAG}_acct_${suffix}`;
  const res = await call("POST", "/api/v1/accounts", { name, description: `seat-e2e ${TAG}` });
  const id = res.json?.id;
  if (res.status >= 300 || !id) throw new Error(`createAccount(${suffix}) failed: ${res.status} ${JSON.stringify(res.json)}`);
  return { id, name };
};

bricks.deleteAccount = async function deleteAccount(call, id) {
  return lib.remove(call, "account", id);
};

// The actual thing under test: grant a role on an account, USER or GROUP target.
bricks.grantAccountRole = async function grantAccountRole(call, accountId, members) {
  // members: [{ id, type: "User"|"Group", role: "Owner"|"Reader"|..., resource: "User"|"Group" }]
  return call("POST", `/api/v1/accounts/${accountId}:grantAccess`, members, { "Account-Id": accountId });
};

bricks.grantWorkspaceRole = async function grantWorkspaceRole(call, accountId, workspaceId, members) {
  return call("POST", `/api/v1/workspaces/${workspaceId}:grantAccess`, members, {
    "Account-Id": accountId,
    "Workspace-Id": workspaceId,
  });
};

// Reuses the SAME counting logic as seat-audit.mjs — the prediction engine. Kept as one brick
// so both tools stay in sync; if this drifts from UserSeatLicenseValidator's real logic, both
// the audit tool and this predictor are wrong the same way, which at least fails loudly when
// compared against the real Java behavior (see seat-audit.mjs README, point 2).
const READER = "Reader";
bricks.countSeats = async function countSeats(call) {
  const [accountsRes, workspacesRes] = await Promise.all([
    call("POST", "/api/v1/accounts/search?pageNo=1&pageSize=5000&sort=updatedTimestamp:desc", {}),
    call("POST", "/api/v1/workspaces/search?pageNo=1&pageSize=5000&sort=updatedTimestamp:desc", {}),
  ]);
  const resources = [
    ...lib.itemsOf(accountsRes.json).map((a) => ({ kind: "accounts", id: a.id })),
    ...lib.itemsOf(workspacesRes.json).map((w) => ({ kind: "workspaces", id: w.id })),
  ];
  const roleByUser = new Map();
  for (const r of resources) {
    const res = await call("GET", `/api/v1/${r.kind}/${r.id}/memberList`);
    if (res.status >= 400 || !Array.isArray(res.json)) continue;
    for (const m of res.json) {
      if (m.type !== "User" || !m.userName) continue;
      if (!roleByUser.has(m.userName)) roleByUser.set(m.userName, new Set());
      roleByUser.get(m.userName).add(m.role);
    }
  }
  let fullAccess = 0, readOnly = 0;
  for (const [, roles] of roleByUser) {
    const onlyReader = [...roles].every((r) => r === READER);
    if (onlyReader) readOnly++; else fullAccess++;
  }
  return { fullAccess, readOnly };
};

// Predicts what the grant SHOULD do, given live state + configured limit — the thing this
// suite actually checks, since we can't assume "under limit" on a real tenant.
bricks.predict = function predict(currentCount, limit, newPromotions) {
  return currentCount + newPromotions > limit ? "blocked" : "allowed";
};

function expectStatus(actualStatus, expected) {
  const actualBucket = actualStatus === 423 ? "blocked" : actualStatus < 300 ? "allowed" : "error";
  if (actualBucket !== expected) {
    throw new Error(`expected ${expected}, got HTTP ${actualStatus} (bucket=${actualBucket})`);
  }
}

// ============================================================================
// SCENARIOS — each one composes bricks, nothing hardcoded about "assume under limit"
// ============================================================================

const { note, results } = lib.makeRecorder();

const scenarios = [];

scenarios.push({
  name: "full-access-grant-matches-prediction",
  async run({ call }) {
    const before = await bricks.countSeats(call);
    const limit = parseInt(lib.env("ICEDQ_LIMIT_FULL", "10"), 10);
    const expected = bricks.predict(before.fullAccess, limit, 1);

    const acct = await bricks.createAccount(call, "fa");
    const user = await bricks.createUser(call, "fa");
    try {
      const grant = await bricks.grantAccountRole(call, acct.id, [
        { id: user.id, type: "User", role: "Owner", resource: "User" },
      ]);
      expectStatus(grant.status, expected);
      return `predicted ${expected}, confirmed (before: full-access=${before.fullAccess}/${limit})`;
    } finally {
      if (!KEEP) {
        await bricks.deleteUser(call, user.id);
        await bricks.deleteAccount(call, acct.id);
      }
    }
  },
});

scenarios.push({
  name: "reader-grant-matches-prediction",
  async run({ call }) {
    const before = await bricks.countSeats(call);
    const limit = parseInt(lib.env("ICEDQ_LIMIT_READONLY", "10"), 10);
    const expected = bricks.predict(before.readOnly, limit, 1);

    const acct = await bricks.createAccount(call, "ro");
    const user = await bricks.createUser(call, "ro");
    try {
      const grant = await bricks.grantAccountRole(call, acct.id, [
        { id: user.id, type: "User", role: "Reader", resource: "User" },
      ]);
      expectStatus(grant.status, expected);
      return `predicted ${expected}, confirmed (before: read-only=${before.readOnly}/${limit})`;
    } finally {
      if (!KEEP) {
        await bricks.deleteUser(call, user.id);
        await bricks.deleteAccount(call, acct.id);
      }
    }
  },
});

scenarios.push({
  name: "already-full-access-user-granted-reader-is-not-a-new-promotion",
  async run({ call }) {
    const acct = await bricks.createAccount(call, "promo");
    const acct2 = await bricks.createAccount(call, "promo2");
    const user = await bricks.createUser(call, "promo");
    try {
      const first = await bricks.grantAccountRole(call, acct.id, [
        { id: user.id, type: "User", role: "Owner", resource: "User" },
      ]);
      if (first.status >= 300) throw new Error(`setup grant failed: ${first.status}`);

      const second = await bricks.grantAccountRole(call, acct2.id, [
        { id: user.id, type: "User", role: "Reader", resource: "User" },
      ]);
      expectStatus(second.status, "allowed");
      return "Reader grant on top of existing full-access role succeeded, as expected";
    } finally {
      if (!KEEP) {
        await bricks.deleteUser(call, user.id);
        await bricks.deleteAccount(call, acct.id);
        await bricks.deleteAccount(call, acct2.id);
      }
    }
  },
});

scenarios.push({
  name: "reader-only-user-upgraded-to-owner-consumes-a-full-access-seat",
  async run({ call }) {
    // Adversarial-review case (DSO-2224 plan, finding #14): a user who currently holds ONLY
    // Reader must be treated as a NEW full-access promotion when upgraded — the earlier plan
    // pseudocode had a self-contradiction that could have let this be a free bypass.
    const before = await bricks.countSeats(call);
    const limit = parseInt(lib.env("ICEDQ_LIMIT_FULL", "10"), 10);
    const expected = bricks.predict(before.fullAccess, limit, 1);

    const acct = await bricks.createAccount(call, "upg");
    const acct2 = await bricks.createAccount(call, "upg2");
    const user = await bricks.createUser(call, "upg");
    try {
      const readerGrant = await bricks.grantAccountRole(call, acct.id, [
        { id: user.id, type: "User", role: "Reader", resource: "User" },
      ]);
      if (readerGrant.status >= 300) throw new Error(`setup Reader grant failed: ${readerGrant.status}`);

      const upgrade = await bricks.grantAccountRole(call, acct2.id, [
        { id: user.id, type: "User", role: "Owner", resource: "User" },
      ]);
      expectStatus(upgrade.status, expected);
      return `Reader→Owner upgrade predicted ${expected}, confirmed (before: full-access=${before.fullAccess}/${limit}) — not a free bypass`;
    } finally {
      if (!KEEP) {
        await bricks.deleteUser(call, user.id);
        await bricks.deleteAccount(call, acct.id);
        await bricks.deleteAccount(call, acct2.id);
      }
    }
  },
});

scenarios.push({
  name: "batch-of-two-promotions-matches-prediction",
  async run({ call }) {
    const before = await bricks.countSeats(call);
    const limit = parseInt(lib.env("ICEDQ_LIMIT_FULL", "10"), 10);
    const expected = bricks.predict(before.fullAccess, limit, 2); // both count together

    const acct = await bricks.createAccount(call, "batch");
    const u1 = await bricks.createUser(call, "batch1");
    const u2 = await bricks.createUser(call, "batch2");
    try {
      const grant = await bricks.grantAccountRole(call, acct.id, [
        { id: u1.id, type: "User", role: "Owner", resource: "User" },
        { id: u2.id, type: "User", role: "Owner", resource: "User" },
      ]);
      expectStatus(grant.status, expected);
      return `2-member batch predicted ${expected} (before: full-access=${before.fullAccess}/${limit}, +2 in one call)`;
    } finally {
      if (!KEEP) {
        await bricks.deleteUser(call, u1.id);
        await bricks.deleteUser(call, u2.id);
        await bricks.deleteAccount(call, acct.id);
      }
    }
  },
});

scenarios.push({
  name: "group-only-batch-is-a-no-op",
  async run({ call }) {
    const groupsRes = await call("POST", "/api/v1/groups/search?pageNo=1&pageSize=1&sort=updatedTimestamp:desc", {});
    const group = lib.itemsOf(groupsRes.json)[0];
    if (!group) return "SKIPPED — no groups exist on this tenant to test with";

    const acct = await bricks.createAccount(call, "group");
    try {
      const grant = await bricks.grantAccountRole(call, acct.id, [
        { id: group.id, type: "Group", role: "Owner", resource: "Group" },
      ]);
      // Documented v1 scope gap: GROUP grants are never blocked, regardless of seat state.
      expectStatus(grant.status, "allowed");
      return `GROUP-only batch succeeded unconditionally (documented v1 gap, group=${group.name})`;
    } finally {
      if (!KEEP) await bricks.deleteAccount(call, acct.id);
    }
  },
});

scenarios.push({
  name: "service-account-target-is-excluded",
  async run({ call }) {
    const saRes = await call("POST", "/api/v1/serviceaccounts/search?pageNo=1&pageSize=1&sort=updatedTimestamp:desc", {});
    const sa = lib.itemsOf(saRes.json)[0];
    if (!sa) return "SKIPPED — no service accounts exist on this tenant to test with";

    const acct = await bricks.createAccount(call, "sa");
    try {
      const grant = await bricks.grantAccountRole(call, acct.id, [
        { id: sa.id, type: "User", role: "Owner", resource: "User" },
      ]);
      // Excluded from the seat check entirely — must succeed even if full-access is at/over limit.
      expectStatus(grant.status, "allowed");
      return `service-account grant succeeded unconditionally, as expected (sa=${sa.name || sa.id})`;
    } finally {
      if (!KEEP) await bricks.deleteAccount(call, acct.id);
    }
  },
});

// ============================================================================
// RUNNER
// ============================================================================

async function main() {
  console.log(`tag=${TAG} host=${BASE} keep=${KEEP}${ONLY ? ` only=${ONLY}` : ""}`);
  console.log("NOTE: requires Steps 0-5 deployed AND icedq.license.seat-enforcement-enabled=true.\n");

  const { bearer } = await lib.login({ base: BASE, user: USER, pass: PASS, postLoginPath: "/#/home" });
  const call = lib.api(BASE, bearer);
  const ctx = { call };

  let failed = false;
  for (const s of scenarios) {
    if (ONLY && s.name !== ONLY) continue;
    try {
      const detail = await s.run(ctx);
      note(s.name, 200, true, detail);
    } catch (err) {
      note(s.name, 0, false, err.message || String(err));
      failed = true;
    }
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed.`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exitCode = 1;
});
