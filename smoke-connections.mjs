#!/usr/bin/env node
/**
 * Connection-matrix smoke: create + test every catalog entry.
 *
 *   ICEDQ_URL=https://192.168.100.44:32222 \
 *   ICEDQ_USER=admin ICEDQ_PASS='…' \
 *   ICEDQ_CONN_05_DB2_PASS='…' … ICEDQ_DB_PASS='…' … \
 *   node smoke-connections.mjs
 *
 * See .env.example for all ICEDQ_CONN_*_PASS vars.
 *
 * ICEDQ_ONLY=15-oracle-up,14-mysql   — run specific catalog ids
 * ICEDQ_SR=15                        — run all variants for SR#
 * ICEDQ_KEEP=1                       — skip cleanup
 * ICEDQ_TEST=0                       — create only, skip :test
 */
import * as bricks from "./lib/bricks.mjs";
import { catalogEntries } from "./lib/connections-catalog.mjs";
import { cleanupConnections, runCatalogEntry } from "./lib/connection-bricks.mjs";
import { parseSmokeConfig } from "./lib/smoke-config.mjs";
import { createSmokeSession } from "./lib/smoke-session.mjs";
import { setupSmokeWorkspace, sweepLeftoverConnections } from "./lib/smoke-workspace.mjs";

const config = parseSmokeConfig();
const { ctx, relogin, hdr, login } = createSmokeSession(config);

const names = {
  account: `${config.tag}-acct`,
  workspace: `${config.tag}-conn-ws`,
};
const entries = catalogEntries({ only: config.only, sr: config.sr });
const { note, results } = bricks.makeRecorder();
const created = [];

async function main() {
  await relogin(login);

  console.log(
    `tag=${config.tag} host=${config.base} entries=${entries.length} test=${config.doTest} keep=${config.keep} user=${config.user}`
  );
  if (!ctx.userId) throw new Error("JWT has no sub — cannot grant Owner");

  const ws = await setupSmokeWorkspace({
    call: ctx.call,
    relogin: () => relogin(login),
    getBearer: () => ctx.bearer,
    userId: ctx.userId,
    tag: config.tag,
    names,
    created,
    note,
    reuseWorkspace: config.reuseWorkspace,
    workspaceName: config.workspaceName,
    accountName: config.accountName,
  });
  ctx.workspaceId = ws.workspaceId;
  ctx.accountId = ws.accountId;
  ctx.createdWorkspace = ws.createdWorkspace;

  await sweepLeftoverConnections(ctx, note, config.tag.slice(0, 3));

  for (const entry of entries) {
    try {
      await runCatalogEntry({
        ctx,
        hdr,
        note,
        entry,
        tag: config.tag,
        created,
        doTest: config.doTest,
      });
    } catch (err) {
      note(`fail ${entry.id}`, 0, false, err.message || String(err));
    }
  }

  if (!config.keep) {
    await cleanupConnections({ call: ctx.call, created, note, accountId: ctx.accountId });
    if (ws.createdWorkspace) {
      const res = await bricks.remove(ctx.call, "workspace", ws.workspaceId, { "Account-Id": ctx.accountId });
      note("delete workspace", res.status, res.status >= 200 && res.status < 300, ws.workspaceId);
    }
  }

  const report = bricks.writeReport("smoke-connections", {
    base: config.base,
    tag: config.tag,
    workspaceId: ctx.workspaceId,
    accountId: ctx.accountId,
    entries: entries.map((e) => e.id),
    created,
    results,
    keep: config.keep,
  });
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed. Report: ${report}`);
  if (results.some((r) => !r.pass)) process.exitCode = 1;
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exitCode = 1;
});
