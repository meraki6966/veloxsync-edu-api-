// src/services/signalEngine.ts
// ─────────────────────────────────────────────────────────────────────────────
// Derived Signal Engine — VeloxSync / Phase 4
//
// Computes four EI-Core input signals for every employee:
//   burnout_probability     — weighted pulse + overtime + absenteeism
//   bandwidth_overload      — overtime + stress resilience + engagement + OKR drift
//   retention_risk          — eNPS + burnout + morale + tenure
//   communication_friction  — manager pulse + culture pulse + collab style + comms cache
//
// All signals are 0–100. Missing data degrades data_confidence but never
// blocks computation — stored employee scores serve as the fallback baseline.
//
// Query strategy: computeOrgSignals / computeTeamSignals load all raw data in
// 5 bulk queries then compute in memory. computeEmployeeSignals runs narrower
// per-employee queries for single-record detail views.
// ─────────────────────────────────────────────────────────────────────────────

import { pool } from '../db';

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC TYPES  (consumed by EI-Core and route handlers)
// ─────────────────────────────────────────────────────────────────────────────

export interface SignalFactor {
  name: string;
  value: number;       // 0–100, already normalized
  weight: number;      // declared weight (0–1), before redistribution
  source: string;      // 'employees' | 'wellness_scores' | 'integration_cache' | 'pulse' | 'okr'
}

export interface EmployeeSignals {
  employee_id: number;
  organization_id: number;
  first_name: string;
  last_name: string;
  department: string | null;
  computed_at: string;

  burnout_probability:    number;   // 0–100
  bandwidth_overload:     number;   // 0–100
  retention_risk:         number;   // 0–100
  communication_friction: number;   // 0–100

  /** 0–1. Fraction of possible signal factors that had real data. */
  data_confidence: number;

  /** Risk tier derived from the highest signal value. */
  risk_level: 'low' | 'moderate' | 'elevated' | 'high' | 'critical';

  factors: {
    burnout:       SignalFactor[];
    bandwidth:     SignalFactor[];
    retention:     SignalFactor[];
    communication: SignalFactor[];
  };
}

export interface TeamSignals {
  team_id: number;
  team_name: string;
  member_count: number;
  computed_at: string;

  avg_burnout_probability:    number;
  avg_bandwidth_overload:     number;
  avg_retention_risk:         number;
  avg_communication_friction: number;

  /** Inverse of mean signal score: 100 − avg(all four signals). */
  team_health_score: number;

  at_risk_count: number;    // any signal ≥ 70
  critical_count: number;   // any signal ≥ 85

  members: EmployeeSignals[];
}

export interface DepartmentRollup {
  department: string;
  employee_count: number;
  avg_burnout_probability:    number;
  avg_bandwidth_overload:     number;
  avg_retention_risk:         number;
  avg_communication_friction: number;
  health_score: number;
  at_risk_count: number;
}

export interface OrgSignals {
  organization_id: number;
  computed_at: string;
  total_employees: number;

  avg_burnout_probability:    number;
  avg_bandwidth_overload:     number;
  avg_retention_risk:         number;
  avg_communication_friction: number;

  /** Inverse of mean of all four org-level averages. */
  org_health_score: number;

  at_risk_count: number;    // any signal ≥ 70
  critical_count: number;   // any signal ≥ 85

  by_department: DepartmentRollup[];
  by_team: TeamSignals[];

  /** Top 5 by signal, ready for EI-Core to generate interventions from. */
  top_burnout_risks:     EmployeeSignals[];
  top_bandwidth_risks:   EmployeeSignals[];
  top_retention_risks:   EmployeeSignals[];
  top_friction_risks:    EmployeeSignals[];
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface EmployeeRow {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  department: string | null;
  burnout_score: number;       // stored VeloxSync score (0–100)
  morale_score: number;
  stress_resilience: number;
  cognitive_agility: number;
  collaboration_style: string | null;
  hire_date: string | null;
  status: string;
}

// Pre-grouped signal maps keyed by employee_id
interface BulkRawData {
  employees: EmployeeRow[];
  // Map<employeeId, Map<category, normalizedScore 0-100>>
  pulseByEmployee:       Map<number, Map<string, number>>;
  // Map<employeeId, Map<dataType, rawValue>>
  integrationByEmployee: Map<number, Map<string, number>>;
  // Map<lowerName, { atRiskRatio, avgProgress }>
  okrByOwnerName:        Map<string, { atRiskRatio: number; avgProgress: number }>;
  // Map<teamId, { name, memberIds }>
  teamMemberships:       Map<number, { name: string; memberIds: number[] }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Weighted average over factors that have a non-null value.
 * Redistributes weight from missing factors to available ones.
 * Returns score 0–100 and confidence 0–1.
 */
function weightedAvg(
  factors: Array<{ value: number | null; weight: number }>,
): { score: number; confidence: number } {
  const available = factors.filter(f => f.value !== null);
  if (available.length === 0) return { score: 50, confidence: 0 };

  const totalDeclaredWeight = factors.reduce((s, f) => s + f.weight, 0);
  const availableWeight     = available.reduce((s, f) => s + f.weight, 0);

  const score = available.reduce(
    (sum, f) => sum + (f.value! * (f.weight / availableWeight)),
    0,
  );

  return {
    score:      Math.round(Math.min(100, Math.max(0, score))),
    confidence: availableWeight / totalDeclaredWeight,
  };
}

function riskLevel(maxSignal: number): EmployeeSignals['risk_level'] {
  if (maxSignal >= 90) return 'critical';
  if (maxSignal >= 75) return 'high';
  if (maxSignal >= 60) return 'elevated';
  if (maxSignal >= 40) return 'moderate';
  return 'low';
}

/**
 * Maps overtime hours to a 0–100 burnout/overload score.
 * Baseline: 40 hr/wk = 0.  Ceiling: 60+ hr/wk = 100.
 */
function overtimeScore(hours: number): number {
  return Math.round(Math.min(100, Math.max(0, (hours - 40) / 20 * 100)));
}

/**
 * Returns a friction modifier (0–40) based on collaboration style.
 * Higher = more friction risk from this person's working style.
 */
function collaborationFrictionScore(style: string | null): number {
  if (!style) return 15; // unknown = neutral-ish
  const s = style.toLowerCase();
  if (s.includes('isolat'))    return 40;
  if (s.includes('independen')) return 20;
  if (s.includes('collaborat')) return 0;
  if (s.includes('team player')) return 5;
  if (s.includes('leader'))     return 10;
  return 15;
}

/**
 * Returns a retention risk modifier (−15 to +20) based on tenure.
 * The highest churn windows are the first year and the 2–3 year "sophomore slump".
 */
function tenureRiskModifier(hireDateStr: string | null): number {
  if (!hireDateStr) return 0;
  const months = (Date.now() - new Date(hireDateStr).getTime()) / (1000 * 60 * 60 * 24 * 30);
  if (months < 6)   return 20;   // onboarding window — highest flight risk
  if (months < 12)  return 15;
  if (months < 24)  return 10;
  if (months < 36)  return 5;    // sophomore slump
  if (months < 60)  return 0;    // stable
  return -10;                     // long-tenured = lower risk
}

/** Normalizes a pulse 1–5 answer to 0–100. */
function pulseNorm(avg1to5: number): number {
  return Math.round(Math.min(100, Math.max(0, (avg1to5 - 1) / 4 * 100)));
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE SIGNAL COMPUTATION (pure — no DB access)
// ─────────────────────────────────────────────────────────────────────────────

function computeSignalsForEmployee(
  emp: EmployeeRow,
  orgId: number,
  pulse: Map<string, number>,           // category → normalized 0-100
  integration: Map<string, number>,     // dataType  → raw value
  okr: { atRiskRatio: number; avgProgress: number } | undefined,
): EmployeeSignals {
  const now = new Date().toISOString();

  // ── Raw signal values (null = not available) ──────────────────────────────

  // Pulse categories already normalized 0–100
  const pulseEngagement  = pulse.get('engagement')  ?? null;
  const pulseBurnout     = pulse.get('burnout')     ?? null;  // already inverted
  const pulseManager     = pulse.get('manager')     ?? null;
  const pulseCulture     = pulse.get('culture')     ?? null;
  const pulseEnps        = pulse.get('enps')        ?? null;  // –100 to 100 → normalized below

  // Integration cache
  const overtimeHours    = integration.get('overtime_hours')          ?? null;
  const absenteeismRate  = integration.get('absenteeism_rate')        ?? null;  // 0–100%
  const commFrequency    = integration.get('communication_frequency') ?? null;  // msgs/week

  // Normalize eNPS: –100 to +100 → 0–100 (invert: high NPS = low risk)
  const enpsNormalized = pulseEnps !== null
    ? Math.round(Math.min(100, Math.max(0, ((-pulseEnps) + 100) / 2)))
    : null;

  // Normalize overtime
  const overtimeNorm = overtimeHours !== null ? overtimeScore(overtimeHours) : null;

  // Normalize absenteeism: 0% = 0, 20%+ = 100
  const absenteeismNorm = absenteeismRate !== null
    ? Math.round(Math.min(100, absenteeismRate * 5))
    : null;

  // Normalize communication frequency: 0 msgs/wk = 100 friction, 20+ = 0 friction
  const commFrictionNorm = commFrequency !== null
    ? Math.round(Math.min(100, Math.max(0, 100 - (commFrequency / 20) * 100)))
    : null;

  // OKR at-risk ratio (already 0–100)
  const okrAtRisk = okr ? Math.round(okr.atRiskRatio) : null;

  // ── BURNOUT PROBABILITY ───────────────────────────────────────────────────
  // Pulse burnout category is the most direct self-reported signal (inverted in
  // pulse.ts: high answer = low burnout, so it arrives already as risk score).
  // Overtime and absenteeism are behavioral corroborators.

  const burnoutFactors: Array<SignalFactor & { value: number | null }> = [
    { name: 'Pulse burnout score',       value: pulseBurnout,       weight: 0.30, source: 'pulse' },
    { name: 'Stored burnout score',      value: emp.burnout_score,  weight: 0.25, source: 'employees' },
    { name: 'Overtime hours',            value: overtimeNorm,       weight: 0.25, source: 'integration_cache' },
    { name: 'Absenteeism rate',          value: absenteeismNorm,    weight: 0.20, source: 'integration_cache' },
  ];

  const { score: burnoutScore, confidence: burnoutConf } = weightedAvg(burnoutFactors);

  // ── BANDWIDTH OVERLOAD ────────────────────────────────────────────────────
  // Overtime is the primary load signal. Stress resilience (inverted) tells us
  // how well the person absorbs load. Low engagement under high load is a sign
  // the person is past their capacity. OKR drift signals delivery strain.

  const bandwidthFactors: Array<SignalFactor & { value: number | null }> = [
    { name: 'Overtime hours',             value: overtimeNorm,                        weight: 0.40, source: 'integration_cache' },
    { name: 'Stress resilience (inv)',    value: 100 - emp.stress_resilience,         weight: 0.25, source: 'employees' },
    { name: 'Pulse engagement (inv)',     value: pulseEngagement !== null ? 100 - pulseEngagement : null, weight: 0.20, source: 'pulse' },
    { name: 'OKR at-risk ratio',          value: okrAtRisk,                           weight: 0.15, source: 'okr' },
  ];

  const { score: bandwidthScore, confidence: bandwidthConf } = weightedAvg(bandwidthFactors);

  // ── RETENTION RISK ────────────────────────────────────────────────────────
  // eNPS is the strongest leading indicator of intent-to-leave.
  // Burnout and morale are corroborators. Tenure adjusts the baseline.

  const retentionBase: Array<{ value: number | null; weight: number }> = [
    { value: enpsNormalized,                                weight: 0.35 },
    { value: burnoutScore,                                  weight: 0.30 },
    { value: 100 - emp.morale_score,                        weight: 0.20 },
    { value: null,                                          weight: 0.15 }, // tenure handled as additive modifier
  ];

  const { score: retentionBase100, confidence: retentionConf } = weightedAvg(retentionBase);
  const retentionScore = Math.round(
    Math.min(100, Math.max(0, retentionBase100 + tenureRiskModifier(emp.hire_date)))
  );

  const retentionFactors: Array<SignalFactor & { value: number | null }> = [
    { name: 'eNPS (inverted)',          value: enpsNormalized,                weight: 0.35, source: 'pulse' },
    { name: 'Burnout probability',      value: burnoutScore,                  weight: 0.30, source: 'computed' },
    { name: 'Morale score (inv)',       value: 100 - emp.morale_score,        weight: 0.20, source: 'employees' },
    { name: 'Tenure risk modifier',     value: tenureRiskModifier(emp.hire_date) + 50, weight: 0.15, source: 'employees' },
  ];

  // ── COMMUNICATION FRICTION ────────────────────────────────────────────────
  // Manager relationship and team culture are the dominant friction signals.
  // Collaboration style adds a structural modifier. Comms frequency from
  // Slack/Teams (when connected) provides a behavioral corroborator.

  const frictionFactors: Array<SignalFactor & { value: number | null }> = [
    { name: 'Manager pulse (inv)',      value: pulseManager !== null ? 100 - pulseManager : null, weight: 0.35, source: 'pulse' },
    { name: 'Culture pulse (inv)',      value: pulseCulture !== null ? 100 - pulseCulture : null, weight: 0.30, source: 'pulse' },
    { name: 'Comms frequency (inv)',    value: commFrictionNorm,                                  weight: 0.20, source: 'integration_cache' },
    { name: 'Collaboration style',      value: collaborationFrictionScore(emp.collaboration_style), weight: 0.15, source: 'employees' },
  ];

  const { score: frictionScore, confidence: frictionConf } = weightedAvg(frictionFactors);

  // ── OVERALL DATA CONFIDENCE ───────────────────────────────────────────────
  const dataConfidence = Math.round(
    ((burnoutConf + bandwidthConf + retentionConf + frictionConf) / 4) * 100
  ) / 100;

  const maxSignal = Math.max(burnoutScore, bandwidthScore, retentionScore, frictionScore);

  return {
    employee_id:    emp.id,
    organization_id: orgId,
    first_name:     emp.first_name,
    last_name:      emp.last_name,
    department:     emp.department,
    computed_at:    now,

    burnout_probability:    burnoutScore,
    bandwidth_overload:     bandwidthScore,
    retention_risk:         retentionScore,
    communication_friction: frictionScore,

    data_confidence: dataConfidence,
    risk_level:      riskLevel(maxSignal),

    factors: {
      burnout:       burnoutFactors.map(({ name, value, weight, source }) => ({ name, value: value ?? 50, weight, source })),
      bandwidth:     bandwidthFactors.map(({ name, value, weight, source }) => ({ name, value: value ?? 50, weight, source })),
      retention:     retentionFactors.map(({ name, value, weight, source }) => ({ name, value: value ?? 50, weight, source })),
      communication: frictionFactors.map(({ name, value, weight, source }) => ({ name, value: value ?? 50, weight, source })),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// BULK DATA LOADER  (5 queries for the entire org)
// ─────────────────────────────────────────────────────────────────────────────

async function loadOrgRawData(orgId: number): Promise<BulkRawData> {
  const [empRes, pulseRes, integrationRes, okrRes, teamRes] = await Promise.all([

    // 1. All active employees
    pool.query<EmployeeRow>(
      `SELECT id, first_name, last_name, email, department,
              COALESCE(burnout_score, 50)        AS burnout_score,
              COALESCE(morale_score, 75)         AS morale_score,
              COALESCE(stress_resilience, 70)    AS stress_resilience,
              COALESCE(cognitive_agility, 80)    AS cognitive_agility,
              collaboration_style,
              hire_date, status
       FROM employees
       WHERE organization_id = $1 AND status = 'active'`,
      [orgId],
    ),

    // 2. Pulse category averages per employee (30-day window)
    //    Bridge: pulse_responses.employee_id (uuid) → users.id → users.email → employees.email
    pool.query(
      `SELECT e.id AS employee_id,
              pq.category,
              AVG(pa.numeric_answer) AS avg_score
       FROM pulse_answers pa
       JOIN pulse_questions pq  ON pq.id  = pa.question_id
       JOIN pulse_responses pr  ON pr.id  = pa.response_id
       JOIN users u              ON u.id   = pr.employee_id
       JOIN employees e          ON LOWER(e.email) = LOWER(u.email)
                                AND e.organization_id = pr.organization_id
       WHERE pr.organization_id = $1
         AND pr.completed_at   >= NOW() - INTERVAL '30 days'
       GROUP BY e.id, pq.category`,
      [orgId],
    ),

    // 3. Integration cache signals per employee (30-day window)
    //    Double bridge: match by employee_id (cast to text) OR employee_email
    pool.query(
      `SELECT e.id AS employee_id,
              idc.data_type,
              AVG(idc.numeric_value) AS avg_value
       FROM integration_data_cache idc
       JOIN employees e ON e.organization_id = idc.organization_id
         AND (
           CAST(e.id AS TEXT) = CAST(idc.employee_id AS TEXT)
           OR LOWER(e.email) = LOWER(idc.employee_email)
         )
       WHERE idc.organization_id = $1
         AND idc.data_type IN (
           'overtime_hours', 'absenteeism_rate',
           'engagement_score', 'burnout_signal', 'communication_frequency'
         )
         AND idc.synced_at >= NOW() - INTERVAL '30 days'
       GROUP BY e.id, idc.data_type`,
      [orgId],
    ),

    // 4. OKR health per owner (matched by name later)
    pool.query(
      `SELECT TRIM(LOWER(owner)) AS owner_key,
              COALESCE(
                COUNT(*) FILTER (WHERE status IN ('at_risk','off_track'))
                  * 100.0 / NULLIF(COUNT(*), 0),
                0
              ) AS at_risk_ratio,
              AVG(COALESCE(progress, 0)) AS avg_progress
       FROM objectives
       WHERE organization_id = $1
       GROUP BY TRIM(LOWER(owner))`,
      [orgId],
    ),

    // 5. Team memberships
    pool.query(
      `SELECT t.id AS team_id, t.name AS team_name, tm.employee_id
       FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
       WHERE t.organization_id = $1`,
      [orgId],
    ),
  ]);

  // ── Index pulse results ──
  const pulseByEmployee = new Map<number, Map<string, number>>();
  for (const row of pulseRes.rows) {
    const empId = Number(row.employee_id);
    if (!pulseByEmployee.has(empId)) pulseByEmployee.set(empId, new Map());
    const normalized = pulseNorm(parseFloat(row.avg_score));
    // Burnout category: high answer (agreement with "I feel burnt out") = high burnout risk
    // Already inverted in pulse.ts compute, but here we're reading raw 1–5 answers.
    // We invert burnout so that high score = high risk, consistent with other signals.
    const value = row.category === 'burnout' ? (100 - normalized) : normalized;
    pulseByEmployee.get(empId)!.set(row.category, value);
  }

  // ── Index integration results ──
  const integrationByEmployee = new Map<number, Map<string, number>>();
  for (const row of integrationRes.rows) {
    const empId = Number(row.employee_id);
    if (!integrationByEmployee.has(empId)) integrationByEmployee.set(empId, new Map());
    integrationByEmployee.get(empId)!.set(row.data_type, parseFloat(row.avg_value));
  }

  // ── Index OKR results by lower-case owner name ──
  const okrByOwnerName = new Map<string, { atRiskRatio: number; avgProgress: number }>();
  for (const row of okrRes.rows) {
    okrByOwnerName.set(row.owner_key, {
      atRiskRatio: parseFloat(row.at_risk_ratio),
      avgProgress: parseFloat(row.avg_progress),
    });
  }

  // ── Index team memberships ──
  const teamMemberships = new Map<number, { name: string; memberIds: number[] }>();
  for (const row of teamRes.rows) {
    const teamId = Number(row.team_id);
    if (!teamMemberships.has(teamId)) {
      teamMemberships.set(teamId, { name: row.team_name, memberIds: [] });
    }
    teamMemberships.get(teamId)!.memberIds.push(Number(row.employee_id));
  }

  return {
    employees: empRes.rows,
    pulseByEmployee,
    integrationByEmployee,
    okrByOwnerName,
    teamMemberships,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROLLUP HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function avgSignals(signals: EmployeeSignals[]) {
  if (signals.length === 0) return { burnout: 0, bandwidth: 0, retention: 0, friction: 0 };
  const n = signals.length;
  return {
    burnout:   Math.round(signals.reduce((s, e) => s + e.burnout_probability,    0) / n),
    bandwidth: Math.round(signals.reduce((s, e) => s + e.bandwidth_overload,     0) / n),
    retention: Math.round(signals.reduce((s, e) => s + e.retention_risk,         0) / n),
    friction:  Math.round(signals.reduce((s, e) => s + e.communication_friction, 0) / n),
  };
}

function healthScore(b: number, bw: number, r: number, f: number): number {
  return Math.round(100 - (b + bw + r + f) / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute signals for a single employee. Runs targeted per-employee queries.
 * Use for employee detail views. Use computeOrgSignals for bulk processing.
 */
export async function computeEmployeeSignals(
  orgId: number,
  employeeId: number,
): Promise<EmployeeSignals | null> {
  const [empRes, pulseRes, integrationRes, okrRes] = await Promise.all([
    pool.query<EmployeeRow>(
      `SELECT id, first_name, last_name, email, department,
              COALESCE(burnout_score, 50)        AS burnout_score,
              COALESCE(morale_score, 75)         AS morale_score,
              COALESCE(stress_resilience, 70)    AS stress_resilience,
              COALESCE(cognitive_agility, 80)    AS cognitive_agility,
              collaboration_style, hire_date, status
       FROM employees WHERE organization_id = $1 AND id = $2`,
      [orgId, employeeId],
    ),
    pool.query(
      `SELECT pq.category, AVG(pa.numeric_answer) AS avg_score
       FROM pulse_answers pa
       JOIN pulse_questions pq ON pq.id = pa.question_id
       JOIN pulse_responses pr ON pr.id = pa.response_id
       JOIN users u             ON u.id  = pr.employee_id
       JOIN employees e         ON LOWER(e.email) = LOWER(u.email)
                               AND e.organization_id = pr.organization_id
       WHERE pr.organization_id = $1
         AND e.id = $2
         AND pr.completed_at >= NOW() - INTERVAL '30 days'
       GROUP BY pq.category`,
      [orgId, employeeId],
    ),
    pool.query(
      `SELECT idc.data_type, AVG(idc.numeric_value) AS avg_value
       FROM integration_data_cache idc
       JOIN employees e ON e.organization_id = idc.organization_id
         AND (
           CAST(e.id AS TEXT) = CAST(idc.employee_id AS TEXT)
           OR LOWER(e.email) = LOWER(idc.employee_email)
         )
       WHERE idc.organization_id = $1 AND e.id = $2
         AND idc.data_type IN (
           'overtime_hours','absenteeism_rate',
           'engagement_score','burnout_signal','communication_frequency'
         )
         AND idc.synced_at >= NOW() - INTERVAL '30 days'
       GROUP BY idc.data_type`,
      [orgId, employeeId],
    ),
    pool.query(
      `SELECT TRIM(LOWER(owner)) AS owner_key,
              COALESCE(
                COUNT(*) FILTER (WHERE status IN ('at_risk','off_track'))
                  * 100.0 / NULLIF(COUNT(*), 0), 0
              ) AS at_risk_ratio,
              AVG(COALESCE(progress, 0)) AS avg_progress
       FROM objectives
       WHERE organization_id = $1
       GROUP BY TRIM(LOWER(owner))`,
      [orgId],
    ),
  ]);

  if (empRes.rows.length === 0) return null;
  const emp = empRes.rows[0];

  const pulse = new Map<string, number>();
  for (const row of pulseRes.rows) {
    const normalized = pulseNorm(parseFloat(row.avg_score));
    pulse.set(row.category, row.category === 'burnout' ? 100 - normalized : normalized);
  }

  const integration = new Map<string, number>();
  for (const row of integrationRes.rows) {
    integration.set(row.data_type, parseFloat(row.avg_value));
  }

  const ownerKey = `${emp.first_name} ${emp.last_name}`.trim().toLowerCase();
  const okrRow = okrRes.rows.find(r => r.owner_key === ownerKey);
  const okr = okrRow
    ? { atRiskRatio: parseFloat(okrRow.at_risk_ratio), avgProgress: parseFloat(okrRow.avg_progress) }
    : undefined;

  return computeSignalsForEmployee(emp, orgId, pulse, integration, okr);
}

/**
 * Compute and return team-level signal rollups for all teams in the org.
 * Employees not on any team are excluded from team rollups but not from org rollups.
 */
export async function computeTeamSignals(orgId: number): Promise<TeamSignals[]> {
  const raw = await loadOrgRawData(orgId);
  const now = new Date().toISOString();

  // Pre-compute all employee signals
  const empSignalMap = new Map<number, EmployeeSignals>();
  for (const emp of raw.employees) {
    const ownerKey = `${emp.first_name} ${emp.last_name}`.trim().toLowerCase();
    const signals = computeSignalsForEmployee(
      emp, orgId,
      raw.pulseByEmployee.get(emp.id)       ?? new Map(),
      raw.integrationByEmployee.get(emp.id) ?? new Map(),
      raw.okrByOwnerName.get(ownerKey),
    );
    empSignalMap.set(emp.id, signals);
  }

  const teamResults: TeamSignals[] = [];

  for (const [teamId, { name, memberIds }] of raw.teamMemberships) {
    const members = memberIds
      .map(id => empSignalMap.get(id))
      .filter((s): s is EmployeeSignals => s !== undefined);

    if (members.length === 0) continue;

    const avgs = avgSignals(members);

    teamResults.push({
      team_id:    teamId,
      team_name:  name,
      member_count: members.length,
      computed_at: now,

      avg_burnout_probability:    avgs.burnout,
      avg_bandwidth_overload:     avgs.bandwidth,
      avg_retention_risk:         avgs.retention,
      avg_communication_friction: avgs.friction,

      team_health_score: healthScore(avgs.burnout, avgs.bandwidth, avgs.retention, avgs.friction),

      at_risk_count: members.filter(m =>
        Math.max(m.burnout_probability, m.bandwidth_overload, m.retention_risk, m.communication_friction) >= 70
      ).length,
      critical_count: members.filter(m =>
        Math.max(m.burnout_probability, m.bandwidth_overload, m.retention_risk, m.communication_friction) >= 85
      ).length,

      members,
    });
  }

  return teamResults.sort((a, b) => a.team_health_score - b.team_health_score); // worst first
}

/**
 * Compute org-wide signals: all employee signals, team rollups, department
 * rollups, and KPI summary. This is the primary payload read by EI-Core.
 */
export async function computeOrgSignals(orgId: number): Promise<OrgSignals> {
  const raw = await loadOrgRawData(orgId);
  const now = new Date().toISOString();

  // ── Compute all employee signals ──────────────────────────────────────────
  const allEmployeeSignals: EmployeeSignals[] = raw.employees.map(emp => {
    const ownerKey = `${emp.first_name} ${emp.last_name}`.trim().toLowerCase();
    return computeSignalsForEmployee(
      emp, orgId,
      raw.pulseByEmployee.get(emp.id)       ?? new Map(),
      raw.integrationByEmployee.get(emp.id) ?? new Map(),
      raw.okrByOwnerName.get(ownerKey),
    );
  });

  // ── Team rollups ──────────────────────────────────────────────────────────
  const empSignalMap = new Map(allEmployeeSignals.map(s => [s.employee_id, s]));
  const teamSignals: TeamSignals[] = [];

  for (const [teamId, { name, memberIds }] of raw.teamMemberships) {
    const members = memberIds
      .map(id => empSignalMap.get(id))
      .filter((s): s is EmployeeSignals => s !== undefined);
    if (members.length === 0) continue;

    const avgs = avgSignals(members);
    teamSignals.push({
      team_id:    teamId,
      team_name:  name,
      member_count: members.length,
      computed_at: now,
      avg_burnout_probability:    avgs.burnout,
      avg_bandwidth_overload:     avgs.bandwidth,
      avg_retention_risk:         avgs.retention,
      avg_communication_friction: avgs.friction,
      team_health_score: healthScore(avgs.burnout, avgs.bandwidth, avgs.retention, avgs.friction),
      at_risk_count:  members.filter(m => Math.max(m.burnout_probability, m.bandwidth_overload, m.retention_risk, m.communication_friction) >= 70).length,
      critical_count: members.filter(m => Math.max(m.burnout_probability, m.bandwidth_overload, m.retention_risk, m.communication_friction) >= 85).length,
      members,
    });
  }

  // ── Department rollups ────────────────────────────────────────────────────
  const deptMap = new Map<string, EmployeeSignals[]>();
  for (const s of allEmployeeSignals) {
    const dept = s.department ?? 'Unassigned';
    if (!deptMap.has(dept)) deptMap.set(dept, []);
    deptMap.get(dept)!.push(s);
  }

  const byDepartment: DepartmentRollup[] = [];
  for (const [dept, members] of deptMap) {
    const avgs = avgSignals(members);
    byDepartment.push({
      department:     dept,
      employee_count: members.length,
      avg_burnout_probability:    avgs.burnout,
      avg_bandwidth_overload:     avgs.bandwidth,
      avg_retention_risk:         avgs.retention,
      avg_communication_friction: avgs.friction,
      health_score: healthScore(avgs.burnout, avgs.bandwidth, avgs.retention, avgs.friction),
      at_risk_count: members.filter(m =>
        Math.max(m.burnout_probability, m.bandwidth_overload, m.retention_risk, m.communication_friction) >= 70
      ).length,
    });
  }

  byDepartment.sort((a, b) => a.health_score - b.health_score); // worst first

  // ── Org-level aggregates ──────────────────────────────────────────────────
  const orgAvgs = avgSignals(allEmployeeSignals);
  const atRiskCount  = allEmployeeSignals.filter(m => Math.max(m.burnout_probability, m.bandwidth_overload, m.retention_risk, m.communication_friction) >= 70).length;
  const criticalCount = allEmployeeSignals.filter(m => Math.max(m.burnout_probability, m.bandwidth_overload, m.retention_risk, m.communication_friction) >= 85).length;

  // ── Top-N flags for EI-Core ───────────────────────────────────────────────
  const top5 = (sorted: EmployeeSignals[]) => sorted.slice(0, 5);

  return {
    organization_id: orgId,
    computed_at:     now,
    total_employees: allEmployeeSignals.length,

    avg_burnout_probability:    orgAvgs.burnout,
    avg_bandwidth_overload:     orgAvgs.bandwidth,
    avg_retention_risk:         orgAvgs.retention,
    avg_communication_friction: orgAvgs.friction,

    org_health_score: healthScore(orgAvgs.burnout, orgAvgs.bandwidth, orgAvgs.retention, orgAvgs.friction),

    at_risk_count:  atRiskCount,
    critical_count: criticalCount,

    by_department: byDepartment,
    by_team:       teamSignals.sort((a, b) => a.team_health_score - b.team_health_score),

    top_burnout_risks:   top5([...allEmployeeSignals].sort((a, b) => b.burnout_probability    - a.burnout_probability)),
    top_bandwidth_risks: top5([...allEmployeeSignals].sort((a, b) => b.bandwidth_overload     - a.bandwidth_overload)),
    top_retention_risks: top5([...allEmployeeSignals].sort((a, b) => b.retention_risk         - a.retention_risk)),
    top_friction_risks:  top5([...allEmployeeSignals].sort((a, b) => b.communication_friction - a.communication_friction)),
  };
}
