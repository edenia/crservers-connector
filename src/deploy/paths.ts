/**
 * Path and file-type rules for everything the AI can touch (SPEC §5 "Scope", "File types").
 * All site paths are relative POSIX paths inside the web root, without a leading slash.
 */

export class PathError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'PathError';
  }
}

const MAX_PATH = 255;
const MAX_SEGMENT = 100;

/** Normalizes user/AI input to a safe relative path, or throws PathError. */
export function normalizeSitePath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) throw new PathError('Empty path', String(input));
  if (/[\u0000-\u001f\u007f\\]/.test(input)) throw new PathError('Control characters or backslashes are not allowed', input);

  const segments: string[] = [];
  for (const seg of input.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new PathError('".." is not allowed', input);
    if (seg.length > MAX_SEGMENT) throw new PathError('Path segment too long', input);
    segments.push(seg);
  }
  if (segments.length === 0) throw new PathError('Path points at the web root itself', input);
  const path = segments.join('/');
  if (path.length > MAX_PATH) throw new PathError('Path too long', input);
  return path;
}

/** Same as normalizeSitePath but allows the web root ("") for directory listings. */
export function normalizeSiteDir(input: string | undefined): string {
  if (input === undefined || input === '' || input === '/' || input === '.') return '';
  return normalizeSitePath(input);
}

const ALLOWED_EXT = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'json', 'xml', 'txt', 'md', 'svg',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'ico',
  'woff', 'woff2', 'ttf', 'otf',
  'mp4', 'webm', 'mp3', 'pdf', 'webmanifest',
]);

const VIDEO_EXT = new Set(['mp4', 'webm']);

export const MB = 1024 * 1024;

export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Paths installed and owned by managed components (P2/P3): readable, never writable by the AI. */
export const COMPONENT_PATHS = ['contact.php', 'vendor/'];

function isComponentPath(path: string): boolean {
  return COMPONENT_PATHS.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

/**
 * Whether the AI may create, overwrite or delete this path. Throws PathError with a
 * plain reason when not. Assumes `path` is already normalized.
 */
export function assertWritable(path: string): void {
  const segments = path.split('/');
  const base = segments[segments.length - 1] ?? '';

  if (isComponentPath(path)) throw new PathError('This file belongs to a managed component and can only be changed by enabling or updating that component', path);

  const isWellKnown = segments[0] === '.well-known';
  if (!isWellKnown && segments.some((s) => s.startsWith('.'))) {
    throw new PathError('Hidden files and folders (starting with ".") are not allowed', path);
  }
  if (base.toLowerCase() === '.htaccess') throw new PathError('.htaccess is not allowed', path);

  if (isWellKnown) return;
  const ext = extOf(path);
  if (!ALLOWED_EXT.has(ext)) {
    throw new PathError(ext ? `File type ".${ext}" is not allowed` : 'Files without an extension are not allowed', path);
  }
}

/** Per-file size cap (SPEC §5 "Size / rate"). */
export function maxFileBytes(path: string): number {
  return VIDEO_EXT.has(extOf(path)) ? 100 * MB : 25 * MB;
}

/** Files read_file returns as text. Everything else returns metadata and a hash only. */
const TEXT_EXT = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'xml', 'txt', 'md', 'svg', 'webmanifest', 'php']);

export function isTextPath(path: string): boolean {
  return TEXT_EXT.has(extOf(path)) || path.startsWith('.well-known/');
}
