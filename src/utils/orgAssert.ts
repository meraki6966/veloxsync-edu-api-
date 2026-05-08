import type { Pool, PoolClient } from 'pg';

type Queryable = Pool | PoolClient;

export class OrgAssertError extends Error {
  status: number;
  constructor(message: string, status = 403) {
    super(message);
    this.name = 'OrgAssertError';
    this.status = status;
  }
}

function coerceScalarId(value: unknown): string | number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}

async function assertRowInOrg(
  table: 'employees' | 'projects' | 'classrooms' | 'students',
  id: unknown,
  orgId: unknown,
  db: Queryable,
  notFoundMessage: string,
): Promise<void> {
  const scalarId = coerceScalarId(id);
  const scalarOrg = coerceScalarId(orgId);
  if (scalarId === null) {
    throw new OrgAssertError(`${notFoundMessage}: id missing`, 400);
  }
  if (scalarOrg === null) {
    throw new OrgAssertError('Not authenticated', 401);
  }
  const result = await db.query(
    `SELECT 1 FROM ${table} WHERE id = $1 AND organization_id = $2 LIMIT 1`,
    [scalarId, scalarOrg],
  );
  if (result.rowCount === 0) {
    throw new OrgAssertError(notFoundMessage, 403);
  }
}

export const assertEmployeeInOrg = (
  employeeId: unknown,
  orgId: unknown,
  db: Queryable,
) => assertRowInOrg('employees', employeeId, orgId, db, 'Employee not found in your organization');

export const assertProjectInOrg = (
  projectId: unknown,
  orgId: unknown,
  db: Queryable,
) => assertRowInOrg('projects', projectId, orgId, db, 'Project not found in your organization');

export const assertClassroomInOrg = (
  classroomId: unknown,
  orgId: unknown,
  db: Queryable,
) => assertRowInOrg('classrooms', classroomId, orgId, db, 'Classroom not found in your organization');

export const assertStudentInOrg = (
  studentId: unknown,
  orgId: unknown,
  db: Queryable,
) => assertRowInOrg('students', studentId, orgId, db, 'Student not found in your organization');

/**
 * Convenience helper for route handlers: respond with the right status if err is an OrgAssertError,
 * otherwise re-throw so the surrounding catch can keep its existing behavior.
 */
export function isOrgAssertError(err: unknown): err is OrgAssertError {
  return err instanceof OrgAssertError;
}
