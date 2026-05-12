// src/services/conflictEngine.ts
// ─────────────────────────────────────────────────────────────────────────────
// Conflict Detection Engine — VeloxSync / Ei-Core
//
// Analyzes signal data to surface interpersonal and structural conflicts before
// they escalate to turnover. Works off existing signal engine output — no
// additional data collection needed.
//
// Signal sources used:
//   communication_friction  — manager pulse, culture pulse, collaboration style
//   burnout_probability      — workload contribution
//   retention_risk           — engagement proxy
//   avg vs individual deltas — morale/workload divergence within teams
// ─────────────────────────────────────────────────────────────────────────────

import { pool } from '../db';
import { computeOrgSignals, computeTeamSignals, EmployeeSignals, TeamSignals } from './signalEngine';

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type ConflictType =
  | 'communication_friction'
  | 'workload_imbalance'
  | 'manager_tension'
  | 'peer_conflict';

export type ConflictSeverity = 'low' | 'medium' | 'high';

export interface AffectedEmployee {
  id: number;
  name: string;
  department: string | null;
  role_in_conflict: string;  // e.g. 'high friction', 'overloaded', 'at-risk'
  signal_value: number;
}

export interface ConflictSignal {
  id: string;
  type: ConflictType;
  severity: ConflictSeverity;
  title: string;
  description: string;
  affected_employees: AffectedEmployee[];
  ai_recommendation: string;
  team_id?: number;
  team_name?: string;
  department?: string;
  detected_at: string;
  resolved?: boolean;
  resolved_at?: string | null;
}

export interface OrgConflictRisk {
  org_health_score: number;
  conflict_risk_score: number;   // 0–100, higher = more conflict risk
  total_signals: number;
  high_signals: number;
  medium_signals: number;
  low_signals: number;
  most_affected_department: string | null;
  signals: ConflictSignal[];
  computed_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function severityFromScore(score: number): ConflictSeverity {
  if (score >= 75) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}

function conflictRiskFromSignals(signals: ConflictSignal[]): number {
  if (signals.length === 0) return 0;
  const weights = { high: 30, medium: 15, low: 5 };
  const raw = signals.reduce((s, c) => s + weights[c.severity], 0);
  return Math.min(100, raw);
}

/** Deterministic ID so the same conflict detected on re-run gets the same id */
function signalId(type: string, scope: string): string {
  return `${type}:${scope}`.replace(/\s+/g, '-').toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// STATIC RECOMMENDATIONS
// Fallback text used in mock mode — AI mode overrides these per signal.
// ─────────────────────────────────────────────────────────────────────────────

const STATIC_RECS: Record<ConflictType, (ctx: string) => string> = {
  communication_friction: (ctx) =>
    `${ctx} Review communication patterns and meeting cadence. A structured team retrospective or 1:1 series can surface unstated friction. Focus on role clarity and feedback loops before assuming interpersonal conflict.`,
  workload_imbalance: (ctx) =>
    `${ctx} Audit task assignments against individual capacity. Facilitate a team standup focused exclusively on workload — not status — to surface hidden bottlenecks and redistribute equitably.`,
  manager_tension: (ctx) =>
    `${ctx} Arrange a private conversation between the manager and affected reports. Use structured dialogue: each person articulates expectations, not grievances. Consider an anonymous pulse survey if direct conversation is premature.`,
  peer_conflict: (ctx) =>
    `${ctx} Identify whether the friction is role-boundary ambiguity or interpersonal. A facilitated team norms session often resolves the former without requiring HR involvement.`,
};

// ─────────────────────────────────────────────────────────────────────────────
// CORE DETECTION — per team
// ─────────────────────────────────────────────────────────────────────────────

function detectFromTeam(team: TeamSignals): ConflictSignal[] {
  const detected: ConflictSignal[] = [];
  const now = new Date().toISOString();
  const members = team.members;
  if (members.length < 2) return [];

  // ── 1. Communication Friction ────────────────────────────────────────────
  // Threshold: avg team communication_friction >= 50, or any member >= 70
  const frictionScores = members.map(m => m.communication_friction);
  const avgFriction = frictionScores.reduce((s, v) => s + v, 0) / frictionScores.length;
  const highFriction = members.filter(m => m.communication_friction >= 70);

  if (avgFriction >= 45 || highFriction.length >= 1) {
    const severity = severityFromScore(Math.max(avgFriction, highFriction[0]?.communication_friction ?? 0));
    const affected = members
      .filter(m => m.communication_friction >= 45)
      .sort((a, b) => b.communication_friction - a.communication_friction)
      .slice(0, 4)
      .map(m => ({
        id: m.employee_id,
        name: `${m.first_name} ${m.last_name}`,
        department: m.department,
        role_in_conflict: 'high friction',
        signal_value: m.communication_friction,
      }));

    if (affected.length > 0) {
      detected.push({
        id: signalId('communication_friction', team.team_name),
        type: 'communication_friction',
        severity,
        title: `Communication friction in ${team.team_name}`,
        description: `Average communication friction score is ${Math.round(avgFriction)}/100 in ${team.team_name} — ${highFriction.length} member${highFriction.length !== 1 ? 's' : ''} above the high-risk threshold of 70. This signal combines manager relationship health, culture pulse responses, and collaboration style mismatches.`,
        affected_employees: affected,
        ai_recommendation: STATIC_RECS.communication_friction(`In ${team.team_name}:`),
        team_id: team.team_id,
        team_name: team.team_name,
        detected_at: now,
      });
    }
  }

  // ── 2. Workload Imbalance ────────────────────────────────────────────────
  // Threshold: burnout spread > 25 points across at least 3 members
  const burnoutScores = members.map(m => m.burnout_probability);
  const bMax = Math.max(...burnoutScores);
  const bMin = Math.min(...burnoutScores);
  const bAvg = burnoutScores.reduce((s, v) => s + v, 0) / burnoutScores.length;

  if (bMax - bMin > 25 && members.length >= 3) {
    const severity = severityFromScore(bMax);
    const overloaded = members
      .filter(m => m.burnout_probability > bAvg + 10)
      .sort((a, b) => b.burnout_probability - a.burnout_probability)
      .slice(0, 4)
      .map(m => ({
        id: m.employee_id,
        name: `${m.first_name} ${m.last_name}`,
        department: m.department,
        role_in_conflict: `overloaded (${Math.round(m.burnout_probability)}/100)`,
        signal_value: m.burnout_probability,
      }));

    if (overloaded.length > 0) {
      detected.push({
        id: signalId('workload_imbalance', team.team_name),
        type: 'workload_imbalance',
        severity,
        title: `Workload imbalance in ${team.team_name}`,
        description: `Burnout probability ranges from ${Math.round(bMin)} to ${Math.round(bMax)}/100 within ${team.team_name} — a ${Math.round(bMax - bMin)}-point spread indicating uneven load distribution. Team average is ${Math.round(bAvg)}/100.`,
        affected_employees: overloaded,
        ai_recommendation: STATIC_RECS.workload_imbalance(`In ${team.team_name}:`),
        team_id: team.team_id,
        team_name: team.team_name,
        detected_at: now,
      });
    }
  }

  // ── 3. Manager Tension ───────────────────────────────────────────────────
  // High communication_friction + high retention_risk = likely manager relationship issue
  const managerRisk = members.filter(
    m => m.communication_friction >= 60 && m.retention_risk >= 55,
  );

  if (managerRisk.length >= 2) {
    const avgScore = managerRisk.reduce((s, m) => s + m.communication_friction + m.retention_risk, 0) / (managerRisk.length * 2);
    const severity = severityFromScore(avgScore);
    detected.push({
      id: signalId('manager_tension', team.team_name),
      type: 'manager_tension',
      severity,
      title: `Manager-report tension detected in ${team.team_name}`,
      description: `${managerRisk.length} team member${managerRisk.length !== 1 ? 's' : ''} in ${team.team_name} show elevated communication friction alongside retention risk — a pattern that Ei-Core associates with manager relationship strain rather than structural workload issues.`,
      affected_employees: managerRisk.map(m => ({
        id: m.employee_id,
        name: `${m.first_name} ${m.last_name}`,
        department: m.department,
        role_in_conflict: 'at-risk',
        signal_value: Math.round((m.communication_friction + m.retention_risk) / 2),
      })),
      ai_recommendation: STATIC_RECS.manager_tension(`In ${team.team_name}:`),
      team_id: team.team_id,
      team_name: team.team_name,
      detected_at: now,
    });
  }

  // ── 4. Peer Conflict ─────────────────────────────────────────────────────
  // Morale divergence > 30 points within a team with >= 3 members
  const moraleScores = members.map(m => {
    // Morale proxy: invert retention_risk and mix with burnout inverse
    return Math.max(0, 100 - m.retention_risk * 0.6 - m.burnout_probability * 0.4);
  });
  const mMax = Math.max(...moraleScores);
  const mMin = Math.min(...moraleScores);

  if (mMax - mMin > 35 && members.length >= 3) {
    const severity = mMax - mMin > 55 ? 'high' : 'medium';
    const lowMorale = members
      .filter((_, i) => moraleScores[i] < (mMin + (mMax - mMin) * 0.4))
      .slice(0, 3)
      .map(m => ({
        id: m.employee_id,
        name: `${m.first_name} ${m.last_name}`,
        department: m.department,
        role_in_conflict: 'disengaged',
        signal_value: Math.round(moraleScores[members.indexOf(m)]),
      }));

    if (lowMorale.length > 0) {
      detected.push({
        id: signalId('peer_conflict', team.team_name),
        type: 'peer_conflict',
        severity,
        title: `Engagement divergence in ${team.team_name}`,
        description: `There is a ${Math.round(mMax - mMin)}-point engagement gap within ${team.team_name}. Wide intra-team engagement divergence is a precursor to peer friction — high-engagement members often become frustrated with disengaged colleagues, and vice versa.`,
        affected_employees: lowMorale,
        ai_recommendation: STATIC_RECS.peer_conflict(`In ${team.team_name}:`),
        team_id: team.team_id,
        team_name: team.team_name,
        detected_at: now,
      });
    }
  }

  return detected;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect conflict signals for a single team.
 * If teamId is provided, filters to that team only.
 */
export async function detectTeamConflicts(
  orgId: number,
  teamId?: number,
): Promise<ConflictSignal[]> {
  const allTeams = await computeTeamSignals(orgId);

  const targets = teamId
    ? allTeams.filter(t => t.team_id === teamId)
    : allTeams;

  const all: ConflictSignal[] = [];
  for (const team of targets) {
    all.push(...detectFromTeam(team));
  }

  // Merge with resolved status from DB
  if (all.length > 0) {
    try {
      const ids = all.map(s => s.id);
      const { rows } = await pool.query<{ signal_id: string; resolved: boolean; resolved_at: string | null }>(
        `SELECT signal_id, resolved, resolved_at FROM conflict_signals
         WHERE organization_id = $1 AND signal_id = ANY($2::text[])`,
        [orgId, ids],
      );
      const resolvedMap = new Map(rows.map(r => [r.signal_id, { resolved: r.resolved, resolved_at: r.resolved_at }]));
      for (const s of all) {
        const stored = resolvedMap.get(s.id);
        if (stored) {
          s.resolved = stored.resolved;
          s.resolved_at = stored.resolved_at;
        }
      }
    } catch {
      // Table may not exist yet — proceed without resolved status
    }
  }

  const severityOrder: Record<ConflictSeverity, number> = { high: 0, medium: 1, low: 2 };
  return all.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
}

/**
 * Org-level rollup of all conflict signals, with aggregate risk score.
 */
export async function computeConflictRisk(orgId: number): Promise<OrgConflictRisk> {
  const [orgSignals, signals] = await Promise.all([
    computeOrgSignals(orgId),
    detectTeamConflicts(orgId),
  ]);

  const active = signals.filter(s => !s.resolved);

  // Department with the most conflict signals
  const deptCount: Record<string, number> = {};
  for (const s of active) {
    const dept = s.department ?? s.affected_employees[0]?.department ?? null;
    if (dept) deptCount[dept] = (deptCount[dept] ?? 0) + 1;
  }
  const mostAffected = Object.entries(deptCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    org_health_score: orgSignals.org_health_score,
    conflict_risk_score: conflictRiskFromSignals(active),
    total_signals: active.length,
    high_signals: active.filter(s => s.severity === 'high').length,
    medium_signals: active.filter(s => s.severity === 'medium').length,
    low_signals: active.filter(s => s.severity === 'low').length,
    most_affected_department: mostAffected,
    signals,
    computed_at: new Date().toISOString(),
  };
}
