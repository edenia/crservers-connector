import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signReq } from '../src/auth/req.js';

/**
 * Cross-language check: a req signed here must verify with the same steps as
 * the client-area extension's PHP verifier. Skipped when php isn't installed.
 */
const PHP = `
$key = base64_decode(strtr($argv[1], '-_', '+/'), true);
$parts = explode('.', $argv[2]);
$sig = base64_decode(strtr($parts[1], '-_', '+/'), true);
$ok = hash_equals(hash_hmac('sha256', $parts[0], $key, true), $sig);
$p = json_decode(base64_decode(strtr($parts[0], '-_', '+/'), true), true);
echo json_encode(['ok' => $ok, 'rid' => $p['rid'] ?? null, 'host' => $p['app_host'] ?? null]);
`;

let hasPhp = true;
try {
  execFileSync('php', ['-v'], { stdio: 'ignore' });
} catch {
  hasPhp = false;
}

describe.skipIf(!hasPhp)('req signature vs PHP plugin', () => {
  it('verifies in PHP, and a tampered req does not', () => {
    const key = randomBytes(32);
    const req = signReq(key, { rid: 'rid_abc123', app_name: 'ChatGPT', app_host: 'chatgpt.com', exp: Math.floor(Date.now() / 1000) + 600 });
    const run = (r: string) => JSON.parse(execFileSync('php', ['-r', PHP, '--', key.toString('base64url'), r]).toString());
    expect(run(req)).toEqual({ ok: true, rid: 'rid_abc123', host: 'chatgpt.com' });
    const [payload, sig] = req.split('.');
    const forged = Buffer.from(JSON.stringify({ rid: 'evil', app_name: 'x', app_host: 'evil.example', exp: 9e9, nonce: 'n' })).toString('base64url');
    expect(run(`${forged}.${sig}`).ok).toBe(false);
    expect(run(`${payload}.${sig}`).ok).toBe(true);
  });
});
