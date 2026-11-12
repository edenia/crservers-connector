import { describe, expect, it } from 'vitest';
import { TooLarge, countOccurrences, excerpts, inScope, normalizeExtensions, replaceEvery, skipReason } from '../src/mcp/bulk.js';

describe('exact text search and replace', () => {
  it('counts literal, non-overlapping occurrences; regex characters mean nothing', () => {
    expect(countOccurrences('a.b a.b axb', 'a.b')).toBe(2);
    expect(countOccurrences('aaaa', 'aa')).toBe(2);
    expect(countOccurrences('Hola hola HOLA', 'hola')).toBe(1);
    expect(countOccurrences('Hola hola HOLA', 'hola', false)).toBe(3);
    expect(countOccurrences('abc', '')).toBe(0);
  });

  it('replaces every occurrence of each pair in order, and "$&" in the new text stays literal', () => {
    const r = replaceEvery('<a class="btn-old">x</a><a class="btn-old">y</a>', [
      { old_text: 'btn-old', new_text: 'btn' },
      { old_text: '"btn"', new_text: '"btn $& $1"' },
      { old_text: 'nope', new_text: 'z' },
      { old_text: '>y<', new_text: null },
    ]);
    expect(r.text).toBe('<a class="btn $& $1">x</a><a class="btn $& $1"/a>');
    expect(r.counts).toEqual([2, 2, 0, 1]);
  });

  it('refuses a result over the limit before building it', () => {
    const text = 'a'.repeat(1000);
    expect(() => replaceEvery(text, [{ old_text: 'a', new_text: 'b'.repeat(2000) }])).toThrow(TooLarge);
    expect(() => replaceEvery(text, [{ old_text: 'a', new_text: 'bb' }], 1999)).toThrow(TooLarge);
    expect(replaceEvery(text, [{ old_text: 'a', new_text: 'bb' }], 2000).text.length).toBe(2000);
    // Each step is checked: growing first and shrinking later doesn't get through.
    expect(() => replaceEvery(text, [{ old_text: 'a', new_text: 'bbb' }, { old_text: 'bbb', new_text: '' }], 2000)).toThrow(TooLarge);
  });

  it('excerpts carry the line number and a short window around the match', () => {
    const text = `uno\ndos btn-old\n${'x'.repeat(500)}btn-old${'y'.repeat(500)}\nbtn-old`;
    const ex = excerpts(text, 'btn-old', true, 3);
    expect(ex.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(ex[0]!.text).toBe('dos btn-old');
    expect(ex[1]!.text.length).toBeLessThan(170);
    expect(ex[1]!.text).toMatch(/^…x+btn-oldy+…$/);
    expect(excerpts(text, 'btn-old', true, 1)).toHaveLength(1);
    expect(excerpts('A\nB\nhOLA', 'hola', false)[0]).toEqual({ line: 3, text: 'hOLA' });
  });

  it('leaves out secrets, other sites, binary files and big text', () => {
    expect(skipReason('index.html', 10, [])).toBeNull();
    expect(skipReason('config.php', 10, [])).toBe('secret');
    expect(skipReason('.env', 10, [])).toBe('secret');
    expect(skipReason('dev/index.html', 10, ['dev'])).toBe('other_site');
    expect(skipReason('developers.html', 10, ['dev'])).toBeNull();
    expect(skipReason('img/a.png', 10, [])).toBe('not_text');
    expect(skipReason('big.js', 2 * 1024 * 1024, [])).toBe('too_large');
  });

  it('scopes by folder and extension', () => {
    expect(inScope('proyectos/a.html', 'proyectos')).toBe(true);
    expect(inScope('proyectos-viejos/a.html', 'proyectos')).toBe(false);
    expect(inScope('a.CSS', '', normalizeExtensions(['.css', 'HTML']))).toBe(true);
    expect(inScope('a.js', '', normalizeExtensions(['.css', 'HTML']))).toBe(false);
  });
});
