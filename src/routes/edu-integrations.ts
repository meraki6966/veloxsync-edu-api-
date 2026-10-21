// src/routes/edu-integrations.ts
// ============================================================
// VeloxSync for Education — External Integrations
// Google Classroom, Clever, PowerSchool, Canvas, ClassDojo,
// Renaissance Learning
// ============================================================
//
// What "connected" means here: a row is reported connected only when the
// credentials that provider needs are actually stored. Credentials are
// encrypted at rest with encryptToken (AES-256-GCM, ENCRYPTION_KEY) and are
// never returned by any route.
//
// No provider has a live sync yet. /:provider/sync answers 501 and /status
// reports sync_available: false, so the page never shows a sync that did not
// happen.

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { createHmac, randomUUID } from 'crypto';
import { pool } from '../db';
import { AuthRequest } from '../middleware/auth';
import { encryptToken } from '../utils/crypto';
import { requireJwtSecret } from '../utils/jwtSecret';

const router = Router();

// ── SUPPORTED PROVIDERS ──────────────────────────────────────
const VALID_PROVIDERS = [
  'google_classroom',
  'clever',
  'powerschool',
  'canvas',
  'classdojo',
  'renaissance',
] as const;
type Provider = typeof VALID_PROVIDERS[number];

// Credentials each provider needs before it counts as connected.
const REQUIRED_FIELDS: Record<Provider, string[]> = {
  google_classroom: ['access_token'],
  clever:           ['client_id', 'client_secret'],
  powerschool:      ['server_url', 'client_id', 'client_secret'],
  canvas:           ['domain', 'access_token'],
  classdojo:        ['api_key'],
  renaissance:      ['tenant_id', 'api_key'],
};

// Stored encrypted.
const SECRET_FIELDS = new Set(['access_token', 'refresh_token', 'client_secret', 'api_key']);

const DISPLAY_NAMES: Record<Provider, string> = {
  google_classroom: 'Google Classroom',
  clever:           'Clever',
  powerschool:      'PowerSchool',
  canvas:           'Canvas LMS',
  classdojo:        'ClassDojo',
  renaissance:      'Renaissance Learning',
};

const MAX_FIELD_LENGTH = 2000;

// ── ENSURE TABLES EXIST ──────────────────────────────────────
// Runs once on module load — idempotent
pool.query(`
  CREATE TABLE IF NOT EXISTS edu_oauth_sessions (
    id          UUID        PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes'
  );
`).catch(err => console.error('[edu-integrations] edu_oauth_sessions init failed:', err.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS edu_integrations (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider        VARCHAR(50) NOT NULL,
    connected       BOOLEAN     NOT NULL DEFAULT FALSE,
    config          JSONB       NOT NULL DEFAULT '{}',
    connected_at    TIMESTAMPTZ,
    UNIQUE (organization_id, provider)
  );
  CREATE INDEX IF NOT EXISTS idx_edu_integrations_org ON edu_integrations(organization_id);
`).catch(err => console.error('[edu-integrations] table init failed:', err.message));

// ── HELPERS ──────────────────────────────────────────────────
function getOrgId(req: AuthRequest): string {
  return (req.user as { organizationId: string }).organizationId;
}

const PROVIDER_ALIASES: Record<string, Provider> = {
  power_school: 'powerschool',
  class_dojo: 'classdojo',
  renaissance_star: 'renaissance',
};

/** Accepts hyphen or underscore spellings and the old page ids. */
export function normalizeProvider(raw: unknown): Provider | null {
  if (typeof raw !== 'string') return null;
  const p = raw.trim().toLowerCase().replace(/-/g, '_');
  const resolved = PROVIDER_ALIASES[p] ?? p;
  return (VALID_PROVIDERS as readonly string[]).includes(resolved) ? (resolved as Provider) : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** True only when every credential the provider needs is stored. */
export function hasCredentials(provider: Provider, config: unknown): boolean {
  const c = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;
  return REQUIRED_FIELDS[provider].every(f => nonEmpty(c[f]));
}

// Canvas domain: a bare hostname such as school.instructure.com.
function normalizeHost(value: string): string | null {
  const host = value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : null;
}

// PowerSchool server: an https URL.
function normalizeHttpsUrl(value: string): string | null {
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

// ============================================================
// GET /api/edu/integrations/status
// ============================================================
router.get('/status', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = getOrgId(req);

    // Seed rows for any providers not yet in the table
    await Promise.all(VALID_PROVIDERS.map(provider =>
      pool.query(
        `INSERT INTO edu_integrations (organization_id, provider)
         VALUES ($1, $2)
         ON CONFLICT (organization_id, provider) DO NOTHING`,
        [orgId, provider]
      )
    ));

    const result = await pool.query(
      `SELECT provider, connected, config, connected_at
       FROM edu_integrations
       WHERE organization_id = $1
       ORDER BY provider`,
      [orgId]
    );

    const statusMap: Record<string, object> = {};
    for (const row of result.rows) {
      const provider = normalizeProvider(row.provider);
      if (!provider) continue;
      // Rows written by the old handlers could say connected with nothing
      // stored. Only stored credentials count.
      const isConnected = row.connected === true && row.connected_at !== null && hasCredentials(provider, row.config);
      statusMap[provider] = {
        connected:      isConnected,
        connected_at:   isConnected ? row.connected_at : null,
        display_name:   DISPLAY_NAMES[provider],
        sync_available: false,
      };
    }

    res.json({ integrations: statusMap });
  } catch (err: any) {
    console.error('[edu-integrations] GET /status', err.message);
    res.status(500).json({ error: 'Failed to fetch integration status' });
  }
});

// ============================================================
// POST /api/edu/integrations/google-classroom/auth-url
// Signed-in users start Google sign-in here. The org is taken from the
// verified login token and carried to the callback in a signed, short-lived,
// single-use state. The login token itself never goes into a URL.
// ============================================================
const GC_SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.rosters.readonly',
].join(' ');

const STATE_PURPOSE = 'edu-gc-oauth';

function gcRedirectUri(): string {
  return 'https://veloxsync.up.railway.app/api/edu/integrations/google-classroom/callback';
}

// A key derived from JWT_SECRET for OAuth state only, so a state can never be
// used as a login token and a login token can never be used as a state.
function stateKey(): Buffer {
  return createHmac('sha256', requireJwtSecret()).update('edu-gc-oauth-state-v1').digest();
}

router.post('/google-classroom/auth-url', async (req: AuthRequest, res: Response) => {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.status(503).json({ error: 'Google Classroom sign-in is not configured.' });

    const orgId = getOrgId(req);
    const userId = req.user?.userId;
    const nonce = randomUUID();

    await pool.query(
      `INSERT INTO edu_oauth_sessions (id, expires_at) VALUES ($1, NOW() + INTERVAL '10 minutes')`,
      [nonce]
    );

    const state = jwt.sign({ orgId, userId, nonce, purpose: STATE_PURPOSE }, stateKey(), {
      algorithm: 'HS256',
      expiresIn: '10m',
    });

    const params = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  gcRedirectUri(),
      response_type: 'code',
      scope:         GC_SCOPES,
      access_type:   'offline',
      prompt:        'consent',
      state,
    });

    res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  } catch (err: any) {
    console.error('[edu-integrations] POST /google-classroom/auth-url', err.message);
    res.status(500).json({ error: 'Could not start Google sign-in' });
  }
});

// ============================================================
// POST /api/edu/integrations/:provider/connect
// ============================================================
router.post('/:provider/connect', async (req: AuthRequest, res: Response) => {
  const provider = normalizeProvider(req.params.provider);
  if (!provider) {
    return res.status(400).json({ error: `Unknown provider. Valid providers: ${VALID_PROVIDERS.join(', ')}` });
  }
  if (provider === 'google_classroom') {
    return res.status(400).json({ error: 'Google Classroom connects through Sign in with Google.' });
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const missing = REQUIRED_FIELDS[provider].filter(f => !nonEmpty(body[f]));
  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }
  if (REQUIRED_FIELDS[provider].some(f => (body[f] as string).length > MAX_FIELD_LENGTH)) {
    return res.status(400).json({ error: 'A field is too long.' });
  }

  const config: Record<string, unknown> = { display_name: DISPLAY_NAMES[provider] };
  for (const field of REQUIRED_FIELDS[provider]) {
    const value = (body[field] as string).trim();
    if (field === 'domain') {
      const host = normalizeHost(value);
      if (!host) return res.status(400).json({ error: 'domain must be a hostname such as school.instructure.com' });
      config.domain = host;
    } else if (field === 'server_url') {
      const url = normalizeHttpsUrl(value);
      if (!url) return res.status(400).json({ error: 'server_url must be an https URL' });
      config.server_url = url;
    } else {
      config[field] = value;
    }
  }
  if (provider === 'clever' && nonEmpty(body.district_id)) {
    config.district_id = (body.district_id as string).trim().slice(0, 200);
  }

  try {
    for (const field of Object.keys(config)) {
      if (SECRET_FIELDS.has(field)) config[field] = encryptToken(config[field] as string);
    }

    const orgId = getOrgId(req);
    const result = await pool.query(
      `INSERT INTO edu_integrations (organization_id, provider, connected, config, connected_at)
       VALUES ($1, $2, TRUE, $3, NOW())
       ON CONFLICT (organization_id, provider) DO UPDATE
         SET connected = TRUE, config = $3, connected_at = NOW()
       RETURNING id, provider, connected, connected_at`,
      [orgId, provider, JSON.stringify(config)]
    );

    res.json({ integration: result.rows[0] });
  } catch (err: any) {
    // encryptToken throws when ENCRYPTION_KEY is missing. Refusing is safer
    // than storing the credential in plain text.
    console.error(`[edu-integrations] POST /${provider}/connect`, err.message);
    res.status(500).json({ error: `Failed to connect ${DISPLAY_NAMES[provider]}` });
  }
});

// ============================================================
// POST /api/edu/integrations/:provider/sync
// ============================================================
router.post('/:provider/sync', (req: AuthRequest, res: Response) => {
  const provider = normalizeProvider(req.params.provider);
  if (!provider) return res.status(400).json({ error: 'Unknown provider' });
  // There is no live sync for any provider yet. Say so instead of returning
  // sample data as if it came from the school's system.
  res.status(501).json({ error: `Sync for ${DISPLAY_NAMES[provider]} is not available yet.` });
});

// ============================================================
// DELETE /api/edu/integrations/:provider/disconnect
// ============================================================
router.delete('/:provider/disconnect', async (req: AuthRequest, res: Response) => {
  const provider = normalizeProvider(req.params.provider);
  if (!provider) {
    return res.status(400).json({ error: `Unknown provider. Valid providers: ${VALID_PROVIDERS.join(', ')}` });
  }
  try {
    const orgId = getOrgId(req);
    await pool.query(
      `UPDATE edu_integrations
       SET connected = FALSE, config = '{}', connected_at = NULL
       WHERE organization_id = $1 AND provider = $2`,
      [orgId, provider]
    );
    res.json({ disconnected: true, provider });
  } catch (err: any) {
    console.error('[edu-integrations] DELETE /:provider/disconnect', err.message);
    res.status(500).json({ error: 'Failed to disconnect integration' });
  }
});

// ============================================================
// PUBLIC router: only Google's redirect back to us lives here.
// Mounted in index.ts BEFORE any auth middleware on /api/edu, because Google's
// browser redirect carries no Authorization header. It trusts nothing but a
// state this server signed for a signed-in user, used once, within 10 minutes.
// ============================================================
export const gcOAuthRouter = Router();

gcOAuthRouter.get('/google-classroom/callback', async (req: Request, res: Response) => {
  const frontendUrl = process.env.FRONTEND_URL || 'https://veloxsync.app';
  const successUrl  = `${frontendUrl}/education/integrations?connected=google-classroom`;
  const errorUrl    = `${frontendUrl}/education/integrations?error=google-classroom`;

  const { code, state, error } = req.query as Record<string, string | undefined>;
  if (error || !code || !state) return res.redirect(errorUrl);

  let orgId: string;
  let nonce: string;
  try {
    const claims = jwt.verify(state, stateKey(), { algorithms: ['HS256'] }) as Record<string, unknown>;
    if (claims.purpose !== STATE_PURPOSE || !nonEmpty(claims.orgId) || !nonEmpty(claims.nonce)) {
      return res.redirect(errorUrl);
    }
    orgId = claims.orgId;
    nonce = claims.nonce;
  } catch {
    return res.redirect(errorUrl);
  }

  try {
    // Single use: the nonce row is consumed here, so a replayed state fails.
    const used = await pool.query(
      `DELETE FROM edu_oauth_sessions WHERE id = $1 AND expires_at > NOW() RETURNING id`,
      [nonce]
    );
    if (used.rowCount === 0) return res.redirect(errorUrl);

    const clientId     = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      console.error('[edu-integrations] missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET');
      return res.redirect(errorUrl);
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  gcRedirectUri(),
        grant_type:    'authorization_code',
      }),
    });
    const tokens = await tokenRes.json() as Record<string, unknown>;
    if (!nonEmpty(tokens.access_token)) {
      console.error('[edu-integrations] token exchange failed');
      return res.redirect(errorUrl);
    }

    const config = {
      access_token:  encryptToken(tokens.access_token),
      refresh_token: nonEmpty(tokens.refresh_token) ? encryptToken(tokens.refresh_token) : null,
      token_expiry:  tokens.expires_in
        ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString()
        : null,
      scope:         typeof tokens.scope === 'string' ? tokens.scope : GC_SCOPES,
      display_name:  DISPLAY_NAMES.google_classroom,
    };

    await pool.query(
      `INSERT INTO edu_integrations (organization_id, provider, connected, config, connected_at)
       VALUES ($1, 'google_classroom', TRUE, $2, NOW())
       ON CONFLICT (organization_id, provider) DO UPDATE
         SET connected    = TRUE,
             config       = $2,
             connected_at = NOW()`,
      [orgId, JSON.stringify(config)]
    );

    res.redirect(successUrl);
  } catch (err: any) {
    console.error('[edu-integrations] callback error:', err?.message);
    res.redirect(errorUrl);
  }
});

export default router;
