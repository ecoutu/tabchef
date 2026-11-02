import { describe, it, expect } from 'vitest';
import { DurationError, parseDuration } from '../../../src/core/lang/duration';

describe('parseDuration', () => {
  it('parses each unit', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('3s')).toBe(3000);
    expect(parseDuration('2m')).toBe(120000);
    expect(parseDuration('1h')).toBe(3600000);
    expect(parseDuration('2d')).toBe(172800000);
  });
  it.each(['3', '1w', '', '1.5s', '-1s', ' 1s'])('rejects %j', (s) => {
    expect(() => parseDuration(s)).toThrow(DurationError);
  });
});
