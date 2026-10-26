import type { SiteFs } from './sitefs.js';

/**
 * Managed components (hostbill-crsconnect docs/connector/SPEC-managed-contact-form.md): server code CR Servers
 * installs and updates on a site, which the AI only wires into pages. The client-area plugin writes this
 * marker last on install and removes it first on removal. Like the deploy marker, the ".ht" prefix keeps
 * it from being served, and the AI can't write dot-files.
 */
export const COMPONENTS_MARKER = '.htcrservers-components.json';

export interface ContactForm {
  version: string;
  endpoint: string;
}

const VERSION_RE = /^v?\d{1,4}(\.\d{1,4}){0,3}$/;

/** The site's managed contact form, or null when it isn't installed (or the marker doesn't look like ours). */
export async function readContactForm(fs: SiteFs): Promise<ContactForm | null> {
  try {
    const st = await fs.stat(COMPONENTS_MARKER);
    if (!st || st.type !== 'file' || st.size > 4096) return null;
    const j = JSON.parse((await fs.read(COMPONENTS_MARKER)).toString('utf8')) as Record<string, unknown>;
    const c = (j.components as Record<string, unknown> | undefined)?.contact_form as Record<string, unknown> | undefined;
    if (j.tool !== 'crservers-components' || !c || typeof c !== 'object') return null;
    // Phase 1 installs only /contact.php in the web root; anything else isn't ours.
    if (c.endpoint !== '/contact.php') return null;
    const php = await fs.stat('contact.php');
    if (!php || php.type !== 'file') return null;
    const version = typeof c.version === 'string' && VERSION_RE.test(c.version) ? c.version.replace(/^v/, '') : 'unknown';
    return { version, endpoint: '/contact.php' };
  } catch {
    return null;
  }
}

/** What the tools tell the AI about calling the contact form from a page. */
export function contactFormNote(): string {
  return (
    'This site has a contact form installed and maintained by CR Servers. To add a form to a page, write only HTML and JavaScript that posts to /contact.php: ' +
    'fetch("/contact.php", { method: "POST", headers: { Accept: "application/json" }, body: new FormData(form) }) and read the JSON { ok, error }. ' +
    'Fields: email (required, the visitor\'s address, used as Reply-To), name, message, optional subject; every other field is included in the email. ' +
    'Add a honeypot: a text input named company, visually hidden with CSS (not type="hidden"), with tabindex="-1", autocomplete="off" and aria-hidden="true", left empty. ' +
    'Show the result on the page without reloading, disable the button while sending, and keep the visitor\'s text if it fails. Show error to the visitor only for status 400; for 429 (too many messages) and 500 or 503 show a short "try again later". ' +
    'The form can\'t send from the preview link; tell the user to test it after publishing. ' +
    'Never write contact.php, vendor/ or composer files, never add other PHP, and never put an email address or password in the page for the form to work: the recipient is set by the site owner in the CR Servers client area.'
  );
}

export function contactFormInfo(c: ContactForm): Record<string, unknown> {
  return {
    enabled: true,
    version: c.version,
    endpoint: c.endpoint,
    method: 'POST',
    request: {
      body: 'multipart/form-data or application/x-www-form-urlencoded (new FormData(form)), or a flat JSON object',
      headers: { Accept: 'application/json' },
      fields: { email: 'required', name: 'optional', message: 'optional', subject: 'optional, up to 200 characters' },
      honeypot: 'company',
    },
    response: {
      200: '{ "ok": true, "error": "" }',
      400: '{ "ok": false, "error": "…" } missing or invalid email, empty or too-short message',
      429: 'too many submissions from this visitor',
      500: 'mail not configured or sending failed',
      503: 'busy, try again',
    },
    limits: { messages_per_hour_per_visitor: 8, attempts_per_hour_per_visitor: 40 },
    guidance: contactFormNote(),
  };
}
