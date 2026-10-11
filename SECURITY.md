# Security

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through this repository's **Security** tab → **Report a vulnerability**. We'll acknowledge it, keep you informed, and credit you when the fix ships if you'd like.

## Scope

In scope: this service (OAuth server, MCP endpoint, publishing core) and its deployment manifests.

Especially interesting:
- Anything that lets one connection read or write outside its own site.
- Bypassing the preview gate, the file-type rules or the conflict check.
- Token theft or replay, redirect-URI or `iss` mix-ups, and consent or sign-in confusion.
- Prompt-injection paths that turn site content into actions.

Out of scope: denial of service through volume alone, and reports that need a compromised client device.

## Design notes

The security model is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
