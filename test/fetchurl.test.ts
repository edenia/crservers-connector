import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ImportError, assertMediaMatches, directDownloadUrl, fetchPublicUrl, isPublicAddress } from '../src/deploy/fetchurl.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

describe('import_from_url safety', () => {
  it('only public addresses', () => {
    for (const ip of ['127.0.0.1', '10.42.0.5', '10.43.0.1', '172.20.1.1', '192.168.1.100', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', 'not-an-ip']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['200.122.181.15', '8.8.8.8', '2606:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('refuses loopback by IP and by name, even with a server listening', async () => {
    const srv = createServer((_q, r) => r.end('secret'));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    try {
      await expect(fetchPublicUrl(`http://127.0.0.1:${port}/x.png`, 1e6)).rejects.toThrow(ImportError);
      await expect(fetchPublicUrl(`http://localhost:${port}/x.png`, 1e6)).rejects.toThrow('Address not allowed');
      await expect(fetchPublicUrl(`http://2130706433:${port}/x.png`, 1e6)).rejects.toThrow('Address not allowed');
      await expect(fetchPublicUrl('file:///etc/passwd', 1e6)).rejects.toThrow('Only http(s)');
    } finally {
      srv.close();
    }
  });

  it('turns share links into direct downloads', () => {
    expect(directDownloadUrl('https://drive.google.com/file/d/AbC_12-3/view?usp=sharing')).toBe('https://drive.google.com/uc?export=download&id=AbC_12-3');
    expect(directDownloadUrl('https://www.dropbox.com/scl/fi/x/foto.jpg?rlkey=k&dl=0')).toBe('https://www.dropbox.com/scl/fi/x/foto.jpg?rlkey=k&dl=1');
    expect(directDownloadUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
  });

  it('checks the content really is the type the path says, and media only', () => {
    expect(() => assertMediaMatches('img/a.png', PNG)).not.toThrow();
    expect(() => assertMediaMatches('img/a.png', Buffer.from('<!doctype html><html>'))).toThrow('not a .png');
    expect(() => assertMediaMatches('a.html', Buffer.from('<html>'))).toThrow('media files');
    expect(() => assertMediaMatches('a.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).not.toThrow();
  });
});
