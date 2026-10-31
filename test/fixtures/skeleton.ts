import { readFileSync } from 'node:fs';

/**
 * Real files from the hosting skeleton (current version, 2026-10-28); index.html still holds "::DOMAIN::".
 * index-20261024.html is the page before that update.
 */
export const skeletonFixture = (name: string) => readFileSync(new URL(`./skeleton/${name}`, import.meta.url));

/** The placeholder page as a new account for `domain` gets it. */
export const placeholderPage = (domain: string) => Buffer.from(skeletonFixture('index.html').toString('latin1').split('::DOMAIN::').join(domain), 'latin1');

/** A fresh account's web root (a subset of the skeleton). */
export const skeletonFiles = (domain: string): Record<string, Buffer> => ({
  'index.html': placeholderPage(domain),
  'index.html.orig': placeholderPage(domain),
  'robots.txt': skeletonFixture('robots.txt'),
  'crservers-logo.svg': skeletonFixture('crservers-logo.svg'),
});

const ASSETS = ['Roboto-OFL.txt', 'apple-icon.png', 'favicon.ico', 'gear-shadow.png', 'gear.png', 'icon.png', 'icon.svg', 'og.jpg', 'roboto-latin-variable.woff2'];

/** Every file a new account's web root gets from the current skeleton (as on prosperacoffee.com, 2026-10-30). */
export const fullSkeletonFiles = (domain: string): Record<string, Buffer> => ({
  ...skeletonFiles(domain),
  'index.html.orig': skeletonFixture('index.html'), // the control panel fills in index.html only
  'index.html.bak-20261028-og': skeletonFixture('index-20261024.html'),
  'favicon.ico': skeletonFixture('favicon.ico'),
  ...Object.fromEntries(ASSETS.map((a) => [`crservers-welcome-assets/${a}`, skeletonFixture(`crservers-welcome-assets/${a}`)])),
});
