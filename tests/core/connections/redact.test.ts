import { describe, expect, it } from 'vitest';
import { REDACTED, TOKEN_PATTERN, base64Utf8, redact } from '../../../src/core/connections/redact';

describe('redact', () => {
  it('redacts token-shaped strings without being told the secret', () => {
    const out = redact('Bad token ghu_ABCDEFGHIJKLMN', []);
    expect(out).not.toContain('ghu_');
    expect(out).toBe('Bad token «redacted»');
    for (const t of ['ghp_abcdefghijkl123', 'gho_abcdefghijkl123', 'ghs_abcdefghijkl123', 'ghr_1B4a2e77838347a7E420ce178F2E7c6912E169246c34E1ccbF66C46812d16D5B1A9Dc86A1498', 'github_pat_11ABCDEFGH_xyz', 'ATATT3xFfGF0abc-def=12'])
      expect(redact(`x ${t} y`, []), t).toBe('x «redacted» y');
  });

  it('redacts a GitHub refresh token (ghr_) from expiring device-flow tokens', () => {
    expect(redact('refresh_token=ghr_ABCDEFGHIJKLMNOP&x=1', [])).toBe('refresh_token=«redacted»&x=1');
  });

  it('leaves short prefixes and ordinary text alone', () => {
    expect(redact('ghu_short and ATATT1 and github.com', [])).toBe('ghu_short and ATATT1 and github.com');
  });

  it('redacts each given secret and its base64', () => {
    const secret = 'opaque-secret-value';
    const s = `a ${secret} b ${base64Utf8(secret)} c`;
    expect(redact(s, [secret])).toBe('a «redacted» b «redacted» c');
  });

  it('redacts the Basic base64 of email:token', () => {
    const pair = 'me@x.com:ATATTxyz0123456789';
    const header = `Authorization: Basic ${base64Utf8(pair)}`;
    const out = redact(header, [pair]);
    expect(out).toBe('Authorization: Basic «redacted»');
    expect(out).not.toContain(base64Utf8(pair));
  });

  it('base64 is UTF-8 safe', () => {
    expect(base64Utf8('é:ü')).toBe(Buffer.from('é:ü', 'utf8').toString('base64'));
    expect(redact(`t ${base64Utf8('pässwörd-tok')}`, ['pässwörd-tok'])).toBe('t «redacted»');
  });

  it('ignores empty secrets and redacts longer secrets first', () => {
    expect(redact('abc', [''])).toBe('abc');
    expect(redact('key-123456 and key-123456-long', ['key-123456', 'key-123456-long'])).toBe('«redacted» and «redacted»');
  });

  it('exports the marker and the token-prefix pattern', () => {
    expect(REDACTED).toBe('«redacted»');
    expect(TOKEN_PATTERN.source).toBe('(gh[oprsu]_|github_pat_)[A-Za-z0-9_]{10,}|ATATT[A-Za-z0-9_\\-=]{10,}');
    expect(TOKEN_PATTERN.flags).toBe('g');
  });
});
