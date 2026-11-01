import { describe, expect, it } from 'vitest';
import { HELP, helpInfo, pathHelp } from '../src/mcp/help.js';

describe('help links', () => {
  it('point at crservers.com support articles in both languages', () => {
    for (const [topic, { es, en }] of Object.entries(HELP)) {
      expect(es, topic).toMatch(/^https:\/\/crservers\.com\/es\/(soporte\/[a-z-]+\/[a-z0-9-]+|contacto)$/);
      expect(en, topic).toMatch(/^https:\/\/crservers\.com\/(support\/[a-z-]+\/[a-z0-9-]+|contact)$/);
    }
  });

  it('get_site_info block carries guidance and every article', () => {
    const h = helpInfo();
    expect(h.guidance).toMatch(/contact_support/);
    expect(h.articles).toBe(HELP);
  });

  it.each([
    ['.htaccess', HELP.redirects_htaccess.en],
    ['blog/.htaccess', HELP.redirects_htaccess.en],
    ['api/send.php', HELP.deploy_from_github.en],
    ['cgi-bin/run.py', HELP.deploy_from_github.en],
  ])('adds a help link to the refusal of %s', (path, link) => {
    expect(pathHelp(path)).toContain(link);
  });

  it.each(['contact.php', 'vendor/autoload.php', 'wp-config.php', 'private/config.php', 'logo.bmp'])(
    'adds nothing for %s (own refusal text, or no article)',
    (path) => expect(pathHelp(path)).toBe(''),
  );
});
