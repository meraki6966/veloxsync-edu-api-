// src/routes/edu-parent-portal.ts
// ============================================================
// VeloxSync for Education — Parent Portal (public, no auth)
// Read-only, safe data only — no scores, no internal notes
// ============================================================

import { Router, Request, Response } from 'express';
import { pool } from '../db';

const router = Router();

// GET /api/edu/parent/:studentId
router.get('/:studentId', async (req: Request, res: Response) => {
  try {
    const { studentId } = req.params;

    const studentResult = await pool.query(
      `SELECT first_name, grade_level, learning_style
       FROM students WHERE id = $1`,
      [studentId]
    );
    if (studentResult.rowCount === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    const student = studentResult.rows[0];

    // Subject mastery % only — no raw scores
    const progressResult = await pool.query(
      `SELECT ss.subject,
         COUNT(cp.id) FILTER (WHERE cp.status = 'mastered')::int AS mastered,
         COUNT(cp.id)::int AS total
       FROM curriculum_progress cp
       JOIN state_standards ss ON ss.id = cp.standard_id
       WHERE cp.student_id = $1
       GROUP BY ss.subject
       ORDER BY ss.subject`,
      [studentId]
    );

    const subjectMastery = progressResult.rows.map(r => ({
      subject: r.subject,
      mastery_pct: r.total > 0 ? Math.round((r.mastered / r.total) * 100) : 0,
      skills_mastered: r.mastered,
      skills_total: r.total,
    }));

    // Intervention types only — no internal notes or priority details
    const interventionsResult = await pool.query(
      `SELECT DISTINCT intervention_type, subject
       FROM learning_interventions
       WHERE student_id = $1 AND status != 'resolved'`,
      [studentId]
    );

    const activeSupport = interventionsResult.rows.map(r => ({
      type: r.intervention_type,
      subject: r.subject || 'General',
    }));

    res.json({
      student: {
        first_name: student.first_name,
        grade_level: student.grade_level,
        learning_style: student.learning_style,
      },
      subject_mastery: subjectMastery,
      active_support: activeSupport,
    });
  } catch (err: any) {
    console.error('[edu-parent] GET /:studentId', err.message);
    res.status(500).json({ error: 'Failed to fetch student data' });
  }
});

export default router;
