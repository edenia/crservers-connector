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

## Demo video script (about 3 minutes)

1. In ChatGPT, open the CR Servers AI Connect app and click **Connect**. Sign in to the CR Servers client area, choose test.crservers.com, **Edit and publish**, **Allow**.
2. "Show me the files on my website." → list of files.
3. "Change the main heading on my home page to "Welcome to our test site" and give me a preview link." → open the preview link and show the new heading; show that the live site is unchanged.
4. "Looks good, publish it." → approve the confirmation → reload the live site.
5. "Undo that change." → approve → reload: the original heading is back.
6. Attach a photo: "Add the attached photo to my site as img/review.jpg and show me a preview." → preview link.
7. Negative cases: "Change the DNS records of my domain…" (explains it can't), "Upload a PHP script…" (refused).
8. In the client area, open **AI Connect** → the site → show the connection and the activity log, and **Remove access**.

## Listing summary

| Field | Value |
|---|---|
| Name | CR Servers AI Connect |
| Short description | Build and publish your website |
| Category | Productivity |
| Countries | All (`[]`) |
| Website / support | KB overview / connecting guide on crservers.com |
| Privacy / terms | `crservers.com/privacy#ai-connect` / client-area terms of service (names Sistemas Edenia Internacional S.A.) |
| Publisher | Sistemas Edenia Internacional S.A. (business verification approved) |
