import { Router, Response } from 'express';
import { pool } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

// Middleware to strictly enforce SchoolFlow access
const requireSchoolFlow = async (req: AuthRequest, res: Response, next: Function) => {
  try {
    const org = await pool.query('SELECT industry_type FROM organizations WHERE id = $1', [req.user?.organizationId]);
    if (org.rows[0]?.industry_type !== 'SchoolFlow') {
      return res.status(403).json({ error: 'Access denied. This module is restricted to SchoolFlow organizations.' });
    }
    next();
  } catch (error) {
    res.status(500).json({ error: 'Failed to verify organization industry.' });
  }
};

router.use(requireSchoolFlow);

// Get all students
router.get('/students', async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      'SELECT * FROM students WHERE organization_id = $1 ORDER BY last_name ASC',
      [req.user?.organizationId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

// Create a student
router.post('/students', async (req: AuthRequest, res: Response) => {
  try {
    const { first_name, last_name, grade_level, neurodivergent_profile } = req.body;
    const result = await pool.query(
      `INSERT INTO students (organization_id, first_name, last_name, grade_level, neurodivergent_profile)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user?.organizationId, first_name, last_name, grade_level, neurodivergent_profile || {}]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create student' });
  }
});

export default router;