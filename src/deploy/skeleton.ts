import { createHash } from 'node:crypto';

/**
 * The placeholder files every new hosting account starts with (the control panel copies its skeleton
 * into the web root): a "Test Page for <domain>" / "Sitio en preparación" page, its backups, logos,
 * robots.txt and the welcome page's fonts and images. On a site that still holds only these, the first
 * publish of a home page removes them (core.ts, preview), so they don't linger next to the new site.
 *
 * Recorded on 2026-10-25 from the hosting skeletons (current and earlier) and the 70 accounts still
 * showing a placeholder (docs/ARCHITECTURE.md, "Placeholder files"); 2026-10-30 adds the skeleton's
 * 2026-10-28 update (social preview image, favicons). Keep in step with the skeleton package
 * (edenia/crservers-interworx, customizations/new-site-page/v2). A file matches only when its path
 * and its exact content are listed here, so a file the customer edited never matches.
 */

/**
 * Placeholder pages, by sha256 after the domain in them is replaced with "::DOMAIN::" (the skeleton's
 * own placeholder, filled in per account). Any of these may sit under any of PAGE_NAMES.
 */
const PAGE_HASHES = new Set([
  '9b37821aa704064c051724955e1d10a18a9a763b4e958a33e31b2dc310272cd2', // "Test Page for …", 50 KB
  '0269ffc6156a977551748aef78e9b6247eb2d8627d8655fcb055600a8d55b1db', // "Test Page for …", 93 KB (the .bak-20260723 copies)
  '1199559298fcc52c806d85cd7104a03fa08b56ebbd32a13d718b164765bb0a77', // "Test Page for …", 93 KB, older
  '11a25716a6f4d6b2a06aad5ea720c75cbd61fff1c245afb42079d270610b9f9d', // "… · Sitio en preparación", 12 KB, with og:image and icons (current)
  'bf0f98660812f60d32ba707e90100ee75522a1f334b71ffac3b15a4da75c605c', // "… · Sitio en preparación", 11 KB (until 2026-10-28; also the .bak-20261028-og copy)
  '42252aea67e5e2fd2d7a4fd1e8e9b9aed7193f077cc91b8f7795a98a60ff8d2f', // "… — Sitio en preparación", 51 KB
]);
const PAGE_NAMES = new Set(['index.html', 'index.html.orig', 'index.html.bak-20260723', 'index.html.orig.bak-20260723', 'index.html.bak-20261028-og']);
const PAGE_MAX_BYTES = 128 * 1024;

/** Other placeholder files: path → sha256 of the exact content. */
const FILES = new Map<string, Set<string>>(
  Object.entries({
    'robots.txt': ['7ef9ca5668105e619daedff0fe33502daf81f63434afa6788d77effa5048c476'],
    'crservers-logo.png': ['b7b74b322ede67814f8caec69a495a5ca99ee11946aaffae639c2bddc3e04dec', 'a83e2638cf74f11d54716c7cdde5718b9ba60bc5ae6f448a474c182dbcb8130c'],
    'crservers-logo.svg': ['ac5297d1136c9672d05707b28a973c01b77c5e8d4d2d2d54fb9814e1c2af75e8'],
    'favicon.ico': ['594437bbed0ec410c7daeaf301c61fd71bb37da74f6e5bc383de4b2fc2e6fd4a'],
    'crservers-welcome-assets/OFL.txt': ['58172e0c0fac2cda8a37b348164bb55e44b0e69051e557e92b1d3f6910141f7b'],
    'crservers-welcome-assets/Roboto-OFL.txt': ['061402327a96aadb0bfb694a960ed289ecd38d383e396243831ab81feb109c41'],
    'crservers-welcome-assets/apple-icon.png': ['ebf581f23c3cc8e08df82d4530d548ac2db9b963d1ca9e6952975f6c87d4ac38'],
    'crservers-welcome-assets/favicon.ico': ['594437bbed0ec410c7daeaf301c61fd71bb37da74f6e5bc383de4b2fc2e6fd4a'],
    'crservers-welcome-assets/gear-shadow.png': ['0f8e35bd0ab1b869a36c0ff7ca39876a9a014512de60af2b303a342c279ed676'],
    'crservers-welcome-assets/gear.png': ['39e17ef770d2efeb9257f7517e747a7e93f93d300a4b731b493e91bd7fe48166'],
    'crservers-welcome-assets/icon.png': ['c57e89985b05c68dfa37f5e815f1062666c4d801cd64fb825bda7d9499d9b4a3'],
    'crservers-welcome-assets/icon.svg': ['2a4cd11de694bee2377d1003c5966775d9cd8c7fd5f38b52f5a00c44fdabff41'],
    'crservers-welcome-assets/manrope-latin-variable.woff2': ['079229497880e72b12cd53daf1f43f7bf37317793e30c29d7a69e4e0edb24d45'],
    'crservers-welcome-assets/og.jpg': ['57908485fd7f52a44f1e1c812301ddf620f8e8a536a76dde8a74164b945ecbd8'],
    'crservers-welcome-assets/roboto-latin-variable.woff2': ['1404ca348bd75ef836f4dd8b6f2cc719458642d1237c368296b2fc652dca47dc'],
    // Images of the older (2018) placeholder page.
    'admin-active.jpg': ['ee14ee710184432bea7a019c5d488ad6be0f4954477baeb9bf61cc4a844b5d38'],
    'admin-hover.jpg': ['8d004a84df1180ec75a0c40f1f021cc77ba74d562be2764fda9b855f2aebe466'],
    'mail-active.jpg': ['c5b7026d02fbaf4416bcd2277d6f493a310f74f698a9def1daecdb4aac0ed031'],
    'mail-hover.jpg': ['488f3920842d605fe0d79e2e8b5d207c8af20f5c31da4105bd7da9e983717a4c'],
    'mosaic.png': ['0f6f0ed6c96f379c1cee89709cbf240aa4f02eaea0d993b2cf46cfd51b701f34'],
    'shadow.png': ['831dfd8c3de24981c1807631f4b76efd024c2bbfd43f039ce42ed897bca3f78b'],
    'shared-active.jpg': ['3c3dc78e7be45be060ab45dde14866962fc13baec047215917ee1bc9495f3ac6'],
    'shared-hover.jpg': ['5f81fdb6ce2e7056a5eb5f5cb49082fea87cee4dbeab1870724a331a5e520926'],
  }).map(([p, h]) => [p, new Set(h)]),
);

/** Home pages the AI can write (php is not allowed, paths.ts) whose arrival replaces the placeholder page. */
export const HOME_PAGES = ['index.html', 'index.htm'];

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Whether a path is one of the placeholder files' names (content not checked). */
export function isSkeletonPath(path: string): boolean {
  return PAGE_NAMES.has(path) || FILES.has(path);
}

const TITLE_RE = /<title>([^<]{1,300})<\/title>/i;
/** Hostnames in the page title: the domain the control panel filled in. */
const HOST_RE = /[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi;

/** Whether `data` is the untouched placeholder content for `path`. */
export function matchesSkeleton(path: string, data: Buffer): boolean {
  const hashes = FILES.get(path);
  if (hashes) return hashes.has(sha256(data));
  if (!PAGE_NAMES.has(path) || data.length > PAGE_MAX_BYTES) return false;
  // Some accounts got the page copied with "::DOMAIN::" never filled in.
  if (PAGE_HASHES.has(sha256(data))) return true;
  // latin1 maps bytes 1:1, so replacing the ASCII hostname leaves every other byte as it was.
  const text = data.toString('latin1');
  const title = text.match(TITLE_RE)?.[1] ?? '';
  for (const host of new Set(title.match(HOST_RE) ?? [])) {
    if (PAGE_HASHES.has(sha256(Buffer.from(text.split(host).join('::DOMAIN::'), 'latin1')))) return true;
  }
  return false;
}
