/** Workspace bootstrap + leftover sweeps shared by smoke scripts. */

import * as bricks from "./bricks.mjs";
import { PROTECTED_NAMES } from "./smoke-config.mjs";

function grantBody(userId) {
  return [{ id: userId, type: "User", role: "Owner", resource: "User" }];
}

async function grantOwner(call, kind, resourceId, userId, extraHeaders = {}) {
  const path =
    kind === "account"
      ? `/api/v1/accounts/${resourceId}:grantAccess`
      : `/api/v1/workspaces/${resourceId}:grantAccess`;
  return call("POST", path, grantBody(userId), extraHeaders);
}

async function searchAccounts(call) {
  return bricks.firstOk([
    () => call("POST", "/api/v1/accounts/search?pageNo=1&pageSize=5000&sort=updatedTimestamp:desc", {}),
    () =>
      call(
        "POST",
        "/api/v1/accounts/search?sort=updatedTimestamp:desc&isDeleted=false,true&pageSize=5000",
        {}
      ),
  ]);
}

async function searchWorkspaces(call) {
  return bricks.firstOk([
    () =>
      call("POST", "/api/v1/workspaces/search?pageNo=1&pageSize=900719007&sort=updatedTimestamp:desc", {
        filter: [
          { attribute: "fetchAll", operator: "Equals", datatype: "string", value: "false" },
          { attribute: "type", operator: "Equals", datatype: "string", value: "data-testing" },
        ],
      }),
    () => call("POST", "/api/v1/workspaces/search?pageNo=1&pageSize=900719007&sort=updatedTimestamp:desc", {}),
  ]);
}

export async function setupSmokeWorkspace({
  call,
  relogin,
  getBearer,
  userId,
  tag,
  names,
  created,
  note,
  reuseWorkspace = false,
  workspaceName = "",
  accountName = "",
  protectedNames = PROTECTED_NAMES,
}) {
  if (reuseWorkspace) {
    const ws = await searchWorkspaces(call);
    const acctSearch = await searchAccounts(call);
    const acctItems = bricks.itemsOf(acctSearch.json);
    const wsItems = bricks.itemsOf(ws.json);
    const chosen = (workspaceName && wsItems.find((i) => i.name === workspaceName)) || wsItems[0];
    if (!chosen?.id) throw new Error(`No workspace (HTTP ${ws.status}): ${bricks.snippet(ws)}`);
    note("workspace", ws.status, true, `reuse ${chosen.name} ${chosen.id}`);
    return {
      workspaceId: chosen.id,
      accountId: chosen.accountId || acctItems[0]?.id || "",
      createdAccount: false,
      createdWorkspace: false,
    };
  }

  let accountId = "";
  let createdAccount = false;
  const acctSearch = await searchAccounts(call);
  const acctItems = bricks.itemsOf(acctSearch.json);
  const acctCreate = await call("POST", "/api/v1/accounts", {
    name: names.account,
    description: `ephemeral smoke ${tag}`,
  });
  if (acctCreate.status >= 200 && acctCreate.status < 300 && bricks.idOf(acctCreate.json)) {
    accountId = bricks.idOf(acctCreate.json);
    createdAccount = true;
    created.push({ kind: "account", id: accountId, name: names.account });
    note("create account", acctCreate.status, true, `${names.account} ${accountId}`);
    const granted = await grantOwner(call, "account", accountId, userId, { "Account-Id": accountId });
    const grantOk = granted.status >= 200 && granted.status < 300;
    note("grant account Owner", granted.status, grantOk, bricks.snippet(granted));
    if (!grantOk) throw new Error(`grant account Owner failed: ${bricks.snippet(granted)}`);
  } else {
    const fallback = (accountName && acctItems.find((i) => i.name === accountName)) || acctItems[0];
    if (!fallback?.id) {
      note("create account", acctCreate.status, false, bricks.snippet(acctCreate));
      throw new Error(`Account create failed and no fallback account: ${bricks.snippet(acctCreate)}`);
    }
    accountId = fallback.id;
    const license = /limit reached|ResourceForbidden/i.test(acctCreate.text || bricks.snippet(acctCreate));
    note(
      "create account",
      acctCreate.status,
      true,
      license
        ? `license limit — using ${fallback.name} ${accountId}`
        : `HTTP ${acctCreate.status} — using ${fallback.name} ${accountId} (${bricks.snippet(acctCreate)})`
    );
  }

  const ws = await call(
    "POST",
    "/api/v1/workspaces",
    {
      name: names.workspace,
      accountId,
      type: "data-testing",
      ownership: "Private",
      description: `ephemeral smoke ${tag}`,
    },
    { "Account-Id": accountId }
  );
  const workspaceId = bricks.idOf(ws.json);
  if (!(ws.status >= 200 && ws.status < 300 && workspaceId)) {
    note("create workspace", ws.status, false, bricks.snippet(ws));
    throw new Error(`Workspace create failed: ${bricks.snippet(ws)}`);
  }
  created.push({ kind: "workspace", id: workspaceId, name: names.workspace });
  note("create workspace", ws.status, true, `${names.workspace} ${workspaceId}`);

  const wsGrant = await grantOwner(call, "workspace", workspaceId, userId, {
    "Account-Id": accountId,
    "Workspace-Id": workspaceId,
  });
  const wsGrantOk = wsGrant.status >= 200 && wsGrant.status < 300;
  note("grant workspace Owner", wsGrant.status, wsGrantOk, bricks.snippet(wsGrant));
  if (!wsGrantOk) throw new Error(`grant workspace Owner failed: ${bricks.snippet(wsGrant)}`);

  await relogin();
  let roles = bricks.jwtRoles(getBearer());
  let owns = roles.some((r) => String(r).startsWith(`${workspaceId}.`));
  if (!owns) {
    await bricks.sleep(2000);
    await relogin();
    roles = bricks.jwtRoles(getBearer());
    owns = roles.some((r) => String(r).startsWith(`${workspaceId}.`));
  }
  note(
    "re-login Owner",
    owns ? 200 : 403,
    owns,
    owns ? `${workspaceId}.Owner` : roles.filter((r) => /wksc|Owner|Admin/.test(r)).join(",")
  );
  if (!owns) throw new Error("did not obtain workspace Owner role after grant + re-login");

  return { workspaceId, accountId, createdAccount, createdWorkspace: true, protectedNames };
}

export async function sweepLeftoverWorkspaces({ call, note, protectedNames = PROTECTED_NAMES, tagPrefix = "smk" }) {
  const leftoverWs = await searchWorkspaces(call);
  for (const item of bricks.itemsOf(leftoverWs.json)) {
    if (!new RegExp(`^${tagPrefix}`, "i").test(item.name || "") || protectedNames.has(item.name)) continue;
    const del = await call("DELETE", `/api/v1/workspaces/${item.id}`, undefined, {
      ...(item.accountId ? { "Account-Id": item.accountId } : {}),
    });
    note("sweep workspace", del.status, del.status >= 200 && del.status < 300, `${item.name} ${item.id}`);
  }
}

export async function sweepLeftoverFixtures({ call, note, ctx, accountId }) {
  const stale = [];
  for (const [kind, path] of [
    ["workflow", "/api/v1/workflows/search?pageNo=1&pageSize=100&sort=updatedTimestamp:desc"],
    ["rule", "/api/v1/rules/search?pageNo=1&pageSize=100&sort=updatedTimestamp:desc"],
    ["connection", "/api/v1/connections/search?pageNo=1&pageSize=100&sort=updatedTimestamp:desc"],
    ["secret", "/api/v1/secret/search?pageNo=1&pageSize=100"],
    ["folder", "/api/v1/folders/search?pageNo=1&pageSize=100&sort=updatedTimestamp:desc"],
  ]) {
    const s = await call("POST", path, {});
    for (const item of bricks.itemsOf(s.json)) {
      if (/^smk/i.test(item.name || item.info?.secret || item.displayName || "")) {
        stale.push({ kind, id: item.id, name: item.name || item.info?.secret });
      }
    }
  }
  for (const item of stale) {
    if (item.kind === "folder") ctx.folderIdHdr = item.id;
    const res = await bricks.remove(call, item.kind, item.id, {
      ...(accountId ? { "Account-Id": accountId } : {}),
      ...(ctx.folderIdHdr ? { "Folder-Id": ctx.folderIdHdr } : {}),
    });
    note(`sweep ${item.kind}`, res.status, res.status >= 200 && res.status < 300, `${item.name} ${item.id}`);
  }
  ctx.folderIdHdr = "";
}

export async function sweepLeftoverConnections(ctx, note, tagPrefix = "smk") {
  const s = await ctx.call("POST", "/api/v1/connections/search?pageNo=1&pageSize=200&sort=updatedTimestamp:desc", {});
  for (const item of bricks.itemsOf(s.json)) {
    if (!new RegExp(`^${tagPrefix}`, "i").test(item.name || "")) continue;
    const res = await bricks.remove(ctx.call, "connection", item.id, {
      ...(ctx.accountId ? { "Account-Id": ctx.accountId } : {}),
    });
    note("sweep connection", res.status, res.status >= 200 && res.status < 300, `${item.name} ${item.id}`);
  }
  for (const path of ["/api/v1/secret/search?pageNo=1&pageSize=200"]) {
    const sec = await ctx.call("POST", path, {});
    for (const item of bricks.itemsOf(sec.json)) {
      if (!new RegExp(`^${tagPrefix}`, "i").test(item.name || item.info?.secret || "")) continue;
      const res = await bricks.remove(ctx.call, "secret", item.id, {
        ...(ctx.accountId ? { "Account-Id": ctx.accountId } : {}),
      });
      note("sweep secret", res.status, res.status >= 200 && res.status < 300, `${item.name || item.info?.secret} ${item.id}`);
    }
  }
}
