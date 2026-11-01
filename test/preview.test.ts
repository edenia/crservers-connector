import { describe, expect, it } from 'vitest';
import { rewriteHtml } from '../src/preview/preview.js';

const P = '/p/tok';

describe('rewriteHtml', () => {
  it('rewrites every candidate of a srcset written over several lines', () => {
    const html = `<picture><source type="image/webp" srcset="
      /images/a-480.webp   480w,
      /images/a-768.webp   768w,
      https://example.com/images/a.webp 1024w
    " sizes="100vw" /><img src="/images/a.jpg" alt=""></picture>`;
    const out = rewriteHtml(html, 'example.com', P, 'es');
    expect(out).toContain(`srcset="${P}/images/a-480.webp 480w, ${P}/images/a-768.webp 768w, ${P}/images/a.webp 1024w"`);
    expect(out).toContain(`src="${P}/images/a.jpg"`);
  });

  it('rewrites an href whose value spans lines', () => {
    const out = rewriteHtml('<a href="\n  /contact/\n">c</a>', 'example.com', P, 'en');
    expect(out).toContain(`href="${P}/contact/"`);
  });
});
