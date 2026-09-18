/** Connection catalog → secret → create → test → cleanup. */

import * as bricks from "./bricks.mjs";

const DEFAULT_PROPS = [
  { name: "loginTimeout", value: "30", type: "System" },
  { name: "useDateAsTimestamp", value: "false", type: "System" },
];

function secretKeyFor(entry) {
  return entry.secretKey || `${entry.connectorId}_UNP`;
}

function connectionPropertiesFor(entry) {
  if (Array.isArray(entry.connectionProperties)) return entry.connectionProperties;
  if (entry.connectorId === "clickhouse") {
    return [{ name: "loginTimeout", value: "30", type: "System" }];
  }
  return DEFAULT_PROPS;
}

function pickProvider(driver, authTypeId = "password") {
  for (const sp of driver?.serviceProviders || []) {
    const auth = sp.authTypes?.find((a) => a.authTypeId === authTypeId);
    if (auth) return { serviceProviderName: sp.serviceProviderId, authTypeId: auth.authTypeId };
  }
  const sp = driver?.serviceProviders?.[0];
  const auth = sp?.authTypes?.[0];
  return {
    serviceProviderName: sp?.serviceProviderId || "",
    authTypeId: auth?.authTypeId || authTypeId,
  };
}

export async function loadConnectorMeta(call, workspaceId, connectorId, authTypeId = "password") {
  const res = await call("GET", `/api/v1/connectors/${connectorId}`, undefined, {
    "Workspace-Id": workspaceId,
  });
  if (!(res.status >= 200 && res.status < 300)) {
    return { driverId: connectorId, serviceProviderName: connectorId, authTypeId, connectionProperties: [] };
  }
  const drivers = res.json?.connectorInfo?.drivers || [];
  const driver =
    drivers.find((d) => d.licenseType !== "custom" && !String(d.id || "").includes("custom")) ||
    drivers[0] ||
    {};
  const picked = pickProvider(driver, authTypeId);
  const connectionProperties = (res.json?.connectorInfo?.displayProperties || [])
    .find((p) => p.field === "connectionProperties")
    ?.values?.map((v) => ({ name: v.key, value: v.defaultValue || "30", type: "System" })) || [];
  return {
    driverId: driver.id || connectorId,
    serviceProviderName: picked.serviceProviderName || connectorId,
    authTypeId: picked.authTypeId || authTypeId,
    connectionProperties,
    urlTemplate: driver.info?.urlTemplate || "",
  };
}

export function enrichEntry(entry, meta) {
  if (entry.skip) return entry;
  return {
    ...entry,
    driverId: entry.driverId || meta.driverId,
    serviceProviderName: entry.serviceProviderName || meta.serviceProviderName,
    authTypeId: entry.authTypeId || meta.authTypeId,
    connectionProperties: entry.connectionProperties ?? meta.connectionProperties,
    jdbcUrlTemplate: entry.jdbcUrlTemplate || meta.urlTemplate,
  };
}

export function buildConnectionBody(entry, { secretId, tag, name }) {
  const sk = secretKeyFor(entry);
  const connName = name || entry.name || `${tag}-${entry.id}`.slice(0, 100);

  return {
    name: connName,
    connectorId: entry.connectorId,
    driverId: entry.driverId || entry.connectorId,
    serviceProviderName: entry.serviceProviderName || entry.connectorId,
    authTypeId: entry.authTypeId || "password",
    type: "System",
    connectorType: entry.connectorType || "RDBMS",
    useVault: true,
    secretId,
    serverInstanceName: entry.serverInstanceName || "Smoke",
    serverConfig: {
      useJDBCurl: false,
      jdbcUrl: entry.jdbcUrlTemplate || "",
      info: {
        host: entry.host,
        port: String(entry.port),
        database: entry.database,
        ...(entry.databaseName ? { databaseName: entry.databaseName } : {}),
        useSsl: entry.useSsl ?? false,
        jksFileType: "wallet",
        useCustomCertificates: false,
        getData: false,
        getSchema: false,
        ...(entry.serverInfo || {}),
      },
      cacheConnectionType: "",
    },
    authConfig: {
      username: entry.username,
      password: sk,
      ...(entry.authConfig || {}),
    },
    connectionProperties: connectionPropertiesFor(entry),
  };
}

export function buildSecretConfig(entry) {
  const sk = secretKeyFor(entry);
  return { secretKey: sk, config: { [sk]: entry.password } };
}

export async function createSecret({ hdr, note, entry, tag, created, secretName, label }) {
  const { secretKey, config } = buildSecretConfig(entry);
  const name = secretName || `${tag}-${entry.id || "secret"}`.slice(0, 60);
  const secretBody = {
    vaultType: "internal",
    info: { type: "Public", secret: name, displayName: name },
    config,
  };
  const secret = await bricks.firstOk([
    hdr("POST", "/api/v1/secret", secretBody),
    hdr("POST", "/api/v1/internal/secret", secretBody),
  ]);
  const secretId = bricks.idOf(secret.json);
  if (!(secret.status >= 200 && secret.status < 300 && secretId)) {
    throw new Error(`create secret failed: ${bricks.snippet(secret)}`);
  }
  created.push({ kind: "secret", id: secretId, name, entryId: entry.id });
  const keyPut = await bricks.firstOk([
    hdr("PUT", `/api/v1/internal/secret/${secretId}`, config),
    hdr("PUT", `/api/v1/secret/${secretId}`, { ...secretBody, id: secretId, config }),
    hdr("POST", `/api/v1/internal/secret/${secretId}:key`, config),
  ]);
  const ok = keyPut.status >= 200 && keyPut.status < 300;
  note(label || "create secret", keyPut.status, ok, `${name} ${secretId}`);
  return { secretId, secretKey };
}

export async function createConnection({ hdr, note, entry, tag, secretId, created, name, label }) {
  const body = buildConnectionBody(entry, { secretId, tag, name });
  const conn = await bricks.firstOk([
    hdr("POST", "/api/v1/connections", body),
    hdr("POST", "/api/v1/internal/connections", body),
  ]);
  const connectionId = bricks.idOf(conn.json);
  const createOk = conn.status >= 200 && conn.status < 300 && connectionId;
  note(label || `create ${entry.id}`, conn.status, createOk, createOk ? connectionId : bricks.snippet(conn));
  if (!createOk) throw new Error(`create connection failed: ${bricks.snippet(conn)}`);
  created.push({ kind: "connection", id: connectionId, name: body.name, entryId: entry.id, secretId });
  return connectionId;
}

export async function testConnection({ call, connectionId, accountId, note, label }) {
  const tested = await call("POST", `/api/v1/connections/${connectionId}:test`, {}, {
    ...(accountId ? { "Account-Id": accountId } : {}),
  });
  const testOk = tested.status >= 200 && tested.status < 300;
  note(label || "test connection", tested.status, testOk, testOk ? "ok" : bricks.snippet(tested));
  if (!testOk) throw new Error(`test connection failed: ${bricks.snippet(tested)}`);
  return tested;
}

export async function runCatalogEntry({ ctx, hdr, note, entry, tag, created, doTest = true }) {
  const meta = await loadConnectorMeta(ctx.call, ctx.workspaceId, entry.connectorId, entry.authTypeId);
  const resolved = enrichEntry(entry, meta);
  const { secretId } = await createSecret({
    hdr,
    note,
    entry: resolved,
    tag,
    created,
    label: `secret ${entry.id}`,
  });
  const connectionId = await createConnection({
    hdr,
    note,
    entry: resolved,
    tag,
    secretId,
    created,
    label: `create ${entry.id}`,
  });
  if (!doTest) {
    note(`test ${entry.id}`, 0, true, "ICEDQ_TEST=0 — skipped");
    return connectionId;
  }
  await testConnection({
    call: ctx.call,
    connectionId,
    accountId: ctx.accountId,
    note,
    label: `test ${entry.id}`,
  });
  return connectionId;
}

export async function cleanupConnections({ call, created, note, accountId }) {
  for (const item of created.filter((c) => c.kind === "connection").reverse()) {
    const res = await bricks.remove(call, "connection", item.id, { "Account-Id": accountId });
    note(`delete connection ${item.entryId || item.name}`, res.status, res.status >= 200 && res.status < 300, item.id);
  }
  for (const item of created.filter((c) => c.kind === "secret").reverse()) {
    const res = await bricks.remove(call, "secret", item.id, { "Account-Id": accountId });
    note(`delete secret ${item.entryId || item.name}`, res.status, res.status >= 200 && res.status < 300, item.id);
  }
}
