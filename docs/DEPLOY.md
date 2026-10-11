# Deploying the connector

Runs on the Edenia k3s cluster (Traefik + Longhorn), namespace `crservers-connector`, at `https://connect.crservers.com`. Same model as crservers.com: a `v*` tag builds the image to GHCR and applies `k8s/`.

## What runs

| Object | Notes |
|---|---|
| `Deployment/connector` | 1 replica, `Recreate` (the per-site publish lock is in-process until it moves to Postgres). Non-root, read-only root filesystem, no capabilities. Probes on `/healthz`. |
| `StatefulSet/connector-postgres` | Postgres 17, 10 Gi on `crservers-connector-storage` (Longhorn, 2 replicas). Holds OAuth state, drafts, releases and revert records. |
| `IngressRoute`s | HTTP → HTTPS redirect; TLS from the cluster's `myresolver` (Let's Encrypt). |
| Secrets | `connector-postgres`, `connector-secrets`, created by the workflow from GitHub environment secrets. Never in the repo or a ConfigMap. |

## One-time bootstrap (cluster admin)

1. **Namespace, deploy identity and storage class:**
   ```bash
   kubectl --context edenia-prod apply -f k8s/bootstrap/deployer-rbac.yml -f k8s/bootstrap/storageclass.yml
   ```
   CI gets a ServiceAccount that can only touch `crservers-connector` (no cluster-wide rights).

2. **Kubeconfig for CI** from that ServiceAccount's token. Paste it as base64 into the `KUBE_CONFIG_DATA` secret below. Never reuse an admin kubeconfig: this repo is public.

3. **GitHub environment `production`** (Settings → Environments), with required reviewers.

   | Kind | Name | Value |
   |---|---|---|
   | secret | `KUBE_CONFIG_DATA` | base64 kubeconfig from step 2 |
   | secret | `POSTGRES_PASSWORD` | random |
   | secret | `REQ_KEY` | 32 random bytes, base64url. **Same value** as the HostBill plugin's `ReqKeyCurrent` |
   | secret | `ENCRYPTION_KEY` | 32 random bytes, base64url. Losing it makes stored FTP passwords unreadable |
   | secret | `HOSTBILL_API_ID`, `HOSTBILL_API_KEY` | key limited to the `module` method, IP-locked to the cluster's egress |
   | variable | `INGRESS_HOST` | `connect.crservers.com` |
   | variable | `HOSTBILL_URL` | `https://hostbill.crservers.net` during the pilot (dev HostBill); `https://clients.crservers.com` for production |
   | variable | `EXTRA_REDIRECT_URIS` | optional, comma-separated |

4. **DNS:** `connect.crservers.com A 200.122.181.15` (the cluster ingress, same as crservers.com) in the `crservers.com` zone on ns1–3.crservers.net.

5. **Image visibility:** if the first rollout can't pull the image, make the GHCR package `crservers-connector` public (the repo is public; the image holds no secrets).

## Release

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The workflow tests, builds, applies the secrets, rolls out Postgres and then the app, and smoke-tests `/healthz`.

## Registering a pilot site

The deploy FTP user is created by hand in SiteWorx (spike 0c). Then:

```bash
kubectl --context edenia-prod -n crservers-connector exec -i deploy/connector -- \
  node dist/cli/site-add.js --account <hostbill account id> --domain <domain> \
  --ftp-host <node>.crservers.com --ftp-user <user>@<domain> < password-file
```

## Backups

Two layers. Both were tested on 2026-10-11, including a restore drill.

| Layer | What | When | Kept | Where |
|---|---|---|---|---|
| Logical | `CronJob/connector-pg-dump`: `pg_dump -Fc`, checked with `pg_restore -l`; the job fails if the dump is unreadable | 03:15 Costa Rica | 7 days | `PVC/connector-dumps` |
| Block | Longhorn `RecurringJob/crservers-connector-backup` (`k8s/bootstrap/longhorn-backup.yml`) for both volumes (Postgres data and dumps) | 03:30 | 14 | the cluster backup target (NFS on the NAS) |

New volumes join the Longhorn job by label, applied by an admin:

```bash
kubectl --context edenia-prod -n longhorn-system label volumes.longhorn.io <pv-name> recurring-job-group.longhorn.io/crservers-connector=enabled
```

**Restore from a dump:**
1. Run a one-off Job with the Postgres image, the dumps volume mounted read-only, and `PG*` env from `connector-postgres`.
2. `pg_restore -d <db> --no-owner /dumps/connector-<date>.dump`.

Drill first into a scratch database: create `restore_drill`, restore, compare row counts with the live database, drop it.

**Restore a whole volume:** from the Longhorn UI, restore the backup to a new volume, then point the StatefulSet's PVC at it.

## Known gaps

- **Single replica:** move the publish lock to a Postgres advisory lock before scaling out.
