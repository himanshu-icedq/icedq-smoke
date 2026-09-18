#!/usr/bin/env node
/**
 * Ephemeral iceDQ smoke: create fixtures → test/run → delete them.
 *
 * Playwright login only. No iceDQ CLI, no MCP, no Java.
 *
 *   ICEDQ_URL=https://192.168.100.69:32222 \
 *   ICEDQ_USER=admin ICEDQ_PASS='…' \
 *   ICEDQ_DB_HOST=192.168.100.126 ICEDQ_DB_PORT=1521 \
 *   ICEDQ_DB_NAME=orcl ICEDQ_DB_USER=regression_database \
 *   ICEDQ_DB_PASS='…' \
 *   node smoke.mjs
 *
 * ICEDQ_KEEP=1              — skip cleanup (debug)
 * ICEDQ_REUSE_WORKSPACE=1   — skip account/workspace create; use ICEDQ_WORKSPACE
 * ICEDQ_ACCOUNT=mcp-demo    — preferred fallback account when create is blocked
 */
import * as bricks from "./lib/bricks.mjs";
import { createSecret, createConnection, testConnection } from "./lib/connection-bricks.mjs";
import { parseSmokeConfig, PROTECTED_NAMES } from "./lib/smoke-config.mjs";
import { createSmokeSession } from "./lib/smoke-session.mjs";
import {
  setupSmokeWorkspace,
  sweepLeftoverFixtures,
  sweepLeftoverWorkspaces,
} from "./lib/smoke-workspace.mjs";

const config = parseSmokeConfig({ requireDbPass: true });
const { ctx, relogin, hdr, login } = createSmokeSession(config);

const names = {
  account: `${config.tag}-acct`,
  workspace: `${config.tag}-ws`,
  secret: config.tag,
  folder: config.tag,
  connection: `${config.tag}-ORACLE`,
  rule: `${config.tag}-RULE`,
  workflow: `${config.tag}-WF`,
};

const oracleEntry = {
  id: "oracle",
  connectorId: "oracle",
  driverId: "oracle",
  serviceProviderName: "oracle",
  host: config.dbHost,
  port: config.dbPort,
  database: config.dbName,
  username: config.dbUser,
  password: config.dbPass,
  secretKey: config.secretKey,
  jdbcUrlTemplate: "jdbc:oracle:thin:@[host]:[port]:[database]",
  serverInstanceName: "Test",
};

const { note, results } = bricks.makeRecorder();
const created = [];

async function waitRun(call, instanceId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const g = await call("GET", `/api/v1/workflowruns/${instanceId}`);
    if (g.status >= 200 && g.status < 300) last = g.json;
    const logs = await call("GET", `/api/v1/workflowruns/${instanceId}/logs`);
    const logText = typeof logs.json === "string" ? logs.json : logs.json?.raw || logs.text || "";
    if (/Total Exit Code:\s*0/i.test(logText)) {
      return { ...(last || {}), status: "success", exitCode: 0, instanceId };
    }
    const st = String(last?.status || "").toLowerCase();
    if (st === "success") return last;
    const logFailed = /Total Exit Code:\s*[1-9]/i.test(logText);
    if (logFailed || (st && st !== "running" && st !== "submitted" && st !== "queued" && st !== "error")) {
      return last;
    }
    if (st === "error" && logText && logFailed) return last;
    const s = await call(
      "POST",
      "/api/v1/workflowruns/search?pageNo=1&pageSize=50&sort=objectInstanceId:desc",
      {}
    );
    const hit = bricks
      .itemsOf(s.json)
      .find((i) => String(i.objectInstanceId || i.instanceId || i.id) === String(instanceId));
    if (hit) {
      last = hit;
      if (String(hit.status || "").toLowerCase() === "success") return hit;
    }
    await bricks.sleep(3000);
  }
  return last;
}

async function triggerAndWait(call, objectId, label) {
  let lastFail = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const trig = await call("POST", "/api/v1/workflow:trigger", { objectId });
    const instanceId = trig.json?.instanceId ?? trig.json?.objectInstanceId;
    const trigOk = trig.status >= 200 && trig.status < 300 && instanceId != null;
    if (!trigOk) {
      lastFail = bricks.snippet(trig);
      note(`trigger ${label}`, trig.status, false, lastFail);
      if (attempt === 1) await bricks.sleep(4000);
      continue;
    }
    const done = await waitRun(call, instanceId);
    const st = String(done?.status || "").toLowerCase();
    const exit = done?.exitCode;
    const ok = st === "success" || String(exit) === "0";
    if (ok) {
      note(`trigger ${label}`, trig.status, true, `instance ${instanceId}`);
      note(`run ${label}`, 200, true, `instance ${instanceId} status=${done?.status} exit=${exit ?? "?"}`);
      return true;
    }
    lastFail = `instance ${instanceId} status=${done?.status} exit=${exit ?? "?"}`;
    if (attempt === 1) await bricks.sleep(4000);
  }
  note(`trigger ${label}`, 200, true, lastFail);
  note(`run ${label}`, 500, false, lastFail);
  return false;
}

async function createFolder() {
  const folder = await bricks.firstOk([
    hdr("POST", "/api/v1/folders", { name: names.folder }),
    hdr("POST", "/api/v1/internal/folders", { name: names.folder }),
  ]);
  const folderId = bricks.idOf(folder.json);
  if (!(folder.status >= 200 && folder.status < 300 && folderId)) {
    note("create folder", folder.status, false, bricks.snippet(folder));
    throw new Error(`create folder failed: ${bricks.snippet(folder)}`);
  }
  ctx.folderIdHdr = folderId;
  created.push({ kind: "folder", id: folderId, name: names.folder });
  note("create folder", folder.status, true, `${names.folder} ${folderId}`);
  return folderId;
}

async function createAndPublishRule(connectionId, folderId) {
  ctx.folderIdHdr = folderId;
  const ruleBody = {
    name: names.rule,
    folderId,
    template: "pushdown",
    ruleType: "Pushdown",
    isActive: true,
    properties: {
      criticality: "Warning",
      engineType: "HighThroughput",
      stopAtFailAndErrorCount: 0,
      stopAtRowCount: 0,
      stopAtTime: 0,
      degreeOfParallelism: 1,
      engineInfo: {},
      languageType: "groovy",
      ruleSpanType: "short",
    },
    objects: [
      {
        id: "SourceDataset",
        type: "source",
        name: "sourceDataset",
        connectionType: "Database",
        connectionId,
        input: "Sql",
        configuration: {
          sql: "SELECT 1 AS X FROM DUAL WHERE 1=0",
          isDeferredSort: false,
          columns: [{ index: 1, name: "X", datatype: "NUMBER", icedqDatatype: "NUMERIC" }],
        },
      },
      {
        id: "RecordCheck",
        type: "recordCheck",
        name: "checks",
        configuration: {
          checks: [
            {
              name: "resulttype",
              index: 1,
              isActive: true,
              isVisible: true,
              expression: { caseInsensitive: false, values: ["RowCount"] },
              type: "ResultType",
            },
            {
              name: "Fyi_s_x",
              index: 2,
              isActive: true,
              isVisible: true,
              expression: { value: "S.[X]", caseInsensitive: false },
              type: "Column",
            },
          ],
        },
      },
      {
        id: "Report",
        type: "report",
        name: "exceptionReport",
        configuration: {
          exportFileRowLimit: "20000",
          exportOnlyRowLimit: "20000",
          createExportDownloadLink: true,
          storeOnlyException: false,
          storeOnlyExportedFile: false,
          format: ["XLSX"],
          loadExceptions: false,
        },
      },
      {
        id: "Summary",
        type: "summary",
        name: "summary",
        configuration: {
          checks: [
            {
              name: "exitcode",
              index: 1,
              isActive: true,
              isVisible: true,
              expression: { value: "exitcode", caseInsensitive: false },
              isOverride: false,
            },
          ],
        },
      },
    ],
  };
  const rule = await bricks.firstOk([
    hdr("POST", "/api/v1/internal/rules", ruleBody),
    hdr("POST", "/api/v1/rules", ruleBody),
  ]);
  const ruleId = bricks.idOf(rule.json);
  if (!(rule.status >= 200 && rule.status < 300 && ruleId)) {
    note("create rule", rule.status, false, bricks.snippet(rule));
    throw new Error(`create rule failed: ${bricks.snippet(rule)}`);
  }
  created.push({ kind: "rule", id: ruleId, name: names.rule });
  note("create rule", rule.status, true, `${names.rule} ${ruleId}`);
  const pub = await bricks.firstOk([
    hdr("POST", `/api/v1/internal/rules/${ruleId}:publish`, {}),
    hdr("POST", `/api/v1/rules/${ruleId}:publish`, {}),
  ]);
  const pubOk = pub.status >= 200 && pub.status < 300;
  note("publish rule", pub.status, pubOk, bricks.snippet(pub));
  if (!pubOk) throw new Error(`publish rule failed: ${bricks.snippet(pub)}`);
  return ruleId;
}

async function createAndPublishWorkflow(ruleId, folderId) {
  const wfBody = {
    name: names.workflow,
    folderId,
    workflowType: "Custom",
    template: "Sequential",
    isActive: true,
    properties: { engineType: "Sequential" },
    activities: [
      {
        index: 1,
        name: names.rule,
        type: "ExecuteRule",
        objectId: ruleId,
        objectType: "Pushdown",
        dependency: { onSuccess: "continue", onFailure: "continue", onError: "continue" },
        properties: { useExitCode: true, isActive: true },
      },
    ],
  };
  const wf = await bricks.firstOk([
    hdr("POST", "/api/v1/internal/workflows", wfBody),
    hdr("POST", "/api/v1/workflows", wfBody),
  ]);
  const workflowId = bricks.idOf(wf.json);
  if (!(wf.status >= 200 && wf.status < 300 && workflowId)) {
    note("create workflow", wf.status, false, bricks.snippet(wf));
    throw new Error(`create workflow failed: ${bricks.snippet(wf)}`);
  }
  created.push({ kind: "workflow", id: workflowId, name: names.workflow });
  note("create workflow", wf.status, true, `${names.workflow} ${workflowId}`);

  await ctx.call("POST", `/api/v1/internal/workflows/${workflowId}:validate`, undefined, {
    "Folder-Id": ctx.folderIdHdr,
  });
  const pub = await ctx.call("POST", `/api/v1/internal/workflows/${workflowId}:publish`, undefined, {
    "Folder-Id": ctx.folderIdHdr,
  });
  const got = await ctx.call("GET", `/api/v1/workflows/${workflowId}`);
  const state = String(got.json?.state || "");
  const pubOk = /published/i.test(state) || (pub.status >= 200 && pub.status < 300);
  note("publish workflow", pubOk ? pub.status || 200 : pub.status, pubOk, `state=${state || "?"} ${bricks.snippet(pub)}`);
  if (!pubOk) throw new Error(`publish workflow failed: state=${state}`);
  return workflowId;
}

async function cleanup() {
  const order = ["workflow", "rule", "connection", "secret", "folder", "workspace", "account"];
  const byKind = [...created].reverse();
  byKind.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const folderForDelete = created.find((c) => c.kind === "folder")?.id;
  let anyFailed = false;
  for (const item of byKind) {
    if (PROTECTED_NAMES.has(item.name)) {
      note(`delete ${item.kind}`, 200, true, `skipped protected ${item.name}`);
      continue;
    }
    if (item.kind === "account" && !ctx.createdAccount) continue;
    if (item.kind === "workspace" && !ctx.createdWorkspace) continue;
    const res = await bricks.remove(ctx.call, item.kind, item.id, {
      ...(ctx.accountId ? { "Account-Id": ctx.accountId } : {}),
      ...(folderForDelete ? { "Folder-Id": folderForDelete } : {}),
    });
    const ok = res.status >= 200 && res.status < 300;
    note(`delete ${item.kind}`, res.status, ok, `${item.name} ${item.id} ${bricks.snippet(res)}`);
    if (!ok) anyFailed = true;
  }
  return anyFailed;
}

async function main() {
  await relogin(login);

  console.log(
    `tag=${config.tag} host=${config.base} reuseWorkspace=${config.reuseWorkspace} keep=${config.keep} user=${config.user} sub=${ctx.userId || "?"}`
  );
  if (!ctx.userId) throw new Error("JWT has no sub — cannot grant Owner");

  let failed = false;
  try {
    await sweepLeftoverWorkspaces({ call: ctx.call, note, tagPrefix: config.tag.slice(0, 3) });
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
    ctx.createdAccount = ws.createdAccount;
    ctx.createdWorkspace = ws.createdWorkspace;

    await sweepLeftoverFixtures({ call: ctx.call, note, ctx, accountId: ctx.accountId });

    const { secretId } = await createSecret({
      hdr,
      note,
      entry: oracleEntry,
      tag: config.tag,
      created,
      secretName: names.secret,
    });
    ctx.secretId = secretId;
    ctx.folderId = await createFolder();
    ctx.connectionId = await createConnection({
      hdr,
      note,
      entry: oracleEntry,
      tag: config.tag,
      secretId,
      created,
      name: names.connection,
    });
    await testConnection({
      call: ctx.call,
      connectionId: ctx.connectionId,
      accountId: ctx.accountId,
      note,
    });
    ctx.ruleId = await createAndPublishRule(ctx.connectionId, ctx.folderId);
    ctx.workflowId = await createAndPublishWorkflow(ctx.ruleId, ctx.folderId);

    const ruleRunOk = await triggerAndWait(ctx.call, ctx.ruleId, "rule");
    const wfRunOk = await triggerAndWait(ctx.call, ctx.workflowId, "workflow");
    if (!ruleRunOk || !wfRunOk) failed = true;
  } catch (err) {
    failed = true;
    note("fatal", 0, false, err.message || String(err));
  } finally {
    if (!config.keep) {
      const cleanupFailed = await cleanup();
      if (cleanupFailed) failed = true;
    } else {
      console.log("KEEP=1 — left behind:", created.map((c) => `${c.kind}:${c.name}:${c.id}`).join(", "));
    }
  }

  const report = bricks.writeReport("smoke", {
    base: config.base,
    tag: config.tag,
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    keep: config.keep,
    names,
    created,
    results,
  });
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed. Report: ${report}`);
  if (failed || results.some((r) => !r.pass)) process.exitCode = 1;
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  process.exitCode = 1;
});
