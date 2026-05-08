// src/routes/education-v2.ts
// ============================================================
// VeloxSync for Education — K-12 Intelligence API v2
// Classrooms, Students, Standards, Progress, Interventions, Homeschool, Ei-Core
// ============================================================

import { Router, Response } from 'express';
import { Resend } from 'resend';
import { pool } from '../db';
import { AuthRequest } from '../middleware/auth';
import { upload } from '../middleware/upload';
import {
  generateStudentInsight,
  generateClassInsight,
  generateCurriculumRecommendation,
} from '../services/eicore';
import { assertClassroomInOrg, assertStudentInOrg, isOrgAssertError } from '../utils/orgAssert';

const resend = new Resend(process.env.RESEND_API_KEY || '');
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';

const router = Router();

// ── HELPER ──────────────────────────────────────────────────

function getUser(req: AuthRequest) {
  const user = req.user as { userId: string; organizationId: string; role: string };
  return { userId: user.userId, orgId: user.organizationId };
}

// ============================================================
// CLASSROOMS
// ============================================================

// GET /api/edu/classrooms
router.get('/classrooms', async (req: AuthRequest, res: Response) => {
  try {
    const { userId, orgId } = getUser(req);
    const result = await pool.query(
      `SELECT c.*, COUNT(s.id)::int AS student_count
       FROM classrooms c
       LEFT JOIN students s ON s.classroom_id = c.id
       WHERE c.organization_id = $1 AND c.teacher_id = $2
       GROUP BY c.id
       ORDER BY c.created_at DESC`,
      [orgId, userId]
    );
    res.json({ classrooms: result.rows });
  } catch (err: any) {
    console.error('[edu] GET /classrooms', err.message);
    res.status(500).json({ error: 'Failed to fetch classrooms' });
  }
});

// POST /api/edu/classrooms
router.post('/classrooms', async (req: AuthRequest, res: Response) => {
  try {
    const { userId, orgId } = getUser(req);
    const { name, grade_band, school_type, state, subject_areas } = req.body;

    if (!name || !grade_band || !school_type || !state) {
      return res.status(400).json({ error: 'name, grade_band, school_type, and state are required' });
    }

    const result = await pool.query(
      `INSERT INTO classrooms (organization_id, teacher_id, name, grade_band, school_type, state, subject_areas)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [orgId, userId, name, grade_band, school_type, state.toUpperCase(), subject_areas || []]
    );
    res.status(201).json({ classroom: result.rows[0] });
  } catch (err: any) {
    console.error('[edu] POST /classrooms', err.message);
    res.status(500).json({ error: 'Failed to create classroom' });
  }
});

// GET /api/edu/classrooms/:id
router.get('/classrooms/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const classroomResult = await pool.query(
      'SELECT * FROM classrooms WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    );
    if (classroomResult.rowCount === 0) {
      return res.status(404).json({ error: 'Classroom not found' });
    }
    const studentsResult = await pool.query(
      'SELECT * FROM students WHERE classroom_id = $1 ORDER BY last_name, first_name',
      [req.params.id]
    );
    res.json({ classroom: classroomResult.rows[0], students: studentsResult.rows });
  } catch (err: any) {
    console.error('[edu] GET /classrooms/:id', err.message);
    res.status(500).json({ error: 'Failed to fetch classroom' });
  }
});

// PUT /api/edu/classrooms/:id
router.put('/classrooms/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { userId, orgId } = getUser(req);
    const { name, grade_band, school_type, state, subject_areas } = req.body;
    const result = await pool.query(
      `UPDATE classrooms
       SET name = COALESCE($1, name),
           grade_band = COALESCE($2, grade_band),
           school_type = COALESCE($3, school_type),
           state = COALESCE($4, state),
           subject_areas = COALESCE($5, subject_areas)
       WHERE id = $6 AND organization_id = $7 AND teacher_id = $8
       RETURNING *`,
      [name, grade_band, school_type, state, subject_areas, req.params.id, orgId, userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Classroom not found or unauthorized' });
    }
    res.json({ classroom: result.rows[0] });
  } catch (err: any) {
    console.error('[edu] PUT /classrooms/:id', err.message);
    res.status(500).json({ error: 'Failed to update classroom' });
  }
});

// ============================================================
// STUDENTS
// ============================================================

// GET /api/edu/students
router.get('/students', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const { classroom_id, grade_level } = req.query;

    let query = 'SELECT * FROM students WHERE organization_id = $1';
    const params: any[] = [orgId];

    if (classroom_id) {
      params.push(classroom_id);
      query += ` AND classroom_id = $${params.length}`;
    }
    if (grade_level) {
      params.push(grade_level);
      query += ` AND grade_level = $${params.length}`;
    }
    query += ' ORDER BY last_name, first_name';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err: any) {
    console.error('[edu] GET /students', err.message);
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

// POST /api/edu/students
router.post('/students', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const {
      classroom_id, first_name, last_name, grade_level, age,
      learning_style, primary_language, has_iep, iep_notes, strengths, challenge_areas
    } = req.body;

    if (!first_name || !last_name || !grade_level) {
      return res.status(400).json({ error: 'first_name, last_name, and grade_level are required' });
    }

    if (classroom_id) {
      await assertClassroomInOrg(classroom_id, orgId, pool);
    }

    const result = await pool.query(
      `INSERT INTO students
        (organization_id, classroom_id, first_name, last_name, grade_level, age,
         learning_style, primary_language, has_iep, iep_notes, strengths, challenge_areas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [orgId, classroom_id || null, first_name, last_name, grade_level, age || null,
       learning_style || null, primary_language || 'English', has_iep || false,
       iep_notes || null, strengths || [], challenge_areas || []]
    );
    res.status(201).json({ student: result.rows[0] });
  } catch (err: any) {
    if (isOrgAssertError(err)) return res.status(err.status).json({ error: err.message });
    console.error('[edu] POST /students', err.message);
    res.status(500).json({ error: 'Failed to create student' });
  }
});

// GET /api/edu/students/:id
router.get('/students/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const studentResult = await pool.query(
      'SELECT * FROM students WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    );
    if (studentResult.rowCount === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    const interventionsResult = await pool.query(
      `SELECT * FROM learning_interventions WHERE student_id = $1
       ORDER BY created_at DESC LIMIT 10`,
      [req.params.id]
    );
    res.json({ student: studentResult.rows[0], interventions: interventionsResult.rows });
  } catch (err: any) {
    console.error('[edu] GET /students/:id', err.message);
    res.status(500).json({ error: 'Failed to fetch student' });
  }
});

// PUT /api/edu/students/:id
router.put('/students/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const {
      classroom_id, first_name, last_name, grade_level, age,
      learning_style, primary_language, has_iep, iep_notes, strengths, challenge_areas
    } = req.body;

    const result = await pool.query(
      `UPDATE students SET
        classroom_id    = COALESCE($1,  classroom_id),
        first_name      = COALESCE($2,  first_name),
        last_name       = COALESCE($3,  last_name),
        grade_level     = COALESCE($4,  grade_level),
        age             = COALESCE($5,  age),
        learning_style  = COALESCE($6,  learning_style),
        primary_language= COALESCE($7,  primary_language),
        has_iep         = COALESCE($8,  has_iep),
        iep_notes       = COALESCE($9,  iep_notes),
        strengths       = COALESCE($10, strengths),
        challenge_areas = COALESCE($11, challenge_areas)
       WHERE id = $12 AND organization_id = $13
       RETURNING *`,
      [classroom_id, first_name, last_name, grade_level, age,
       learning_style, primary_language, has_iep, iep_notes, strengths, challenge_areas,
       req.params.id, orgId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    res.json({ student: result.rows[0] });
  } catch (err: any) {
    console.error('[edu] PUT /students/:id', err.message);
    res.status(500).json({ error: 'Failed to update student' });
  }
});

// GET /api/edu/students/:id/progress
router.get('/students/:id/progress', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const check = await pool.query(
      'SELECT id FROM students WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    );
    if (check.rowCount === 0) return res.status(404).json({ error: 'Student not found' });

    const result = await pool.query(
      `SELECT cp.*, ss.standard_code, ss.standard_description, ss.subject, ss.grade_band, ss.curriculum_framework
       FROM curriculum_progress cp
       JOIN state_standards ss ON ss.id = cp.standard_id
       WHERE cp.student_id = $1
       ORDER BY ss.subject, ss.grade_band`,
      [req.params.id]
    );

    const summary = {
      mastered:      result.rows.filter(r => r.status === 'mastered').length,
      in_progress:   result.rows.filter(r => r.status === 'in_progress').length,
      needs_review:  result.rows.filter(r => r.status === 'needs_review').length,
      not_started:   result.rows.filter(r => r.status === 'not_started').length,
    };

    res.json({ progress: result.rows, summary });
  } catch (err: any) {
    console.error('[edu] GET /students/:id/progress', err.message);
    res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

// POST /api/edu/students/:id/progress
router.post('/students/:id/progress', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const check = await pool.query(
      'SELECT id FROM students WHERE id = $1 AND organization_id = $2',
      [req.params.id, orgId]
    );
    if (check.rowCount === 0) return res.status(404).json({ error: 'Student not found' });

    const { standard_id, status, score, last_assessed, notes } = req.body;
    if (!standard_id || !status) {
      return res.status(400).json({ error: 'standard_id and status are required' });
    }

    const result = await pool.query(
      `INSERT INTO curriculum_progress (student_id, standard_id, status, score, last_assessed, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (student_id, standard_id) DO UPDATE
         SET status = EXCLUDED.status,
             score = EXCLUDED.score,
             last_assessed = EXCLUDED.last_assessed,
             notes = EXCLUDED.notes
       RETURNING *`,
      [req.params.id, standard_id, status, score || null, last_assessed || null, notes || null]
    );
    res.status(201).json({ progress: result.rows[0] });
  } catch (err: any) {
    console.error('[edu] POST /students/:id/progress', err.message);
    res.status(500).json({ error: 'Failed to update progress' });
  }
});

// ============================================================
// PROGRESS — ORG-WIDE
// ============================================================

// GET /api/edu/progress/all
router.get('/progress/all', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const { classroom_id, subject, status } = req.query;

    let query = `
      SELECT
        cp.id,
        cp.status,
        cp.score,
        cp.last_assessed,
        cp.notes,
        s.id           AS student_id,
        s.first_name,
        s.last_name,
        s.grade_level,
        COALESCE(s.has_iep, false) AS has_iep,
        ss.standard_code,
        ss.standard_description,
        ss.subject,
        ss.grade_band,
        ss.curriculum_framework
      FROM curriculum_progress cp
      JOIN students s  ON s.id  = cp.student_id
      JOIN state_standards ss ON ss.id = cp.standard_id
      WHERE s.organization_id = $1`;

    const params: unknown[] = [orgId];

    if (classroom_id) {
      params.push(classroom_id);
      query += ` AND s.classroom_id = $${params.length}`;
    }
    if (subject) {
      params.push(subject);
      query += ` AND ss.subject ILIKE $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND cp.status = $${params.length}`;
    }

    query += ' ORDER BY s.last_name, s.first_name, ss.subject, ss.standard_code';

    const result = await pool.query(query, params);

    const summary = {
      total:        result.rowCount ?? 0,
      mastered:     result.rows.filter(r => r.status === 'mastered').length,
      in_progress:  result.rows.filter(r => r.status === 'in_progress').length,
      needs_review: result.rows.filter(r => r.status === 'needs_review').length,
      not_started:  result.rows.filter(r => r.status === 'not_started').length,
    };

    res.json({ progress: result.rows, summary });
  } catch (err: any) {
    console.error('[edu] GET /progress/all', err.message);
    res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

// ============================================================
// STANDARDS
// ============================================================

// GET /api/edu/standards/states
router.get('/standards/states', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT state_code, curriculum_framework FROM state_standards ORDER BY state_code`
    );
    res.json({ states: result.rows });
  } catch (err: any) {
    console.error('[edu] GET /standards/states', err.message);
    res.status(500).json({ error: 'Failed to fetch states' });
  }
});

// GET /api/edu/standards
router.get('/standards', async (req: AuthRequest, res: Response) => {
  try {
    const { state, grade_band, subject, framework } = req.query;

    let query = 'SELECT * FROM state_standards WHERE 1=1';
    const params: any[] = [];

    if (state) {
      params.push((state as string).toUpperCase());
      query += ` AND state_code = $${params.length}`;
    }
    if (grade_band) {
      params.push(grade_band);
      query += ` AND grade_band = $${params.length}`;
    }
    if (subject) {
      params.push(subject);
      query += ` AND subject ILIKE $${params.length}`;
    }
    if (framework) {
      params.push(framework);
      query += ` AND curriculum_framework = $${params.length}`;
    }
    query += ' ORDER BY state_code, grade_band, subject, standard_code';
    query += ' LIMIT 200';

    const result = await pool.query(query, params);
    res.json({ standards: result.rows, count: result.rowCount });
  } catch (err: any) {
    console.error('[edu] GET /standards', err.message);
    res.status(500).json({ error: 'Failed to fetch standards' });
  }
});

// ============================================================
// INTERVENTIONS
// ============================================================

// GET /api/edu/interventions
router.get('/interventions', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const { student_id, status, priority } = req.query;

    let query = `
      SELECT li.*,
        li.student_id,
        COALESCE(s.first_name || ' ' || s.last_name, 'General') AS student_name,
        s.grade_level
      FROM learning_interventions li
      LEFT JOIN students s ON li.student_id = s.id
      WHERE li.organization_id = $1`;
    const params: any[] = [orgId];

    if (student_id) {
      params.push(student_id);
      query += ` AND li.student_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND li.status = $${params.length}`;
    }
    if (priority) {
      params.push(priority);
      query += ` AND li.priority = $${params.length}`;
    }
    query += ' ORDER BY li.created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err: any) {
    console.error('[edu] GET /interventions', err.message);
    res.status(500).json({ error: 'Failed to fetch interventions' });
  }
});

// POST /api/edu/interventions
router.post('/interventions', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const { student_id, intervention_type, subject, recommendation, priority, ei_core_generated } = req.body;

    if (!student_id || !intervention_type || !recommendation) {
      return res.status(400).json({ error: 'student_id, intervention_type, and recommendation are required' });
    }

    await assertStudentInOrg(student_id, orgId, pool);

    const result = await pool.query(
      `INSERT INTO learning_interventions
        (student_id, organization_id, intervention_type, subject, recommendation, priority, ei_core_generated)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [student_id, orgId, intervention_type, subject || null, recommendation,
       priority || 'medium', ei_core_generated || false]
    );
    res.status(201).json({ intervention: result.rows[0] });
  } catch (err: any) {
    if (isOrgAssertError(err)) return res.status(err.status).json({ error: err.message });
    console.error('[edu] POST /interventions', err.message);
    res.status(500).json({ error: 'Failed to create intervention' });
  }
});

// PATCH /api/edu/interventions/:id
router.patch('/interventions/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const { status, priority, recommendation } = req.body;

    const result = await pool.query(
      `UPDATE learning_interventions
       SET status         = COALESCE($1, status),
           priority       = COALESCE($2, priority),
           recommendation = COALESCE($3, recommendation)
       WHERE id = $4 AND organization_id = $5
       RETURNING *`,
      [status, priority, recommendation, req.params.id, orgId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Intervention not found' });
    }
    res.json({ intervention: result.rows[0] });
  } catch (err: any) {
    console.error('[edu] PATCH /interventions/:id', err.message);
    res.status(500).json({ error: 'Failed to update intervention' });
  }
});

// ============================================================
// HOMESCHOOL
// ============================================================

// GET /api/edu/homeschool/children
router.get('/homeschool/children', async (req: AuthRequest, res: Response) => {
  try {
    const { userId, orgId } = getUser(req);
    const result = await pool.query(
      `SELECT * FROM homeschool_children
       WHERE organization_id = $1 AND parent_user_id = $2
       ORDER BY last_name, first_name`,
      [orgId, userId]
    );
    res.json({ children: result.rows });
  } catch (err: any) {
    console.error('[edu] GET /homeschool/children', err.message);
    res.status(500).json({ error: 'Failed to fetch children' });
  }
});

// POST /api/edu/homeschool/children
router.post('/homeschool/children', async (req: AuthRequest, res: Response) => {
  try {
    const { userId, orgId } = getUser(req);
    const { first_name, last_name, grade_level, age, curriculum_type, learning_style, subjects_taught } = req.body;

    if (!first_name || !last_name || !grade_level || !curriculum_type) {
      return res.status(400).json({ error: 'first_name, last_name, grade_level, and curriculum_type are required' });
    }

    const result = await pool.query(
      `INSERT INTO homeschool_children
        (organization_id, parent_user_id, first_name, last_name, grade_level, age, curriculum_type, learning_style, subjects_taught)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [orgId, userId, first_name, last_name, grade_level, age || null,
       curriculum_type, learning_style || null, subjects_taught || []]
    );
    res.status(201).json({ child: result.rows[0] });
  } catch (err: any) {
    console.error('[edu] POST /homeschool/children', err.message);
    res.status(500).json({ error: 'Failed to add child' });
  }
});

// PUT /api/edu/homeschool/children/:id
router.put('/homeschool/children/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { userId, orgId } = getUser(req);
    const { first_name, last_name, grade_level, age, curriculum_type, learning_style, subjects_taught } = req.body;

    const result = await pool.query(
      `UPDATE homeschool_children SET
        first_name      = COALESCE($1, first_name),
        last_name       = COALESCE($2, last_name),
        grade_level     = COALESCE($3, grade_level),
        age             = COALESCE($4, age),
        curriculum_type = COALESCE($5, curriculum_type),
        learning_style  = COALESCE($6, learning_style),
        subjects_taught = COALESCE($7, subjects_taught)
       WHERE id = $8 AND organization_id = $9 AND parent_user_id = $10
       RETURNING *`,
      [first_name, last_name, grade_level, age, curriculum_type, learning_style, subjects_taught,
       req.params.id, orgId, userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Child not found' });
    }
    res.json({ child: result.rows[0] });
  } catch (err: any) {
    console.error('[edu] PUT /homeschool/children/:id', err.message);
    res.status(500).json({ error: 'Failed to update child' });
  }
});

// ============================================================
// EI-CORE EDUCATION AI
// ============================================================

// POST /api/edu/ai/student-insight
router.post('/ai/student-insight', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const { student_id } = req.body;

    if (!student_id) return res.status(400).json({ error: 'student_id is required' });

    const studentResult = await pool.query(
      'SELECT * FROM students WHERE id = $1 AND organization_id = $2',
      [student_id, orgId]
    );
    if (studentResult.rowCount === 0) return res.status(404).json({ error: 'Student not found' });

    const student = studentResult.rows[0];

    const progressResult = await pool.query(
      `SELECT cp.status, cp.score, ss.subject, ss.standard_code, ss.standard_description, ss.grade_band
       FROM curriculum_progress cp
       JOIN state_standards ss ON ss.id = cp.standard_id
       WHERE cp.student_id = $1`,
      [student_id]
    );

    const insight = await generateStudentInsight(student_id, student, progressResult.rows);
    res.json({ insight });
  } catch (err: any) {
    console.error('[edu] POST /ai/student-insight', err.message);
    res.status(500).json({ error: 'Failed to generate student insight' });
  }
});

// POST /api/edu/ai/class-insight
router.post('/ai/class-insight', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    let classroom_id: string = req.body.classroom_id || req.body.classroomId || req.query.classroom_id as string;

    // If no classroom_id provided, fall back to first classroom for the org
    if (!classroom_id) {
      const fallback = await pool.query(
        'SELECT id FROM classrooms WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1',
        [orgId]
      );
      if (fallback.rowCount === 0) {
        return res.json({ insight: {
          class_health_summary: 'No classrooms found for this organization.',
          at_risk_students: [], pacing_recommendations: [], differentiation_strategies: [],
        }});
      }
      classroom_id = fallback.rows[0].id;
    }

    const classroomResult = await pool.query(
      'SELECT * FROM classrooms WHERE id = $1 AND organization_id = $2',
      [classroom_id, orgId]
    );
    if (classroomResult.rowCount === 0) {
      return res.status(404).json({ error: 'Classroom not found in your organization' });
    }

    const studentsResult = await pool.query(
      `SELECT s.id, s.first_name, s.last_name, s.grade_level,
         COALESCE(s.has_iep, false)       AS has_iep,
         COALESCE(s.learning_style, null) AS learning_style,
         COUNT(cp.id) FILTER (WHERE cp.status = 'mastered')::int     AS mastered_count,
         COUNT(cp.id) FILTER (WHERE cp.status = 'needs_review')::int AS needs_review_count,
         COUNT(cp.id) FILTER (WHERE cp.status = 'in_progress')::int  AS in_progress_count
       FROM students s
       LEFT JOIN curriculum_progress cp ON cp.student_id = s.id
       WHERE s.classroom_id = $1
       GROUP BY s.id, s.first_name, s.last_name, s.grade_level, s.has_iep, s.learning_style`,
      [classroom_id]
    );

    const insight = await generateClassInsight(classroom_id, studentsResult.rows);
    res.json({ insight });
  } catch (err: any) {
    console.error('[edu] POST /ai/class-insight', err.message);
    res.status(500).json({ error: 'Failed to generate class insight' });
  }
});

// Realistic fallback curriculum recommendations by grade band + subject
function getCurriculumFallback(gradeLevel: string, subject: string, state: string | null) {
  const band = ['K','1','2'].includes(gradeLevel) ? 'K-2'
    : ['3','4','5'].includes(gradeLevel) ? '3-5'
    : ['6','7','8'].includes(gradeLevel) ? '6-8' : '9-12';

  const framework = state === 'TX' ? 'Texas TEKS' : state === 'FL' ? 'Florida NGSSS'
    : state === 'CA' ? 'California State Standards' : 'Common Core State Standards';

  const byBandSubject: Record<string, Record<string, string[]>> = {
    'K-2': {
      'ELA':  ['Use decodable readers aligned to phonics scope and sequence (e.g., Bob Books, Jolly Phonics)', 'Practice daily phonemic awareness with oral blending and segmenting activities', 'Introduce sight words using multisensory Orton-Gillingham techniques', 'Use shared reading with big books to build print concepts and fluency', 'Implement Writers Workshop with picture-supported sentence frames'],
      'Math': ['Use base-ten blocks and ten frames to build number sense to 100', 'Practice addition/subtraction with rekenreks and number bonds', 'Introduce measurement with non-standard units before rulers', 'Use pattern blocks for early geometry and spatial reasoning', 'Play math games like Snap and Tens Go Fish for fact fluency'],
    },
    '3-5': {
      'ELA':  ['Use close reading protocols with text-dependent questions (Notice and Note signposts)', 'Implement Reading Workshop with independent leveled texts at A-Z Reading level', 'Practice paragraph writing with the OREO or RACE writing frameworks', 'Use Socratic Seminar for discussion of literary themes', 'Integrate vocabulary instruction with Frayer Models and word walls'],
      'Math': ['Use area models and arrays to develop multiplication conceptual understanding', 'Introduce fractions with fraction tiles and number lines (not just pie charts)', 'Practice multi-digit operations with partial products and partial quotients', 'Use real-world data for graphing and statistics units', 'Implement Estimation 180 for daily number sense warm-ups'],
      'Science': ['Use 5E inquiry model (Engage, Explore, Explain, Elaborate, Evaluate)', 'Integrate STEM challenges for engineering design process', 'Use science notebooks for recording observations and claims-evidence-reasoning'],
    },
    '6-8': {
      'ELA':    ['Use SOAPSTone annotation strategy for informational and literary texts', 'Teach argument writing with Toulmin model (claim, warrant, evidence, rebuttal)', 'Implement literature circles with assigned discussion roles', 'Use mentor texts for craft and structure in narrative writing', 'Practice textual evidence citation with PEEL paragraph structure'],
      'Math':   ['Use Desmos activities for visual exploration of proportional relationships', 'Implement number talks to build algebraic reasoning and mental math', 'Use algebra tiles for modeling expressions and solving equations', 'Connect geometry to coordinate plane with real-world mapping tasks', 'Use Khan Academy targeted exercises for gaps in rational number operations'],
      'Science': ['Implement CER (Claim-Evidence-Reasoning) for lab reports', 'Use PhET simulations for physics and chemistry concepts', 'Integrate NGSS crosscutting concepts across all units'],
    },
    '9-12': {
      'ELA':    ['Use Socratic Seminar and Philosophical Chairs for complex literary analysis', 'Teach research paper writing with MLA/APA and source credibility evaluation', 'Incorporate independent reading with student-choice novels', 'Use AP Language rhetorical analysis frameworks for non-fiction texts', 'Integrate college essay writing and personal narrative craft'],
      'Math':   ['Use Desmos graphing calculator for function analysis and transformations', 'Implement collaborative problem-solving with rich mathematical tasks (NCTM Illuminations)', 'Connect statistics to real data sets (Census Bureau, sports analytics)', 'Use Khan Academy for differentiated algebra and geometry review', 'Integrate college readiness benchmarks with ACT/SAT prep problems'],
      'Science': ['Use peer-reviewed article analysis for scientific literacy', 'Implement formal lab design with independent/dependent variable identification', 'Connect content to current events and environmental applications'],
    },
  };

  const recs = byBandSubject[band]?.[subject] ?? byBandSubject[band]?.['ELA'] ?? [
    `Use differentiated instructional materials appropriate for grade ${gradeLevel} ${subject}`,
    'Implement formative assessment checkpoints every 2-3 lessons',
    'Provide scaffolded graphic organizers for note-taking and comprehension',
    'Use spaced repetition review for previously taught standards',
    'Incorporate student choice in demonstrating mastery',
  ];

  return {
    framework,
    grade_band: band,
    recommendations: recs,
    resources: ['Khan Academy', 'Desmos', 'CommonLit', 'ReadWorks', 'IXL', 'Teachers Pay Teachers'],
    alignment_notes: `Recommendations aligned to ${framework} for grade ${gradeLevel} ${subject}. Generated using built-in curriculum library.`,
  };
}

function getResourceFallback(resourceName: string, gradeLevel: string, subject: string): string {
  const name = resourceName.toLowerCase();
  if (name.includes('rubric')) {
    return `# ${resourceName} — Grade ${gradeLevel} ${subject}

## Criteria

| Criteria | Excellent (4) | Proficient (3) | Developing (2) | Beginning (1) |
|---|---|---|---|---|
| Content Understanding | Demonstrates deep understanding of all key concepts | Understands most key concepts accurately | Shows partial understanding with some errors | Limited understanding of key concepts |
| Application | Applies concepts independently in novel situations | Applies concepts with minimal guidance | Applies concepts with support | Requires significant guidance |
| Communication | Communicates ideas clearly and precisely | Communicates ideas adequately | Communication is unclear in places | Communication is unclear |
| Completion | All components completed thoroughly | Most components completed | Some components completed | Few components completed |

## Scoring Guide
- 13–16: Excellent
- 9–12: Proficient
- 5–8: Developing
- 1–4: Beginning

## Implementation Steps
1. Share rubric with students before the assignment begins
2. Allow students to self-assess using the rubric
3. Use rubric during grading for consistency
4. Return rubric with feedback to students`;
  }

  if (name.includes('project') || name.includes('planning')) {
    return `# ${resourceName} — Grade ${gradeLevel} ${subject}

## Project Overview
**Title:** ___________________________
**Subject:** ${subject}  **Grade:** ${gradeLevel}
**Duration:** ___ days/weeks
**Essential Question:** ___________________________

## Learning Objectives
- Students will be able to: ___________________________
- Students will understand: ___________________________
- Students will demonstrate: ___________________________

## Project Phases

### Phase 1: Launch (Day 1–2)
- [ ] Introduce essential question
- [ ] Build background knowledge
- [ ] Form student groups

### Phase 2: Research & Planning (Day 3–5)
- [ ] Students develop inquiry questions
- [ ] Gather resources and evidence
- [ ] Create project plan/timeline

### Phase 3: Creation (Day 6–10)
- [ ] Students build/create product
- [ ] Checkpoints with teacher feedback
- [ ] Peer review session

### Phase 4: Presentation & Reflection (Day 11–12)
- [ ] Present to audience
- [ ] Peer and self-assessment
- [ ] Reflection and celebration

## Materials Needed
- ___________________________

## Implementation Steps
1. Introduce the project 2–3 days before students begin
2. Model each phase with an example
3. Conduct daily 5-minute check-ins with groups
4. Collect evidence of learning at each phase`;
  }

  if (name.includes('tracking') || name.includes('sheet')) {
    return `# ${resourceName} — Grade ${gradeLevel} ${subject}

## Student Progress Tracker

| Student Name | Standard/Skill | Pre-Assessment | Formative 1 | Formative 2 | Post-Assessment | Notes |
|---|---|---|---|---|---|---|
| | | | | | | |
| | | | | | | |
| | | | | | | |

## Key
- **M** = Mastery (80%+)
- **P** = Proficient (60–79%)
- **D** = Developing (40–59%)
- **B** = Beginning (<40%)

## Intervention Groups (update weekly)
| Group | Students | Focus Skill | Strategy |
|---|---|---|---|
| Enrichment | | | |
| On Track | | | |
| Support | | | |

## Implementation Steps
1. Record student names at the start of the unit
2. Enter pre-assessment scores before instruction begins
3. Update formative data after each major lesson
4. Use data to form flexible groups for the following week`;
  }

  // Generic fallback
  return `# ${resourceName} — Grade ${gradeLevel} ${subject}

## Overview
This resource is designed for Grade ${gradeLevel} ${subject} students.

## Purpose
Provide teachers with a structured tool to support student learning aligned to grade-level standards.

## Components

### Section 1: Introduction
- Introduce key vocabulary and concepts
- Connect to prior knowledge
- State learning objectives clearly

### Section 2: Core Content
- Main instructional content aligned to ${subject} standards
- Examples and practice opportunities
- Scaffolded support for diverse learners

### Section 3: Application
- Independent practice activities
- Real-world connections
- Extension tasks for advanced learners

### Section 4: Assessment
- Formative check-in questions
- Success criteria for students
- Teacher observation notes

## Implementation Steps
1. Review the resource and gather any additional materials needed
2. Introduce the resource to students with clear expectations
3. Model the first section together as a class
4. Allow independent or group work with teacher support
5. Collect and review student work to inform next steps`;
}

// POST /api/edu/ai/curriculum-advisor
router.post('/ai/curriculum-advisor', async (req: AuthRequest, res: Response) => {
  const { mode, grade_level, state, subject, learning_style, gaps, resource_name } = req.body;

  // Default gracefully — never require grade_level/subject to be present
  const gl      = grade_level || 'K';
  const subj    = subject     || 'ELA';
  const st      = state       || null;

  // ── generate_resource mode ─────────────────────────────────────
  if (mode === 'generate_resource') {
    const rn = resource_name || 'Resource';
    const ls = learning_style || 'general';

    try {
      const TIMEOUT_MS = 25_000;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)
      );

      const prompt = `Generate a complete, usable ${rn} for Grade ${gl} ${subj} students with ${ls} learning style. Include specific content, examples, and implementation steps a teacher can use immediately.`;

      // Re-use generateCurriculumRecommendation with a prompt-bearing gap entry
      const result = await Promise.race([
        generateCurriculumRecommendation(gl, st, subj, ls, [prompt]),
        timeoutPromise,
      ]);

      // Synthesise a readable content string from the structured result
      const content = [
        `# ${rn} — Grade ${gl} ${subj}`,
        '',
        `**Learning Style:** ${ls}`,
        '',
        '## Recommendations',
        ...result.recommendations.map((r: string) => `- ${r}`),
        '',
        '## Resources',
        ...result.resources.map((r: string) => `- ${r}`),
        '',
        `## Alignment Notes`,
        result.alignment_notes,
      ].join('\n');

      return res.json({ resource_name: rn, content, grade_level: gl, subject: subj });
    } catch (err: any) {
      const reason = err?.message === 'timeout' ? 'AI timeout' : 'AI unavailable';
      console.warn(`[edu] POST /ai/curriculum-advisor generate_resource — ${reason}, returning fallback`);
      return res.json({
        resource_name: rn,
        content: getResourceFallback(rn, gl, subj),
        grade_level: gl,
        subject: subj,
        fallback: true,
      });
    }
  }

  // ── default: curriculum recommendation mode ────────────────────
  try {
    const TIMEOUT_MS = 20_000;
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)
    );

    const recommendation = await Promise.race([
      generateCurriculumRecommendation(gl, st, subj, learning_style || null, gaps || []),
      timeoutPromise,
    ]);

    res.json({ recommendation });
  } catch (err: any) {
    const reason = err?.message === 'timeout' ? 'AI timeout' : 'AI unavailable';
    console.warn(`[edu] POST /ai/curriculum-advisor — ${reason}, returning fallback`);
    res.json({ recommendation: getCurriculumFallback(gl, subj, st), fallback: true });
  }
});

// ============================================================
// ASSIGNMENT GENERATOR
// ============================================================

function getGradeBand(gradeLevel: string): 'K-2' | '3-5' | '6-8' | '9-12' {
  if (gradeLevel === 'K' || gradeLevel === '1' || gradeLevel === '2') return 'K-2';
  if (['3', '4', '5'].includes(gradeLevel)) return '3-5';
  if (['6', '7', '8'].includes(gradeLevel)) return '6-8';
  return '9-12';
}

function getStateFramework(state: string): 'TEKS' | 'NGSS' | 'CCSS' {
  if (state === 'TX') return 'TEKS';
  const ngssStates = ['CA', 'NY', 'IL', 'WA', 'OR', 'MA', 'MD', 'NJ', 'RI', 'VT', 'NH', 'ME', 'CT', 'HI', 'DC'];
  if (ngssStates.includes(state)) return 'NGSS';
  return 'CCSS';
}

function buildStandardCode(gradeLevel: string, state: string, subject: string, gradeBand: string): string {
  const framework = getStateFramework(state);
  const g = gradeLevel;

  if (framework === 'TEKS') {
    const teksMap: Record<string, Record<string, string>> = {
      'K-2':  { 'Math': `TEKS.Math.${g}.2(A)`,  'ELA': `TEKS.ELA.${g}.1(A)`,  'Science': `TEKS.Sci.${g}.1(A)`,  'Social Studies': `TEKS.SS.${g}.1(A)`  },
      '3-5':  { 'Math': `TEKS.Math.${g}.4(A)`,  'ELA': `TEKS.ELA.${g}.6(A)`,  'Science': `TEKS.Sci.${g}.5(A)`,  'Social Studies': `TEKS.SS.${g}.2(A)`  },
      '6-8':  { 'Math': `TEKS.Math.${g}.7(A)`,  'ELA': `TEKS.ELA.${g}.6(G)`,  'Science': `TEKS.Sci.${g}.8(A)`,  'Social Studies': `TEKS.SS.${g}.9(A)`  },
      '9-12': { 'Math': `TEKS.Alg1.7(A)`,        'ELA': `TEKS.ELA1.6(E)`,      'Science': `TEKS.Bio.7(A)`,        'Social Studies': `TEKS.USH.29(A)`     },
    };
    return teksMap[gradeBand]?.[subject] ?? `TEKS.${subject.substring(0, 3)}.${g}.1(A)`;
  }

  const ccssMap: Record<string, Record<string, string>> = {
    'K-2':  { 'Math': `CCSS.MATH.CONTENT.${g}.OA.A.1`, 'ELA': `CCSS.ELA-LITERACY.RF.${g}.1`,    'Science': `NGSS.${g}-LS1-1`,  'Social Studies': `C3.D2.His.1.K-2`  },
    '3-5':  { 'Math': `CCSS.MATH.CONTENT.${g}.NBT.A.1`,'ELA': `CCSS.ELA-LITERACY.RI.${g}.1`,    'Science': `NGSS.${g}-LS1-1`,  'Social Studies': `C3.D2.His.2.3-5`  },
    '6-8':  { 'Math': `CCSS.MATH.CONTENT.${g}.EE.A.1`, 'ELA': `CCSS.ELA-LITERACY.RH.6-8.1`,    'Science': `NGSS.MS-LS1-1`,    'Social Studies': `C3.D2.His.1.6-8`  },
    '9-12': { 'Math': `CCSS.MATH.CONTENT.HSA.REI.A.1`, 'ELA': `CCSS.ELA-LITERACY.RH.9-10.1`,   'Science': `NGSS.HS-LS1-1`,    'Social Studies': `C3.D2.His.1.9-12` },
  };
  return ccssMap[gradeBand]?.[subject] ?? `CCSS.${subject.substring(0, 3)}.${g}.1`;
}

function buildStandardDescription(subject: string, gradeBand: string): string {
  const descriptions: Record<string, Record<string, string>> = {
    'K-2': {
      'Math':           'Understand the relationship between numbers and quantities. Connect counting to cardinality and solve addition and subtraction problems within 20.',
      'ELA':            'Demonstrate understanding of spoken words, syllables, and sounds (phonemes). Identify and produce rhyming words and recognize print concepts.',
      'Science':        'Use observations to describe patterns of what plants and animals (including humans) need to survive.',
      'Social Studies': 'Identify and describe the roles of community helpers and explain how people in communities work together.',
    },
    '3-5': {
      'Math':           'Use place value understanding and properties of operations to perform multi-digit arithmetic. Develop fraction concepts.',
      'ELA':            'Refer to details and examples in a text when explaining what the text says explicitly and when drawing inferences.',
      'Science':        'Analyze and interpret data to provide evidence that plants and animals have traits inherited from parents and that variation of traits exists.',
      'Social Studies': 'Explain connections among historical events using primary and secondary sources.',
    },
    '6-8': {
      'Math':           'Apply and extend previous understandings of operations with fractions to add, subtract, multiply, and divide rational numbers.',
      'ELA':            'Cite several pieces of textual evidence to support analysis of what the text says explicitly as well as inferences drawn from the text.',
      'Science':        'Analyze and interpret data on the properties of substances before and after the substances interact to determine if a chemical reaction has occurred.',
      'Social Studies': 'Construct arguments using claims and relevant evidence from multiple sources.',
    },
    '9-12': {
      'Math':           'Explain each step in solving a simple equation as following from the equality of numbers asserted at the previous step.',
      'ELA':            'Cite strong and thorough textual evidence to support analysis of what the text says explicitly as well as inferences drawn from the text.',
      'Science':        'Construct and revise an explanation based on valid and reliable evidence obtained from a variety of sources.',
      'Social Studies': 'Evaluate the credibility, accuracy, and relevance of each source; find corroborating evidence across sources.',
    },
  };
  return descriptions[gradeBand]?.[subject]
    ?? `Students will demonstrate understanding of grade-level concepts through appropriate tasks and assessments.`;
}

interface AssignmentSection {
  type: 'introduction' | 'content' | 'activity' | 'discussion' | 'closing';
  title: string;
  content: string;
  activity_type: 'cards_3col' | 'compare_contrast' | 'sort' | 'fill_in' | 'narration' | 'discussion';
  items: any[];
}

interface GeneratedAssignment {
  title: string;
  theme: string;
  grade_band: string;
  standard_code: string;
  standard_description: string;
  i_can_statement: string;
  estimated_duration: string;
  materials_needed: string[];
  sections: AssignmentSection[];
  differentiation: { visual: string; auditory: string; kinesthetic: string };
  rubric: { distinguished: string; proficient: string; apprentice: string; novice: string };
  teacher_notes: string;
  bridge_to_next: string;
}

function buildAssignmentMock(params: {
  grade_level: string;
  state: string;
  subject: string;
  learning_style: string;
  curriculum_type: string;
  standard_code?: string;
  topic?: string;
}): GeneratedAssignment {
  const { grade_level, state, subject, curriculum_type, topic } = params;
  const gradeBand = getGradeBand(grade_level);
  const standardCode = params.standard_code || buildStandardCode(grade_level, state, subject, gradeBand);
  const standardDesc = buildStandardDescription(subject, gradeBand);
  const t = topic || subject;
  const isCM        = curriculum_type === 'charlotte_mason';
  const isClassical = curriculum_type === 'classical';
  const isTraditional = curriculum_type === 'traditional';

  // ── K-2 Mission Theme ─────────────────────────────────────
  if (gradeBand === 'K-2') {
    const missionNames: Record<string, string> = {
      'Math':           topic ? `${topic} Explorers`   : 'Number Hunters',
      'ELA':            topic ? `${topic} Detectives`  : 'Word Detectives',
      'Science':        topic ? `${topic} Scientists`  : 'Little Scientists',
      'Social Studies': topic ? `${topic} Adventurers` : 'Community Explorers',
    };
    const theme = missionNames[subject] || `${t} Adventurers`;
    const title = `Mission: ${theme}`;

    const kineticCards: Record<string, { card: string; question: string }[]> = {
      'Math': [
        { card: 'Clap It!',  question: 'Clap once for each number you count. How many claps?' },
        { card: 'Find It!',  question: 'Find something in the room shaped like a circle. Show your teacher!' },
        { card: 'Show Me!',  question: 'Use your fingers to show the number 5. Now show 7!' },
      ],
      'ELA': [
        { card: 'Say It!',   question: 'Say the word slowly. How many sounds do you hear?' },
        { card: 'Find It!',  question: 'Find a letter from our word on the word wall. Point to it!' },
        { card: 'Act It!',   question: 'Act out what this word means without talking!' },
      ],
      'Science': [
        { card: 'Touch It!', question: 'Touch something in the room that is a solid. What does it feel like?' },
        { card: 'Show Me!',  question: 'Act out how a plant grows from a tiny seed.' },
        { card: 'Find It!',  question: 'Find something living in our classroom. Point to it!' },
      ],
      'Social Studies': [
        { card: 'Act It!',   question: 'Act out what a community helper does. Can your friends guess?' },
        { card: 'Show Me!',  question: 'Show how you would help a neighbor or friend.' },
        { card: 'Find It!',  question: 'Find something in the room we all share.' },
      ],
    };
    const actItems = kineticCards[subject] || [
      { card: 'Try It!',  question: `Show what you know about ${t}!` },
      { card: 'Find It!', question: `Find an example of ${t} around you.` },
      { card: 'Act It!',  question: `Act out something you learned about ${t}.` },
    ];

    const sections: AssignmentSection[] = [
      {
        type: 'introduction',
        title: '🚀 Mission Briefing',
        content: isCM
          ? `Share a short living story or picture book connected to ${t}. Invite narration: "Tell me what you notice."`
          : `Welcome, ${theme}! Today we are going on a special mission to learn about ${t}. Are you ready?`,
        activity_type: 'cards_3col',
        items: [
          { card: 'What do you know?',   question: `What do you already know about ${t}?` },
          { card: 'What do you see?',    question: 'Look at the picture. What do you notice?' },
          { card: 'What do you wonder?', question: `What question do you have about ${t}?` },
        ],
      },
      {
        type: 'content',
        title: '🔍 Mission Clues',
        content: isCM
          ? `Read aloud from a living book about ${t}. Pause and invite children to narrate back what they heard in their own words.`
          : `Let's discover 3 important things about ${t} today!`,
        activity_type: 'cards_3col',
        items: [
          { card: 'Clue 1', question: `What is ${t}? Can you say it in your own words?` },
          { card: 'Clue 2', question: `Where do we find ${t} in real life?` },
          { card: 'Clue 3', question: `Why is ${t} important?` },
        ],
      },
      {
        type: 'activity',
        title: '⚡ Mission Challenge',
        content: isCM
          ? `Invite each child to narrate today's story in their own words — verbal, drawn, or acted responses are all welcome.`
          : `Time for your mission challenge! Use your body to show what you know.`,
        activity_type: 'cards_3col',
        items: actItems,
      },
      {
        type: 'closing',
        title: '🎉 Mission Complete!',
        content: `Amazing work, agents! You completed your mission. Let's celebrate what we learned!`,
        activity_type: 'cards_3col',
        items: [
          { card: 'I learned...',  question: `Tell a friend one thing you learned about ${t}.` },
          { card: 'I can...',      question: `What can you do now that you know about ${t}?` },
          { card: 'Next time...', question: `What do you want to learn more about?` },
        ],
      },
    ];

    return {
      title,
      theme,
      grade_band: gradeBand,
      standard_code: standardCode,
      standard_description: standardDesc,
      i_can_statement: `I can explore and share what I know about ${t}!`,
      estimated_duration: '15–20 minutes',
      materials_needed: ['Pencils or crayons', 'Activity cards (printed or displayed)', 'Picture books or visuals about the topic', 'Open movement space'],
      sections,
      differentiation: {
        visual:      `Provide picture cards and illustrated vocabulary supports. Use a visual schedule for each mission step.`,
        auditory:    `Read each mission clue aloud. Use call-and-response chants or songs related to ${t}.`,
        kinesthetic: `Allow students to clap, jump, or use manipulatives. Accept acted responses instead of written ones.`,
      },
      rubric: {
        distinguished: `Student explains ${t} in their own words and gives a real-world example without prompting.`,
        proficient:    `Student answers all 3 mission clue questions with minimal support.`,
        apprentice:    `Student answers 1–2 questions with teacher prompting.`,
        novice:        `Student is beginning to engage with ${t} concepts with significant support.`,
      },
      teacher_notes: isCM
        ? `Charlotte Mason: Emphasize narration over worksheets. Accept oral, drawn, or acted responses as valid mastery evidence. Focus on wonder and observation.`
        : `Keep pace lively — K-2 learners need movement every 5–7 minutes. Use mission language (agents, clues, mission) throughout. Accept verbal responses as valid assessment.`,
      bridge_to_next: `Next mission we will build on what we learned about ${t} and go even deeper!`,
    };
  }

  // ── 3-5 Standard Format ───────────────────────────────────
  if (gradeBand === '3-5') {
    const compareItems: Record<string, object[]> = {
      'Social Studies': topic
        ? [{ left_label: topic, right_label: 'Other Examples', left: ['Key leader or idea', 'Primary source evidence', 'Historical impact'], right: ['Compare to another leader or event', 'Different perspective', 'Different outcome'] }]
        : [{ left_label: 'Then', right_label: 'Now', left: ['How it worked before', 'Who was involved', 'Challenges faced'], right: ['How it works today', 'Who is involved now', 'How challenges were addressed'] }],
      'Math':    [{ left_label: 'Method A', right_label: 'Method B', left: ['Step 1', 'Step 2', 'When to use it'], right: ['Step 1', 'Step 2', 'When to use it'] }],
      'ELA':     [{ left_label: 'Text A', right_label: 'Text B', left: ['Setting or context', 'Key actions', 'Central message'], right: ['Setting or context', 'Key actions', 'Central message'] }],
      'Science': [{ left_label: 'Before', right_label: 'After', left: ['Observation', 'Characteristics', 'Evidence'], right: ['Observation', 'Characteristics', 'Evidence'] }],
    };

    const sortItems = [
      { label: `True about ${t}`,     items: ['Statement A', 'Statement B', 'Statement C'] },
      { label: `Not true about ${t}`, items: ['Misconception A', 'Misconception B'] },
      { label: 'Not sure',            items: [] },
    ];

    const sections: AssignmentSection[] = [
      {
        type: 'introduction',
        title: isClassical ? `Grammar Stage Review: ${t}` : `Connecting to Prior Knowledge`,
        content: isClassical
          ? `Begin with oral recitation. Students recite key facts or a timeline related to ${t}. Teacher leads call-and-response review.`
          : isCM
          ? `Read a short passage from a living book aloud. Students narrate what they heard before moving to the lesson.`
          : `Today we will explore ${t}. Think about what you already know. Connect new learning to what we have studied before.`,
        activity_type: 'fill_in',
        items: [
          { prompt: `I already know that ${t} is...`, answer: '' },
          { prompt: `One question I have about ${t} is...`, answer: '' },
          { prompt: `I think ${t} connects to... because...`, answer: '' },
        ],
      },
      {
        type: 'content',
        title: `Exploring ${t}`,
        content: `Let's examine two key perspectives or examples related to ${t}. Use your notes and sources to complete the comparison.`,
        activity_type: 'compare_contrast',
        items: compareItems[subject] || compareItems['ELA'],
      },
      {
        type: 'activity',
        title: isTraditional ? `Practice: Sort and Classify` : `Interactive Sort`,
        content: isTraditional
          ? `Sort each statement into the correct category. Use your notes to help you decide.`
          : `Work with a partner to sort these statements. Be ready to explain your reasoning.`,
        activity_type: 'sort',
        items: sortItems,
      },
      {
        type: 'discussion',
        title: `Discussion: What Do You Think?`,
        content: ``,
        activity_type: 'discussion',
        items: [
          { question: `Based on what you learned, what is the most important idea about ${t}? Use at least one detail from today's lesson to support your thinking.` },
        ],
      },
    ];

    return {
      title: `${standardCode}: ${t}`,
      theme: isClassical ? `Grammar Stage — ${t}` : `Exploring ${t}`,
      grade_band: gradeBand,
      standard_code: standardCode,
      standard_description: standardDesc,
      i_can_statement: `I can explain key ideas about ${t} and support my thinking with evidence.`,
      estimated_duration: '45–60 minutes',
      materials_needed: ['Textbook or primary source documents', 'Graphic organizer (printed or digital)', 'Pencil or pen', 'Student notes from previous lessons'],
      sections,
      differentiation: {
        visual:      `Provide graphic organizers with visual cues. Use maps, timelines, or illustrated vocabulary cards.`,
        auditory:    `Read content sections aloud. Use partner discussion before written responses. Allow oral answers.`,
        kinesthetic: `Use physical card sorts. Allow students to stand and share answers. Act out sequences or processes.`,
      },
      rubric: {
        distinguished: `Student demonstrates thorough understanding of ${t}, provides multiple evidence-based examples, and connects to broader themes independently.`,
        proficient:    `Student explains ${t} accurately with at least one example and completes all activity sections.`,
        apprentice:    `Student shows partial understanding with some evidence. Completes most sections with prompting.`,
        novice:        `Student demonstrates limited understanding and requires significant teacher support.`,
      },
      teacher_notes: isCM
        ? `Charlotte Mason: Replace fill-in activities with oral narration. Accept illustrated narration maps. No grades — use observation notes for assessment.`
        : isClassical
        ? `Classical/Grammar Stage: Emphasize memorization and recitation of key facts. Use choral response and call-and-answer for key terms.`
        : `Check for understanding after the compare/contrast section before moving to the sort. Group students who need support for the discussion.`,
      bridge_to_next: `In our next lesson, we will build on ${t} by examining how it connects to the next topic in the sequence. Students should review their notes from today.`,
    };
  }

  // ── 6-8 Logic and Argumentation ───────────────────────────
  if (gradeBand === '6-8') {
    const sections: AssignmentSection[] = [
      {
        type: 'introduction',
        title: `Warm-Up: Activate Prior Knowledge`,
        content: isCM
          ? `Read aloud a primary source excerpt related to ${t}. Students narrate in writing what they observed.`
          : `Complete the CER starter below to activate your prior knowledge about ${t}.`,
        activity_type: 'fill_in',
        items: [
          { prompt: `My initial claim about ${t} is...`, answer: '' },
          { prompt: `Evidence I can recall:`, answer: '' },
          { prompt: `This matters because...`, answer: '' },
        ],
      },
      {
        type: 'content',
        title: `Primary Source Analysis: ${t}`,
        content: `Analyze the source using the SOAPS method (Source, Occasion, Audience, Purpose, Subject).`,
        activity_type: 'fill_in',
        items: [
          { prompt: 'Source (Who created this?)', answer: '' },
          { prompt: 'Occasion (When/why was it created?)', answer: '' },
          { prompt: 'Audience (Who was it written for?)', answer: '' },
          { prompt: 'Purpose (What was the creator trying to accomplish?)', answer: '' },
          { prompt: 'Subject (What is the main topic?)', answer: '' },
        ],
      },
      {
        type: 'activity',
        title: `Building Your Argument: ${t}`,
        content: `Use the outline below to structure a claim-evidence-reasoning response about ${t}.`,
        activity_type: 'fill_in',
        items: [
          { prompt: `Claim: My argument about ${t} is...`, answer: '' },
          { prompt: 'Evidence 1 (cite your source):', answer: '' },
          { prompt: 'Reasoning: This evidence supports my claim because...', answer: '' },
          { prompt: 'Evidence 2 (from a different source):', answer: '' },
          { prompt: 'Reasoning: This further demonstrates that...', answer: '' },
          { prompt: `Conclusion: Therefore, ${t}...`, answer: '' },
        ],
      },
      {
        type: 'discussion',
        title: `Socratic Discussion`,
        content: ``,
        activity_type: 'discussion',
        items: [
          { question: `Essential Question: To what extent does ${t} still influence our world today? Use at least two pieces of evidence.` },
          { question: `Counter-argument: What would someone who disagrees argue? How would you respond?` },
        ],
      },
    ];

    return {
      title: `${t}: Claim, Evidence, and Reasoning`,
      theme: `Argumentation and Analysis: ${t}`,
      grade_band: gradeBand,
      standard_code: standardCode,
      standard_description: standardDesc,
      i_can_statement: `I can construct a claim about ${t} and support it with evidence from multiple sources.`,
      estimated_duration: '60–90 minutes',
      materials_needed: ['Primary source document (provided by teacher)', 'CER graphic organizer', 'Class notes', 'Colored pens for annotation'],
      sections,
      differentiation: {
        visual:      `Provide annotated source images, graphic organizers with sentence frames, and color-coded CER templates.`,
        auditory:    `Allow oral discussion of claims before writing. Use partner debate format for the Socratic question.`,
        kinesthetic: `Fishbowl discussion format. Students physically move to agree/disagree stations based on claims.`,
      },
      rubric: {
        distinguished: `Constructs a clear, specific claim supported by two or more pieces of cited evidence. Reasoning explicitly connects evidence to claim. Acknowledges counter-argument.`,
        proficient:    `States a claim with at least one piece of cited evidence and clear reasoning.`,
        apprentice:    `States a claim but evidence is vague or not cited. Reasoning is partially developed.`,
        novice:        `Claim is unclear or missing. Little to no evidence. Reasoning not present.`,
      },
      teacher_notes: isClassical
        ? `Classical/Logic Stage: Well-suited to formal debate format. Assign devil's advocate roles to develop dialectical thinking.`
        : `Pre-select primary sources appropriate to your students' reading level. Consider chunking source analysis into pairs before whole-class discussion.`,
      bridge_to_next: `Next class we will examine how the arguments we built about ${t} connect to broader historical or thematic patterns. Students should be prepared to defend their claims.`,
    };
  }

  // ── 9-12 Extended Response ────────────────────────────────
  const sections: AssignmentSection[] = [
    {
      type: 'introduction',
      title: `Context and Background: ${t}`,
      content: isCM
        ? `Students read a selection from a primary source or living text independently. Narrate in writing before constructing the thesis.`
        : `Before constructing your argument, establish the historical or conceptual context for ${t}. Use your prior knowledge and provided sources.`,
      activity_type: 'fill_in',
      items: [
        { prompt: `Historical/contextual background of ${t}:`, answer: '' },
        { prompt: `The central debate or tension related to ${t} is...`, answer: '' },
        { prompt: `My preliminary thesis is...`, answer: '' },
      ],
    },
    {
      type: 'content',
      title: `Evidence-Based Thesis Development`,
      content: `A strong thesis makes a specific, defensible claim and previews the evidence you will use.`,
      activity_type: 'fill_in',
      items: [
        { prompt: 'Thesis (specific claim + evidence preview):', answer: '' },
        { prompt: 'Body ¶1 — Evidence A (source + citation):', answer: '' },
        { prompt: 'Analysis: How does this evidence support your thesis?', answer: '' },
        { prompt: 'Body ¶2 — Evidence B (source + citation):', answer: '' },
        { prompt: 'Analysis: How does this further develop your argument?', answer: '' },
        { prompt: 'Body ¶3 — Evidence C (source + citation):', answer: '' },
        { prompt: 'Analysis: How does this strengthen your overall argument?', answer: '' },
      ],
    },
    {
      type: 'activity',
      title: `Counter-Argument and Rebuttal`,
      content: `A sophisticated argument acknowledges and responds to opposing viewpoints.`,
      activity_type: 'fill_in',
      items: [
        { prompt: `The strongest counter-argument to my thesis is...`, answer: '' },
        { prompt: `This counter-argument fails because...`, answer: '' },
        { prompt: `Additional evidence that supports my position over the counter-argument:`, answer: '' },
      ],
    },
    {
      type: 'discussion',
      title: `Socratic Seminar / Extended Response Prompt`,
      content: ``,
      activity_type: 'discussion',
      items: [
        { question: `Extended Response: Using at least three pieces of evidence from your sources, construct a well-developed argument about ${t}. Include a thesis, body paragraphs with cited evidence and analysis, a counter-argument with rebuttal, and a conclusion that returns to the significance of your claim.` },
      ],
    },
  ];

  return {
    title: `Extended Analysis: ${t}`,
    theme: `Evidence-Based Argumentation: ${t}`,
    grade_band: gradeBand,
    standard_code: standardCode,
    standard_description: standardDesc,
    i_can_statement: `I can construct and defend a thesis about ${t} using multiple primary and secondary sources.`,
    estimated_duration: '90–120 minutes',
    materials_needed: ['Primary and secondary source packet', 'Thesis outline graphic organizer', 'Student notes and prior knowledge', 'Writing materials or word processor'],
    sections,
    differentiation: {
      visual:      `Provide thesis template with visual structure map. Color-code claim, evidence, and reasoning components.`,
      auditory:    `Allow students to verbally rehearse their thesis before writing. Use Socratic Seminar as the primary assessment mode.`,
      kinesthetic: `Structured Academic Controversy format — students physically move and debate positions before writing.`,
    },
    rubric: {
      distinguished: `Thesis is specific, sophisticated, and fully defensible. Three or more pieces of cited evidence with thorough analysis. Counter-argument acknowledged and effectively rebutted. Writing is polished.`,
      proficient:    `Thesis is clear and defensible. At least two pieces of cited evidence with analysis. Counter-argument addressed. Writing is organized.`,
      apprentice:    `Thesis present but vague. Evidence provided but analysis is underdeveloped. Counter-argument mentioned but not addressed effectively.`,
      novice:        `Thesis missing or unclear. Little to no cited evidence. No counter-argument. Writing is difficult to follow.`,
    },
    teacher_notes: isClassical
      ? `Classical/Rhetoric Stage: Ideal for formal debate or Socratic Seminar before the written response. Emphasize the rhetorical triangle (logos, ethos, pathos).`
      : isCM
      ? `Charlotte Mason: Accept the extended response as oral narration or recorded response. Living book references are acceptable sources.`
      : `Pre-teach source citation format before this assignment. Consider a thesis workshop day before the extended response session.`,
    bridge_to_next: `This assignment prepares students for the culminating unit assessment. Return written feedback on thesis and evidence quality before the final draft is due.`,
  };
}

// POST /api/edu/ai/generate-assignment
router.post('/ai/generate-assignment', async (req: AuthRequest, res: Response) => {
  const {
    grade_level,
    state,
    subject,
    learning_style,
    curriculum_type,
    standard_code,
    topic,
  } = req.body;

  if (!grade_level || !state || !subject) {
    return res.status(400).json({ error: 'grade_level, state, and subject are required' });
  }

  const validGrades = ['K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
  if (!validGrades.includes(String(grade_level))) {
    return res.status(400).json({ error: 'grade_level must be K or 1–12' });
  }

  const validStyles      = ['visual', 'auditory', 'kinesthetic', 'reading-writing'];
  const validCurriculums = ['traditional', 'charlotte_mason', 'classical', 'eclectic', 'online'];

  const normalizedStyle      = validStyles.includes(learning_style)      ? learning_style      : 'visual';
  const normalizedCurriculum = validCurriculums.includes(curriculum_type) ? curriculum_type : 'traditional';
  const normalizedGrade      = String(grade_level);
  const normalizedState      = String(state).toUpperCase();

  try {
    const USE_MOCK_AI = process.env.MOCK_AI === 'true';

    // ── Attempt AI generation if enabled ──────────────────────
    if (!USE_MOCK_AI && process.env.TOGETHER_API_KEY) {
      const TIMEOUT_MS = 25_000;
      const gradeBandForPrompt = getGradeBand(normalizedGrade);

      const prompt = [
        `Generate a structured educational assignment for Grade ${normalizedGrade} ${subject} in state ${normalizedState}.`,
        `Learning style: ${normalizedStyle}. Curriculum type: ${normalizedCurriculum}. Grade band: ${gradeBandForPrompt}.`,
        standard_code ? `Target standard: ${standard_code}.` : '',
        topic ? `Topic focus: ${topic}.` : '',
        `Return ONLY a JSON object with keys: title, theme, i_can_statement, sections (array), teacher_notes, bridge_to_next.`,
        `Each section must have: type, title, content, activity_type, items.`,
      ].filter(Boolean).join(' ');

      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)
        );

        const aiRaw = await Promise.race([
          fetch('https://api.together.xyz/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.TOGETHER_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: process.env.MERAKI_MODEL_ID || 'meta-llama/Llama-3-8b-chat-hf',
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 2000,
              temperature: 0.7,
            }),
          }).then(r => r.json()),
          timeoutPromise,
        ]) as any;

        if (aiRaw?.choices?.[0]?.message?.content) {
          const jsonMatch = (aiRaw.choices[0].message.content as string).match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              const aiParsed = JSON.parse(jsonMatch[0]);
              const mockBase = buildAssignmentMock({
                grade_level: normalizedGrade, state: normalizedState, subject,
                learning_style: normalizedStyle, curriculum_type: normalizedCurriculum,
                standard_code, topic,
              });
              return res.json({ assignment: { ...mockBase, ...aiParsed } });
            } catch (_) { /* fall through */ }
          }
        }
      } catch (_) { /* timeout or fetch failure — fall through */ }
    }

    // ── Mock fallback ─────────────────────────────────────────
    const assignment = buildAssignmentMock({
      grade_level: normalizedGrade,
      state: normalizedState,
      subject,
      learning_style: normalizedStyle,
      curriculum_type: normalizedCurriculum,
      standard_code,
      topic,
    });

    const isFallback = USE_MOCK_AI || !process.env.TOGETHER_API_KEY;
    res.json({ assignment, ...(isFallback && { fallback: true }) });
  } catch (err: any) {
    console.error('[edu] POST /ai/generate-assignment', err.message);
    res.status(500).json({ error: 'Failed to generate assignment' });
  }
});

// ============================================================
// DOCUMENTS
// ============================================================

// Ensure edu_documents table exists
pool.query(`
  CREATE TABLE IF NOT EXISTS edu_documents (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    uploaded_by     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename        VARCHAR(500) NOT NULL,
    file_type       VARCHAR(20)  NOT NULL,
    file_size       INTEGER      NOT NULL,
    content_text    TEXT,
    purpose         VARCHAR(30)  NOT NULL DEFAULT 'resource'
                      CHECK (purpose IN ('curriculum','student_work','lesson_plan','resource')),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_edu_docs_org ON edu_documents(organization_id);
`).catch(err => console.error('[edu] edu_documents table init failed:', err.message));

// POST /api/edu/documents
router.post('/documents', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const { userId, orgId } = getUser(req);
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const purpose = (req.body.purpose || 'resource') as string;
    const validPurposes = ['curriculum', 'student_work', 'lesson_plan', 'resource'];
    const safePurpose = validPurposes.includes(purpose) ? purpose : 'resource';

    const ext = file.originalname.split('.').pop()?.toLowerCase() || '';
    const fileType = ext;

    // Extract text for TXT files; store null for binary formats
    let contentText: string | null = null;
    if (ext === 'txt') {
      contentText = file.buffer.toString('utf8').slice(0, 50000); // cap at 50k chars
    }

    const result = await pool.query(
      `INSERT INTO edu_documents
         (organization_id, uploaded_by, filename, file_type, file_size, content_text, purpose)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, filename, purpose, file_type, file_size, created_at`,
      [orgId, userId, file.originalname, fileType, file.size, contentText, safePurpose]
    );

    res.status(201).json({
      document_id: result.rows[0].id,
      filename:    result.rows[0].filename,
      purpose:     result.rows[0].purpose,
      file_type:   result.rows[0].file_type,
      file_size:   result.rows[0].file_size,
    });
  } catch (err: any) {
    console.error('[edu] POST /documents', err.message);
    res.status(500).json({ error: 'Failed to upload document' });
  }
});

// GET /api/edu/documents
router.get('/documents', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const result = await pool.query(
      `SELECT id, filename, file_type, file_size, purpose, created_at
       FROM edu_documents WHERE organization_id = $1
       ORDER BY created_at DESC`,
      [orgId]
    );
    res.json({ documents: result.rows });
  } catch (err: any) {
    console.error('[edu] GET /documents', err.message);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// ============================================================
// REPORTS
// ============================================================

// POST /api/edu/reports/class-progress
router.post('/reports/class-progress', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const { classroom_id } = req.body;
    if (!classroom_id) return res.status(400).json({ error: 'classroom_id is required' });

    // Fetch classroom + teacher email
    const classroomResult = await pool.query(
      `SELECT c.*, u.email AS teacher_email, u.first_name AS teacher_first, u.last_name AS teacher_last
       FROM classrooms c
       JOIN users u ON u.id = c.teacher_id
       WHERE c.id = $1 AND c.organization_id = $2`,
      [classroom_id, orgId]
    );
    if (classroomResult.rowCount === 0) return res.status(404).json({ error: 'Classroom not found' });
    const classroom = classroomResult.rows[0];

    // Fetch all students with progress counts
    const studentsResult = await pool.query(
      `SELECT s.*,
         COUNT(cp.id) FILTER (WHERE cp.status = 'mastered')::int       AS mastered_count,
         COUNT(cp.id) FILTER (WHERE cp.status = 'in_progress')::int    AS in_progress_count,
         COUNT(cp.id) FILTER (WHERE cp.status = 'needs_review')::int   AS needs_review_count,
         COUNT(cp.id) FILTER (WHERE cp.status = 'not_started')::int    AS not_started_count,
         COUNT(cp.id)::int                                              AS total_standards
       FROM students s
       LEFT JOIN curriculum_progress cp ON cp.student_id = s.id
       WHERE s.classroom_id = $1
       GROUP BY s.id
       ORDER BY s.last_name, s.first_name`,
      [classroom_id]
    );
    const students = studentsResult.rows;

    // Fetch active interventions
    const interventionsResult = await pool.query(
      `SELECT li.student_id, li.intervention_type, li.priority, li.subject
       FROM learning_interventions li
       JOIN students s ON s.id = li.student_id
       WHERE s.classroom_id = $1 AND li.status != 'resolved'`,
      [classroom_id]
    );
    const interventionsByStudent: Record<string, typeof interventionsResult.rows> = {};
    for (const iv of interventionsResult.rows) {
      if (!interventionsByStudent[iv.student_id]) interventionsByStudent[iv.student_id] = [];
      interventionsByStudent[iv.student_id].push(iv);
    }

    // Fetch subject-level progress breakdown
    const subjectResult = await pool.query(
      `SELECT ss.subject,
         COUNT(cp.id) FILTER (WHERE cp.status = 'mastered')::int     AS mastered,
         COUNT(cp.id) FILTER (WHERE cp.status = 'needs_review')::int AS needs_review,
         COUNT(cp.id)::int                                            AS total
       FROM curriculum_progress cp
       JOIN state_standards ss ON ss.id = cp.standard_id
       JOIN students s ON s.id = cp.student_id
       WHERE s.classroom_id = $1
       GROUP BY ss.subject
       ORDER BY ss.subject`,
      [classroom_id]
    );

    // Compute per-student mastery pct
    const withMastery = students.map(s => ({
      ...s,
      mastery_pct: s.total_standards > 0
        ? Math.round((s.mastered_count / s.total_standards) * 100)
        : 0,
      active_interventions: (interventionsByStudent[s.id] || []).length,
    }));

    const totalStudents = students.length;
    const iepCount = students.filter(s => s.has_iep).length;
    const avgMastery = totalStudents > 0
      ? Math.round(withMastery.reduce((sum, s) => sum + s.mastery_pct, 0) / totalStudents)
      : 0;

    const sorted = [...withMastery].sort((a, b) => b.mastery_pct - a.mastery_pct);
    const excelling = sorted.slice(0, 3);
    const atRisk = [...withMastery]
      .sort((a, b) => a.mastery_pct - b.mastery_pct || b.needs_review_count - a.needs_review_count)
      .filter(s => s.mastery_pct < 60 || s.needs_review_count > 1)
      .slice(0, 3);

    const report = {
      classroom_name: classroom.name,
      grade_band: classroom.grade_band,
      state: classroom.state,
      total_students: totalStudents,
      iep_student_count: iepCount,
      avg_mastery_pct: avgMastery,
      subject_breakdown: subjectResult.rows.map(r => ({
        subject: r.subject,
        mastered: r.mastered,
        needs_review: r.needs_review,
        total: r.total,
        mastery_pct: r.total > 0 ? Math.round((r.mastered / r.total) * 100) : 0,
      })),
      at_risk_students: atRisk.map(s => ({
        name: `${s.first_name} ${s.last_name}`,
        grade: s.grade_level,
        mastery_pct: s.mastery_pct,
        needs_review_count: s.needs_review_count,
        has_iep: s.has_iep,
        active_interventions: s.active_interventions,
      })),
      excelling_students: excelling.map(s => ({
        name: `${s.first_name} ${s.last_name}`,
        grade: s.grade_level,
        mastery_pct: s.mastery_pct,
        mastered_count: s.mastered_count,
      })),
      generated_at: new Date().toISOString(),
    };

    // Build HTML email
    const subjectRows = report.subject_breakdown.map(s =>
      `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${s.subject}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${s.mastered}/${s.total}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">
          <span style="color:${s.mastery_pct >= 70 ? '#16a34a' : s.mastery_pct >= 50 ? '#d97706' : '#dc2626'};font-weight:600;">${s.mastery_pct}%</span>
        </td>
      </tr>`
    ).join('');

    const atRiskRows = report.at_risk_students.map(s =>
      `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${s.name}${s.has_iep ? ' <span style="color:#7c3aed;font-size:11px;">[IEP]</span>' : ''}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">Gr. ${s.grade}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;color:#dc2626;font-weight:600;">${s.mastery_pct}%</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${s.needs_review_count} standard(s)</td>
      </tr>`
    ).join('');

    const excellingRows = report.excelling_students.map(s =>
      `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${s.name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">Gr. ${s.grade}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;color:#16a34a;font-weight:600;">${s.mastery_pct}%</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${s.mastered_count} standard(s)</td>
      </tr>`
    ).join('');

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:620px;margin:0 auto;padding:32px 16px;">

  <div style="background:#0f172a;border-radius:8px 8px 0 0;padding:24px 28px;">
    <p style="color:#94a3b8;font-size:12px;margin:0 0 4px;">VeloxSync for Education</p>
    <h1 style="color:#ffffff;font-size:22px;margin:0;">Class Progress Report</h1>
    <p style="color:#cbd5e1;font-size:14px;margin:8px 0 0;">${classroom.name} &mdash; ${classroom.grade_band} &mdash; ${classroom.state}</p>
  </div>

  <div style="background:#ffffff;padding:24px 28px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
    <p style="color:#64748b;font-size:13px;margin:0 0 20px;">Hi ${classroom.teacher_first}, here is your latest class progress snapshot.</p>

    <div style="display:flex;gap:12px;margin-bottom:24px;">
      ${[
        ['Total Students', totalStudents, '#0f172a'],
        ['Avg Mastery', `${avgMastery}%`, avgMastery >= 70 ? '#16a34a' : avgMastery >= 50 ? '#d97706' : '#dc2626'],
        ['IEP Students', iepCount, '#7c3aed'],
        ['At-Risk', atRisk.length, atRisk.length > 0 ? '#dc2626' : '#16a34a'],
      ].map(([label, val, color]) =>
        `<div style="flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px;text-align:center;">
          <div style="font-size:22px;font-weight:700;color:${color};">${val}</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px;">${label}</div>
        </div>`
      ).join('')}
    </div>

    ${subjectResult.rowCount > 0 ? `
    <h2 style="font-size:15px;color:#0f172a;margin:0 0 10px;">Subject Breakdown</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <thead>
        <tr style="background:#f1f5f9;">
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600;">Subject</th>
          <th style="padding:8px 12px;text-align:center;font-size:12px;color:#64748b;font-weight:600;">Mastered</th>
          <th style="padding:8px 12px;text-align:center;font-size:12px;color:#64748b;font-weight:600;">Mastery %</th>
        </tr>
      </thead>
      <tbody>${subjectRows}</tbody>
    </table>` : ''}

    ${atRisk.length > 0 ? `
    <h2 style="font-size:15px;color:#dc2626;margin:0 0 10px;">Students Needing Support</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <thead>
        <tr style="background:#fef2f2;">
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600;">Student</th>
          <th style="padding:8px 12px;text-align:center;font-size:12px;color:#64748b;font-weight:600;">Grade</th>
          <th style="padding:8px 12px;text-align:center;font-size:12px;color:#64748b;font-weight:600;">Mastery</th>
          <th style="padding:8px 12px;text-align:center;font-size:12px;color:#64748b;font-weight:600;">Needs Review</th>
        </tr>
      </thead>
      <tbody>${atRiskRows}</tbody>
    </table>` : ''}

    ${excelling.length > 0 ? `
    <h2 style="font-size:15px;color:#16a34a;margin:0 0 10px;">Students Excelling</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
      <thead>
        <tr style="background:#f0fdf4;">
          <th style="padding:8px 12px;text-align:left;font-size:12px;color:#64748b;font-weight:600;">Student</th>
          <th style="padding:8px 12px;text-align:center;font-size:12px;color:#64748b;font-weight:600;">Grade</th>
          <th style="padding:8px 12px;text-align:center;font-size:12px;color:#64748b;font-weight:600;">Mastery</th>
          <th style="padding:8px 12px;text-align:center;font-size:12px;color:#64748b;font-weight:600;">Mastered</th>
        </tr>
      </thead>
      <tbody>${excellingRows}</tbody>
    </table>` : ''}
  </div>

  <div style="background:#f1f5f9;border-radius:0 0 8px 8px;border:1px solid #e2e8f0;border-top:none;padding:16px 28px;">
    <p style="color:#94a3b8;font-size:11px;margin:0;">Generated ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} &middot; VeloxSync for Education &middot; This report is for educator use only.</p>
  </div>

</div>
</body>
</html>`;

    // Send email (non-blocking — don't fail the response if email fails)
    try {
      await resend.emails.send({
        from: `VeloxSync Education <${FROM_EMAIL}>`,
        to: classroom.teacher_email,
        subject: `Class Progress Report — ${classroom.name}`,
        html,
      });
    } catch (emailErr: any) {
      console.error('[edu] class-progress email failed:', emailErr.message);
    }

    res.json({ report, email_sent_to: classroom.teacher_email });
  } catch (err: any) {
    console.error('[edu] POST /reports/class-progress', err.message);
    res.status(500).json({ error: 'Failed to generate class progress report' });
  }
});

// POST /api/edu/reports/student-progress
router.post('/reports/student-progress', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const { student_id, parent_email } = req.body;

    if (!student_id) return res.status(400).json({ error: 'student_id is required' });
    if (!parent_email) return res.status(400).json({ error: 'parent_email is required' });

    // Fetch student
    const studentResult = await pool.query(
      'SELECT * FROM students WHERE id = $1 AND organization_id = $2',
      [student_id, orgId]
    );
    if (studentResult.rowCount === 0) return res.status(404).json({ error: 'Student not found' });
    const student = studentResult.rows[0];

    // Fetch progress with standard details
    const progressResult = await pool.query(
      `SELECT cp.status, cp.score, cp.last_assessed,
              ss.subject, ss.standard_code, ss.standard_description, ss.grade_band
       FROM curriculum_progress cp
       JOIN state_standards ss ON ss.id = cp.standard_id
       WHERE cp.student_id = $1
       ORDER BY ss.subject, cp.status`,
      [student_id]
    );
    const progress = progressResult.rows;

    // Fetch active interventions
    const interventionsResult = await pool.query(
      `SELECT intervention_type, subject, recommendation, priority
       FROM learning_interventions
       WHERE student_id = $1 AND status != 'resolved'
       ORDER BY priority DESC, created_at DESC`,
      [student_id]
    );
    const interventions = interventionsResult.rows;

    // Compute subject-level mastery
    const subjectMap: Record<string, { mastered: number; total: number; needs_review: number }> = {};
    for (const p of progress) {
      if (!subjectMap[p.subject]) subjectMap[p.subject] = { mastered: 0, total: 0, needs_review: 0 };
      subjectMap[p.subject].total++;
      if (p.status === 'mastered') subjectMap[p.subject].mastered++;
      if (p.status === 'needs_review') subjectMap[p.subject].needs_review++;
    }

    const subjectBreakdown = Object.entries(subjectMap).map(([subject, counts]) => ({
      subject,
      mastered: counts.mastered,
      total: counts.total,
      needs_review: counts.needs_review,
      mastery_pct: counts.total > 0 ? Math.round((counts.mastered / counts.total) * 100) : 0,
    }));

    const overallMastery = progress.length > 0
      ? Math.round((progress.filter(p => p.status === 'mastered').length / progress.length) * 100)
      : 0;

    // Generate Ei-Core recommendation summary
    let eiSummary = '';
    try {
      const insight = await generateStudentInsight(student_id, student, progress);
      eiSummary = insight.learning_summary;
    } catch {
      eiSummary = `${student.first_name} is working through their current curriculum. Please contact the teacher for a personalized update.`;
    }

    const report = {
      student: {
        name: `${student.first_name} ${student.last_name}`,
        grade_level: student.grade_level,
        learning_style: student.learning_style,
        has_iep: student.has_iep,
      },
      overall_mastery_pct: overallMastery,
      subject_breakdown: subjectBreakdown,
      active_interventions: interventions.map(iv => ({
        type: iv.intervention_type,
        subject: iv.subject,
        priority: iv.priority,
        recommendation: iv.recommendation,
      })),
      ei_core_summary: eiSummary,
      generated_at: new Date().toISOString(),
    };

    // Build HTML email
    const subjectRows = subjectBreakdown.map(s =>
      `<tr>
        <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;">${s.subject}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;text-align:center;">${s.mastered} of ${s.total} skills</td>
        <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0;text-align:center;">
          <span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600;
            background:${s.mastery_pct >= 70 ? '#dcfce7' : s.mastery_pct >= 50 ? '#fef9c3' : '#fee2e2'};
            color:${s.mastery_pct >= 70 ? '#16a34a' : s.mastery_pct >= 50 ? '#92400e' : '#dc2626'};">
            ${s.mastery_pct}%
          </span>
        </td>
      </tr>`
    ).join('');

    const interventionItems = interventions.length > 0
      ? interventions.map(iv =>
          `<li style="margin-bottom:8px;color:#374151;">
            <strong>${iv.subject || 'General'} (${iv.intervention_type})</strong><br>
            <span style="color:#64748b;font-size:13px;">${iv.recommendation}</span>
          </li>`
        ).join('')
      : '<li style="color:#64748b;">No active interventions at this time.</li>';

    const learningStyleLabel: Record<string, string> = {
      'visual': 'Visual Learner',
      'auditory': 'Auditory Learner',
      'kinesthetic': 'Kinesthetic Learner',
      'reading-writing': 'Reading-Writing Learner',
    };

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:32px 16px;">

  <div style="background:#1e3a5f;border-radius:8px 8px 0 0;padding:24px 28px;">
    <p style="color:#93c5fd;font-size:12px;margin:0 0 4px;">VeloxSync for Education &mdash; Student Progress Report</p>
    <h1 style="color:#ffffff;font-size:22px;margin:0;">${student.first_name} ${student.last_name}</h1>
    <p style="color:#bfdbfe;font-size:14px;margin:8px 0 0;">Grade ${student.grade_level}${student.learning_style ? ' &middot; ' + (learningStyleLabel[student.learning_style] || student.learning_style) : ''}</p>
  </div>

  <div style="background:#ffffff;padding:24px 28px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">

    <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 20px;">
      Dear Parent or Guardian,<br><br>
      We are pleased to share a progress update for <strong>${student.first_name}</strong>.
      This report reflects their current curriculum mastery and areas of focus.
    </p>

    <div style="background:#f0f9ff;border-left:4px solid #0ea5e9;border-radius:4px;padding:16px 20px;margin-bottom:24px;">
      <p style="font-size:13px;color:#0369a1;font-weight:600;margin:0 0 6px;">Overall Mastery</p>
      <div style="font-size:36px;font-weight:700;color:${overallMastery >= 70 ? '#16a34a' : overallMastery >= 50 ? '#d97706' : '#dc2626'};">${overallMastery}%</div>
      <p style="font-size:12px;color:#64748b;margin:4px 0 0;">${progress.filter(p => p.status === 'mastered').length} of ${progress.length} standards mastered</p>
    </div>

    ${subjectBreakdown.length > 0 ? `
    <h2 style="font-size:15px;color:#0f172a;margin:0 0 10px;">Progress by Subject</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="padding:10px 14px;text-align:left;font-size:12px;color:#64748b;font-weight:600;border-bottom:2px solid #e2e8f0;">Subject</th>
          <th style="padding:10px 14px;text-align:center;font-size:12px;color:#64748b;font-weight:600;border-bottom:2px solid #e2e8f0;">Skills Mastered</th>
          <th style="padding:10px 14px;text-align:center;font-size:12px;color:#64748b;font-weight:600;border-bottom:2px solid #e2e8f0;">Mastery Level</th>
        </tr>
      </thead>
      <tbody>${subjectRows}</tbody>
    </table>` : `<p style="color:#64748b;font-size:14px;margin-bottom:24px;">No curriculum progress has been recorded yet.</p>`}

    <h2 style="font-size:15px;color:#0f172a;margin:0 0 10px;">Teacher Notes &amp; Support Areas</h2>
    <ul style="margin:0 0 24px;padding-left:20px;line-height:1.8;">
      ${interventionItems}
    </ul>

    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:16px 20px;margin-bottom:8px;">
      <p style="font-size:13px;color:#7c3aed;font-weight:600;margin:0 0 6px;">Ei-Core Learning Insight</p>
      <p style="font-size:14px;color:#374151;line-height:1.6;margin:0;">${eiSummary}</p>
    </div>

  </div>

  <div style="background:#f1f5f9;border-radius:0 0 8px 8px;border:1px solid #e2e8f0;border-top:none;padding:16px 28px;">
    <p style="color:#94a3b8;font-size:11px;margin:0;">
      Generated ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
      &middot; VeloxSync for Education &middot; Confidential — for parent/guardian use only.
      <br>If you have questions, please contact your child's teacher directly.
    </p>
  </div>

</div>
</body>
</html>`;

    try {
      await resend.emails.send({
        from: `VeloxSync Education <${FROM_EMAIL}>`,
        to: parent_email,
        subject: `Progress Report for ${student.first_name} ${student.last_name}`,
        html,
      });
    } catch (emailErr: any) {
      console.error('[edu] student-progress email failed:', emailErr.message);
    }

    res.json({ report, email_sent_to: parent_email });
  } catch (err: any) {
    console.error('[edu] POST /reports/student-progress', err.message);
    res.status(500).json({ error: 'Failed to generate student progress report' });
  }
});

// ============================================================
// TASK 1 — ASSESSMENT ENGINE
// ============================================================

// POST /api/edu/assessments
router.post('/assessments', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const { student_id, standard_ids, scores, notes } = req.body;

    if (!student_id || !Array.isArray(standard_ids) || !Array.isArray(scores)) {
      return res.status(400).json({ error: 'student_id, standard_ids (array), and scores (array) are required' });
    }
    if (standard_ids.length !== scores.length) {
      return res.status(400).json({ error: 'standard_ids and scores must be the same length' });
    }

    const check = await pool.query(
      'SELECT id FROM students WHERE id = $1 AND organization_id = $2',
      [student_id, orgId]
    );
    if (check.rowCount === 0) return res.status(404).json({ error: 'Student not found' });

    const toStatus = (score: number): string => {
      if (score >= 80) return 'mastered';
      if (score >= 50) return 'in_progress';
      return 'needs_review';
    };

    const upserts = standard_ids.map((sid: string, i: number) =>
      pool.query(
        `INSERT INTO curriculum_progress (student_id, standard_id, status, score, last_assessed, notes)
         VALUES ($1, $2, $3, $4, NOW(), $5)
         ON CONFLICT (student_id, standard_id) DO UPDATE
           SET status = EXCLUDED.status,
               score = EXCLUDED.score,
               last_assessed = EXCLUDED.last_assessed,
               notes = EXCLUDED.notes`,
        [student_id, sid, toStatus(scores[i]), scores[i], notes || null]
      )
    );
    await Promise.all(upserts);

    const summary = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'mastered')::int     AS mastered,
         COUNT(*) FILTER (WHERE status = 'in_progress')::int  AS in_progress,
         COUNT(*) FILTER (WHERE status = 'needs_review')::int AS needs_review,
         COUNT(*) FILTER (WHERE status = 'not_started')::int  AS not_started,
         COUNT(*)::int                                         AS total
       FROM curriculum_progress WHERE student_id = $1`,
      [student_id]
    );

    res.json({
      assessed: standard_ids.length,
      mastery_summary: summary.rows[0],
    });
  } catch (err: any) {
    console.error('[edu] POST /assessments', err.message);
    res.status(500).json({ error: 'Failed to record assessments' });
  }
});

// ============================================================
// TASK 2 — PACING GUIDE
// ============================================================

// GET /api/edu/pacing/:classroomId
router.get('/pacing/:classroomId', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);

    const classroomResult = await pool.query(
      'SELECT * FROM classrooms WHERE id = $1 AND organization_id = $2',
      [req.params.classroomId, orgId]
    );
    if (classroomResult.rowCount === 0) return res.status(404).json({ error: 'Classroom not found' });

    // Per-standard class mastery rate
    const standardStats = await pool.query(
      `SELECT ss.id AS standard_id, ss.standard_code, ss.standard_description, ss.subject, ss.grade_band,
         COUNT(cp.id)::int AS total_assessed,
         COUNT(cp.id) FILTER (WHERE cp.status = 'mastered')::int AS mastered_count,
         AVG(cp.score) AS avg_score
       FROM state_standards ss
       LEFT JOIN curriculum_progress cp ON cp.standard_id = ss.id
       LEFT JOIN students s ON s.id = cp.student_id AND s.classroom_id = $1
       WHERE s.classroom_id = $1
       GROUP BY ss.id
       ORDER BY ss.subject, ss.standard_code`,
      [req.params.classroomId]
    );

    const totalStudents = (await pool.query(
      'SELECT COUNT(*)::int AS n FROM students WHERE classroom_id = $1',
      [req.params.classroomId]
    )).rows[0].n;

    const behind: typeof standardStats.rows = [];
    const onTrack: typeof standardStats.rows = [];

    for (const row of standardStats.rows) {
      const pct = totalStudents > 0 ? (row.mastered_count / totalStudents) * 100 : 0;
      if (pct < 50) behind.push({ ...row, class_mastery_pct: Math.round(pct) });
      else if (pct > 80) onTrack.push({ ...row, class_mastery_pct: Math.round(pct) });
    }

    // Students needing support — below 60% average mastery
    const studentStats = await pool.query(
      `SELECT s.id, s.first_name, s.last_name, s.grade_level, s.has_iep,
         COUNT(cp.id) FILTER (WHERE cp.status = 'mastered')::int AS mastered_count,
         COUNT(cp.id) FILTER (WHERE cp.status = 'needs_review')::int AS needs_review_count,
         COUNT(cp.id)::int AS total
       FROM students s
       LEFT JOIN curriculum_progress cp ON cp.student_id = s.id
       WHERE s.classroom_id = $1
       GROUP BY s.id`,
      [req.params.classroomId]
    );

    const studentsNeedingSupport = studentStats.rows
      .map(s => ({
        ...s,
        mastery_pct: s.total > 0 ? Math.round((s.mastered_count / s.total) * 100) : 0,
      }))
      .filter(s => s.mastery_pct < 60)
      .sort((a, b) => a.mastery_pct - b.mastery_pct);

    const insight = await generateClassInsight(req.params.classroomId as string, studentStats.rows.map(s => ({
      id: s.id,
      first_name: s.first_name,
      last_name: s.last_name,
      grade_level: s.grade_level,
      has_iep: s.has_iep,
      learning_style: null,
      mastered_count: s.mastered_count,
      needs_review_count: s.needs_review_count,
      in_progress_count: 0,
    })));

    res.json({
      classroom: classroomResult.rows[0],
      this_week_focus: behind.slice(0, 5),
      behind_schedule: behind,
      on_track: onTrack,
      students_needing_support: studentsNeedingSupport,
      recommended_adjustments: insight.pacing_recommendations,
    });
  } catch (err: any) {
    console.error('[edu] GET /pacing/:classroomId', err.message);
    res.status(500).json({ error: 'Failed to generate pacing guide' });
  }
});

// ============================================================
// TASK 3 — AUTO DIFFERENTIATION GROUPS
// ============================================================

// POST /api/edu/groups/:classroomId
router.post('/groups/:classroomId', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);

    const classroomResult = await pool.query(
      'SELECT * FROM classrooms WHERE id = $1 AND organization_id = $2',
      [req.params.classroomId, orgId]
    );
    if (classroomResult.rowCount === 0) return res.status(404).json({ error: 'Classroom not found' });

    const studentsResult = await pool.query(
      `SELECT s.id, s.first_name, s.last_name, s.grade_level,
         COALESCE(s.has_iep, false)       AS has_iep,
         COALESCE(s.learning_style, null) AS learning_style,
         COUNT(cp.id) FILTER (WHERE cp.status = 'mastered')::int     AS mastered_count,
         COUNT(cp.id) FILTER (WHERE cp.status = 'needs_review')::int AS needs_review_count,
         COUNT(cp.id) FILTER (WHERE cp.status = 'in_progress')::int  AS in_progress_count,
         COUNT(cp.id)::int AS total
       FROM students s
       LEFT JOIN curriculum_progress cp ON cp.student_id = s.id
       WHERE s.classroom_id = $1
       GROUP BY s.id, s.first_name, s.last_name, s.grade_level, s.has_iep, s.learning_style`,
      [req.params.classroomId as string]
    );

    const withPct = studentsResult.rows.map(s => ({
      ...s,
      mastery_pct: s.total > 0 ? Math.round((s.mastered_count / s.total) * 100) : 0,
    }));

    const advanced      = withPct.filter(s => s.mastery_pct > 80);
    const onGradeLevel  = withPct.filter(s => s.mastery_pct >= 60 && s.mastery_pct <= 80);
    const needsSupport  = withPct.filter(s => s.mastery_pct < 60);

    // Ei-Core strategies per group — run in parallel
    const [advancedInsight, onGradeInsight, supportInsight] = await Promise.all([
      advanced.length > 0
        ? generateClassInsight(req.params.classroomId as string, advanced)
        : Promise.resolve({ class_health_summary: 'No advanced students yet.', at_risk_students: [], pacing_recommendations: [], differentiation_strategies: ['Provide enrichment projects and independent research opportunities.'] }),
      onGradeLevel.length > 0
        ? generateClassInsight(req.params.classroomId as string, onGradeLevel)
        : Promise.resolve({ class_health_summary: 'No on-grade-level students yet.', at_risk_students: [], pacing_recommendations: [], differentiation_strategies: ['Continue current pacing with regular formative checks.'] }),
      needsSupport.length > 0
        ? generateClassInsight(req.params.classroomId as string, needsSupport)
        : Promise.resolve({ class_health_summary: 'No students needing support.', at_risk_students: [], pacing_recommendations: [], differentiation_strategies: ['No immediate support interventions needed.'] }),
    ]);

    const toStudentList = (arr: typeof withPct) => arr.map(s => ({
      id: s.id,
      name: `${s.first_name} ${s.last_name}`,
      grade_level: s.grade_level,
      mastery_pct: s.mastery_pct,
      has_iep: s.has_iep,
      learning_style: s.learning_style,
    }));

    res.json({
      classroom: classroomResult.rows[0].name,
      total_students: withPct.length,
      advanced: {
        students: toStudentList(advanced),
        count: advanced.length,
        strategies: advancedInsight.differentiation_strategies,
      },
      on_grade: {
        students: toStudentList(onGradeLevel),
        count: onGradeLevel.length,
        strategies: onGradeInsight.differentiation_strategies,
      },
      needs_support: {
        students: toStudentList(needsSupport),
        count: needsSupport.length,
        strategies: supportInsight.differentiation_strategies,
      },
    });
  } catch (err: any) {
    console.error('[edu] POST /groups/:classroomId', err.message);
    res.status(500).json({ error: 'Failed to generate differentiation groups' });
  }
});

// ============================================================
// TASK 4 — BEHAVIOR LOG
// ============================================================

// Patch students table — add columns that may be missing if the table pre-dated this migration
pool.query(`
  ALTER TABLE students ADD COLUMN IF NOT EXISTS has_iep          BOOLEAN      NOT NULL DEFAULT FALSE;
  ALTER TABLE students ADD COLUMN IF NOT EXISTS iep_notes        TEXT;
  ALTER TABLE students ADD COLUMN IF NOT EXISTS learning_style   VARCHAR(30);
  ALTER TABLE students ADD COLUMN IF NOT EXISTS primary_language VARCHAR(50)  DEFAULT 'English';
  ALTER TABLE students ADD COLUMN IF NOT EXISTS strengths        TEXT[]       NOT NULL DEFAULT '{}';
  ALTER TABLE students ADD COLUMN IF NOT EXISTS challenge_areas  TEXT[]       NOT NULL DEFAULT '{}';
  ALTER TABLE students ADD COLUMN IF NOT EXISTS classroom_id     UUID         REFERENCES classrooms(id) ON DELETE SET NULL;
`).catch(err => console.error('[edu] students column patch failed:', err.message));

// Ensure behavior_logs table exists
pool.query(`
  CREATE TABLE IF NOT EXISTS behavior_logs (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id       UUID        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    observation_type VARCHAR(10) NOT NULL CHECK (observation_type IN ('positive','concern','neutral')),
    description      TEXT        NOT NULL,
    subject          VARCHAR(100),
    date             DATE        NOT NULL DEFAULT CURRENT_DATE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_behavior_student ON behavior_logs(student_id);
`).catch(err => console.error('[edu] behavior_logs table init failed:', err.message));

// POST /api/edu/behavior/:studentId
router.post('/behavior/:studentId', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);
    const { observation_type, description, subject, date } = req.body;

    if (!observation_type || !description) {
      return res.status(400).json({ error: 'observation_type and description are required' });
    }

    const studentCheck = await pool.query(
      'SELECT id FROM students WHERE id = $1 AND organization_id = $2',
      [req.params.studentId, orgId]
    );
    if (studentCheck.rowCount === 0) return res.status(404).json({ error: 'Student not found' });

    await pool.query(
      `INSERT INTO behavior_logs (student_id, observation_type, description, subject, date)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.studentId, observation_type, description, subject || null, date || new Date().toISOString().split('T')[0]]
    );

    // Check for 3+ concern logs in past 30 days
    let interventionCreated = false;
    if (observation_type === 'concern') {
      const recentConcerns = await pool.query(
        `SELECT COUNT(*)::int AS n FROM behavior_logs
         WHERE student_id = $1 AND observation_type = 'concern'
           AND date >= CURRENT_DATE - INTERVAL '30 days'`,
        [req.params.studentId]
      );

      if (recentConcerns.rows[0].n >= 3) {
        // Only create if no urgent/high intervention already pending
        const existing = await pool.query(
          `SELECT id FROM learning_interventions
           WHERE student_id = $1 AND status != 'resolved' AND priority IN ('high','urgent')
           LIMIT 1`,
          [req.params.studentId]
        );

        if (existing.rowCount === 0) {
          await pool.query(
            `INSERT INTO learning_interventions
               (student_id, organization_id, intervention_type, recommendation, priority, ei_core_generated)
             VALUES ($1, $2, 'accommodation',
               '3 or more behavior concerns logged in the past 30 days. Schedule a student support meeting and review recent observations.',
               'high', FALSE)`,
            [req.params.studentId, orgId]
          );
          interventionCreated = true;
        }
      }
    }

    res.status(201).json({ logged: true, intervention_created: interventionCreated });
  } catch (err: any) {
    console.error('[edu] POST /behavior/:studentId', err.message);
    res.status(500).json({ error: 'Failed to log behavior' });
  }
});

// GET /api/edu/behavior/:studentId
router.get('/behavior/:studentId', async (req: AuthRequest, res: Response) => {
  try {
    const { orgId } = getUser(req);

    const studentCheck = await pool.query(
      'SELECT id FROM students WHERE id = $1 AND organization_id = $2',
      [req.params.studentId, orgId]
    );
    if (studentCheck.rowCount === 0) return res.status(404).json({ error: 'Student not found' });

    const result = await pool.query(
      `SELECT * FROM behavior_logs
       WHERE student_id = $1
         AND date >= CURRENT_DATE - INTERVAL '30 days'
       ORDER BY date DESC, created_at DESC`,
      [req.params.studentId]
    );

    res.json({ logs: result.rows, count: result.rowCount });
  } catch (err: any) {
    console.error('[edu] GET /behavior/:studentId', err.message);
    res.status(500).json({ error: 'Failed to fetch behavior logs' });
  }
});

export default router;
