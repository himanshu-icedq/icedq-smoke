-- Real schema list from the actual dev DB (confirmed, not guessed) — each
-- service's Liquibase migrations expect their own schema to already exist
-- (k8s has a dedicated init container for this before boot). Pre-creating
-- all of them now covers services not yet wired into this compose stack too.
CREATE SCHEMA IF NOT EXISTS bi_test;     -- bitesting
CREATE SCHEMA IF NOT EXISTS brg;
CREATE SCHEMA IF NOT EXISTS conn;        -- connection-repo-service
CREATE SCHEMA IF NOT EXISTS dqw;         -- datawarehouse
CREATE SCHEMA IF NOT EXISTS iam;         -- admin-service
CREATE SCHEMA IF NOT EXISTS insta;       -- workflow (workflow-instance)
CREATE SCHEMA IF NOT EXISTS liquibase;
CREATE SCHEMA IF NOT EXISTS notification;
CREATE SCHEMA IF NOT EXISTS orch;        -- workflow (workflow-orchestration)
CREATE SCHEMA IF NOT EXISTS rulebuild;   -- workflow (rule-build)
CREATE SCHEMA IF NOT EXISTS ruler;       -- workflow (rule-repo) — connection also touches this
CREATE SCHEMA IF NOT EXISTS scheduler;
CREATE SCHEMA IF NOT EXISTS workengine;  -- workflow (workflow-engine)
-- keycloak, public, temporal, temporal_visibility are handled by their own
-- services/containers already (keycloak's own DB, temporal's auto-setup image).

-- Real Keycloak (docker-compose.yml's `keycloak` service) runs in `start-dev`
-- mode against its own embedded/ephemeral DB, not this shared postgres --
-- so `keycloak.user_entity` never exists here the way it would in a real
-- deployment where Keycloak is postgres-backed. datawarehouse's own
-- Liquibase migration (v9.6 dml changeset) does a one-time
-- `... where user_id not in (select id from keycloak.user_entity)` cleanup
-- against it. A schema-only stub (empty, matching Keycloak's real varchar(36)
-- id column) is enough to satisfy that changeset -- an empty NOT IN subquery
-- is harmless, and this is Keycloak's own internal table, not another
-- icedq microservice's, so there's no "real owner service" to run instead.
CREATE SCHEMA IF NOT EXISTS keycloak;
CREATE TABLE IF NOT EXISTS keycloak.user_entity (id varchar(36) PRIMARY KEY);
