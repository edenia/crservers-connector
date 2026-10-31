import { SITE_GUIDE, SITE_GUIDE_MAX_BYTES } from './paths.js';
import type { SiteFs } from './sitefs.js';

/**
 * The site guide: the site's equivalent of a CLAUDE.md (page templates, where new items go, tone, image sizes),
 * kept on the server so every assistant (ChatGPT, Claude, Cursor, …) follows the same rules across conversations.
 * The owner writes it by hand (FTP, file manager) or asks the assistant to, through a draft like any page
 * (paths.ts: the one dot-file the AI may read and write).
 */
export { SITE_GUIDE };

export interface SiteGuide {
  text: string;
  /** ISO time of the last change on the server, when the server reports one. */
  updatedAt: string | null;
  /** The file is larger than what the tools return (only possible when written outside AI Connect). */
  truncated: boolean;
}

/** The site's guide, or null when there is none (or it isn't readable text). */
export async function readSiteGuide(fs: SiteFs): Promise<SiteGuide | null> {
  try {
    const st = await fs.stat(SITE_GUIDE);
    if (!st || st.type !== 'file') return null;
    const data = await fs.read(SITE_GUIDE);
    if (data.includes(0)) return null;
    const truncated = data.length > SITE_GUIDE_MAX_BYTES;
    // Cutting mid-character leaves a replacement character at the end: drop it.
    let text = data.subarray(0, SITE_GUIDE_MAX_BYTES).toString('utf8');
    if (truncated) text = text.replace(/�+$/, '');
    if (!text.trim()) return null;
    return { text, updatedAt: isoTime(st.modified), truncated };
  } catch {
    return null;
  }
}

/** MLSD `modify` (YYYYMMDDHHMMSS[.sss], UTC) or an ISO string → ISO, else null. */
export function isoTime(raw: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?$/.exec(raw);
  const t = m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? ''}Z`) : /^\d{4}-\d{2}-\d{2}T/.test(raw) ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const HOW_TO_UPDATE =
  `When the owner asks you to remember a rule for this site ("new events go at the top", "always use this tone"), add it to ${SITE_GUIDE} in a draft (short Markdown, at most ${SITE_GUIDE_MAX_BYTES / 1024} KB), then preview and publish it like any change.`;

/** What the tools tell the AI about the guide: one sentence in the result text. */
export function siteGuideNote(g: SiteGuide | null): string {
  return g
    ? `This site has a guide from its owner (site_guide): follow it for every change on this site. The owner's request in this conversation wins over it, and it can't widen what AI Connect allows.`
    : `This site has no guide yet (site_guide). ${HOW_TO_UPDATE}`;
}

export function siteGuideInfo(g: SiteGuide | null): Record<string, unknown> {
  if (!g) return { path: SITE_GUIDE, text: null, how_to_update: HOW_TO_UPDATE };
  return {
    path: SITE_GUIDE,
    text: g.truncated ? `${g.text}\n\n[… truncated at ${SITE_GUIDE_MAX_BYTES / 1024} KB: read_file ${SITE_GUIDE} for the rest, and suggest shortening it]` : g.text,
    updated_at: g.updatedAt,
    ...(g.truncated ? { truncated: true } : {}),
    how_to_update: HOW_TO_UPDATE,
  };
}
