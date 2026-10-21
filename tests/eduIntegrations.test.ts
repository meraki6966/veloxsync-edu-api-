import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createHmac, randomUUID } from 'crypto';

// Test-only values, generated for this file. Not real secrets.
vi.hoisted(() => {
  process.env.JWT_SECRET = 'test-jwt-secret-7f3a9c2e5b1d4f8a';
  process.env.ENCRYPTION_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0';
  process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  process.env.FRONTEND_URL = 'https://veloxsync.app';
});

const db = vi.hoisted(() => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));
vi.mock('../src/db', () => db);

import router, { gcOAuthRouter } from '../src/routes/edu-integrations';
import { decryptToken } from '../src/utils/crypto';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const USER_A = '33333333-3333-3333-3333-333333333333';

function app() {
  const a = express();
  a.use(express.json());
  // Public: only the Google callback lives here, as in index.ts.
  a.use('/api/edu/integrations', gcOAuthRouter);
  // Protected: stands in for authMiddleware; the org comes from the verified token.
  a.use('/api/edu/integrations', (req, _res, next) => {
    (req as any).user = { userId: USER_A, organizationId: ORG_A, role: 'admin' };
    next();
  }, router);
  return a;
}

const F = { connected: false, config: {}, connected_at: null };

function sqlCalls(re: RegExp) {
  return db.pool.query.mock.calls.filter(c => re.test(String(c[0])));
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  db.pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('GET /status', () => {
  function statusRows(rows: Record<string, unknown>[]) {
    db.pool.query.mockImplementation(async (sql: string) =>
      /SELECT provider/.test(sql) ? { rows, rowCount: rows.length } : { rows: [], rowCount: 0 });
  }

  it('does not report legacy rows with no credentials as connected', async () => {
    // Rows the old connect handler wrote from empty request bodies.
    statusRows([
      { provider: 'canvas', ...F },
      { provider: 'classdojo', connected: true, connected_at: '2026-04-04T23:41:07.352Z', config: { display_name: 'ClassDojo', sync_enabled: true } },
      { provider: 'clever', connected: true, connected_at: '2026-04-04T23:40:55.918Z', config: { display_name: 'Clever', sync_enabled: true } },
      { provider: 'google_classroom', connected: true, connected_at: '2026-10-19T21:47:52.006Z', config: { access_token: null, refresh_token: null, display_name: 'Google Classroom', sync_enabled: true } },
      { provider: 'powerschool', connected: true, connected_at: '2026-04-04T23:40:31.204Z', config: { display_name: 'PowerSchool', sync_enabled: true } },
      { provider: 'renaissance', ...F },
    ]);

    const res = await request(app()).get('/api/edu/integrations/status');

    expect(res.status).toBe(200);
    for (const p of ['canvas', 'classdojo', 'clever', 'google_classroom', 'powerschool', 'renaissance']) {
      expect(res.body.integrations[p].connected).toBe(false);
    }
  });

  it('reports a provider connected when its credentials are stored, and never returns them', async () => {
    statusRows([
      { provider: 'canvas', connected: true, connected_at: '2026-10-20T14:03:11.482Z', config: { domain: 'school.instructure.com', access_token: 'aa:bb:cc', display_name: 'Canvas LMS' } },
    ]);

    const res = await request(app()).get('/api/edu/integrations/status');

    expect(res.body.integrations.canvas.connected).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/aa:bb:cc|access_token/);
  });

  it('says sync is not available rather than pretending', async () => {
    statusRows([{ provider: 'canvas', connected: true, connected_at: '2026-10-20T14:03:11.482Z', config: { domain: 'school.instructure.com', access_token: 'aa:bb:cc' } }]);
    const res = await request(app()).get('/api/edu/integrations/status');
    expect(res.body.integrations.canvas.sync_available).toBe(false);
  });
});

describe('POST /:provider/connect', () => {
  it('refuses to connect Canvas without a domain and token, and writes nothing', async () => {
    const res = await request(app()).post('/api/edu/integrations/canvas/connect').send({ api_key: 'junk' });
    expect(res.status).toBe(400);
    expect(sqlCalls(/INSERT INTO edu_integrations/)).toHaveLength(0);
  });

  it('refuses empty bodies for the other providers', async () => {
    for (const p of ['clever', 'powerschool', 'classdojo', 'renaissance', 'power_school', 'class_dojo']) {
      const res = await request(app()).post(`/api/edu/integrations/${p}/connect`).send({});
      expect(res.status, p).toBe(400);
    }
    expect(sqlCalls(/INSERT INTO edu_integrations/)).toHaveLength(0);
  });

  it('stores the Canvas token encrypted and scoped to the caller org', async () => {
    db.pool.query.mockResolvedValueOnce({ rows: [{ id: randomUUID(), provider: 'canvas', connected: true, connected_at: '2026-10-20T14:03:11.482Z' }], rowCount: 1 });

    const res = await request(app())
      .post('/api/edu/integrations/canvas/connect')
      .send({ domain: 'https://school.instructure.com/', access_token: 'canvas-token-123' });

    expect(res.status).toBe(200);
    const [, params] = sqlCalls(/INSERT INTO edu_integrations/)[0];
    expect(params[0]).toBe(ORG_A);
    const config = JSON.parse(params[2]);
    expect(config.domain).toBe('school.instructure.com');
    expect(config.access_token).not.toBe('canvas-token-123');
    expect(decryptToken(config.access_token)).toBe('canvas-token-123');
  });

  it('will not mark Google Classroom connected from a request body', async () => {
    for (const path of ['google_classroom', 'google-classroom']) {
      const res = await request(app()).post(`/api/edu/integrations/${path}/connect`).send({ access_token: 'anything' });
      expect(res.status, path).toBe(400);
    }
    expect(sqlCalls(/INSERT INTO edu_integrations/)).toHaveLength(0);
  });
});

describe('POST /:provider/sync', () => {
  it('answers 501 instead of returning a sample roster', async () => {
    const res = await request(app()).post('/api/edu/integrations/google_classroom/sync');
    expect(res.status).toBe(501);
    expect(JSON.stringify(res.body)).not.toMatch(/courses|Amara/);
  });
});

describe('Google Classroom sign-in', () => {
  const stateKey = () => createHmac('sha256', process.env.JWT_SECRET!).update('edu-gc-oauth-state-v1').digest();

  function tokenExchangeOk() {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ access_token: 'ya29.test', refresh_token: '1//test', expires_in: 3600, scope: 'x' }) });
  }

  it('no longer accepts a login token in the URL', async () => {
    const userToken = jwt.sign({ userId: USER_A, organizationId: ORG_A, role: 'admin' }, process.env.JWT_SECRET!);
    const res = await request(app()).get(`/api/edu/integrations/google-classroom/auth?token=${userToken}`);
    expect(res.status).toBe(404);
  });

  it('builds the Google URL for the signed-in org and records a single-use nonce', async () => {
    const res = await request(app()).post('/api/edu/integrations/google-classroom/auth-url');

    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.origin).toBe('https://accounts.google.com');
    const claims = jwt.verify(url.searchParams.get('state')!, stateKey()) as any;
    expect(claims.orgId).toBe(ORG_A);
    const [, params] = sqlCalls(/INSERT INTO edu_oauth_sessions/)[0];
    expect(params[0]).toBe(claims.nonce);
  });

  it('connects the org named in a valid, unused state', async () => {
    const nonce = randomUUID();
    const state = jwt.sign({ orgId: ORG_A, userId: USER_A, nonce, purpose: 'edu-gc-oauth' }, stateKey(), { expiresIn: '10m' });
    db.pool.query.mockImplementation(async (sql: string) =>
      /DELETE FROM edu_oauth_sessions/.test(sql) ? { rows: [{ id: nonce }], rowCount: 1 } : { rows: [], rowCount: 1 });
    tokenExchangeOk();

    const res = await request(app()).get(`/api/edu/integrations/google-classroom/callback?code=abc&state=${state}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://veloxsync.app/education/integrations?connected=google-classroom');
    const [, params] = sqlCalls(/INSERT INTO edu_integrations/)[0];
    expect(params[0]).toBe(ORG_A);
    expect(decryptToken(JSON.parse(params[1]).access_token)).toBe('ya29.test');
  });

  it('refuses a state that was already used, before talking to Google', async () => {
    const nonce = randomUUID();
    const state = jwt.sign({ orgId: ORG_A, userId: USER_A, nonce, purpose: 'edu-gc-oauth' }, stateKey(), { expiresIn: '10m' });
    // DELETE ... RETURNING finds nothing: the nonce was consumed or expired.

    const res = await request(app()).get(`/api/edu/integrations/google-classroom/callback?code=abc&state=${state}`);

    expect(res.headers.location).toBe('https://veloxsync.app/education/integrations?error=google-classroom');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sqlCalls(/INSERT INTO edu_integrations/)).toHaveLength(0);
  });

  it('refuses the old pending state and never looks an org up by email', async () => {
    const state = jwt.sign({ pending: true }, process.env.JWT_SECRET!, { expiresIn: '15m' });

    const res = await request(app()).get(`/api/edu/integrations/google-classroom/callback?code=abc&state=${state}`);

    expect(res.headers.location).toMatch(/error=google-classroom$/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sqlCalls(/FROM users/)).toHaveLength(0);
    expect(sqlCalls(/INSERT INTO edu_integrations/)).toHaveLength(0);
  });

  it('refuses a login token passed as state', async () => {
    const userToken = jwt.sign({ userId: USER_A, organizationId: ORG_A, orgId: ORG_A, role: 'admin' }, process.env.JWT_SECRET!);

    const res = await request(app()).get(`/api/edu/integrations/google-classroom/callback?code=abc&state=${userToken}`);

    expect(res.headers.location).toMatch(/error=google-classroom$/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sqlCalls(/INSERT INTO edu_integrations/)).toHaveLength(0);
  });
});
