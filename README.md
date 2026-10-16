<p align="center">
  <a href="https://crservers.com"><img src="docs/assets/crservers-logo.svg" alt="CR Servers" width="280"></a>
</p>

# CR Servers · AI Connect

[![CI](https://github.com/edenia/crservers-connector/actions/workflows/ci.yml/badge.svg)](https://github.com/edenia/crservers-connector/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Su sitio web, manejado por su asistente de IA.** Pídale a ChatGPT o Claude que actualice su sitio en CR Servers. Usted revisa una vista previa, confirma, y si algo no le gusta, lo deshace con una frase.

*Your website, managed by your AI assistant. [English below.](#english)*

> **Estado: piloto.** Estamos probando AI Connect con un grupo pequeño de clientes. Todavía no está disponible para todas las cuentas.

---

## Español

### ¿Para quién es?

Para dueños de negocios y profesionales con hospedaje en CR Servers que ya usan un asistente de IA y quieren mantener su sitio al día sin depender de un desarrollador, sin copiar y pegar código y sin compartir contraseñas.

### Cómo funciona

1. **Conecte su asistente.** En Claude o ChatGPT agregue CR Servers AI Connect.
2. **Autorice en su área de clientes.** Inicia sesión en el área de clientes de CR Servers, como siempre, y elige qué sitio puede tocar el asistente. Su contraseña nunca pasa por el asistente.
3. **Pida el cambio.** Por ejemplo: *"Cambie el precio del lote de 1000 m² a $45.000 y agregue estas fotos."* El asistente prepara un borrador; su sitio no cambia todavía.
4. **Revise y confirme.** El asistente le muestra qué va a cambiar y espera su confirmación antes de publicar.
5. **Deshaga si hace falta.** *"Deshaga el último cambio"* y el sitio vuelve a como estaba.

### Lo que su asistente puede y no puede hacer

| Puede | No puede |
|---|---|
| Leer y editar los archivos de **un** sitio que usted eligió | Ver ni cambiar su correo, DNS, bases de datos o facturación |
| Publicar páginas, estilos, imágenes, videos y documentos | Subir código de servidor (PHP), archivos ocultos ni configuración del servidor |
| Deshacer cualquiera de sus últimas publicaciones | Tocar sus otros sitios |
| Mostrarle el historial de cambios | Publicar sin una vista previa del cambio exacto |

Usted puede quitarle el acceso al asistente cuando quiera.

### Asistentes compatibles

- **Claude** (conector personalizado): funcionando en el piloto.
- **ChatGPT**: en preparación.

### ¿Preguntas?

Escríbanos desde [crservers.com](https://crservers.com). Le atiende nuestro equipo en Costa Rica, en español.

---

## English

**CR Servers AI Connect** lets a hosting client's own AI assistant (Claude, ChatGPT) publish and maintain their website safely. It's a remote [MCP](https://modelcontextprotocol.io) server with its own OAuth 2.1 authorization server. Sign-in happens in the CR Servers client area, so no password ever reaches the AI.

> **Status: pilot.** Not yet generally available to all CR Servers accounts.

### How it works

```
AI assistant ──MCP──▶ connector ──FTPS──▶ the client's web root (deploy user jailed to it)
     │                  │
     └── OAuth 2.1 ─────┴──▶ CR Servers client area (sign-in, consent, site picker)
```

- **Only the sites the client picked.** The token is bound to the sites (domains) the client ticked when connecting, and to this server's MCP URL. A subdomain's folder can't be changed through its parent site.
- **Drafts first.** Changes are staged; nothing is live until `publish`.
- **Preview gate.** `publish` only accepts a draft that was previewed in its current form, even if the AI host is set to "always allow".
- **Conflict check.** Publishing is refused if the live file changed since the draft was based on it.
- **Undo.** Before each publish, the previous version of every touched file is saved; the last 5 releases can be reverted, and a revert can itself be undone.
- **Safe publishing.** Uploads go to temporary names first, then are renamed into place; a failure halfway is rolled back automatically.
- **Static by default.** HTML, CSS, JS, images, video, fonts and PDF. Server-side code, `.htaccess` and hidden files are refused.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Tools

| Tool | What it does |
|---|---|
| `list_sites`, `get_site_info`, `get_usage_limits` | The connected site, its permission and limits |
| `list_files`, `read_file` | Browse and read (paged for large files) the live site or a draft |
| `start_changeset`, `write_files`, `edit_file`, `delete_files`, `discard_changeset` | Work in a draft |
| `preview_changeset` | What will change, plus the conflict check (required before publishing) |
| `publish`, `list_releases`, `revert_release` | Go live, see history, undo |
| `get_activity_log` | Who changed what, and when |

Every tool declares its MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`, `idempotentHint`), so AI hosts ask the user before anything goes live.

### Standards

OAuth 2.1 with PKCE (S256), Protected Resource Metadata (RFC 9728), Authorization Server Metadata (RFC 8414), resource indicators (RFC 8707), `iss` in authorization responses (RFC 9207), Dynamic Client Registration and Client ID Metadata Documents, and rotating refresh tokens with reuse detection.

### Development

Requirements: Node 22, pnpm 10, Docker (for Postgres).

```bash
pnpm install
docker run -d --name crs-connector-pg -e POSTGRES_PASSWORD=devonly -e POSTGRES_DB=connector -p 127.0.0.1:54329:5432 postgres:17-alpine
cp .env.example .env   # fill in the keys
pnpm test              # unit, FTP integration and end-to-end tests
pnpm dev
```

The end-to-end tests sign in through the real OAuth flow (with a stubbed client area) and drive the tools with the official MCP client.

Deployment notes: [docs/DEPLOY.md](docs/DEPLOY.md).

### Security

Please report vulnerabilities privately through this repository's **Security** tab → **Report a vulnerability**. See [SECURITY.md](SECURITY.md).

### License

[MIT](LICENSE). Built and operated by CR Servers, a brand of Sistemas Edenia Internacional S.A., Costa Rica.
