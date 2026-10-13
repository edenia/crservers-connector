import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openSiteSetup, verifyEvent } from '../src/auth/sitesetup.js';

/**
 * Cross-language check against the plugin's PHP (sealForConnector / notifyConnector), the same
 * steps copied here: what PHP seals and signs, the connector must open and accept.
 */
const PHP = `
$k = base64_decode(strtr($argv[1], '-_', '+/'), true);
$b64 = function ($s) { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); };
$key = hash_hmac('sha256', 'crsconnect site setup v1', $k, true);
$iv = random_bytes(12); $tag = '';
$ct = openssl_encrypt(json_encode(['ftp_host' => 'iwx41.crservers.com', 'ftp_user' => 'crsconnect@test.crservers.com', 'ftp_password' => $argv[2]]), 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
$body = json_encode(['service_id' => 6014, 'event' => 'suspend', 'at' => time(), 'nonce' => $b64(random_bytes(12))]);
echo json_encode(['sealed' => 'v1.' . $b64($iv) . '.' . $b64($ct) . '.' . $b64($tag), 'body' => $body, 'sig' => $b64(hash_hmac('sha256', $body, $k, true))]);
`;

let hasPhp = true;
try {
  execFileSync('php', ['-v'], { stdio: 'ignore' });
} catch {
  hasPhp = false;
}

describe.skipIf(!hasPhp)('site setup vs PHP plugin', () => {
  it('opens credentials sealed in PHP and accepts its signed events; rejects tampering', () => {
    const key = randomBytes(32);
    const pw = randomBytes(24).toString('base64url'); // generated: no credential-like literals in the repo
    const out = JSON.parse(execFileSync('php', ['-r', PHP, '--', key.toString('base64url'), pw]).toString()) as { sealed: string; body: string; sig: string };
    expect(openSiteSetup(key, out.sealed)).toEqual({ ftpHost: 'iwx41.crservers.com', ftpUser: 'crsconnect@test.crservers.com', ftpPassword: pw });
    expect(() => openSiteSetup(randomBytes(32), out.sealed)).toThrow();
    const parts = out.sealed.split('.');
    parts[2] = Buffer.from('tampered').toString('base64url');
    expect(() => openSiteSetup(key, parts.join('.'))).toThrow();

    expect(verifyEvent(key, Buffer.from(out.body), out.sig)).toMatchObject({ serviceId: 6014, event: 'suspend' });
    expect(verifyEvent(randomBytes(32), Buffer.from(out.body), out.sig)).toBeNull();
    expect(verifyEvent(key, Buffer.from(out.body.replace('6014', '1')), out.sig)).toBeNull();
    expect(verifyEvent(key, Buffer.from(out.body), out.sig, Math.floor(Date.now() / 1000) + 3600)).toBeNull(); // stale
  });
});
