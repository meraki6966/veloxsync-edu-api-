// src/routes/education.ts
// ============================================================
// VeloxSync Education API
// Handles roster, cognitive load, bandwidth heatmap, interventions
// ============================================================

import { Router, Response } from 'express';
import { pool } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { assertEmployeeInOrg, isOrgAssertError } from '../utils/orgAssert';

const router = Router();
router.use(authMiddleware);

// ── HELPER: get org id ──────────────────────────────────────
async function getOrgId(req: AuthRequest): Promise<string | null> {
  const user = req.user as any;
  const fromToken = user?.organizationId || user?.organization_id || null;
  if (fromToken) return fromToken;
  const userId = user?.userId || user?.user_id || null;
  if (!userId) return null;
  try {
    const result = await pool.query('SELECT organization_id FROM users WHERE id = $1', [userId]);
    return result.rows[0]?.organization_id || null;
  } catch { return null; }
}

// ── HELPER: calculate cognitive load score ─────────────────
// Based on: number of active assignments, their weights, missed deadlines
function calculateCognitiveLoad(
  activeAssignments: number,
  totalWeight: number,
  missedDeadlines: number
): number {
  // Base load from assignment weight (max 70 points)
  const weightScore = Math.min((totalWeight / 20) * 70, 70);
  // Missed deadline penalty (10 points each, max 30)
  const missedPenalty = Math.min(missedDeadlines * 10, 30);
  return Math.round(weightScore + missedPenalty);
}

// ── GET ROSTER — all students with load status ──────────────
// GET /api/education/roster
router.get('/roster', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = await getOrgId(req);
    if (!orgId) return res.status(401).json({ error: 'Not authenticated' });

    const result = await pool.query(
      `SELECT
        e.id,
        e.first_name,
        e.last_name,
        e.department,
        e.grade_level,
        e.has_special_needs,
        e.cognitive_load_score,
        e.disconnect_risk,
        e.morale_score,
        e.status,
        e.updated_at,
        -- Count active assignments
        COUNT(t.id) FILTER (WHERE t.status != 'completed') AS active_assignments,
        -- Sum cognitive weight of active assignments
        COALESCE(SUM(t.cognitive_weight) FILTER (WHERE t.status != 'completed'), 0) AS total_weight,
        -- Count missed deadlines (past due, not completed)
        COUNT(t.id) FILTER (WHERE t.due_date < NOW() AND t.status != 'completed') AS missed_deadlines,
        -- Load status
        CASE
          WHEN e.cognitive_load_score <= 39 THEN 'sync'
          WHEN e.cognitive_load_score <= 69 THEN 'friction'
          ELSE 'overload'
        END AS load_status
      FROM employees e
      LEFT JOIN tasks t ON t.assigned_to = e.id
      WHERE e.organization_id = $1
        AND e.industry_type = 'education'
        AND (e.student_role = 'student' OR e.job_title = 'Student')
        AND e.status = 'active'
      GROUP BY e.id
      ORDER BY e.cognitive_load_score DESC`,
      [orgId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Education roster error:', error);
    res.status(500).json({ error: 'Failed to fetch roster' });
  }
});

// ── RECALCULATE COGNITIVE LOAD for all students ─────────────
// POST /api/education/recalculate-load
router.post('/recalculate-load', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = await getOrgId(req);
    if (!orgId) return res.status(401).json({ error: 'Not authenticated' });

    // Get all students
    const students = await pool.query(
      `SELECT id FROM employees
       WHERE organization_id = $1
         AND industry_type = 'education'
         AND (student_role = 'student' OR job_title = 'Student')
         AND status = 'active'`,
      [orgId]
    );

    let updated = 0;
    for (const student of students.rows) {
      // Get their assignment stats
      const stats = await pool.query(
        `SELECT
          COUNT(*) FILTER (WHERE status != 'completed') AS active_count,
          COALESCE(SUM(cognitive_weight) FILTER (WHERE status != 'completed'), 0) AS total_weight,
          COUNT(*) FILTER (WHERE due_date < NOW() AND status != 'completed') AS missed
         FROM tasks WHERE assigned_to = $1`,
        [student.id]
      );

      const { active_count, total_weight, missed } = stats.rows[0];
      const newScore = calculateCognitiveLoad(
        parseInt(active_count),
        parseInt(total_weight),
        parseInt(missed)
      );

      await pool.query(
        `UPDATE employees SET cognitive_load_score = $1, updated_at = NOW() WHERE id = $2`,
        [newScore, student.id]
      );
      updated++;
    }

    res.json({ success: true, studentsUpdated: updated });
  } catch (error) {
    console.error('Recalculate load error:', error);
    res.status(500).json({ error: 'Failed to recalculate cognitive load' });
  }
});

// ── GET BANDWIDTH HEATMAP — cross-teacher load per day ──────
// GET /api/education/bandwidth?studentId=xxx
router.get('/bandwidth', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = await getOrgId(req);
    if (!orgId) return res.status(401).json({ error: 'Not authenticated' });

    const { studentId } = req.query;

    let query = `
      SELECT
        t.due_date,
        SUM(t.cognitive_weight) AS total_weight,
        COUNT(t.id) AS assignment_count,
        JSON_AGG(JSON_BUILD_OBJECT(
          'title', t.title,
          'weight', t.cognitive_weight,
          'subject', t.subject,
          'assignedTo', t.assigned_to
        )) AS assignments,
        CASE
          WHEN SUM(t.cognitive_weight) <= 4  THEN 'sync'
          WHEN SUM(t.cognitive_weight) <= 8  THEN 'friction'
          ELSE 'overload'
        END AS load_status
      FROM tasks t
      JOIN employees e ON t.assigned_to = e.id
      WHERE e.organization_id = $1
        AND t.due_date >= CURRENT_DATE
        AND t.due_date <= CURRENT_DATE + INTERVAL '14 days'
        AND t.cognitive_weight IS NOT NULL
    `;

    const params: any[] = [orgId];

    if (studentId) {
      query += ` AND t.assigned_to = $2`;
      params.push(studentId);
    }

    query += ` GROUP BY t.due_date ORDER BY t.due_date ASC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Bandwidth heatmap error:', error);
    res.status(500).json({ error: 'Failed to fetch bandwidth data' });
  }
});

// ── GET INTERVENTIONS ───────────────────────────────────────
// GET /api/education/interventions
router.get('/interventions', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = await getOrgId(req);
    if (!orgId) return res.status(401).json({ error: 'Not authenticated' });

    const result = await pool.query(
      `SELECT
        i.*,
        e.first_name || ' ' || e.last_name AS student_name,
        e.has_special_needs,
        e.cognitive_load_score,
        e.grade_level
       FROM interventions i
       JOIN employees e ON i.student_id = e.id
       WHERE i.organization_id = $1
         AND i.status NOT IN ('resolved', 'declined')
       ORDER BY i.recommended_at DESC`,
      [orgId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Interventions error:', error);
    res.status(500).json({ error: 'Failed to fetch interventions' });
  }
});

// ── CREATE INTERVENTION ─────────────────────────────────────
// POST /api/education/interventions
router.post('/interventions', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = await getOrgId(req);
    if (!orgId) return res.status(401).json({ error: 'Not authenticated' });

    const { student_id, type, ai_reasoning, teacher_notes } = req.body;

    await assertEmployeeInOrg(student_id, orgId, pool);

    const result = await pool.query(
      `INSERT INTO interventions (organization_id, student_id, type, ai_reasoning, teacher_notes, status)
       VALUES ($1, $2, $3, $4, $5, 'recommended_by_ai')
       RETURNING *`,
      [orgId, student_id, type, ai_reasoning, teacher_notes]
    );

    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    if (isOrgAssertError(error)) return res.status(error.status).json({ error: error.message });
    console.error('Create intervention error:', error);
    res.status(500).json({ error: 'Failed to create intervention' });
  }
});

// ── UPDATE INTERVENTION STATUS ──────────────────────────────
// PATCH /api/education/interventions/:id
router.patch('/interventions/:id', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = await getOrgId(req);
    if (!orgId) return res.status(401).json({ error: 'Not authenticated' });

    const { status, teacher_notes } = req.body;

    const result = await pool.query(
      `UPDATE interventions
       SET status = $1,
           teacher_notes = COALESCE($2, teacher_notes),
           actioned_at = CASE WHEN $1 = 'actioned_by_teacher' THEN NOW() ELSE actioned_at END,
           resolved_at = CASE WHEN $1 = 'resolved' THEN NOW() ELSE resolved_at END,
           updated_at = NOW()
       WHERE id = $3 AND organization_id = $4
       RETURNING *`,
      [status, teacher_notes, req.params.id, orgId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Intervention not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update intervention error:', error);
    res.status(500).json({ error: 'Failed to update intervention' });
  }
});

// ── AUTO-GENERATE INTERVENTIONS for overloaded students ─────
// POST /api/education/interventions/auto-generate
router.post('/interventions/auto-generate', async (req: AuthRequest, res: Response) => {
  try {
    const orgId = await getOrgId(req);
    if (!orgId) return res.status(401).json({ error: 'Not authenticated' });

    // Find students in overload with no active intervention
    const overloaded = await pool.query(
      `SELECT e.id, e.first_name, e.last_name, e.cognitive_load_score, e.has_special_needs
       FROM employees e
       WHERE e.organization_id = $1
         AND e.industry_type = 'education'
         AND e.cognitive_load_score >= 70
         AND e.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM interventions i
           WHERE i.student_id = e.id
             AND i.status IN ('recommended_by_ai', 'actioned_by_teacher')
         )`,
      [orgId]
    );

    let created = 0;
    for (const student of overloaded.rows) {
      const type = student.has_special_needs ? 'iep_accommodation' : '1_on_1_checkin';
      const reasoning = student.has_special_needs
        ? `${student.first_name} has an active IEP and cognitive load score of ${student.cognitive_load_score}. IEP accommodation or deadline extension recommended.`
        : `${student.first_name} has a cognitive load score of ${student.cognitive_load_score}, indicating overload. A 1-on-1 check-in is recommended.`;

      await pool.query(
        `INSERT INTO interventions (organization_id, student_id, type, ai_reasoning, status)
         VALUES ($1, $2, $3, $4, 'recommended_by_ai')`,
        [orgId, student.id, type, reasoning]
      );
      created++;
    }

    res.json({ success: true, interventionsCreated: created });
  } catch (error) {
    console.error('Auto-generate interventions error:', error);
    res.status(500).json({ error: 'Failed to auto-generate interventions' });
  }
});

export default router;
