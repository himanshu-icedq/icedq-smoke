/** Shared CLI/env parsing for smoke scripts. */

import * as bricks from "./bricks.mjs";

export const PROTECTED_NAMES = new Set(["mcp-demo", "mcp-workspace"]);

export function localApiDefault(apiBase, port) {
  return apiBase.includes("localhost:9100") ? apiBase.replace(":9100", `:${port}`) : "";
}

export function makeApiBaseFor({ apiBase, connectionApi = "", workflowApi = "" }) {
  return function apiBaseFor(path) {
    if (
      connectionApi &&
      (/^\/api\/v1\/(secret|connections)/.test(path) || /^\/api\/v1\/internal\/secret/.test(path))
    ) {
      return connectionApi;
    }
    if (
      workflowApi &&
      (/^\/api\/v1\/(rules|workflows)/.test(path) ||
        /^\/api\/v1\/internal\/(rules|workflows)/.test(path))
    ) {
      return workflowApi;
    }
    return apiBase;
  };
}

export function smokeTag() {
  return `smk${Date.now().toString(36).slice(-6)}`;
}

/** @param {{ requirePass?: boolean, requireDbPass?: boolean }} opts */
export function parseSmokeConfig(opts = {}) {
  const base = (bricks.arg("--url", bricks.env("ICEDQ_URL"))).replace(/\/$/, "");
  const apiBase = (bricks.arg("--api-url", bricks.env("ICEDQ_API_URL", base))).replace(/\/$/, "");
  const connectionApi = (
    bricks.arg("--connection-api-url", bricks.env("ICEDQ_CONNECTION_API_URL", localApiDefault(apiBase, 9200)))
  ).replace(/\/$/, "");
  const workflowApi = (
    bricks.arg("--workflow-api-url", bricks.env("ICEDQ_WORKFLOW_API_URL", localApiDefault(apiBase, 9300)))
  ).replace(/\/$/, "");

  const config = {
    base,
    apiBase,
    connectionApi,
    workflowApi,
    user: bricks.arg("--user", bricks.env("ICEDQ_USER", "admin")),
    pass: bricks.arg("--pass", bricks.env("ICEDQ_PASS")),
    workspaceName: bricks.arg("--workspace", bricks.env("ICEDQ_WORKSPACE")),
    accountName: bricks.arg("--account", bricks.env("ICEDQ_ACCOUNT")),
    keep: process.argv.includes("--keep") || bricks.env("ICEDQ_KEEP") === "1",
    reuseWorkspace:
      process.argv.includes("--reuse-workspace") || bricks.env("ICEDQ_REUSE_WORKSPACE") === "1",
    dbHost: bricks.env("ICEDQ_DB_HOST", "192.168.100.126"),
    dbPort: bricks.env("ICEDQ_DB_PORT", "1521"),
    dbName: bricks.env("ICEDQ_DB_NAME", "orcl"),
    dbUser: bricks.env("ICEDQ_DB_USER", "regression_database"),
    dbPass: bricks.env("ICEDQ_DB_PASS"),
    secretKey: bricks.env("ICEDQ_DB_SECRET_KEY", "oracle_UNP"),
    only: bricks.env("ICEDQ_ONLY", ""),
    sr: bricks.env("ICEDQ_SR", ""),
    doTest: bricks.env("ICEDQ_TEST", "1") !== "0",
    tag: smokeTag(),
    apiBaseFor: makeApiBaseFor({ apiBase, connectionApi, workflowApi }),
  };

  if (!base) {
    console.error("Set ICEDQ_URL or --url https://host:32222");
    process.exit(2);
  }
  if (opts.requirePass !== false && !config.pass) {
    console.error("Set ICEDQ_PASS or --pass");
    process.exit(2);
  }
  if (opts.requireDbPass && !config.dbPass) {
    console.error("Set ICEDQ_DB_PASS (Oracle password for the smoke connection)");
    process.exit(2);
  }

  return config;
}
