import { describe, expect, it } from 'vitest';
import { pickLang } from '../src/ui/page.js';

describe('pickLang', () => {
  it.each([
    [undefined, 'es'],
    ['', 'es'],
    ['fr-FR,fr;q=0.9', 'es'],
    ['en-US,en;q=0.9', 'en'],
    ['es-CR,es;q=0.9,en;q=0.8', 'es'],
    ['en;q=0.4,es;q=0.8', 'es'],
    ['de,en;q=0.7', 'en'],
  ])('%j -> %s', (header, want) => expect(pickLang(header)).toBe(want));
});
