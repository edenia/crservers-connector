import { describe, expect, it } from 'vitest';
import { PathError, assertWritable, normalizeSiteDir, normalizeSitePath } from '../src/deploy/paths.js';

describe('normalizeSitePath', () => {
  it.each([
    ['index.html', 'index.html'],
    ['/index.html', 'index.html'],
    ['./assets//img.png', 'assets/img.png'],
    ['assets/./a/b.css', 'assets/a/b.css'],
  ])('%s -> %s', (input, out) => expect(normalizeSitePath(input)).toBe(out));

  it.each(['', '/', '.', '../etc/passwd', 'a/../../b', 'a\\b', 'a\u0000b', 'x/'.repeat(200) + 'y'])('rejects %j', (input) => {
    expect(() => normalizeSitePath(input)).toThrow(PathError);
  });

  it('allows the root only for directories', () => {
    expect(normalizeSiteDir(undefined)).toBe('');
    expect(normalizeSiteDir('/')).toBe('');
    expect(normalizeSiteDir('assets/')).toBe('assets');
  });
});

describe('assertWritable', () => {
  it.each(['index.html', 'assets/a.jpg', 'video/tour.mp4', 'robots.txt', 'sitemap.xml', '.well-known/security.txt', '.well-known/acme'])('allows %s', (p) => {
    expect(() => assertWritable(p)).not.toThrow();
  });

  it.each([
    'admin.php',
    'shell.phtml',
    'x.phar',
    'run.sh',
    '.htaccess',
    'assets/.htaccess',
    '.env',
    '.user.ini',
    '.git/config',
    'Makefile',
    'site.zip',
    'contact.php',
    'vendor/autoload.php',
    'vendor/x/readme.md',
    'composer.json',
  ])('blocks %s', (p) => {
    expect(() => assertWritable(p)).toThrow(PathError);
  });
});
