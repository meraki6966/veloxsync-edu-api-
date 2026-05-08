// src/routes/edu-integrations.ts
// ============================================================
// VeloxSync for Education — External Integrations
// Google Classroom, Clever, PowerSchool, Canvas, ClassDojo,
// Renaissance Learning
// ============================================================

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../db';
import { AuthRequest } from '../middleware/auth';
import { encryptToken } from '../utils/crypto';

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

// ── ENSURE TABLE EXISTS ──────────────────────────────────────
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

// ── HELPER ───────────────────────────────────────────────────
function getOrgId(req: AuthRequest): string {
  return (req.user as { organizationId: string }).organizationId;
}

function isValidProvider(p: string): p is Provider {
  return (VALID_PROVIDERS as readonly string[]).includes(p);
}

// ── MOCK SYNC DATA ───────────────────────────────────────────
const MOCK_GOOGLE_ROSTER = {
  provider: 'google_classroom',
  synced_at: new Date().toISOString(),
  courses: [
    {
      id: 'gc_course_001',
      name: '3rd Grade ELA — Room 12',
      section: 'Period 1',
      students: [
        { id: 'gc_s_001', first_name: 'Amara', last_name: 'Johnson', email: 'amara.j@school.edu' },
        { id: 'gc_s_002', first_name: 'Liam',  last_name: 'Torres',  email: 'liam.t@school.edu' },
        { id: 'gc_s_003', first_name: 'Sofia', last_name: 'Patel',   email: 'sofia.p@school.edu' },
        { id: 'gc_s_004', first_name: 'Noah',  last_name: 'Kim',     email: 'noah.k@school.edu' },
        { id: 'gc_s_005', first_name: 'Zoe',   last_name: 'Carter',  email: 'zoe.c@school.edu' },
      ],
    },
    {
      id: 'gc_course_002',
      name: '3rd Grade Math — Room 12',
      section: 'Period 2',
      students: [
        { id: 'gc_s_001', first_name: 'Amara', last_name: 'Johnson', email: 'amara.j@school.edu' },
        { id: 'gc_s_003', first_name: 'Sofia', last_name: 'Patel',   email: 'sofia.p@school.edu' },
        { id: 'gc_s_006', first_name: 'Ethan', last_name: 'Brown',   email: 'ethan.b@school.edu' },
      ],
    },
  ],
  total_students_imported: 6,
  note: 'Mock sync — connect a real Google Classroom OAuth token to pull live data.',
};

// ============================================================
// GET /api/edu/integrations/status
// ============================================================
router.get('/status', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = getOrgId(req);

    // Seed rows for any providers not yet in the table
    const upsertQueries = VALID_PROVIDERS.map(provider =>
      pool.query(
        `INSERT INTO edu_integrations (organization_id, provider)
         VALUES ($1, $2)
         ON CONFLICT (organization_id, provider) DO NOTHING`,
        [orgId, provider]
      )
    );
    await Promise.all(upsertQueries);

    const result = await pool.query(
      `SELECT provider, connected, config, connected_at
       FROM edu_integrations
       WHERE organization_id = $1
       ORDER BY provider`,
      [orgId]
    );

    const statusMap: Record<string, object> = {};
    for (const row of result.rows) {
      // Only report connected=true when explicitly connected with a timestamp
      const isConnected = row.connected === true && row.connected_at !== null;
      statusMap[row.provider] = {
        connected: isConnected,
        connected_at: isConnected ? row.connected_at : null,
        display_name: isConnected ? (row.config?.display_name || null) : null,
        sync_enabled: isConnected ? (row.config?.sync_enabled ?? false) : false,
      };
    }

    res.json({ integrations: statusMap });
  } catch (err: any) {
    console.error('[edu-integrations] GET /status', err.message);
    res.status(500).json({ error: 'Failed to fetch integration status' });
  }
});

// ============================================================
// POST /api/edu/integrations/:provider/connect  (shared handler)
// All fields are optional — store whatever is provided, never 400
// ============================================================
async function handleConnect(
  req: AuthRequest,
  res: Response,
  provider: Provider,
  _requiredFields: string[],
  configBuilder: (body: Record<string, string>) => Record<string, unknown>
) {
  try {
    const orgId = getOrgId(req);
    const config = configBuilder(req.body || {});

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
    console.error(`[edu-integrations] POST /${provider}/connect`, err.message);
    res.status(500).json({ error: `Failed to connect ${provider}` });
  }
}

// ── GOOGLE CLASSROOM ─────────────────────────────────────────
router.post('/google-classroom/connect', (req: AuthRequest, res: Response) =>
  handleConnect(req, res, 'google_classroom', ['access_token'], (body) => ({
    access_token:  body.access_token,
    refresh_token: body.refresh_token || null,
    display_name:  'Google Classroom',
    sync_enabled:  true,
  }))
);

// POST /api/edu/integrations/google-classroom/sync
router.post('/google-classroom/sync', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = getOrgId(req);
    const row = await pool.query(
      `SELECT connected FROM edu_integrations WHERE organization_id = $1 AND provider = 'google_classroom'`,
      [orgId]
    );
    if (!row.rows[0]?.connected) {
      return res.status(400).json({ error: 'Google Classroom is not connected. Connect it first.' });
    }
    // In production: use stored access_token to call Google Classroom API.
    // Returning mock roster for now.
    res.json({ sync: MOCK_GOOGLE_ROSTER });
  } catch (err: any) {
    console.error('[edu-integrations] POST /google-classroom/sync', err.message);
    res.status(500).json({ error: 'Sync failed' });
  }
});

// ── CLEVER ───────────────────────────────────────────────────
router.post('/clever/connect', (req: AuthRequest, res: Response) =>
  handleConnect(req, res, 'clever', ['client_id', 'client_secret'], (body) => ({
    client_id:    body.client_id,
    client_secret: body.client_secret,
    district_id:  body.district_id || null,
    display_name: 'Clever',
    sync_enabled: true,
  }))
);

// ── POWERSCHOOL ──────────────────────────────────────────────
router.post('/powerschool/connect', (req: AuthRequest, res: Response) =>
  handleConnect(req, res, 'powerschool', ['server_url', 'client_id', 'client_secret'], (body) => ({
    server_url:    body.server_url,
    client_id:     body.client_id,
    client_secret: body.client_secret,
    display_name:  'PowerSchool',
    sync_enabled:  true,
  }))
);

// ── CANVAS ───────────────────────────────────────────────────
router.post('/canvas/connect', (req: AuthRequest, res: Response) =>
  handleConnect(req, res, 'canvas', ['domain', 'access_token'], (body) => ({
    domain:       body.domain,
    access_token: body.access_token,
    display_name: 'Canvas LMS',
    sync_enabled: true,
  }))
);

// ── CLASSDOJO ────────────────────────────────────────────────
router.post('/classdojo/connect', (req: AuthRequest, res: Response) =>
  handleConnect(req, res, 'classdojo', ['api_key'], (body) => ({
    api_key:      body.api_key,
    display_name: 'ClassDojo',
    sync_enabled: true,
  }))
);

// ── RENAISSANCE ──────────────────────────────────────────────
router.post('/renaissance/connect', (req: AuthRequest, res: Response) =>
  handleConnect(req, res, 'renaissance', ['tenant_id', 'api_key'], (body) => ({
    tenant_id:    body.tenant_id,
    api_key:      body.api_key,
    display_name: 'Renaissance Learning',
    sync_enabled: true,
  }))
);

// ── UNDERSCORE ALIASES (google_classroom, power_school, class_dojo) ──────────
// Frontend may call either hyphen or underscore variants — both work
router.post('/google_classroom/connect',  (req: AuthRequest, res: Response) =>
  handleConnect(req, res, 'google_classroom', [], (body) => ({
    access_token: body.access_token || null, refresh_token: body.refresh_token || null,
    display_name: 'Google Classroom', sync_enabled: true,
  }))
);
router.post('/google_classroom/sync', async (req: AuthRequest, res: Response) => {
  const orgId = getOrgId(req);
  const row = await pool.query(
    `SELECT connected FROM edu_integrations WHERE organization_id = $1 AND provider = 'google_classroom'`,
    [orgId]
  ).catch(() => ({ rows: [] }));
  if (!(row as any).rows[0]?.connected) {
    return res.status(400).json({ error: 'Google Classroom is not connected. Connect it first.' });
  }
  res.json({ sync: MOCK_GOOGLE_ROSTER });
});
router.post('/powerschool/connect',   (req: AuthRequest, res: Response) =>
  handleConnect(req, res, 'powerschool', [], (body) => ({
    server_url: body.server_url || null, client_id: body.client_id || null,
    client_secret: body.client_secret || null, display_name: 'PowerSchool', sync_enabled: true,
  }))
);
router.post('/power_school/connect',  (req: AuthRequest, res: Response) =>
  handleConnect(req, res, 'powerschool', [], (body) => ({
    server_url: body.server_url || null, client_id: body.client_id || null,
    client_secret: body.client_secret || null, display_name: 'PowerSchool', sync_enabled: true,
  }))
);
router.post('/classdojo/connect',     (req: AuthRequest, res: Response) =>
  handleConnect(req, res, 'classdojo', [], (body) => ({
    api_key: body.api_key || null, display_name: 'ClassDojo', sync_enabled: true,
  }))
);
router.post('/class_dojo/connect',    (req: AuthRequest, res: Response) =>
  handleConnect(req, res, 'classdojo', [], (body) => ({
    api_key: body.api_key || null, display_name: 'ClassDojo', sync_enabled: true,
  }))
);
router.post('/clever/connect',        (req: AuthRequest, res: Response) =>
  handleConnect(req, res, 'clever', [], (body) => ({
    client_id: body.client_id || null, client_secret: body.client_secret || null,
    district_id: body.district_id || null, display_name: 'Clever', sync_enabled: true,
  }))
);
router.post('/canvas/connect',        (req: AuthRequest, res: Response) =>
  handleConnect(req, res, 'canvas', [], (body) => ({
    domain: body.domain || null, access_token: body.access_token || null,
    display_name: 'Canvas LMS', sync_enabled: true,
  }))
);
router.post('/renaissance/connect',   (req: AuthRequest, res: Response) =>
  handleConnect(req, res, 'renaissance', [], (body) => ({
    tenant_id: body.tenant_id || null, api_key: body.api_key || null,
    display_name: 'Renaissance Learning', sync_enabled: true,
  }))
);

// ============================================================
// DELETE /api/edu/integrations/:provider/disconnect
// ============================================================
router.delete('/:provider/disconnect', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = getOrgId(req);
    // Normalise hyphen/underscore variants (google-classroom → google_classroom)
    const provider = (req.params.provider as string).replace(/-/g, '_');

    if (!isValidProvider(provider)) {
      return res.status(400).json({
        error: `Unknown provider. Valid providers: ${VALID_PROVIDERS.join(', ')}`,
      });
    }

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
// PUBLIC OAuth router (no authMiddleware — browser redirects)
// Registered separately in index.ts at /api/edu/integrations
// ============================================================

export const gcOAuthRouter = Router();

const GC_SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.rosters.readonly',
].join(' ');

function gcRedirectUri(): string {
  return 'https://veloxsync.up.railway.app/api/edu/integrations/google-classroom/callback';
}

// ── GET /google-classroom/auth ───────────────────────────────
// Called by the frontend via browser redirect — Authorization headers won't be sent.
// Token sources tried in order:
//   1. ?token=<jwt> query param
//   2. Authorization: Bearer <jwt> header
//   3. Common cookie names (token, auth_token, jwt, access_token)
// If none found → proceed anyway with state={ pending:true }.
// The callback resolves the org via Google userinfo email lookup.
// NEVER returns an error for a missing token.
gcOAuthRouter.get('/google-classroom/auth', async (req: Request, res: Response) => {
  try {
    const clientId  = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.status(500).json({ error: 'GOOGLE_CLIENT_ID not configured' });

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) return res.status(500).json({ error: 'JWT_SECRET not configured' });

    // Extract token from any available source
    const queryToken  = req.query.token as string | undefined;
    const authHeader  = req.headers.authorization as string | undefined;
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    const cookies     = (req as any).cookies as Record<string, string> | undefined;
    const cookieToken = cookies
      ? (cookies['token'] || cookies['auth_token'] || cookies['jwt'] || cookies['access_token'])
      : undefined;

    const userToken = queryToken || headerToken || cookieToken;

    let statePayload: object;

    if (userToken) {
      try {
        const payload = jwt.verify(userToken, jwtSecret) as any;
        const orgId   = payload.organizationId as string;
        statePayload  = { orgId };
      } catch {
        // Token present but invalid — fall through to pending; don't error
        console.warn('[edu-integrations] /google-classroom/auth: token present but invalid, proceeding as pending');
        statePayload = { pending: true };
      }
    } else {
      // No token at all — proceed; org resolved at callback via Google email lookup
      console.warn('[edu-integrations] /google-classroom/auth: no token found, proceeding as pending');
      statePayload = { pending: true };
    }

    const state = jwt.sign(statePayload, jwtSecret, { expiresIn: '15m' });

    const params = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  gcRedirectUri(),
      response_type: 'code',
      scope:         GC_SCOPES,
      access_type:   'offline',
      prompt:        'consent',
      state,
    });

    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  } catch (err) {
    console.error('[edu-integrations] /google-classroom/auth error:', err);
    res.status(500).json({ error: 'Failed to initiate Google Classroom OAuth' });
  }
});

// ── GET /google-classroom/callback ──────────────────────────
gcOAuthRouter.get('/google-classroom/callback', async (req: Request, res: Response) => {
  const frontendUrl = process.env.FRONTEND_URL || 'https://veloxsync.app';
  const successUrl  = `${frontendUrl}/education/integrations?connected=google-classroom`;
  const errorUrl    = `${frontendUrl}/education/integrations?error=google-classroom`;

  const { code, state, error } = req.query as Record<string, string>;

  if (error || !code || !state) {
    console.error('[edu-integrations] callback denied or missing params:', { error, code: !!code, state: !!state });
    return res.redirect(errorUrl);
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) return res.redirect(errorUrl);

  let orgId: string | undefined;
  let pending = false;
  try {
    const payload = jwt.verify(state, jwtSecret) as any;
    orgId   = payload.orgId;
    pending = !!payload.pending;
  } catch {
    console.error('[edu-integrations] invalid state JWT');
    return res.redirect(errorUrl);
  }

  try {
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

    const tokens = await tokenRes.json() as any;
    if (!tokens.access_token) {
      console.error('[edu-integrations] token exchange failed:', tokens);
      return res.redirect(errorUrl);
    }

    // Pending path: no org in state — resolve via Google userinfo email
    if (!orgId && pending) {
      const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const userinfo = await userinfoRes.json() as any;
      const email    = userinfo.email as string | undefined;

      if (email) {
        const userRow = await pool.query(
          `SELECT organization_id FROM users WHERE email = $1 LIMIT 1`,
          [email]
        );
        if (userRow.rows[0]) {
          orgId = userRow.rows[0].organization_id as string;
          console.log('[edu-integrations] pending callback resolved org via email:', email);
        }
      }

      if (!orgId) {
        console.error('[edu-integrations] callback: could not resolve org from Google email');
        return res.redirect(errorUrl);
      }
    }

    if (!orgId) {
      console.error('[edu-integrations] callback: could not determine orgId');
      return res.redirect(errorUrl);
    }

    const config = {
      access_token:  encryptToken(tokens.access_token),
      refresh_token: tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
      token_expiry:  tokens.expires_in
        ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString()
        : null,
      scope:         tokens.scope ?? GC_SCOPES,
      display_name:  'Google Classroom',
      sync_enabled:  true,
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
  } catch (err) {
    console.error('[edu-integrations] callback exchange error:', err);
    res.redirect(errorUrl);
  }
});

export default router;
