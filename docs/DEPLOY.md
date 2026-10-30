# Deploying

The connector ships as a container image and plain Kubernetes manifests (`k8s/`). This page covers the moving parts. Environment-specific values live in the deployment environment, not in this repository.

## What gets deployed

| Object | Notes |
|---|---|
| `Deployment/connector` | One replica, `Recreate` strategy (the per-site publish lock is in-process for now). Non-root, read-only root filesystem, no capabilities. Probes on `/healthz`. |
| `StatefulSet/connector-postgres` | Postgres 17 with a persistent volume. Holds connections, drafts, releases and undo records. |
| `CronJob/connector-pg-dump` | Daily `pg_dump`, verified with `pg_restore -l`, kept 7 days. |
| `IngressRoute`s | Traefik: HTTP → HTTPS, TLS via the cluster's ACME resolver. |
| Secrets | `connector-postgres`, `connector-secrets`, created by the deploy workflow from the deployment environment. Never committed and never in a ConfigMap. |

`k8s/bootstrap/` holds the one-time, cluster-admin pieces:
- the namespace;
- a deploy ServiceAccount limited to that namespace;
- the storage class;
- a recurring volume backup job.

## Environments

| Environment | Deploys on | Namespace | Approval |
|---|---|---|---|
| `staging` | every push to `main` | `crservers-connector-staging` | none |
| `production` | a `vX.Y.Z` tag | `crservers-connector` | required |

Staging talks to the test client area, so whole sign-in flows can be tried without touching real accounts. Each GitHub environment holds its own variables and secrets (below); the workflow is the same.

Bootstrap a new environment once, as a cluster admin:

```bash
NAMESPACE=crservers-connector-staging envsubst '${NAMESPACE}' < k8s/bootstrap/deployer-rbac.yml | kubectl apply -f -
```

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `INGRESS_HOST` | variable | Public host name; `PUBLIC_URL` is `https://<host>` |
| `CLIENT_AREA_URL` | variable | CR Servers client area origin |
| `EXTRA_REDIRECT_URIS` | variable | Optional extra exact OAuth redirect URIs |
| `NAMESPACE` | variable | Kubernetes namespace (default `crservers-connector`) |
| `BACKUPS` | variable | `off` skips the daily dump job (staging) |
| `KUBE_CONFIG_DATA` | secret | Base64 kubeconfig for the namespace-scoped deploy account |
| `POSTGRES_PASSWORD` | secret | Database password |
| `CLIENT_AREA_API_ID`, `CLIENT_AREA_API_KEY` | secret | Server-to-server key for redeeming sign-in codes (IP-restricted, least privilege) |
| `REQ_KEY` | secret | 32 random bytes, base64url. Shared with the client-area extension to sign sign-in requests. |
| `ENCRYPTION_KEY` | secret | 32 random bytes, base64url. Encrypts stored FTP credentials. |

Generate a key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## Release

```bash
git tag vX.Y.Z && git push origin vX.Y.Z
```

A push to `main` deploys to staging right away. A tag deploys to production. The workflow:
1. Runs the tests.
2. Builds the image.
3. For production, waits for approval.
4. Applies the secrets and rolls out Postgres, then the app.
5. Checks `/healthz`.

## Registering a site

Sites register themselves on their first connection (see ARCHITECTURE.md, "Automatic site setup"). Manual registration remains as a fallback, once a deploy FTP user jailed to the site's web root exists on the hosting server. The FTP password is read from stdin:

```bash
kubectl -n crservers-connector exec -i deploy/connector -- \
  node dist/cli/site-add.js --account <service id> --domain <domain> \
  --ftp-host <server host name> --ftp-user <user> < password-file
```

## Backups and restore

**Logical dumps** (`connector-dumps` volume). Restore one into a scratch database:
1. Restore it with `pg_restore --no-owner`.
2. Compare row counts with the live database.
3. Then restore for real.

**Volume backups** come from the recurring job in `k8s/bootstrap/`. New volumes join it by label.

## Finding a customer's problem (support)

Every tool error shown to the assistant ends with a reference, e.g. `(ref: K7Q2MD)`. So does a refused connection (the client consented in the client area but the app says it could not connect): its record has kind `connect_refused` and the reason in `error`, e.g. `no_site_after_exchange: example.com; 2 site(s), site_setup 1/2` (the client area sent no setup for a site the connector doesn't know; plugin 0.8.1+ re-runs the setup on the next try), `site_frozen` (service suspended), `exchange_failed` (the client area refused or couldn't be reached; see the `client_area_exchange_*` log lines) or `approve_scope`. Ask the customer for it (or for the hosting service id) and look it up in the support records, kept 30 days:

```sh
# By reference
kubectl -n crservers-connector exec connector-postgres-0 -- psql -U connector -d connector -c \
  "SELECT at, kind, tool, ok, error, service_id, app FROM support_events WHERE ref = 'K7Q2MD'"

# A customer's recent activity by hosting service id (tool calls; session starts have the site ids)
kubectl -n crservers-connector exec connector-postgres-0 -- psql -U connector -d connector -c \
  "SELECT at, kind, tool, ok, left(error, 80) AS error, ref, app FROM support_events
   WHERE service_id = 6020 OR site_ids && (SELECT array_agg(id) FROM sites WHERE service_id = 6020)
   ORDER BY at DESC LIMIT 50"
```

The request log has the same ref (`kubectl -n crservers-connector logs deploy/connector | grep K7Q2MD`), next to the stack trace for internal errors. A session start (`initialize`) with no tool calls after it means the app connected and then nothing reached the connector: the problem is on the client side or its network.

