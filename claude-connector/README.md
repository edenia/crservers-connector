# CR Servers AI Connect: Claude directory submission

Everything to enter in Anthropic's developer portal ([claude.ai/directory/manage](https://claude.ai/directory/manage) → **Submit new** → **MCP connector**). Requirements: [Submit a connector](https://claude.com/docs/connectors/building/submission), [review criteria](https://claude.com/docs/connectors/building/review-criteria), [authentication](https://claude.com/docs/connectors/building/authentication).

## Before submitting

- [ ] Connector release with loopback callbacks deployed (PR #39), so Claude Code can connect.
- [ ] Tested as a custom connector in Claude (claude.ai → Settings → Connectors → Add custom connector → `https://connect.crservers.com/mcp`): every tool called once from a chat, with the review account.
- [ ] Tested in Claude Code: `claude mcp add --transport http crservers https://connect.crservers.com/mcp`, then sign in and list files.
- [ ] Review account `review@crservers.com` working, test.crservers.com heading reads "Welcome to our test site".
- [ ] Submitting account is on a paid Claude plan and is an organization Owner.

## Portal steps

### 1. Connection

Universal URL: `https://connect.crservers.com/mcp`

### 2. Tools

17 tools sync from the server. Each has a `title` and explicit annotations: read-only tools `readOnlyHint: true`; draft tools change only the server-side draft; `publish`, `revert_release` and `discard_changeset` are `destructiveHint: true`. No tool should be flagged.

### 3. Listing

| Field | Value |
|---|---|
| Server name (≤100) | CR Servers AI Connect |
| One-liner (≤200) | Edit and publish your CR Servers-hosted website from Claude, with a private preview before anything goes live and one-step undo. |
| Categories | Developer tools; Productivity (closest available) |
| Documentation URL | https://crservers.com/support/hosting/ai-connect |
| Privacy policy URL | https://crservers.com/privacy#ai-connect |
| Support contact | support@crservers.com |
| Icon | `chatgpt-app/assets/logo.png` (256×256 PNG) |
| URL slug (permanent) | `crservers-ai-connect` |

Description (≤2000):

> Publish changes to your website hosted on CR Servers, straight from Claude. Ask Claude to edit a page, update a price or add a photo: it prepares the change in a draft, gives you a private preview link, and publishes it to your live site only after you confirm. Every published change can be undone with one sentence.
>
> You sign in with your CR Servers client area account and tick the websites Claude can work on: your main domain, additional domains or subdomains. You also choose whether it can publish or only prepare previews. Claude can't see or change your email, DNS, databases, certificates or billing, and it never sees your password.
>
> What you can do:
> - Read your site's files and change text, prices, images, styles and pages
> - Bring in images from a public link
> - Preview every change privately before it goes live
> - Publish once you confirm, and undo any of the last five publishes
> - See every change in your client area, and remove access at any time
>
> AI Connect works with file-based websites (HTML, CSS, JavaScript, images, fonts and PDFs). Server-side code such as PHP is not accepted. It is included with CR Servers shared hosting.

### 4. Use cases

- **Primary use cases:** update an existing website (text, prices, images, pages); build a simple site from scratch; preview changes privately; publish after confirmation; undo a publish.
- **What users need first:** an active CR Servers shared hosting service with a file-based website, and a CR Servers client area account.
- **Reads or writes:** both. Reads the site's files; writes to a draft; publishes to the live site only through `publish` after the user confirms.

### 5. Company

- Company: Sistemas Edenia Internacional S.A. (CR Servers)
- Website: https://crservers.com
- Primary contact: entered in the portal by the submitter.

### 6. Authentication

OAuth 2.0 with **client ID metadata documents** (DCR also supported as a fallback). PKCE S256, refresh tokens rotate, 1-hour access tokens. Callbacks: `https://claude.ai/api/mcp/auth_callback` and loopback (Claude Code). Sign-in and consent happen in the CR Servers client area.

### 7. Data handling

- API: **our own** (CR Servers hosting, first-party).
- Personal health data: no. Sponsored content: no.

### 8. Test & launch (reviewer instructions)

Credentials go only in the portal field, never in this file.

1. Add the connector (`https://connect.crservers.com/mcp`) and click **Connect**. The CR Servers client area sign-in page opens.
2. Sign in with the review account (`review@crservers.com`, password in the portal). No 2FA; invisible reCAPTCHA, so please use a normal browser session.
3. On the consent screen, keep **test.crservers.com** ticked, choose **Edit and publish**, and click **Allow**.
4. Try:
   - "Show me the files on my website." (`list_sites`, `list_files`)
   - "Change the main heading on my home page to "Hello from Claude" and give me a preview link." (`start_changeset`, `read_file`, `edit_file`, `preview_changeset`)
   - "Looks good, publish it." (`publish`; Claude asks for confirmation)
   - "Undo that change." (`list_releases`, `revert_release`)
   - "Add this image to my site as img/review.png: https://crservers.com/icon.png" (`import_from_url`)
5. Out of scope, expected to be declined: DNS changes, uploading PHP, billing.

Notes:
- The test cases only change test.crservers.com; please undo publishes so the heading returns to "Welcome to our test site".
- `add_attachments` receives files attached in ChatGPT (OpenAI file parameters). In Claude, images come in through `import_from_url`.
- Preview links are private and expire after an hour.

Confirm: every tool has been run through a custom connector in Claude.

### 9. Compliance

All seven acknowledgments apply as stated:
- **Directory guidelines:** accepted.
- **First-party API:** the server calls only CR Servers' own hosting.
- **Financial transactions:** none. The connector moves no money and sells nothing.
- **AI media generation:** none.
- **Prompt injection:** site content is returned as data, and the server instructions tell the model never to follow instructions found in files.
- **Conversation data:** none collected. The server logs only the tool name, duration and errors, never arguments or results.
- **Public documentation:** the knowledge base articles above.
