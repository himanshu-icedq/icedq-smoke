/**
 * Regression connections verified green on https://192.168.100.44:32222/
 * (create + :test). On-prem static host/port from the SR matrix.
 *
 * Passwords are never stored here — set env vars before running smoke-connections.mjs.
 * See `.env.example` for the full list.
 */

import * as bricks from "./bricks.mjs";

export const CONNECTION_CATALOG = [
  {
    id: "05-db2",
    sr: 5,
    label: "IBM DB2",
    kind: "rdbms",
    connectorId: "db2",
    host: "192.168.100.125",
    port: 50000,
    database: "ICEDQ",
    username: "db2admin",
  },
  {
    id: "08-greenplum",
    sr: 8,
    label: "Greenplum",
    kind: "rdbms",
    connectorId: "greenplum",
    host: "192.168.100.131",
    port: 5432,
    database: "icedq",
    username: "gpmon",
  },
  {
    id: "10-denodo",
    sr: 10,
    label: "Denodo",
    kind: "rdbms",
    connectorId: "denodo",
    host: "192.168.100.125",
    port: 9999,
    database: "icedq_db",
    username: "admin",
  },
  {
    id: "14-mysql",
    sr: 14,
    label: "MySQL",
    kind: "rdbms",
    connectorId: "mysql",
    host: "192.168.100.125",
    port: 3306,
    database: "icedq",
    username: "ice",
  },
  {
    id: "15-oracle-up",
    sr: 15,
    label: "Oracle JDBC Username & Password",
    kind: "rdbms",
    connectorId: "oracle",
    host: "192.168.100.126",
    port: 1521,
    database: "orcl",
    username: "regression_database",
    secretKey: "oracle_UNP",
    passwordEnv: "ICEDQ_DB_PASS",
  },
  {
    id: "16-postgresql",
    sr: 16,
    label: "PostgreSQL JDBC",
    kind: "rdbms",
    connectorId: "postgresql",
    host: "192.168.100.39",
    port: 5432,
    database: "regression_database",
    username: "readonly_user",
  },
  {
    id: "24-clickhouse",
    sr: 24,
    label: "ClickHouse",
    kind: "rdbms",
    connectorId: "clickhouse",
    host: "192.168.100.34",
    port: 8123,
    database: "icedq_db",
    username: "icedquser",
  },
];

/** Default env var name for a catalog entry's DB password. */
export function passwordEnvFor(entry) {
  if (entry.passwordEnv) return entry.passwordEnv;
  const suffix = entry.id.replace(/-/g, "_").toUpperCase();
  return `ICEDQ_CONN_${suffix}_PASS`;
}

/** Resolve password from env; throws if missing. */
export function resolveCatalogEntry(entry) {
  const envKey = passwordEnvFor(entry);
  const password = bricks.env(envKey);
  if (!password) {
    throw new Error(`Set ${envKey} for catalog entry ${entry.id} (${entry.label})`);
  }
  const { passwordEnv, ...rest } = entry;
  return { ...rest, password };
}

export function catalogEntries({ only = "", sr = "" } = {}) {
  let items = CONNECTION_CATALOG;
  if (sr) {
    const n = Number(sr);
    items = items.filter((e) => e.sr === n);
  }
  if (only) {
    const set = new Set(
      only
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
    items = items.filter((e) => set.has(e.id));
  }
  return items.map(resolveCatalogEntry);
}
