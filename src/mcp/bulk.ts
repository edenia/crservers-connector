import { READ_TEXT_LIMIT } from '../deploy/core.js';
import { MB, extOf, isSecretPath, isTextPath } from '../deploy/paths.js';

/**
 * Search and replace across files (search_files, replace_in_files, the replacements of copy_files).
 * Exact text only, never patterns: what the assistant asks for is what is counted and changed.
 */

/** Files looked at per call, and their total size: a call stays within one request over FTPS. */
export const SCAN_MAX_FILES = 300;
export const SCAN_MAX_BYTES = 20 * MB;
/** Files with matches that search_files returns per call. */
export const SEARCH_MAX_RESULTS = 100;
export const EXCERPTS_PER_FILE = 3;
const EXCERPT_CHARS = 160;
/** Files replace_in_files changes per call. */
export const REPLACE_MAX_FILES = 100;

export interface Replacement {
  old_text: string;
  new_text?: string | null;
}

/**
 * Where `needle` starts in `text`, non-overlapping. Positions are always in `text` itself: lower-casing
 * can change a text's length ("İ"), so when it does the case-insensitive search runs as an escaped
 * pattern on the original instead.
 */
export function findAll(text: string, needle: string, caseSensitive = true, max = Infinity): number[] {
  const at: number[] = [];
  if (!needle) return at;
  let h = text;
  let n = needle;
  if (!caseSensitive) {
    h = text.toLowerCase();
    n = needle.toLowerCase();
    if (h.length !== text.length || n.length !== needle.length) {
      const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      for (let m = re.exec(text); m && at.length < max; m = re.exec(text)) at.push(m.index);
      return at;
    }
  }
  for (let i = h.indexOf(n); i !== -1 && at.length < max; i = h.indexOf(n, i + n.length)) at.push(i);
  return at;
}

export function countOccurrences(text: string, needle: string, caseSensitive = true): number {
  return findAll(text, needle, caseSensitive).length;
}

/** A replacement would make the text larger than the caller allows. */
export class TooLarge extends Error {}

/**
 * Applies each pair in order to every occurrence; `counts[i]` is how many times pair i matched.
 * The size of the result is worked out before it is built: over `maxChars` it throws TooLarge, so a
 * short text that matches many times can't be turned into a huge one in memory.
 */
export function replaceEvery(text: string, pairs: Replacement[], maxChars = READ_TEXT_LIMIT): { text: string; counts: number[] } {
  const counts: number[] = [];
  for (const p of pairs) {
    const n = countOccurrences(text, p.old_text);
    counts.push(n);
    if (!n) continue;
    const to = p.new_text ?? '';
    if (text.length + n * (to.length - p.old_text.length) > maxChars) throw new TooLarge();
    text = text.split(p.old_text).join(to);
  }
  return { text, counts };
}

/** The first matches of a file, each on one line with its line number, cut to a short window around the match. */
export function excerpts(text: string, needle: string, caseSensitive = true, max = EXCERPTS_PER_FILE): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let line = 1;
  let pos = 0;
  for (const i of findAll(text, needle, caseSensitive, max)) {
    for (let j = text.indexOf('\n', pos); j !== -1 && j < i; j = text.indexOf('\n', j + 1)) line++;
    pos = i;
    const lineStart = text.lastIndexOf('\n', i - 1) + 1;
    const nl = text.indexOf('\n', i);
    const lineEnd = nl === -1 ? text.length : nl;
    const room = Math.max(0, EXCERPT_CHARS - needle.length);
    const start = Math.max(lineStart, i - Math.floor(room / 2));
    const end = Math.min(lineEnd, start + Math.max(EXCERPT_CHARS, needle.length));
    out.push({ line, text: `${start > lineStart ? '…' : ''}${text.slice(start, end).trim()}${end < lineEnd ? '…' : ''}` });
  }
  return out;
}

export type SkipReason = 'secret' | 'other_site' | 'not_text' | 'too_large';

/**
 * Why a file is left out of a search or replace, or null when it can be read as text: files that may
 * hold passwords or keys, other sites' folders (subdomains), binary files and text over 1 MB.
 */
export function skipReason(path: string, size: number, protectedDirs: string[]): SkipReason | null {
  if (isSecretPath(path)) return 'secret';
  if (protectedDirs.some((d) => path === d || path.startsWith(`${d}/`))) return 'other_site';
  if (!isTextPath(path)) return 'not_text';
  if (size > READ_TEXT_LIMIT) return 'too_large';
  return null;
}

/** Whether a path is inside `dir` ("" = the whole site) and has one of the extensions (none given = any). */
export function inScope(path: string, dir: string, extensions: string[] = []): boolean {
  if (dir && !path.startsWith(`${dir}/`)) return false;
  return !extensions.length || extensions.includes(extOf(path));
}

/** "HTML", ".html" → "html". */
export function normalizeExtensions(raw: string[] | undefined): string[] {
  return [...new Set((raw ?? []).map((e) => e.trim().replace(/^\./, '').toLowerCase()).filter(Boolean))];
}
