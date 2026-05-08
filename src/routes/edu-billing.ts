// src/routes/edu-billing.ts
// ============================================================
// VeloxSync for Education — Stripe Billing
// Plans: Teacher Pro ($9/mo), Homeschool Family ($12/mo), School License ($199/yr)
// ============================================================

import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { pool } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-12-18.acacia' as any,
});

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://veloxsync.app';

const EDU_PRICE_MAP: Record<string, string> = {
  teacher_pro:      process.env.EDU_STRIPE_PRICE_TEACHER_PRO || '',
  homeschool_family: process.env.EDU_STRIPE_PRICE_HOMESCHOOL  || '',
  school_license:   process.env.EDU_STRIPE_PRICE_SCHOOL       || '',
};

const EDU_PLAN_NAMES: Record<string, string> = {
  teacher_pro:       'Teacher Pro',
  homeschool_family: 'Homeschool Family',
  school_license:    'School License',
};

// ── ENSURE TABLE EXISTS ──────────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS edu_subscriptions (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    stripe_customer_id     VARCHAR(255),
    stripe_subscription_id VARCHAR(255),
    plan                   VARCHAR(50),
    status                 VARCHAR(30) NOT NULL DEFAULT 'trialing',
    trial_ends_at          TIMESTAMPTZ,
    current_period_end     TIMESTAMPTZ,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id)
  );
  CREATE INDEX IF NOT EXISTS idx_edu_subs_org      ON edu_subscriptions(organization_id);
  CREATE INDEX IF NOT EXISTS idx_edu_subs_customer ON edu_subscriptions(stripe_customer_id);
`).catch(err => console.error('[edu-billing] table init failed:', err.message));

// ── HELPER ───────────────────────────────────────────────────
function getUser(req: AuthRequest) {
  const user = req.user as { userId: string; organizationId: string };
  return { userId: user.userId, orgId: user.organizationId };
}

// ============================================================
// POST /api/edu/billing/checkout
// ============================================================
router.post('/checkout', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { userId, orgId } = getUser(req);
    const { plan, success_url, cancel_url } = req.body;

    if (!plan || !EDU_PRICE_MAP[plan]) {
      return res.status(400).json({
        error: 'Invalid plan',
        valid_plans: Object.keys(EDU_PRICE_MAP),
      });
    }

    const priceId = EDU_PRICE_MAP[plan];
    if (!priceId) {
      return res.status(500).json({ error: `Price not configured for plan "${plan}". Set the env var.` });
    }

    // Get or create Stripe customer
    const orgResult = await pool.query(
      'SELECT id, name FROM organizations WHERE id = $1',
      [orgId]
    );
    if (orgResult.rowCount === 0) return res.status(404).json({ error: 'Organization not found' });
    const org = orgResult.rows[0];

    const subRow = await pool.query(
      'SELECT stripe_customer_id FROM edu_subscriptions WHERE organization_id = $1',
      [orgId]
    );
    let customerId: string | null = subRow.rows[0]?.stripe_customer_id || null;

    if (!customerId) {
      const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
      const email = userResult.rows[0]?.email;

      const customer = await stripe.customers.create({
        email,
        name: org.name,
        metadata: { organization_id: orgId, product: 'edu' },
      });
      customerId = customer.id;

      // Upsert subscription row with customer id
      await pool.query(
        `INSERT INTO edu_subscriptions (organization_id, stripe_customer_id, status)
         VALUES ($1, $2, 'trialing')
         ON CONFLICT (organization_id) DO UPDATE SET stripe_customer_id = $2`,
        [orgId, customerId]
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId as string,
      mode: 'subscription',
      payment_method_types: ['card'],
      payment_method_collection: 'if_required',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: 14,
        metadata: { organization_id: orgId, plan, product: 'edu' },
      },
      success_url: success_url || `${FRONTEND_URL}/education?checkout=success&plan=${plan}`,
      cancel_url:  cancel_url  || `${FRONTEND_URL}/education-home#pricing`,
      metadata: { organization_id: orgId, plan, product: 'edu' },
    });

    res.json({ url: session.url, session_id: session.id });
  } catch (err: any) {
    console.error('[edu-billing] POST /checkout', err.message);
    res.status(500).json({ error: 'Failed to create checkout session', details: err.message });
  }
});

// ============================================================
// POST /api/edu/billing/portal
// ============================================================
router.post('/portal', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const { return_url } = req.body;

    const subResult = await pool.query(
      'SELECT stripe_customer_id FROM edu_subscriptions WHERE organization_id = $1',
      [orgId]
    );
    const customerId = subResult.rows[0]?.stripe_customer_id;
    if (!customerId) {
      return res.status(400).json({ error: 'No billing account found. Subscribe to a plan first.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: return_url || `${FRONTEND_URL}/education/settings`,
    });

    res.json({ url: session.url });
  } catch (err: any) {
    console.error('[edu-billing] POST /portal', err.message);
    res.status(500).json({ error: 'Failed to open billing portal', details: err.message });
  }
});

// ============================================================
// GET /api/edu/billing/status
// ============================================================
router.get('/status', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);

    const result = await pool.query(
      `SELECT plan, status, trial_ends_at, current_period_end, stripe_customer_id
       FROM edu_subscriptions WHERE organization_id = $1`,
      [orgId]
    );

    if (result.rowCount === 0) {
      return res.json({
        plan: null,
        status: 'none',
        trial_ends_at: null,
        current_period_end: null,
        is_active: false,
        plan_name: null,
      });
    }

    const sub = result.rows[0];
    const now = new Date();
    const trialEndsAt = sub.trial_ends_at ? new Date(sub.trial_ends_at) : null;
    const isTrialActive = sub.status === 'trialing' && trialEndsAt && trialEndsAt > now;
    const isActive = sub.status === 'active' || isTrialActive;

    res.json({
      plan: sub.plan,
      plan_name: sub.plan ? (EDU_PLAN_NAMES[sub.plan] || sub.plan) : null,
      status: sub.status,
      trial_ends_at: sub.trial_ends_at,
      current_period_end: sub.current_period_end,
      is_active: isActive,
      has_billing: !!sub.stripe_customer_id,
    });
  } catch (err: any) {
    console.error('[edu-billing] GET /status', err.message);
    res.status(500).json({ error: 'Failed to fetch billing status' });
  }
});

// ============================================================
// POST /api/edu/billing/webhook  (no auth — raw body)
// ============================================================
router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  const webhookSecret = process.env.EDU_STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;

  let event: Stripe.Event;

  try {
    if (webhookSecret && sig) {
      event = stripe.webhooks.constructEvent(
        (req as any).rawBody || req.body,
        sig,
        webhookSecret
      );
    } else {
      // Dev mode — no signature verification
      event = req.body as Stripe.Event;
    }
  } catch (err: any) {
    console.error('[edu-billing] webhook signature failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  console.log('[edu-billing] webhook received:', event.type);

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.product !== 'edu') break;

        const orgId = session.metadata?.organization_id;
        const plan  = session.metadata?.plan;

        if (orgId && plan) {
          const sub = session.subscription
            ? await stripe.subscriptions.retrieve(session.subscription as string) as unknown as Stripe.Subscription
            : null;

          const trialEnd = (sub as any)?.trial_end
            ? new Date((sub as any).trial_end * 1000)
            : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

          const periodEnd = (sub as any)?.current_period_end
            ? new Date((sub as any).current_period_end * 1000)
            : null;

          await pool.query(
            `INSERT INTO edu_subscriptions
               (organization_id, stripe_customer_id, stripe_subscription_id, plan, status, trial_ends_at, current_period_end)
             VALUES ($1, $2, $3, $4, 'trialing', $5, $6)
             ON CONFLICT (organization_id) DO UPDATE
               SET stripe_customer_id     = EXCLUDED.stripe_customer_id,
                   stripe_subscription_id = EXCLUDED.stripe_subscription_id,
                   plan                   = EXCLUDED.plan,
                   status                 = 'trialing',
                   trial_ends_at          = EXCLUDED.trial_ends_at,
                   current_period_end     = EXCLUDED.current_period_end`,
            [orgId, session.customer, session.subscription, plan, trialEnd, periodEnd]
          );
          console.log(`[edu-billing] org ${orgId} subscribed to ${plan}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        if (sub.metadata?.product !== 'edu') break;

        const orgId = sub.metadata?.organization_id;
        if (!orgId) break;

        const status = sub.status === 'active'    ? 'active'    :
                       sub.status === 'trialing'  ? 'trialing'  :
                       sub.status === 'past_due'  ? 'past_due'  :
                       sub.status === 'canceled'  ? 'cancelled' : sub.status;

        const periodEnd = (sub as any).current_period_end
          ? new Date((sub as any).current_period_end * 1000)
          : null;

        const trialEnd = (sub as any).trial_end
          ? new Date((sub as any).trial_end * 1000)
          : null;

        await pool.query(
          `UPDATE edu_subscriptions
           SET status = $1, current_period_end = $2, trial_ends_at = COALESCE($3, trial_ends_at)
           WHERE organization_id = $4`,
          [status, periodEnd, trialEnd, orgId]
        );
        console.log(`[edu-billing] org ${orgId} subscription updated: ${status}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        if (sub.metadata?.product !== 'edu') break;

        const orgId = sub.metadata?.organization_id;
        if (!orgId) break;

        await pool.query(
          `UPDATE edu_subscriptions SET status = 'cancelled', plan = 'cancelled'
           WHERE organization_id = $1`,
          [orgId]
        );
        console.log(`[edu-billing] org ${orgId} subscription cancelled`);
        break;
      }
    }

    res.json({ received: true });
  } catch (err: any) {
    console.error('[edu-billing] webhook processing error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export default router;
