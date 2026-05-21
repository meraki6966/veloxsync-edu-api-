import { Resend } from 'resend';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';

// Register new organization + user
router.post('/register', async (req, res) => {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY || '');
    const FRONTEND_URL = process.env.FRONTEND_URL || 'https://education.veloxsync.app';
    const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';
    const firstName = req.body.firstName || req.body.first_name || '';
    const lastName = req.body.lastName || req.body.last_name || '';
    const { email, password } = req.body;
    const role = req.body.role || 'owner';
    const industryType = req.body.industry_type || req.body.organization_type || 'education';
    const explicitOrgName = req.body.organizationName || req.body.organization_name;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check if email exists
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Derive organization name when the frontend does not pass one (homeschool flow)
    const emailHandle = String(email).split('@')[0] || 'family';
    const organizationName = explicitOrgName
      || (firstName ? `${firstName}'s ${role === 'homeschool' ? 'Homeschool' : 'Organization'}`
                    : `${emailHandle}'s ${role === 'homeschool' ? 'Homeschool' : 'Organization'}`);

    // Create slug from org name (suffixed for uniqueness)
    const slug = organizationName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now().toString(36);

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create organization
    const orgResult = await pool.query(
      `INSERT INTO organizations (name, slug, industry_type, trial_ends_at, subscription_status, plan)
       VALUES ($1, $2, $3, NOW() + INTERVAL '7 days', 'trialing', 'trial')
       RETURNING id`,
      [organizationName, slug, industryType]
    );
    const organizationId = orgResult.rows[0].id;

    // Create user
    const userResult = await pool.query(
      `INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, first_name, last_name, role`,
      [organizationId, email, passwordHash, firstName, lastName, role]
    );
    const user = userResult.rows[0];

    // Send welcome email
    try {
      await resend.emails.send({
        from: `VeloxSync for Education <${FROM_EMAIL}>`,
        to: email,
        subject: 'Welcome to VeloxSync for Education!',
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 500px; margin: 0 auto; padding: 40px 20px;">
            <div style="text-align: center; margin-bottom: 32px;">
              <h1 style="font-size: 24px; font-weight: 800; color: #0f172a; margin: 0;">VeloxSync for Education</h1>
              <p style="font-size: 13px; color: #64748b; margin-top: 4px;">AI co-teacher for classrooms and homeschool families</p>
            </div>
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 32px;">
              <h2 style="font-size: 20px; font-weight: 700; color: #0f172a; margin: 0 0 12px;">Welcome, ${firstName || 'there'}!</h2>
              <p style="font-size: 15px; color: #475569; line-height: 1.6; margin: 0 0 24px;">Your 7-day free trial is active. Here is how to get started:</p>
              <ul style="font-size: 14px; color: #475569; line-height: 2; padding-left: 20px; margin: 0 0 24px;">
                <li>Add your students or children</li>
                <li>Generate your first lesson plan</li>
                <li>Try the curriculum standards alignment</li>
                <li>Explore differentiation and pacing tools</li>
              </ul>
              <a href="${FRONTEND_URL}/dashboard" style="display: inline-block; background: #0B9B8A; color: #ffffff; font-size: 14px; font-weight: 700; text-decoration: none; padding: 12px 32px; border-radius: 8px;">Go to Dashboard</a>
            </div>
            <p style="font-size: 12px; color: #94a3b8; text-align: center; margin-top: 32px;">Questions? Reply to this email or contact support@veloxsync.app</p>
            <p style="font-size: 11px; color: #cbd5e1; text-align: center; margin-top: 8px;">VeloxSync for Education is a product of Meraki is Love, LLC.</p>
          </div>
        `,
      });
    } catch (emailErr) {
      console.error('Welcome email failed:', emailErr);
    }

    // Generate token
    const token = jwt.sign(
      { userId: user.id, organizationId, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'Registration successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        organizationId
      }
    });
  } catch (error: any) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password, rememberMe } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Find user
    const result = await pool.query(
      `SELECT u.id, u.email, u.password_hash, u.first_name, u.last_name, u.role, u.organization_id,
              u.mfa_enabled, o.name as organization_name
       FROM users u
       JOIN organizations o ON u.organization_id = o.id
       WHERE u.email = $1 AND u.is_active IS NOT FALSE`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Check password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    // MFA gate — if enabled, return a short-lived temp token instead of the full JWT
    if (user.mfa_enabled) {
      const tempToken = jwt.sign(
        { userId: user.id, organizationId: user.organization_id, role: user.role, mfaPending: true, rememberMe: !!rememberMe },
        JWT_SECRET,
        { expiresIn: '5m' }
      );
      return res.json({ mfaRequired: true, tempToken });
    }

    // Generate token — 30d if rememberMe, otherwise 7d
    const token = jwt.sign(
      { userId: user.id, organizationId: user.organization_id, role: user.role },
      JWT_SECRET,
      { expiresIn: rememberMe ? '30d' : '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        organizationId: user.organization_id,
        organizationName: user.organization_name
      }
    });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

export default router;
