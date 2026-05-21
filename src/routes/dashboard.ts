import { Router, Response } from 'express';
import { pool } from '../db';
import { AuthRequest } from '../middleware/auth';

const router = Router();

// GET /api/dashboard/me — return the authenticated user's profile
router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const result = await pool.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.organization_id,
              o.industry_type, o.name AS organization_name
       FROM users u
       LEFT JOIN organizations o ON u.organization_id = o.id
       WHERE u.id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    const u = result.rows[0];
    res.json({
      user: {
        id: u.id,
        email: u.email,
        firstName: u.first_name,
        lastName: u.last_name,
        role: u.role,
        industryType: u.industry_type,
        organizationId: u.organization_id,
        organizationName: u.organization_name,
      },
    });
  } catch (error: any) {
    console.error('Dashboard /me error:', error);
    res.status(500).json({ error: 'Failed to load user' });
  }
});

export default router;
