import { describe, expect, it } from 'vitest';
import { UploadError, freePath, safeFileName, uploadPage } from '../src/upload/upload.js';

describe('upload file names', () => {
  it('turns device file names into web-safe ones', () => {
    expect(safeFileName('IMG 0001 (1).JPG')).toBe('img-0001-1.jpg');
    expect(safeFileName('Árbol de Navidad.png')).toBe('arbol-de-navidad.png');
    expect(safeFileName('foto.jpeg')).toBe('foto.jpg');
    expect(safeFileName('C:\\Users\\ana\\Fotos\\Casa.Final.webp')).toBe('casa-final.webp');
    expect(safeFileName('../../etc/passwd.png')).toBe('passwd.png');
    expect(safeFileName('.htaccess.png')).toBe('htaccess.png');
    expect(safeFileName('___.pdf')).toBe('archivo.pdf');
    expect(safeFileName(`${'a'.repeat(300)}.jpg`).length).toBeLessThanOrEqual(84);
  });

  it('needs an extension', () => {
    expect(() => safeFileName('foto')).toThrow(UploadError);
    expect(() => safeFileName('.jpg')).toThrow(UploadError);
  });

  it('finds a free name instead of replacing a file', async () => {
    const taken = new Set(['img/foto.jpg', 'img/foto-2.jpg']);
    const has = async (p: string) => taken.has(p);
    expect(await freePath('img/casa.jpg', has)).toBe('img/casa.jpg');
    expect(await freePath('img/foto.jpg', has)).toBe('img/foto-3.jpg');
  });
});

describe('upload page', () => {
  it('carries a script that parses, under the page nonce, with nothing from the site left unescaped', () => {
    const html = uploadPage('es', { domain: 'uat.example', folder: 'img/<b>', widths: [800] }, [{ path: 'img/<i>.png', size: 1 }], 'n0nce');
    const script = /<script nonce="n0nce">([\s\S]*)<\/script>/.exec(html)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(`return async () => {${script}}`)).not.toThrow();
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
    expect(html).toContain('"widths":[800]');
  });
});
