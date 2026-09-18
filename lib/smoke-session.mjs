/** Playwright login + multi-base API routing shared by smoke scripts. */

import * as bricks from "./bricks.mjs";

export function createSmokeSession(config) {
  const ctx = {
    bearer: "",
    call: null,
    userId: "",
    workspaceId: "",
    accountId: "",
    createdAccount: false,
    createdWorkspace: false,
    folderIdHdr: "",
    secretId: "",
    connectionId: "",
    ruleId: "",
    folderId: "",
    workflowId: "",
  };

  const apiClients = new Map();

  async function relogin(loginFn) {
    const logged = await loginFn();
    ctx.bearer = logged.bearer;
    ctx.userId = logged.userId;
    apiClients.clear();
    ctx.call = (method, path, body, extraHeaders = {}) => {
      const base = config.apiBaseFor(path);
      if (!apiClients.has(base)) apiClients.set(base, bricks.api(base, ctx.bearer));
      return apiClients.get(base)(method, path, body, {
        ...(ctx.workspaceId ? { "Workspace-Id": ctx.workspaceId } : {}),
        ...extraHeaders,
      });
    };
  }

  function hdr(method, path, body, extra = {}) {
    return () =>
      ctx.call(method, path, body, {
        ...(ctx.accountId ? { "Account-Id": ctx.accountId } : {}),
        ...(ctx.folderIdHdr ? { "Folder-Id": ctx.folderIdHdr } : {}),
        ...extra,
      });
  }

  function login() {
    return bricks.login({
      base: config.base,
      user: config.user,
      pass: config.pass,
      postLoginPath: bricks.env("ICEDQ_POST_LOGIN_PATH", "/#/home"),
      settleMs: 4000,
    });
  }

  return { ctx, relogin, hdr, login };
}
