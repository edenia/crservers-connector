# crservers-connector

Lets a CR Servers hosting client's own AI assistant (Claude, ChatGPT) publish and maintain their website safely.

**Status:** design stage. Nothing here is built or shipped yet. See [SPEC.md](SPEC.md).

## What it will be

- A **remote MCP server** at `connect.crservers.com/mcp`, usable as a Claude custom connector and a ChatGPT plugin.
- An **OAuth 2.1 authorization server** whose sign-in step is the CR Servers client area, via a HostBill client-area plugin (kept in a private repo). We never see client passwords.
- A **deploy core** that stages changes, previews them, scans them, publishes to one site's web root only, and keeps a revert record of every publish.

## Related repos

| Repo | Role |
|---|---|
| `edenia/hostbill-crsconnect` (private) | HostBill client-area plugin: sign-in, consent, site picker |
| [edenia/crservers-static-deploy](https://github.com/edenia/crservers-static-deploy) | GitHub Action deploy path, and the contact form component |

## Security

Found a security issue? Please don't open a public issue. Report it privately through this repo's **Security** tab → **Report a vulnerability**.

## License

MIT
