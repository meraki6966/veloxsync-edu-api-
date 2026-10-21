// src/utils/jwtSecret.ts
// The one place the JWT signing secret is read.
//
// It used to be read in five places as `process.env.JWT_SECRET || 'fallback-secret'`.
// If the variable were ever missing, every token would be signed and verified
// with that public string, and anyone who had seen this code could mint a
// token for any user in any organization. Refusing to start is the safe
// failure: a missing secret becomes a loud deploy error, not a silent hole.

const KNOWN_PLACEHOLDERS = new Set(['fallback-secret', 'secret', 'changeme', 'your-secret-here']);

export function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new Error('JWT_SECRET is not set. Refusing to start without a signing secret.');
  }
  if (KNOWN_PLACEHOLDERS.has(secret.trim().toLowerCase())) {
    throw new Error('JWT_SECRET is set to a placeholder value. Set a real random secret.');
  }
  return secret;
}
