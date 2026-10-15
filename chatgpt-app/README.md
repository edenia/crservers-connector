# CR Servers AI Connect: ChatGPT directory submission

Everything needed to submit AI Connect to the ChatGPT plugin directory. The ZIP holds `plugin.json`, `mcp.json`, `skills/` and `assets/`. This README never goes in the ZIP.

## Before submitting

- [ ] Server release deployed with `add_attachments`, the domain-check route and the trimmed tool output.
- [ ] `OPENAI_APPS_CHALLENGE` set as a production environment variable (token from the submission dashboard), deployed; `https://connect.crservers.com/.well-known/openai-apps-challenge` returns it.
- [ ] Privacy policy AI Connect section live at `https://crservers.com/privacy#ai-connect` (both languages).
- [ ] Reviewer account ready (below), tested in a fresh browser profile.
- [ ] Demo video recorded (script below); its URL set in `plugin.json` → `review.demo_recording_url`.
- [ ] `./build-zip.sh` → upload `crservers-ai-connect.zip`, fix anything the automatic scans report, fill **Review details**, submit.

The MCP origin `https://connect.crservers.com` can't change after submission.

## Reviewer details (dashboard → Review details, not the ZIP)

- **Login URL:** https://clients.crservers.com/login/ (opens automatically when connecting from ChatGPT)
- **Account:** the dedicated review client (email and password entered in the dashboard only). No 2FA. Owns one test site: **test.crservers.com**.
- **Notes for reviewers:**
  - Sign in uses invisible reCAPTCHA v3; please use a normal browser session.
  - On the consent screen choose **test.crservers.com** and **Edit and publish**, then **Allow**.
  - The test cases change only the test site, and every published change can be undone with "undo that change".
  - Preview links are private and expire after an hour.

## Demo video script (about 3–4 minutes)

The test site's home page heading should read "Welcome to our test site" before recording (and before submitting), so the change below is visible. Run test case 4 ("Undo that change.") after test case 3 to put it back.

### Setup

- Record with macOS (`Cmd + Shift + 5` → Record Selected Portion, Options → Show Mouse Clicks, microphone on). Trim in QuickTime (Edit → Trim) or iMovie.
- Clean browser profile or guest window, zoom 110–125%. Tabs: ChatGPT and `https://test.crservers.com`.
- In ChatGPT, AI Connect available but **not connected**, so the video shows Connect.
- Sign in to the client area as the review account, never a real customer account.
- A small photo on the desktop for step 6. Do one practice run: confirmation cards can appear below the fold.
- Upload as **Unlisted** (YouTube or Loom) and check the link in a signed-out window.

### Steps and narration

| # | Action / prompt | Narration |
|---|---|---|
| – | Intro | "This is CR Servers AI Connect. It lets CR Servers hosting customers update their website from ChatGPT. I'll show connecting, editing, previewing, publishing and undoing a change on our test site." |
| 1 | Open the app, **Connect**, sign in, choose test.crservers.com → **Edit and publish** → **Allow** | "I click Connect and sign in to the CR Servers client area. I choose the site and the permission 'Edit and publish', then Allow. The connection only works on the site I picked." |
| 2 | "Show me the files on my website." | "First, I ask to see my website's files. This only reads; nothing changes." |
| 3 | "Change the main heading on my home page to "Hello from ChatGPT" and give me a preview link." → open the preview, then the live tab | "Changes are saved to a draft, not the live site. Here's the private preview link with the new heading… and here's the live site, still unchanged." |
| 4 | "Looks good, publish it." → approve → reload the live site | "Publishing changes the live site, so ChatGPT asks me to confirm first. I approve… and after a reload the live site shows the new heading." |
| 5 | "Undo that change." → approve → reload | "Every publish can be undone. I confirm… and the original heading is back." |
| 6 | Attach a photo: "Add the attached photo to my site as img/review.jpg and show me a preview." | "I can also attach a photo in the chat. It's added to the draft, and I get a preview link to check it before anything goes live." |
| 7 | "Change the DNS records of my domain to point to another server." | "The app only edits website files. If I ask it to change DNS records, it explains that it can't." |
| 8 | Client area → **AI Connect** → the site → activity log → **Remove access** (record last) | "In the client area, under AI Connect, I can see the connection and a log of every change. I can remove ChatGPT's access at any time." |
| – | Closing | "That's CR Servers AI Connect: edit in a draft, preview privately, publish only after confirming, and undo any time." |

After recording: the unpublished photo draft expires on its own within 24 hours; reconnect if needed.

## Listing summary

| Field | Value |
|---|---|
| Name | CR Servers AI Connect |
| Short description | Publish website changes |
| Category | Developer Tools |
| Countries | All (`[]`) |
| Website / support | KB overview / connecting guide on crservers.com |
| Privacy / terms | `crservers.com/privacy#ai-connect` / client-area terms of service (names Sistemas Edenia Internacional S.A.) |
| Publisher | Sistemas Edenia Internacional S.A. (business verification approved) |
