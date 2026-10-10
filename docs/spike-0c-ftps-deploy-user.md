# Spike 0c: FTPS deploy user jailed to a site's web root

Run 2026-10-10 against a live InterWorx node (pilot site's node), with a dedicated deploy FTP user. Scratch files only; everything was removed afterwards.

## Setup

- Created through SiteWorx CLI as the site's unixuser: `siteworx.pex <domain> -u -n -c Ftp -a add --user <name> --password … --confirm_password … --homedir /home/<unixuser>/<domain>/html` (with `IWORX_UNIXUSER=<unixuser>`).
- **Finding: the deploy user consumes an FTP account slot.** The pilot account's package was already at its limit (the default `ftp@` user plus the account login), and `add` failed with "FTP account limit reached" until the account's `ftp_accounts` limit was raised by one. Beta provisioning must raise the limit (or plans must reserve a slot).
- Password generated locally and passed over SSH stdin; never on a command line visible to the operator's tooling.

## Results (FTPS, explicit TLS, strict certificate verification against the node hostname)

| Check | Result |
|---|---|
| Connect + `AUTH TLS` + login with system CA verification and hostname check (`<node>.crservers.com`) | Pass |
| `PROT P` (encrypted data channel) | Pass |
| `PWD` after login | `/` = the web root |
| `MLSD` on the root | Pass. Lists exactly the web root's entries |
| Jail: `CWD ..` | Stays at `/` |
| Jail: `CWD /home` | `550 No such file or directory` |
| `MKD` scratch dir | Pass |
| `STOR` to a temporary name, then `RNFR`/`RNTO` into place | Pass |
| `MLSD` facts | `size`, `modify` (UTC, second precision), `type`, `unix.mode` (0644) available, which is enough for the drift check in SPEC §5 |
| `RETR` and SHA-256 compare | Match |
| Rename **over an existing file** (atomic replace per file) | Pass |
| `DELE`, `RMD`, cleanup verified | Pass |

Timings were all under 0.6 s per operation from Costa Rica.

## Conclusions

- The write path in SPEC §6 decision 3 works as designed on this node: upload to temp names, rename into place (overwrite allowed), delete last.
- `MLSD` gives what the drift check needs without downloading files.
- **Still to do:** repeat on a second node (the spec asked for two), and test the connector's real network egress (k8s) rather than an operator workstation.
