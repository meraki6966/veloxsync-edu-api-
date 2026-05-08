// src/services/eicore.ts
// ============================================================
// Ei-Core AI Service — VeloxSync
// Toggle MOCK_AI=true in .env to never hit Together API
// Uses Mixtral-8x7B for dev/testing, Llama-3 for production
// ============================================================

import {
  computeOrgSignals,
  computeEmployeeSignals,
  OrgSignals,
  EmployeeSignals,
  SignalFactor,
} from './signalEngine';
import { sendSlackOrgAlert, sendTeamsOrgAlert } from './alertNotifier';

const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;
const MERAKI_MODEL_ID = process.env.MERAKI_MODEL_ID || 'meta-llama/Llama-3-8b-chat-hf';
const DEV_MODEL_ID = 'mistralai/Mixtral-8x7B-Instruct-v0.1'; // cheap dev model
const USE_MOCK_AI = process.env.MOCK_AI === 'true';
const USE_DEV_MODEL = process.env.NODE_ENV !== 'production';

// ── MOCK RESPONSES — returned in dev when MOCK_AI=true ──────
// Keyed by prompt type so responses feel contextual

const MOCK_RESPONSES: Record<string, string[]> = {
  intervention: [
    "Based on the student's current cognitive load score and overlapping deadlines, I recommend a 48-hour deadline extension. The student has shown consistent engagement but is showing early signs of overload.",
    "This student's IEP status combined with 3+ active high-weight assignments suggests immediate intervention. A 1-on-1 check-in before Thursday is recommended to assess comprehension barriers.",
    "Cognitive load trajectory indicates friction building over the next 72 hours. Consider redistributing assignment weight or offering an alternative submission format.",
  ],
  wellness: [
    "Team wellness indicators are trending positively this week. Two members show elevated stress markers — recommend brief check-ins before Friday's deadline.",
    "Pulse data suggests cognitive fatigue is building across the 11th grade cohort. Consider a low-stakes activity to reset engagement levels.",
    "Overall roster health is stable. Sarah Mitchell and Priya Patel are flagged for proactive support based on load trajectory.",
  ],
  clarity: [
    "Here is a neurodivergent-friendly version of this assignment: Break the task into 3 clear steps. Step 1: Read pages 12-15 only. Step 2: Answer question 1 in 2-3 sentences. Step 3: Draw or describe one idea from the reading.",
    "Simplified version: You need to do two things today. First, finish the reading (pages 20-22). Second, write 3 sentences about what you learned. You can use bullet points if that's easier.",
    "Clear version: This assignment has one goal — explain what photosynthesis is in your own words. Aim for 4-6 sentences. You can use a diagram instead of writing if you prefer.",
  ],
  general: [
    "Based on the available data, I recommend focusing on the top 3 flagged students this week. Their combined load score indicates a high probability of disengagement within 5 days without intervention.",
    "The current roster shows a healthy distribution with 62% of students in sync status. The 2 students in overload should be prioritized for immediate teacher outreach.",
    "Ei-Core analysis complete. No critical interventions required at this time. Continue monitoring Sarah Mitchell and Aiden Torres for load progression.",
  ],
};

function getMockResponse(promptType: string): string {
  const responses = MOCK_RESPONSES[promptType] || MOCK_RESPONSES.general;
  return responses[Math.floor(Math.random() * responses.length)];
}

// ── TOGETHER AI CALL ────────────────────────────────────────

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

async function callTogetherAI(
  messages: Message[],
  maxTokens: number = 300,
  options: { jsonMode?: boolean } = {},
): Promise<string> {
  const model = USE_DEV_MODEL ? DEV_MODEL_ID : MERAKI_MODEL_ID;

  const response = await fetch('https://api.together.xyz/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOGETHER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,       // keep low to save credits
      temperature: 0.7,
      top_p: 0.9,
      stream: false,
      ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Together AI error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || 'No response generated.';
}

// ── PUBLIC EI-CORE METHODS ──────────────────────────────────

/**
 * Generate an intervention recommendation for a student.
 * Uses mock in dev, Together AI in production.
 */
export async function generateIntervention(params: {
  studentName: string;
  cognitiveLoadScore: number;
  hasIEP: boolean;
  missedDeadlines: number;
  activeAssignments: number;
  orgContext?: string;
}): Promise<string> {
  if (USE_MOCK_AI) {
    console.log('[Ei-Core MOCK] generateIntervention called — skipping Together AI');
    return getMockResponse('intervention');
  }

  const messages: Message[] = [
    {
      role: 'system',
      content: `You are Ei-Core, VeloxSync's AI co-pilot for educators. You generate empathetic, actionable intervention recommendations for teachers. Keep responses under 3 sentences. Be specific and student-focused. Never use corporate HR language.${params.orgContext ? `\n\nOrganization context: ${params.orgContext}` : ''}`,
    },
    {
      role: 'user',
      content: `Generate an intervention recommendation for this student:
- Name: ${params.studentName}
- Cognitive Load Score: ${params.cognitiveLoadScore}/100
- IEP Status: ${params.hasIEP ? 'Active IEP' : 'No IEP'}
- Missed Deadlines: ${params.missedDeadlines}
- Active Assignments: ${params.activeAssignments}

What should the teacher do next?`,
    },
  ];

  return callTogetherAI(messages, 150); // 150 tokens max — keeps costs low
}

/**
 * Generate a Clarity Mode translation of an assignment prompt.
 * Result is cached in DB — only called once per assignment.
 */
export async function generateClarityTranslation(params: {
  assignmentTitle: string;
  assignmentDescription: string;
  gradeLevel: string;
}): Promise<string> {
  if (USE_MOCK_AI) {
    console.log('[Ei-Core MOCK] generateClarityTranslation called — skipping Together AI');
    return getMockResponse('clarity');
  }

  const messages: Message[] = [
    {
      role: 'system',
      content: 'You are Ei-Core, an AI assistant that rewrites assignment prompts for neurodivergent students. Make instructions clear, sequential, and concrete. Remove jargon. Use short sentences. Break into numbered steps where possible. Keep the academic integrity of the original task.',
    },
    {
      role: 'user',
      content: `Rewrite this assignment for a ${params.gradeLevel} student with neurodivergent learning needs:

Title: ${params.assignmentTitle}
Instructions: ${params.assignmentDescription}

Provide a clear, step-by-step version.`,
    },
  ];

  return callTogetherAI(messages, 200);
}

/**
 * Generate a wellness summary for the teacher dashboard.
 */
export async function generateWellnessSummary(params: {
  totalStudents: number;
  syncCount: number;
  frictionCount: number;
  overloadCount: number;
  iepCount: number;
}): Promise<string> {
  if (USE_MOCK_AI) {
    console.log('[Ei-Core MOCK] generateWellnessSummary called — skipping Together AI');
    return getMockResponse('wellness');
  }

  const messages: Message[] = [
    {
      role: 'system',
      content: 'You are Ei-Core, a student wellness AI. Generate a brief, empathetic 2-sentence summary of roster health for a teacher. Focus on what action to take today.',
    },
    {
      role: 'user',
      content: `Roster summary:
- Total students: ${params.totalStudents}
- Synced (healthy): ${params.syncCount}
- Friction (at risk): ${params.frictionCount}
- Overload (critical): ${params.overloadCount}
- Students with IEP: ${params.iepCount}

Give me a brief wellness summary and one recommended action for today.`,
    },
  ];

  return callTogetherAI(messages, 120);
}

/**
 * General Ei-Core chat — used by the Edu Catalyst chat button.
 */
export async function eiCoreChat(params: {
  messages: Message[];
  orgContext?: string;
}): Promise<string> {
  if (USE_MOCK_AI) {
    console.log('[Ei-Core MOCK] eiCoreChat called — skipping Together AI');
    return getMockResponse('general');
  }

  const systemMessage: Message = {
    role: 'system',
    content: `You are Ei-Core, VeloxSync's AI co-pilot for educators. You help teachers understand student wellness, cognitive load, and intervention strategies. Be warm, empathetic, and specific. Never use corporate HR jargon. Always center student wellbeing.${params.orgContext ? `\n\nContext: ${params.orgContext}` : ''}`,
  };

  return callTogetherAI([systemMessage, ...params.messages], 300);
}

// ── EI-CORE EDUCATION METHODS ────────────────────────────────

/**
 * Grade band helper — maps a grade_level string to its band label.
 */
function gradeToBand(gradeLevel: string): string {
  if (['K', '1', '2'].includes(gradeLevel)) return 'K-2';
  if (['3', '4', '5'].includes(gradeLevel)) return '3-5';
  if (['6', '7', '8'].includes(gradeLevel)) return '6-8';
  return '9-12';
}

/**
 * Grade-band-aware language for developmental context in prompts.
 */
function gradeBandLanguage(band: string): string {
  switch (band) {
    case 'K-2': return 'early elementary (ages 5-8). Use concrete, nurturing language. Focus on foundational skills, phonics, number sense, and social-emotional readiness.';
    case '3-5': return 'upper elementary (ages 8-11). Focus on skill fluency, reading comprehension, multi-step problem solving, and growing independence.';
    case '6-8': return 'middle school (ages 11-14). Acknowledge social complexity, abstract thinking development, and growing academic demands.';
    case '9-12': return 'high school (ages 14-18). Focus on college/career readiness, analytical reasoning, and long-term goal alignment.';
    default: return 'K-12 student.';
  }
}

/**
 * Learning style descriptor for AI prompt context.
 */
function learningStyleContext(style: string | null): string {
  switch (style) {
    case 'visual': return 'visual learner — responds well to charts, diagrams, color-coding, and visual organizers';
    case 'auditory': return 'auditory learner — benefits from verbal explanation, discussion, read-aloud, and audio resources';
    case 'kinesthetic': return 'kinesthetic learner — learns best through hands-on activities, movement, and tactile experiences';
    case 'reading-writing': return 'reading-writing learner — excels with written notes, lists, reading materials, and written summaries';
    default: return 'learner with unspecified learning style preference';
  }
}

/**
 * Generate a deep student insight including learning summary, interventions, gaps, and strengths.
 */
export async function generateStudentInsight(
  studentId: string,
  profile: {
    first_name: string;
    last_name: string;
    grade_level: string;
    learning_style: string | null;
    has_iep: boolean;
    iep_notes: string | null;
    strengths: string[];
    challenge_areas: string[];
  },
  progress: Array<{
    status: string;
    score: number | null;
    subject: string;
    standard_code: string;
    standard_description: string;
    grade_band: string;
  }>
): Promise<{
  learning_summary: string;
  recommended_interventions: string[];
  strengths_to_build: string[];
  gaps_to_address: string[];
  suggested_resources: string[];
}> {
  if (USE_MOCK_AI) {
    console.log('[Ei-Core MOCK] generateStudentInsight — skipping Together AI');
    return {
      learning_summary: `${profile.first_name} is making steady progress across core subjects. Their ${profile.learning_style || 'individual'} learning style is an asset when properly leveraged.`,
      recommended_interventions: ['Schedule a 1-on-1 check-in to review recent assessment results', 'Provide visual anchor charts for current math unit'],
      strengths_to_build: profile.strengths.length ? profile.strengths : ['Reading fluency', 'Collaborative learning'],
      gaps_to_address: profile.challenge_areas.length ? profile.challenge_areas : ['Fraction operations', 'Paragraph structure'],
      suggested_resources: ['Khan Academy targeted practice', 'Reading A-Z for leveled texts', 'IXL adaptive math drill'],
    };
  }

  const band = gradeToBand(profile.grade_level);
  const mastered = progress.filter(p => p.status === 'mastered');
  const gaps = progress.filter(p => p.status === 'needs_review' || (p.score !== null && p.score < 60));
  const inProgress = progress.filter(p => p.status === 'in_progress');

  const masteredList = mastered.map(p => `${p.subject}: ${p.standard_code}`).join(', ') || 'None recorded yet';
  const gapList = gaps.map(p => `${p.subject}: ${p.standard_description} (score: ${p.score ?? 'N/A'})`).join('\n') || 'None identified';
  const inProgressList = inProgress.map(p => `${p.subject}: ${p.standard_code}`).join(', ') || 'None';

  const messages: Message[] = [
    {
      role: 'system',
      content: `You are Ei-Core, an education intelligence AI. Generate structured student insights for teachers. Be specific, actionable, and empathetic. Grade band context: ${gradeBandLanguage(band)}. Respond ONLY with valid JSON matching the exact schema provided.`,
    },
    {
      role: 'user',
      content: `Generate a complete learning insight for this student:

Student: ${profile.first_name} ${profile.last_name}
Grade: ${profile.grade_level} (${band})
Learning Style: ${learningStyleContext(profile.learning_style)}
IEP: ${profile.has_iep ? `Yes — ${profile.iep_notes || 'IEP notes not provided'}` : 'No'}
Known Strengths: ${profile.strengths.join(', ') || 'Not recorded'}
Challenge Areas: ${profile.challenge_areas.join(', ') || 'Not recorded'}

Curriculum Progress:
- Mastered: ${masteredList}
- In Progress: ${inProgressList}
- Gaps/Needs Review:
${gapList}

Return a JSON object with EXACTLY these keys:
{
  "learning_summary": "2-3 sentence narrative about this student's current learning status",
  "recommended_interventions": ["array of 3-4 specific teacher action items"],
  "strengths_to_build": ["array of 2-3 strength areas to leverage"],
  "gaps_to_address": ["array of 2-4 specific skill gaps"],
  "suggested_resources": ["array of 3-5 specific resources or tools"]
}`,
    },
  ];

  try {
    const raw = await callTogetherAI(messages, 500, { jsonMode: true });
    return JSON.parse(raw);
  } catch {
    return {
      learning_summary: `${profile.first_name} has ${mastered.length} mastered standards and ${gaps.length} areas needing review.`,
      recommended_interventions: ['Review gap standards with targeted mini-lessons', 'Schedule progress check-in'],
      strengths_to_build: profile.strengths.length ? profile.strengths : ['Building from mastered standards'],
      gaps_to_address: gaps.map(g => g.subject + ': ' + g.standard_code),
      suggested_resources: ['Khan Academy', 'Teacher-created anchor charts', 'IXL adaptive practice'],
    };
  }
}

/**
 * Generate a class-level insight with at-risk identification and pacing recommendations.
 */
export async function generateClassInsight(
  classroomId: string,
  students: Array<{
    id: string;
    first_name: string;
    last_name: string;
    grade_level: string;
    has_iep: boolean;
    learning_style: string | null;
    mastered_count: number;
    needs_review_count: number;
    in_progress_count: number;
  }>
): Promise<{
  class_health_summary: string;
  at_risk_students: Array<{ name: string; reason: string; priority: string }>;
  pacing_recommendations: string[];
  differentiation_strategies: string[];
}> {
  if (USE_MOCK_AI) {
    console.log('[Ei-Core MOCK] generateClassInsight — skipping Together AI');
    const atRisk = students
      .filter(s => s.needs_review_count > 2 || s.has_iep)
      .map(s => ({ name: `${s.first_name} ${s.last_name}`, reason: s.has_iep ? 'Active IEP' : 'Multiple standards needing review', priority: 'high' }));
    return {
      class_health_summary: `Class of ${students.length} students is progressing. ${atRisk.length} student(s) flagged for additional support.`,
      at_risk_students: atRisk.slice(0, 5),
      pacing_recommendations: ['Review needs-review standards before introducing next unit', 'Consider small-group rotations for differentiated instruction'],
      differentiation_strategies: ['Pair visual learners with graphic organizers', 'Offer kinesthetic stations for concept reinforcement'],
    };
  }

  const atRiskRaw = students.filter(s => s.needs_review_count > 1 || s.mastered_count === 0);
  const avgMastery = students.length
    ? Math.round(students.reduce((sum, s) => sum + s.mastered_count, 0) / students.length)
    : 0;
  const iepCount = students.filter(s => s.has_iep).length;

  const studentSummary = students
    .slice(0, 20)
    .map(s => `${s.first_name} ${s.last_name} (Gr ${s.grade_level}): mastered=${s.mastered_count}, needs_review=${s.needs_review_count}, IEP=${s.has_iep}`)
    .join('\n');

  const messages: Message[] = [
    {
      role: 'system',
      content: 'You are Ei-Core, a classroom intelligence AI. Generate class-level insights for teachers. Be practical, concise, and focused on actionable differentiation. Respond ONLY with valid JSON.',
    },
    {
      role: 'user',
      content: `Analyze this classroom and generate insights:

Total Students: ${students.length}
Students with IEP: ${iepCount}
Avg Mastered Standards: ${avgMastery}
At-Risk Count (needs review > 1): ${atRiskRaw.length}

Student Breakdown:
${studentSummary}

Return a JSON object with EXACTLY these keys:
{
  "class_health_summary": "2-3 sentence class health narrative",
  "at_risk_students": [{"name": "...", "reason": "...", "priority": "high|medium|low"}],
  "pacing_recommendations": ["array of 2-3 pacing suggestions"],
  "differentiation_strategies": ["array of 3-4 differentiation strategies"]
}`,
    },
  ];

  try {
    const raw = await callTogetherAI(messages, 500, { jsonMode: true });
    return JSON.parse(raw);
  } catch {
    return {
      class_health_summary: `Class of ${students.length} students. Average mastery: ${avgMastery} standards. ${atRiskRaw.length} students flagged for review.`,
      at_risk_students: atRiskRaw.slice(0, 5).map(s => ({
        name: `${s.first_name} ${s.last_name}`,
        reason: s.needs_review_count > 1 ? `${s.needs_review_count} standards needing review` : 'No mastered standards yet',
        priority: s.has_iep ? 'high' : 'medium',
      })),
      pacing_recommendations: ['Review gap standards before advancing units', 'Use formative assessment before whole-class re-teach'],
      differentiation_strategies: ['Small-group pull-aside for review students', 'Enrichment tasks for mastery-level students'],
    };
  }
}

/**
 * Generate curriculum recommendations mapped to state standards framework, grade, and learning style.
 */
export async function generateCurriculumRecommendation(
  gradeLevel: string,
  state: string | null,
  subject: string,
  learningStyle: string | null,
  gaps: string[]
): Promise<{
  framework: string;
  grade_band: string;
  recommendations: string[];
  resources: string[];
  alignment_notes: string;
}> {
  if (USE_MOCK_AI) {
    console.log('[Ei-Core MOCK] generateCurriculumRecommendation — skipping Together AI');
    const band = gradeToBand(gradeLevel);
    return {
      framework: state === 'TX' ? 'TEKS' : state === 'FL' ? 'NGSSS' : state === 'CA' ? 'California ELA' : 'Common Core',
      grade_band: band,
      recommendations: [
        `Use visual anchor charts to scaffold ${subject} concepts for ${band} learners`,
        `Incorporate hands-on manipulatives for concrete understanding of key standards`,
        `Use spaced repetition review for gap areas: ${gaps.slice(0, 2).join(', ') || 'identified standards'}`,
        `Leverage leveled readers to build comprehension alongside content`,
      ],
      resources: ['Khan Academy', 'ReadWorks', 'Illustrative Mathematics', 'BrainPOP', 'Teachers Pay Teachers'],
      alignment_notes: `Recommendations align with ${state || 'Common Core'} standards for grade ${gradeLevel} ${subject}.`,
    };
  }

  const band = gradeToBand(gradeLevel);
  const frameworkMap: Record<string, string> = {
    TX: 'Texas TEKS', FL: 'Florida NGSSS', CA: 'California State Standards',
    NY: 'New York State Learning Standards', VA: 'Virginia SOLs', AC: 'ACSI Standards',
  };
  const framework = state ? (frameworkMap[state] || 'Common Core State Standards') : 'Common Core State Standards';

  const messages: Message[] = [
    {
      role: 'system',
      content: `You are Ei-Core, a curriculum advisor AI. Generate specific, actionable curriculum recommendations for teachers. Be grade-appropriate and standards-aligned. Grade context: ${gradeBandLanguage(band)}. Respond ONLY with valid JSON.`,
    },
    {
      role: 'user',
      content: `Generate curriculum recommendations:

Grade Level: ${gradeLevel} (${band})
State: ${state || 'Not specified — use Common Core'}
Standards Framework: ${framework}
Subject: ${subject}
Learning Style: ${learningStyleContext(learningStyle)}
Identified Gaps: ${gaps.length ? gaps.join(', ') : 'No specific gaps identified — provide general recommendations'}

Return a JSON object with EXACTLY these keys:
{
  "framework": "standards framework name",
  "grade_band": "${band}",
  "recommendations": ["array of 3-5 specific curriculum recommendations tailored to learning style and gaps"],
  "resources": ["array of 4-6 specific named resources, tools, or programs"],
  "alignment_notes": "1-2 sentences on how recommendations align to the specified state standards"
}`,
    },
  ];

  try {
    const raw = await callTogetherAI(messages, 500, { jsonMode: true });
    return JSON.parse(raw);
  } catch {
    return {
      framework,
      grade_band: band,
      recommendations: [
        `Focus on ${subject} foundational standards for grade ${gradeLevel}`,
        `Use ${learningStyle || 'multi-modal'} instructional strategies`,
        gaps.length ? `Target gap areas: ${gaps.join(', ')}` : 'Build fluency across core standards',
      ],
      resources: ['Khan Academy', 'IXL', 'BrainPOP', 'CommonLit', 'Desmos'],
      alignment_notes: `Aligned to ${framework} for grade ${gradeLevel} ${subject}.`,
    };
  }
}

// ── STATUS HELPER — useful for health checks ────────────────

export function getEiCoreStatus(): {
  mode: string;
  model: string;
  mockEnabled: boolean;
} {
  return {
    mode: USE_MOCK_AI ? 'mock' : USE_DEV_MODEL ? 'dev' : 'production',
    model: USE_MOCK_AI ? 'mock' : USE_DEV_MODEL ? DEV_MODEL_ID : MERAKI_MODEL_ID,
    mockEnabled: USE_MOCK_AI,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL-DRIVEN INSIGHT TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface OrgInsightAtRisk {
  employee_name: string;
  primary_signal: 'burnout_probability' | 'bandwidth_overload' | 'retention_risk' | 'communication_friction';
  signal_value: number;
  recommended_action: string;
}

export interface OrgInsightAction {
  priority: 'immediate' | 'this_week' | 'this_month';
  action: string;
  /** Who or what this targets — e.g. "Engineering team", "Flagged employees" */
  target: string;
  rationale: string;
}

export interface OrgInsightResponse {
  /** 2–3 sentence summary for the exec dashboard. */
  executive_summary: string;
  top_at_risk: OrgInsightAtRisk[];
  recommended_actions: OrgInsightAction[];
  /** 0–100. Sourced directly from computeOrgSignals — not AI-generated. */
  org_health_score: number;
  /** 0–1. Mean data confidence across all employee signal computations. */
  data_confidence: number;
  generated_at: string;
}

export interface EmployeeInsightAction {
  action: string;
  timing: 'today' | 'next_1:1' | 'this_week' | 'this_month';
  rationale: string;
}

export interface EmployeeInsightResponse {
  /** 2–3 sentence coaching brief for the employee's manager. */
  coaching_summary: string;
  primary_concern: 'burnout_probability' | 'bandwidth_overload' | 'retention_risk' | 'communication_friction';
  signal_scores: {
    burnout_probability:    number;
    bandwidth_overload:     number;
    retention_risk:         number;
    communication_friction: number;
  };
  suggested_actions: EmployeeInsightAction[];
  /** Specific questions the manager can open with in their next 1:1. */
  conversation_starters: string[];
  /** True when any signal exceeds 85 — flags for HR escalation. */
  escalate_to_hr: boolean;
  data_confidence: number;
  generated_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON CALL HELPER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calls Together AI with JSON mode enabled and parses the response.
 * Falls back to `fallback` if the model returns unparseable content.
 * Strips markdown code fences that some models add around JSON.
 */
async function callTogetherAIJson<T>(
  messages: Message[],
  maxTokens: number,
  fallback: T,
): Promise<T> {
  try {
    const raw = await callTogetherAI(messages, maxTokens, { jsonMode: true });
    // Strip optional markdown code fences (```json ... ```)
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON object found in response');
    return JSON.parse(match[0]) as T;
  } catch (err: any) {
    console.error('[Ei-Core] JSON parse failed, using fallback:', err.message);
    return fallback;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

function primarySignal(s: EmployeeSignals): OrgInsightAtRisk['primary_signal'] {
  const scores: Array<[OrgInsightAtRisk['primary_signal'], number]> = [
    ['burnout_probability',    s.burnout_probability],
    ['bandwidth_overload',     s.bandwidth_overload],
    ['retention_risk',         s.retention_risk],
    ['communication_friction', s.communication_friction],
  ];
  return scores.sort((a, b) => b[1] - a[1])[0][0];
}

function confidenceLabel(c: number): string {
  if (c >= 0.75) return 'high — multiple integrated data sources';
  if (c >= 0.45) return 'moderate — some signals estimated from stored scores';
  return 'low — limited data; treat as directional indicator only';
}

/** Top 2 factors by value for a given signal, formatted for the prompt. */
function topFactors(factors: SignalFactor[]): string {
  return factors
    .filter(f => f.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 2)
    .map(f => `${f.name} (${f.value}/100, source: ${f.source})`)
    .join('; ');
}

function buildOrgInsightPrompt(signals: OrgSignals): string {
  const top3 = [
    ...signals.top_burnout_risks,
    ...signals.top_bandwidth_risks,
    ...signals.top_retention_risks,
  ]
    .sort((a, b) =>
      Math.max(b.burnout_probability, b.bandwidth_overload, b.retention_risk, b.communication_friction) -
      Math.max(a.burnout_probability, a.bandwidth_overload, a.retention_risk, a.communication_friction)
    )
    .filter((e, i, arr) => arr.findIndex(x => x.employee_id === e.employee_id) === i)
    .slice(0, 3);

  const deptLines = signals.by_department
    .slice(0, 3)
    .map(d => `  - ${d.department}: health ${d.health_score}/100, at-risk count ${d.at_risk_count}`)
    .join('\n');

  const teamLines = signals.by_team
    .slice(0, 3)
    .map(t => `  - ${t.team_name}: health ${t.team_health_score}/100, at-risk ${t.at_risk_count}`)
    .join('\n');

  const empLines = top3.map((e, i) => {
    const ps = primarySignal(e);
    return `${i + 1}. ${e.first_name} ${e.last_name} | Dept: ${e.department ?? 'Unknown'} | Risk level: ${e.risk_level}
   Burnout: ${e.burnout_probability} | Bandwidth: ${e.bandwidth_overload} | Retention: ${e.retention_risk} | Friction: ${e.communication_friction}
   Primary signal: ${ps} (${e[ps]}/100)
   Top factors: ${topFactors(e.factors[ps.replace('_probability','').replace('_overload','').replace('_risk','').replace('_friction','') as keyof typeof e.factors] ?? [])}`;
  }).join('\n\n');

  return `Organization Signal Report
Computed: ${signals.computed_at}
Active employees: ${signals.total_employees}
Org health score: ${signals.org_health_score}/100
Data confidence: ${confidenceLabel(signals.by_department.length > 0 ? 0.6 : 0.3)}

Signal averages (0-100, higher = more risk):
  Burnout Probability: ${signals.avg_burnout_probability}
  Bandwidth Overload:  ${signals.avg_bandwidth_overload}
  Retention Risk:      ${signals.avg_retention_risk}
  Communication Friction: ${signals.avg_communication_friction}

At-risk employees (any signal ≥ 70): ${signals.at_risk_count}
Critical employees (any signal ≥ 85): ${signals.critical_count}

Top at-risk employees:
${empLines || '  None above threshold.'}

Worst departments by health score:
${deptLines || '  No department data.'}

Worst teams by health score:
${teamLines || '  No team data.'}`;
}

function buildEmployeeInsightPrompt(signals: EmployeeSignals): string {
  const ps = primarySignal(signals);
  const psKey = ps.replace('_probability','').replace('_overload','').replace('_risk','').replace('_friction','') as keyof typeof signals.factors;

  const factorBlock = (label: string, factors: SignalFactor[], score: number) =>
    `${label}: ${score}/100\n  Top drivers: ${topFactors(factors) || 'stored baseline score'}`;

  return `Employee Signal Report
Name: ${signals.first_name} ${signals.last_name}
Department: ${signals.department ?? 'Unknown'}
Risk level: ${signals.risk_level}
Data confidence: ${confidenceLabel(signals.data_confidence)} (${Math.round(signals.data_confidence * 100)}%)

Signal scores (0-100, higher = more risk):
${factorBlock('Burnout Probability',    signals.factors.burnout,       signals.burnout_probability)}
${factorBlock('Bandwidth Overload',     signals.factors.bandwidth,     signals.bandwidth_overload)}
${factorBlock('Retention Risk',         signals.factors.retention,     signals.retention_risk)}
${factorBlock('Communication Friction', signals.factors.communication, signals.communication_friction)}

Primary concern: ${ps} at ${signals[ps]}/100
Escalation threshold (85): ${signals[ps] >= 85 ? 'EXCEEDED — HR awareness recommended' : 'not reached'}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MOCK FACTORIES  (use real signal scores, template AI text)
// ─────────────────────────────────────────────────────────────────────────────

function mockOrgInsight(signals: OrgSignals): OrgInsightResponse {
  const top3 = [
    ...signals.top_burnout_risks.slice(0, 1),
    ...signals.top_bandwidth_risks.slice(0, 1),
    ...signals.top_retention_risks.slice(0, 1),
  ].filter((e, i, arr) => arr.findIndex(x => x.employee_id === e.employee_id) === i);

  const healthLabel = signals.org_health_score >= 75 ? 'stable' :
                      signals.org_health_score >= 50 ? 'moderate strain' : 'significant strain';

  return {
    executive_summary: `Your organization is showing ${healthLabel} with an overall health score of ${signals.org_health_score}/100. ${signals.at_risk_count} employee${signals.at_risk_count !== 1 ? 's are' : ' is'} above the at-risk threshold across burnout, bandwidth, retention, and communication signals. ${signals.critical_count > 0 ? `${signals.critical_count} individual${signals.critical_count !== 1 ? 's require' : ' requires'} immediate attention.` : 'No employees have crossed the critical threshold at this time.'}`,

    top_at_risk: top3.map(e => {
      const ps = primarySignal(e);
      const actions: Record<OrgInsightAtRisk['primary_signal'], string> = {
        burnout_probability:    'Schedule a 1:1 this week to discuss workload, energy levels, and whether they have enough support to sustain their current pace.',
        bandwidth_overload:     'Review their current project assignments — look for hidden dependencies or work that isn\'t tracked in the system.',
        retention_risk:         'Open a career development conversation before their next review cycle; their recent pulse scores suggest waning connection to the org.',
        communication_friction: 'Check in on their team relationships and whether they have clarity on their role and priorities.',
      };
      return {
        employee_name: `${e.first_name} ${e.last_name}`,
        primary_signal: ps,
        signal_value: e[ps],
        recommended_action: actions[ps],
      };
    }),

    recommended_actions: [
      {
        priority: 'immediate' as const,
        action: `Conduct targeted 1:1s with the ${signals.at_risk_count} flagged employee${signals.at_risk_count !== 1 ? 's' : ''} within the next 5 business days.`,
        target: 'At-risk employees',
        rationale: 'Early intervention at the elevated threshold significantly reduces escalation to the critical range.',
      },
      {
        priority: 'this_week' as const,
        action: `Run a focused pulse survey for the ${signals.by_department[0]?.department ?? 'highest-risk'} department covering workload and clarity.`,
        target: signals.by_department[0]?.department ?? 'Top at-risk department',
        rationale: `This department has the lowest health score (${signals.by_department[0]?.health_score ?? 'N/A'}/100) with ${signals.by_department[0]?.at_risk_count ?? 0} at-risk members.`,
      },
      {
        priority: 'this_month' as const,
        action: 'Review team capacity allocation before the next planning cycle to address structural load imbalance.',
        target: 'Team leads and project owners',
        rationale: 'Bandwidth overload patterns that persist across planning cycles indicate structural misalignment, not individual performance issues.',
      },
    ],

    org_health_score: signals.org_health_score,
    data_confidence: Math.round(
      signals.top_burnout_risks.reduce((s, e) => s + e.data_confidence, 0) /
      Math.max(signals.top_burnout_risks.length, 1) * 100
    ) / 100,
    generated_at: new Date().toISOString(),
  };
}

function mockEmployeeInsight(signals: EmployeeSignals): EmployeeInsightResponse {
  const ps = primarySignal(signals);
  const psValue = signals[ps];

  const summaries: Record<OrgInsightAtRisk['primary_signal'], string> = {
    burnout_probability:    `${signals.first_name} is showing a burnout probability of ${psValue}/100, driven primarily by ${topFactors(signals.factors.burnout) || 'stored wellness indicators'}. Their engagement signals have been declining over the past 30-day window — a direct conversation about sustainable pace would be a strong starting point.`,
    bandwidth_overload:     `${signals.first_name}'s bandwidth overload score has reached ${psValue}/100, with ${topFactors(signals.factors.bandwidth) || 'stress resilience and workload signals'} as the leading contributors. This pattern often indicates untracked coordination work that isn't visible in the project board.`,
    retention_risk:         `${signals.first_name} is showing a retention risk score of ${psValue}/100. Their eNPS and morale signals have softened recently, which typically precedes disengagement. A career development conversation — not a performance check-in — is the recommended approach.`,
    communication_friction: `${signals.first_name} has a communication friction score of ${psValue}/100, with manager relationship and team culture signals as the primary contributors. This doesn't necessarily indicate conflict — it may reflect unclear role boundaries or insufficient feedback loops.`,
  };

  const allActions: Record<OrgInsightAtRisk['primary_signal'], EmployeeInsightAction[]> = {
    burnout_probability: [
      { action: 'Open the 1:1 by asking what part of their work is taking the most energy right now — not what\'s on their list.', timing: 'next_1:1', rationale: 'Burnout often hides in the emotional cost of work, not just the volume.' },
      { action: 'Identify one deliverable that can be deprioritized or handed off this sprint.', timing: 'this_week', rationale: 'A visible reduction in load is more effective than reassurance alone.' },
      { action: 'Follow up in 2 weeks with a lightweight energy check to confirm the conversation had impact.', timing: 'this_month', rationale: 'Short feedback loops catch early re-escalation before it compounds.' },
    ],
    bandwidth_overload: [
      { action: 'Ask specifically about work that isn\'t in the task tracker — meetings, reviews, unplanned requests.', timing: 'next_1:1', rationale: 'Invisible work is the leading cause of bandwidth overload that doesn\'t show in project tools.' },
      { action: 'Audit their current objectives and explicitly drop or defer the lowest-priority one together.', timing: 'this_week', rationale: 'Joint deprioritization is more effective than unilateral reassignment for maintaining trust.' },
      { action: 'Check with their team lead on whether any dependencies are cascading additional work to them.', timing: 'this_week', rationale: 'Bandwidth overload in collaborative roles often has a structural upstream cause.' },
    ],
    retention_risk: [
      { action: 'Frame the 1:1 as a career conversation, not a check-in — ask where they want to be in 12 months.', timing: 'next_1:1', rationale: 'Retention risk is most effectively addressed through growth conversations, not satisfaction surveys.' },
      { action: 'Identify one concrete growth opportunity, stretch assignment, or visibility moment you can offer this quarter.', timing: 'this_week', rationale: 'Tangible investment signals tend to shift eNPS faster than compensation discussions alone.' },
      { action: 'Revisit in 30 days — a single strong 1:1 often produces a measurable pulse improvement within that window.', timing: 'this_month', rationale: 'Retention risk at moderate levels responds well to single interventions when acted on quickly.' },
    ],
    communication_friction: [
      { action: 'Ask whether they feel they have enough clarity on priorities and what\'s expected of their role right now.', timing: 'next_1:1', rationale: 'Communication friction is most commonly driven by ambiguity, not interpersonal conflict.' },
      { action: 'Review whether their communication with you has been consistent — have 1:1s been skipped or shortened recently?', timing: 'today', rationale: 'Manager accessibility is the most controllable factor in communication friction scores.' },
      { action: 'If the friction is team-related, consider a team retrospective or norms-setting session this month.', timing: 'this_month', rationale: 'Structural team interventions address the root cause where individual coaching cannot.' },
    ],
  };

  const starters: Record<OrgInsightAtRisk['primary_signal'], string[]> = {
    burnout_probability:    ['What part of your work right now feels like it\'s taking the most out of you?', 'If you could change one thing about your current workload, what would it be?', 'How are you feeling about your pace going into the next few weeks?'],
    bandwidth_overload:     ['Is there anything on your plate right now that I don\'t know about?', 'If you could take one thing off your list this week, what would it be?', 'Are there any meetings or reviews you\'re in that you\'re not sure you need to be?'],
    retention_risk:         ['Where do you want to be in a year — inside or outside this role?', 'Is there a type of work you\'ve been wanting to do more of that you haven\'t had the chance to?', 'What would make this role feel more exciting to you right now?'],
    communication_friction: ['Do you feel like you have enough clarity on what\'s expected of you right now?', 'Is there anything about how we\'re working together that you\'d want to change?', 'Are there relationships on the team that feel difficult or unclear to you?'],
  };

  return {
    coaching_summary: summaries[ps],
    primary_concern: ps,
    signal_scores: {
      burnout_probability:    signals.burnout_probability,
      bandwidth_overload:     signals.bandwidth_overload,
      retention_risk:         signals.retention_risk,
      communication_friction: signals.communication_friction,
    },
    suggested_actions: allActions[ps],
    conversation_starters: starters[ps],
    escalate_to_hr: signals[ps] >= 85,
    data_confidence: signals.data_confidence,
    generated_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: SIGNAL-DRIVEN INSIGHTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate an org-wide intelligence brief for the executive dashboard.
 *
 * Always calls computeOrgSignals (DB read) regardless of MOCK_AI.
 * MOCK_AI only bypasses the Together AI call — real signal scores are always
 * present in the response.
 */
export async function generateOrgInsight(orgId: number): Promise<OrgInsightResponse> {
  const signals = await computeOrgSignals(orgId);

  let insight: OrgInsightResponse;

  if (USE_MOCK_AI) {
    console.log('[Ei-Core MOCK] generateOrgInsight — skipping Together AI, using real signals');
    insight = mockOrgInsight(signals);
  } else {
    const systemPrompt = `You are EI-Core, VeloxSync's workforce intelligence engine. You analyze organizational signal data and generate concise, actionable insights for senior leaders. Return ONLY valid JSON — no markdown, no explanation outside the JSON object. Be specific, data-driven, and empathetic. Never fabricate employee names or data points beyond what is provided.`;

    const userPrompt = `${buildOrgInsightPrompt(signals)}

Return a JSON object with EXACTLY this structure:
{
  "executive_summary": "<2-3 sentences for the executive dashboard, referencing specific signal values>",
  "top_at_risk": [
    {
      "employee_name": "<first last>",
      "primary_signal": "<burnout_probability|bandwidth_overload|retention_risk|communication_friction>",
      "signal_value": <number 0-100>,
      "recommended_action": "<1 specific, actionable sentence for this person's manager>"
    }
  ],
  "recommended_actions": [
    {
      "priority": "<immediate|this_week|this_month>",
      "action": "<specific action>",
      "target": "<who or what this targets>",
      "rationale": "<1 sentence why>"
    }
  ]
}

Include up to 3 entries in top_at_risk and exactly 3 entries in recommended_actions (one per priority level). Reference the actual signal values from the report above.`;

    const fallback = mockOrgInsight(signals);

    const aiResponse = await callTogetherAIJson<Partial<OrgInsightResponse>>(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      600,
      {},
    );

    insight = {
      executive_summary:   aiResponse.executive_summary   ?? fallback.executive_summary,
      top_at_risk:         aiResponse.top_at_risk          ?? fallback.top_at_risk,
      recommended_actions: aiResponse.recommended_actions  ?? fallback.recommended_actions,
      org_health_score:    signals.org_health_score,   // always from signal engine, never from AI
      data_confidence:     fallback.data_confidence,
      generated_at:        new Date().toISOString(),
    };
  }

  // ── EI-Core Alert: fire Slack / Teams for high-priority orgs ──────────────
  // Thresholds: avg burnout >= 70 OR at-risk count >= 3
  const isHighPriority =
    signals.avg_burnout_probability >= 70 || signals.at_risk_count >= 3;

  if (isHighPriority) {
    sendSlackOrgAlert(orgId, insight, signals).catch(err =>
      console.error('[Ei-Core] Slack alert failed:', err?.message),
    );
    sendTeamsOrgAlert(orgId, insight, signals).catch(err =>
      console.error('[Ei-Core] Teams alert failed:', err?.message),
    );
  }

  return insight;
}

/**
 * Generate personalized coaching guidance for a single employee's manager.
 *
 * Returns null if the employee is not found or not active.
 * Always calls computeEmployeeSignals (DB read) regardless of MOCK_AI.
 */
export async function generateEmployeeInsight(
  orgId: number,
  employeeId: number,
): Promise<EmployeeInsightResponse | null> {
  const signals = await computeEmployeeSignals(orgId, employeeId);
  if (!signals) return null;

  if (USE_MOCK_AI) {
    console.log('[Ei-Core MOCK] generateEmployeeInsight — skipping Together AI, using real signals');
    return mockEmployeeInsight(signals);
  }

  const systemPrompt = `You are EI-Core, VeloxSync's workforce intelligence engine. You generate coaching guidance for managers to use in 1:1 conversations. Return ONLY valid JSON. Write in plain language — the manager reading this is not an HR professional. Be empathetic, specific, and actionable. Ground every recommendation in the signal data provided.`;

  const userPrompt = `${buildEmployeeInsightPrompt(signals)}

Return a JSON object with EXACTLY this structure:
{
  "coaching_summary": "<2-3 sentence brief for the manager, referencing specific signals>",
  "primary_concern": "<burnout_probability|bandwidth_overload|retention_risk|communication_friction>",
  "suggested_actions": [
    {
      "action": "<specific action the manager should take>",
      "timing": "<today|next_1:1|this_week|this_month>",
      "rationale": "<1 sentence why this action addresses the signal>"
    }
  ],
  "conversation_starters": [
    "<question 1>",
    "<question 2>",
    "<question 3>"
  ]
}

Include exactly 3 suggested_actions and exactly 3 conversation_starters. Actions must be specific to the signal data above — do not give generic advice.`;

  const fallback = mockEmployeeInsight(signals);

  const aiResponse = await callTogetherAIJson<Partial<EmployeeInsightResponse>>(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    500,
    {},
  );

  return {
    coaching_summary:       aiResponse.coaching_summary       ?? fallback.coaching_summary,
    primary_concern:        aiResponse.primary_concern        ?? fallback.primary_concern,
    signal_scores:          fallback.signal_scores,           // always from signal engine
    suggested_actions:      aiResponse.suggested_actions      ?? fallback.suggested_actions,
    conversation_starters:  aiResponse.conversation_starters  ?? fallback.conversation_starters,
    escalate_to_hr:         fallback.escalate_to_hr,          // always from signal engine
    data_confidence:        fallback.data_confidence,
    generated_at:           new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFLICT INSIGHT
// ─────────────────────────────────────────────────────────────────────────────

export interface ConflictInsightResponse {
  summary: string;
  mediation_suggestions: string[];
  priority_actions: Array<{
    action: string;
    urgency: 'immediate' | 'this_week' | 'this_month';
    target: string;
  }>;
  generated_at: string;
}

import { ConflictSignal } from './conflictEngine';

/**
 * Takes conflict signals and returns Ei-Core mediation guidance.
 * MOCK_AI returns template text using real signal data.
 */
export async function generateConflictInsight(
  orgId: number,
  signals: ConflictSignal[],
): Promise<ConflictInsightResponse> {
  const active = signals.filter(s => !s.resolved);
  const highCount = active.filter(s => s.severity === 'high').length;
  const medCount = active.filter(s => s.severity === 'medium').length;

  const mockResponse = (): ConflictInsightResponse => ({
    summary: active.length === 0
      ? 'No active conflict signals detected. Ei-Core is monitoring team communication patterns and workload distribution. Continue current management cadence.'
      : highCount > 0
        ? `${active.length} conflict signal${active.length !== 1 ? 's' : ''} detected — ${highCount} require immediate attention. High-severity signals left unaddressed for more than 2 weeks have a 71% escalation rate to voluntary departure. Prioritize structured 1:1s and workload reviews this week.`
        : `${active.length} conflict signal${active.length !== 1 ? 's' : ''} at medium or low severity. These are manageable with structured check-ins and proactive communication. Teams that address medium-severity friction within 2 weeks reduce escalation risk by 68%.`,
    mediation_suggestions: active.length === 0 ? [
      'Maintain current 1:1 cadence — consistent check-ins are the best prevention.',
      'Run a quarterly team health pulse to catch early signals before they surface.',
    ] : [
      ...active.filter(s => s.type === 'communication_friction').map(s =>
        `${s.team_name ?? 'Affected team'}: Host a structured communication retrospective. Ask each member what they need more of, less of, and the same from their teammates.`
      ),
      ...active.filter(s => s.type === 'workload_imbalance').map(s =>
        `${s.team_name ?? 'Affected team'}: Facilitate a capacity mapping session — each member lists their current commitments. Redistribute work visibly, not silently.`
      ),
      ...active.filter(s => s.type === 'manager_tension').map(s =>
        `${s.team_name ?? 'Affected team'}: Manager should conduct 30-minute individual 1:1s with each flagged report before any group discussion. Build individual trust before addressing group dynamics.`
      ),
      ...active.filter(s => s.type === 'peer_conflict').map(s =>
        `${s.team_name ?? 'Affected team'}: Use a team norms exercise. Have members articulate how they prefer to work, receive feedback, and handle disagreements. Normalize differences explicitly.`
      ),
    ].slice(0, 4),
    priority_actions: active.length === 0 ? [
      { action: 'Schedule next quarterly team health review', urgency: 'this_month', target: 'All teams' },
    ] : [
      ...(highCount > 0 ? [{
        action: `Conduct 1:1s with the ${active.filter(s => s.severity === 'high').reduce((n, s) => n + s.affected_employees.length, 0)} employees flagged in high-severity signals`,
        urgency: 'immediate' as const,
        target: 'High-severity signal employees',
      }] : []),
      ...(medCount > 0 ? [{
        action: `Run structured team check-ins for the ${medCount} team${medCount !== 1 ? 's' : ''} with medium-severity signals`,
        urgency: 'this_week' as const,
        target: 'Medium-severity teams',
      }] : []),
      {
        action: 'Review and update workload distribution with team leads before next sprint planning',
        urgency: 'this_month' as const,
        target: 'Team leads',
      },
    ].slice(0, 3),
    generated_at: new Date().toISOString(),
  });

  if (USE_MOCK_AI) {
    console.log('[Ei-Core MOCK] generateConflictInsight — skipping Together AI');
    return mockResponse();
  }

  const signalSummary = active.slice(0, 6).map(s =>
    `- [${s.severity.toUpperCase()}] ${s.title} (${s.type}): ${s.description.slice(0, 120)}...`
  ).join('\n');

  const userPrompt = `Conflict Signal Report for organization ${orgId}
Active signals: ${active.length} (High: ${highCount}, Medium: ${medCount}, Low: ${active.filter(s => s.severity === 'low').length})

Top signals:
${signalSummary || '  None'}

Return a JSON object:
{
  "summary": "<2-3 sentence org-level summary for the manager>",
  "mediation_suggestions": ["<specific suggestion per signal type, 2-4 items>"],
  "priority_actions": [
    { "action": "<specific action>", "urgency": "<immediate|this_week|this_month>", "target": "<who>" }
  ]
}`;

  const fallback = mockResponse();

  const aiResponse = await callTogetherAIJson<Partial<ConflictInsightResponse>>(
    [
      { role: 'system', content: 'You are Ei-Core, VeloxSync\'s workforce intelligence engine. Generate empathetic, specific mediation guidance for managers dealing with team conflict signals. Return ONLY valid JSON. Never fabricate names or data.' },
      { role: 'user', content: userPrompt },
    ],
    500,
    {},
  );

  return {
    summary: aiResponse.summary ?? fallback.summary,
    mediation_suggestions: aiResponse.mediation_suggestions ?? fallback.mediation_suggestions,
    priority_actions: aiResponse.priority_actions ?? fallback.priority_actions,
    generated_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SOVEREIGN PORTFOLIO — Homeschool narrative synthesis
// ─────────────────────────────────────────────────────────────────────────────

const SOVEREIGN_SYSTEM_PROMPT = `You are the Sovereign Education Architect. Your task is to synthesize a semester's worth of raw instructional Signals into a high-fidelity Narrative Summary of Learning. You must speak with the warmth of a mentor and the precision of an educational strategist.

Generate a structured portfolio with four sections:
1. The Opening (The Atmosphere) - describe overall engagement and growth in context of their philosophy. If Classical: focus on Grammar to Logic stage transition. If Montessori: focus on concentration cycles. If Charlotte Mason: focus on living connections and narration depth.
2. The Mastery Narrative - describe Mastery Velocity not grades. Example: In Mathematics, [Student] moved past foundational arithmetic into abstract algebraic reasoning with a 20% increase in signal fluency over 4 weeks.
3. The Human Signal - highlight a specific Cognitive Wall the child hit and the intervention that led to the breakthrough.
4. The Compliance Translation - map philosophical gains to state standard nomenclature.

Tone: Use grounded, professional, observant language. Avoid words like delve, unlock, tapestry. Focus on evidence-based progress over generic praise.`;

export interface StudentData {
  philosophy: 'Classical' | 'Montessori' | 'Charlotte Mason' | 'Eclectic';
  raw_logs: string[];
  mastery_signals: string[];
  cognitive_friction_events: string[];
  student_name: string;
  grade_level: string;
}

const MOCK_SOVEREIGN_PORTFOLIO = `## The Opening (The Atmosphere)

[MOCK] This student demonstrated consistent engagement throughout the semester, showing strong alignment with their chosen educational philosophy. Their learning environment fostered curiosity and self-direction.

## The Mastery Narrative

[MOCK] In core subjects, this student showed measurable progress across all tracked domains. Signal fluency increased approximately 15% over the review period, with particular strength in applied reasoning tasks.

## The Human Signal

[MOCK] A notable cognitive friction event occurred mid-semester around abstract concept formation. Through targeted intervention and adjusted pacing, the student broke through this wall within two weeks, demonstrating adaptive learning capacity.

## The Compliance Translation

[MOCK] Progress maps to grade-level state standards in Language Arts, Mathematics, and Science. Documentation supports portfolio-based assessment requirements for homeschool compliance.`;

export async function generateSovereignPortfolio(studentData: StudentData): Promise<string> {
  if (USE_MOCK_AI) {
    console.log('[Ei-Core MOCK] generateSovereignPortfolio — skipping Together AI');
    return MOCK_SOVEREIGN_PORTFOLIO;
  }

  const userMessage = `Student: ${studentData.student_name}
Grade Level: ${studentData.grade_level}
Philosophy: ${studentData.philosophy}

Raw Instructional Logs:
${studentData.raw_logs.map((l, i) => `${i + 1}. ${l}`).join('\n')}

Mastery Signals:
${studentData.mastery_signals.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Cognitive Friction Events:
${studentData.cognitive_friction_events.map((e, i) => `${i + 1}. ${e}`).join('\n')}

Generate the full four-section portfolio narrative now.`;

  return callTogetherAI(
    [
      { role: 'system', content: SOVEREIGN_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    2048,
  );
}
