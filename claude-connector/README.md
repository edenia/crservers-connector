# CR Servers AI Connect: Claude directory submission

Everything to enter in Anthropic's developer portal ([claude.ai/directory/manage](https://claude.ai/directory/manage) → **Submit new** → **MCP connector**). Requirements: [Submit a connector](https://claude.com/docs/connectors/building/submission), [review criteria](https://claude.com/docs/connectors/building/review-criteria), [authentication](https://claude.com/docs/connectors/building/authentication).

## Before submitting

- [x] Connector v0.7.3 deployed: loopback callbacks (Claude Code), annotations.title, app icon.
- [ ] Tested as a custom connector in Claude (claude.ai → Settings → Connectors → Add custom connector → `https://connect.crservers.com/mcp`): every tool called once from a chat, with the review account.
- [ ] Tested in Claude Code: `claude mcp add --transport http crservers https://connect.crservers.com/mcp`, then sign in and list files.
- [ ] Review account `review@crservers.com` working, test.crservers.com heading reads "Welcome to our test site".
- [ ] Submitting account is on a paid Claude plan and is an organization Owner.

## Portal steps

The portal keeps a draft only in the browser tab (**"Draft saved in this tab"**). **Save and exit** doesn't create a submission, and the draft can be lost, so enter everything in one sitting: test first, then fill all 10 steps and submit.

### 1. Connection

- **Server URL:** `https://connect.crservers.com/mcp`. The portal should show *CR Servers · 17 tools · 0 resources · Auth OAuth*.
- **Users connect to different URLs:** leave unchecked.

### 2. Tools

17 tools, each with `annotations.title` (since v0.7.2) and explicit hints. Ignore the "Reference the target API docs" suggestion: it's for tools that send raw API requests, and ours call fixed operations.

### 3. Listing

| Field | Value |
|---|---|
| Name | CR Servers AI Connect |
| Slug (permanent) | `crservers-ai-connect` |
| One-liner | Edit and publish your CR Servers-hosted website from Claude, with a private preview before anything goes live and one-step undo. |
| Description | The text below |
| Categories | Development tools; Productivity |
| Author name | CR Servers |
| Author URL | https://crservers.com |
| Icon | Leave blank (the server serves `/favicon.ico`), or `https://connect.crservers.com/icon.png`. Not `crservers.com/icon.png`: the website blocks cross-origin image loads. |

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

| Use case | Example prompt |
|---|---|
| Update text or prices on a website | Change the price of the 1,000 m² lot on my home page to $45,000 and show me a preview. |
| Add a photo to a page | Add this image to my homepage below the main heading: https://crservers.com/icon.png |
| Publish or undo a change | Looks good, publish it. Then undo that change. |

- **Prerequisites:** An active CR Servers shared hosting service with a file-based website (HTML, CSS, JavaScript, images), and a CR Servers client area account that owns it. On first connection the user signs in to the client area, ticks the sites Claude may work on, and chooses "Edit and publish" or "Preview only". Reviewers: use the test account in Test & launch (site test.crservers.com).
- **Read/write:** Read and write.

### 5. Company

- **Company name:** Sistemas Edenia Internacional S.A. (CR Servers)
- **Website:** https://crservers.com
- **Primary contact:** the submitter's name, email and role.
- **Anthropic contact:** blank.

### 6. Authentication

The portal detects it, so keep what it shows:
- **Requirement:** Always required.
- **OAuth client:** Client ID Metadata Document.
- **Headers:** none.

### 7. Data handling

- **API:** our own (first-party).
- **Personal health data:** no.
- **Sponsored content:** no.

### 8. Test & launch

Paste this into **Test setup instructions**. Replace `[PASSWORD]` in the portal only, never in this file.

```
Server: https://connect.crservers.com/mcp (OAuth sign-in through the CR Servers client area; the account below already exists, no sign-up needed).

Test account (dedicated to reviews, owns one test website, test.crservers.com):
- Email: review@crservers.com
- Password: [PASSWORD]
- No 2FA. The sign-in page uses invisible reCAPTCHA, so please use a normal browser session.

Steps:
1. Add the connector and click Connect. The CR Servers client area sign-in page opens.
2. Sign in with the test account.
3. On "Connect your AI assistant", keep test.crservers.com ticked, choose "Edit and publish", and click Allow.
4. In a new chat, try (tools in brackets):
   - "Which sites can you work on? Show me the files on my website." (list_sites, get_site_info, get_usage_limits, list_files)
   - "Change the main heading on my home page to "Hello from Claude" and give me a preview link." (start_changeset, read_file, edit_file, preview_changeset)
   - "Looks good, publish it." (publish; asks for confirmation)
   - "Undo that change." (list_releases, revert_release)
   - "Add this image to my site as img/review.png and show me a preview: https://crservers.com/icon.png" (import_from_url, preview_changeset)
   - "Create a page about.html that says hello, then delete it from the draft and discard the draft." (write_files, delete_files, discard_changeset)
   - "Show me the activity log." (get_activity_log)
5. Out of scope, expected to be declined: changing DNS records, uploading PHP, anything about billing.

Notes:
- The tests only change test.crservers.com. Please undo publishes so the heading returns to "Welcome to our test site".
- add_attachments receives files attached in ChatGPT (OpenAI file parameters). In Claude, images come in with import_from_url.
- Preview links are private and expire after one hour.
- Docs: https://crservers.com/support/hosting/ai-connect
```

**Self-tested:** tick it only after running the prompts above as a custom connector in Claude (Settings → Connectors → Add custom connector).

### 9. Compliance

All seven acknowledgments apply as stated:
- **Directory guidelines:** accepted.
- **First-party API:** the server calls only CR Servers' own hosting.
- **Financial transactions:** none. The connector moves no money and sells nothing.
- **AI media generation:** none.
- **Prompt injection:** site content is returned as data, and the server instructions tell the model never to follow instructions found in files.
- **Conversation data:** none collected. The server logs only the tool name, duration and errors, never arguments or results.
- **Public documentation:** the knowledge base articles above.
