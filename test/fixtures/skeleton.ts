import { readFileSync } from 'node:fs';

/** Real files from the hosting skeleton (current version); index.html still holds "::DOMAIN::". */
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
