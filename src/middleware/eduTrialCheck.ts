// src/middleware/eduTrialCheck.ts
// ============================================================
// VeloxSync for Education — Trial Enforcement Middleware
// Blocks /api/edu/* when trial expired and no active subscription
// Exempts: /api/edu/billing/*, /api/edu/parent/*, /api/edu/homeschool/*
// Returns 402 with upgrade prompt
// ============================================================

import { Response, NextFunction } from 'express';
import { pool } from '../db';
import { AuthRequest } from './auth';

const EXEMPT_PREFIXES = ['/billing', '/parent', '/homeschool'];
const SUPER_ADMIN_ORG = '0c7bbd12-5021-4785-bb6b-bddae8531081';

export async function eduTrialCheck(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Strip the /api/edu prefix — req.path is relative to the router mount
  const path = req.path;

  // Exempt billing and parent portal routes
  for (const prefix of EXEMPT_PREFIXES) {
    if (path.startsWith(prefix)) {
      return next();
    }
  }

  const user = req.user as { organizationId: string } | undefined;
  if (!user?.organizationId) {
    return next(); // auth middleware will handle missing user
  }

  // Super admin org always passes through
  if (user.organizationId === SUPER_ADMIN_ORG) {
    return next();
  }

  try {
    const result = await pool.query(
      `SELECT status, trial_ends_at FROM edu_subscriptions WHERE organization_id = $1`,
      [user.organizationId]
    );

    // No row — new user who hasn't gone through checkout yet, pass through
    if (result.rowCount === 0) {
      return next();
    }

    const sub = result.rows[0];
    const now = new Date();

    // Active subscription — allow through
    if (sub.status === 'active') {
      return next();
    }

    // Trial still valid — allow through
    if (sub.status === 'trialing' && sub.trial_ends_at && new Date(sub.trial_ends_at) > now) {
      return next();
    }

    // Trial expired or cancelled — block with 402
    res.status(402).json({
      error: 'trial_expired',
      message: 'Your VeloxSync for Education trial has ended. Upgrade to continue.',
      upgrade_url: '/education-home#pricing',
    });
  } catch (err: any) {
    console.error('[eduTrialCheck] error:', err.message);
    // On DB error, fail open so a billing outage doesn't lock out all teachers
    next();
  }
}
