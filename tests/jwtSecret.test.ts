import { describe, it, expect, afterEach } from 'vitest';
import { requireJwtSecret } from '../src/utils/jwtSecret';

const original = process.env.JWT_SECRET;
afterEach(() => {
  if (original === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = original;
});

describe('requireJwtSecret', () => {
  it('refuses to run with no secret', () => {
    delete process.env.JWT_SECRET;
    expect(() => requireJwtSecret()).toThrow(/not set/);
    process.env.JWT_SECRET = '   ';
    expect(() => requireJwtSecret()).toThrow(/not set/);
  });

  it('refuses the old hardcoded fallback and other placeholders', () => {
    process.env.JWT_SECRET = 'fallback-secret';
    expect(() => requireJwtSecret()).toThrow(/placeholder/);
    process.env.JWT_SECRET = 'changeme';
    expect(() => requireJwtSecret()).toThrow(/placeholder/);
  });

  it('returns a real secret unchanged', () => {
    process.env.JWT_SECRET = 'a3f9c1e7b2d84f60a1c5e9b3d7f2a8c4';
    expect(requireJwtSecret()).toBe('a3f9c1e7b2d84f60a1c5e9b3d7f2a8c4');
  });
});
