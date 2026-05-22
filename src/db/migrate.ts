// src/db/migrate.ts
// =============================================================================
// Bootstrap migration for the VeloxSync Education API.
//
// Runs CREATE TABLE IF NOT EXISTS for every table the API touches, in
// FK-dependency order. Idempotent — safe to run on every boot, on top of an
// empty or partially-populated DB.
//
// Schema choices follow the actual code, not a wish list:
//   - organizations / users mirror the canonical schema in the HR repo so the
//     two services can share a DB without column drift if you ever fold them
//     back together.
//   - The seven "edu_*" / education tables mirror the inline CREATE TABLE
//     blocks already embedded in src/routes/edu-billing.ts,
//     edu-integrations.ts, and education-v2.ts (plus the canonical
//     education-schema.sql lifted from the HR repo).
// =============================================================================

import { pool } from '../db';

interface Migration {
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  // ── extensions ────────────────────────────────────────────────────────────
  {
    name: 'extension:pgcrypto',
    sql: `CREATE EXTENSION IF NOT EXISTS pgcrypto;`,
  },

  // ── 1. organizations ──────────────────────────────────────────────────────
  {
    name: 'table:organizations',
    sql: `
      CREATE TABLE IF NOT EXISTS organizations (
        id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name                   VARCHAR(255) NOT NULL,
        slug                   VARCHAR(100) UNIQUE,
        industry               VARCHAR(50),
        industry_type          VARCHAR(50)  DEFAULT 'standard',
        plan                   VARCHAR(50)  DEFAULT 'trial',
        subscription_status    VARCHAR(50)  DEFAULT 'trialing',
        stripe_customer_id     VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        trial_ends_at          TIMESTAMPTZ,
        settings               JSONB        NOT NULL DEFAULT '{}'::jsonb,
        created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_orgs_subscription_status ON organizations(subscription_status);
      CREATE INDEX IF NOT EXISTS idx_orgs_stripe_customer     ON organizations(stripe_customer_id);
    `,
  },

  // ── 2. users ──────────────────────────────────────────────────────────────
  {
    name: 'table:users',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID         REFERENCES organizations(id) ON DELETE CASCADE,
        email           VARCHAR(255) NOT NULL UNIQUE,
        password_hash   VARCHAR(255) NOT NULL,
        first_name      VARCHAR(100),
        last_name       VARCHAR(100),
        role            VARCHAR(50)  DEFAULT 'member',
        is_active       BOOLEAN      DEFAULT TRUE,
        is_super_admin  BOOLEAN      DEFAULT FALSE,
        mfa_enabled     BOOLEAN      DEFAULT FALSE,
        last_login_at   TIMESTAMPTZ,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);
    `,
  },

  // ── 3. classrooms ─────────────────────────────────────────────────────────
  {
    name: 'table:classrooms',
    sql: `
      CREATE TABLE IF NOT EXISTS classrooms (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        teacher_id      UUID         NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
        name            VARCHAR(255) NOT NULL,
        grade_band      VARCHAR(10)  NOT NULL
                          CHECK (grade_band IN ('K-2','3-5','6-8','9-12')),
        school_type     VARCHAR(20)  NOT NULL
                          CHECK (school_type IN ('public','private','charter','homeschool')),
        state           CHAR(2)      NOT NULL,
        subject_areas   TEXT[]       NOT NULL DEFAULT '{}',
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_classrooms_org     ON classrooms(organization_id);
      CREATE INDEX IF NOT EXISTS idx_classrooms_teacher ON classrooms(teacher_id);
    `,
  },

  // ── 4. students ───────────────────────────────────────────────────────────
  {
    name: 'table:students',
    sql: `
      CREATE TABLE IF NOT EXISTS students (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id  UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        classroom_id     UUID         REFERENCES classrooms(id) ON DELETE SET NULL,
        first_name       VARCHAR(100) NOT NULL,
        last_name        VARCHAR(100) NOT NULL,
        grade_level      VARCHAR(3)   NOT NULL
                           CHECK (grade_level IN ('K','1','2','3','4','5','6','7','8','9','10','11','12')),
        age              SMALLINT,
        learning_style   VARCHAR(30)
                           CHECK (learning_style IN ('visual','auditory','kinesthetic','reading-writing')),
        primary_language VARCHAR(50)  DEFAULT 'English',
        has_iep          BOOLEAN      NOT NULL DEFAULT FALSE,
        iep_notes        TEXT,
        strengths        TEXT[]       NOT NULL DEFAULT '{}',
        challenge_areas  TEXT[]       NOT NULL DEFAULT '{}',
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_students_org       ON students(organization_id);
      CREATE INDEX IF NOT EXISTS idx_students_classroom ON students(classroom_id);
    `,
  },

  // ── 5. state_standards ────────────────────────────────────────────────────
  {
    name: 'table:state_standards',
    sql: `
      CREATE TABLE IF NOT EXISTS state_standards (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        state_code           CHAR(2)      NOT NULL,
        grade_band           VARCHAR(10)  NOT NULL
                               CHECK (grade_band IN ('K-2','3-5','6-8','9-12')),
        subject              VARCHAR(100) NOT NULL,
        standard_code        VARCHAR(50)  NOT NULL,
        standard_description TEXT         NOT NULL,
        standard_type        VARCHAR(20)  NOT NULL
                               CHECK (standard_type IN ('core','supplemental')),
        curriculum_framework VARCHAR(50)  NOT NULL
                               CHECK (curriculum_framework IN ('common_core','teks','ngsss','sols','acsi','classical')),
        UNIQUE (state_code, standard_code)
      );
      CREATE INDEX IF NOT EXISTS idx_standards_state      ON state_standards(state_code);
      CREATE INDEX IF NOT EXISTS idx_standards_grade_band ON state_standards(grade_band);
      CREATE INDEX IF NOT EXISTS idx_standards_subject    ON state_standards(subject);
    `,
  },

  // ── 6. curriculum_progress ────────────────────────────────────────────────
  {
    name: 'table:curriculum_progress',
    sql: `
      CREATE TABLE IF NOT EXISTS curriculum_progress (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id    UUID        NOT NULL REFERENCES students(id)        ON DELETE CASCADE,
        standard_id   UUID        NOT NULL REFERENCES state_standards(id) ON DELETE CASCADE,
        status        VARCHAR(20) NOT NULL DEFAULT 'not_started'
                        CHECK (status IN ('not_started','in_progress','mastered','needs_review')),
        score         SMALLINT    CHECK (score BETWEEN 0 AND 100),
        last_assessed DATE,
        notes         TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (student_id, standard_id)
      );
      CREATE INDEX IF NOT EXISTS idx_progress_student  ON curriculum_progress(student_id);
      CREATE INDEX IF NOT EXISTS idx_progress_standard ON curriculum_progress(standard_id);
    `,
  },

  // ── 7. learning_interventions ─────────────────────────────────────────────
  {
    name: 'table:learning_interventions',
    sql: `
      CREATE TABLE IF NOT EXISTS learning_interventions (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id        UUID        NOT NULL REFERENCES students(id)       ON DELETE CASCADE,
        organization_id   UUID        NOT NULL REFERENCES organizations(id)  ON DELETE CASCADE,
        intervention_type VARCHAR(20) NOT NULL
                            CHECK (intervention_type IN ('enrichment','remediation','accommodation','extension')),
        subject           VARCHAR(100),
        recommendation    TEXT        NOT NULL,
        priority          VARCHAR(10) NOT NULL DEFAULT 'medium'
                            CHECK (priority IN ('low','medium','high','urgent')),
        status            VARCHAR(15) NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','in_progress','resolved')),
        ei_core_generated BOOLEAN     NOT NULL DEFAULT FALSE,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_interventions_student ON learning_interventions(student_id);
      CREATE INDEX IF NOT EXISTS idx_interventions_org     ON learning_interventions(organization_id);
    `,
  },

  // ── 8. homeschool_children ────────────────────────────────────────────────
  {
    name: 'table:homeschool_children',
    sql: `
      CREATE TABLE IF NOT EXISTS homeschool_children (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        parent_user_id  UUID         NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
        first_name      VARCHAR(100) NOT NULL,
        last_name       VARCHAR(100) NOT NULL,
        grade_level     VARCHAR(3)   NOT NULL
                          CHECK (grade_level IN ('K','1','2','3','4','5','6','7','8','9','10','11','12')),
        age             SMALLINT,
        curriculum_type VARCHAR(30)  NOT NULL
                          CHECK (curriculum_type IN ('classical','charlotte_mason','unschooling','eclectic','online','textbook')),
        learning_style  VARCHAR(30)
                          CHECK (learning_style IN ('visual','auditory','kinesthetic','reading-writing')),
        subjects_taught TEXT[]       NOT NULL DEFAULT '{}',
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_homeschool_org    ON homeschool_children(organization_id);
      CREATE INDEX IF NOT EXISTS idx_homeschool_parent ON homeschool_children(parent_user_id);
    `,
  },

  // ── 8a. drop curriculum_type CHECK on homeschool_children ─────────────────
  // The frontend sends Title Case + spaces ("Charlotte Mason", "Eclectic", …)
  // but the original CHECK required lowercase/underscored values. Dropping the
  // constraint lets any string through. Idempotent — safe on every boot.
  {
    name: 'alter:homeschool_children_drop_curriculum_type_check',
    sql: `
      ALTER TABLE homeschool_children
        DROP CONSTRAINT IF EXISTS homeschool_children_curriculum_type_check;
    `,
  },

  // ── 9. behavior_logs ──────────────────────────────────────────────────────
  // Mirrors the inline block in routes/education-v2.ts (≈ line 2343).
  {
    name: 'table:behavior_logs',
    sql: `
      CREATE TABLE IF NOT EXISTS behavior_logs (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id       UUID        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        observation_type VARCHAR(10) NOT NULL
                           CHECK (observation_type IN ('positive','concern','neutral')),
        description      TEXT        NOT NULL,
        subject          VARCHAR(100),
        date             DATE        NOT NULL DEFAULT CURRENT_DATE,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_behavior_student ON behavior_logs(student_id);
    `,
  },

  // ── 10. edu_documents ─────────────────────────────────────────────────────
  // Mirrors the inline block in routes/education-v2.ts (≈ line 1559).
  {
    name: 'table:edu_documents',
    sql: `
      CREATE TABLE IF NOT EXISTS edu_documents (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        uploaded_by     UUID         NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
        filename        VARCHAR(500) NOT NULL,
        file_type       VARCHAR(20)  NOT NULL,
        file_size       INTEGER      NOT NULL,
        content_text    TEXT,
        purpose         VARCHAR(30)  NOT NULL DEFAULT 'resource'
                          CHECK (purpose IN ('curriculum','student_work','lesson_plan','resource')),
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_edu_docs_org ON edu_documents(organization_id);
    `,
  },

  // ── 11. edu_subscriptions ─────────────────────────────────────────────────
  // Mirrors the inline block in routes/edu-billing.ts (≈ line 34).
  {
    name: 'table:edu_subscriptions',
    sql: `
      CREATE TABLE IF NOT EXISTS edu_subscriptions (
        id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id        UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        stripe_customer_id     VARCHAR(255),
        stripe_subscription_id VARCHAR(255),
        plan                   VARCHAR(50),
        status                 VARCHAR(30) NOT NULL DEFAULT 'trialing',
        trial_ends_at          TIMESTAMPTZ,
        current_period_end     TIMESTAMPTZ,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (organization_id)
      );
      CREATE INDEX IF NOT EXISTS idx_edu_subs_org      ON edu_subscriptions(organization_id);
      CREATE INDEX IF NOT EXISTS idx_edu_subs_customer ON edu_subscriptions(stripe_customer_id);
    `,
  },

  // ── 12. edu_integrations ──────────────────────────────────────────────────
  // Mirrors the inline block in routes/edu-integrations.ts (≈ line 38).
  {
    name: 'table:edu_integrations',
    sql: `
      CREATE TABLE IF NOT EXISTS edu_integrations (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        provider        VARCHAR(50) NOT NULL,
        connected       BOOLEAN     NOT NULL DEFAULT FALSE,
        config          JSONB       NOT NULL DEFAULT '{}'::jsonb,
        connected_at    TIMESTAMPTZ,
        UNIQUE (organization_id, provider)
      );
      CREATE INDEX IF NOT EXISTS idx_edu_integrations_org ON edu_integrations(organization_id);
    `,
  },

  // ── 13. edu_oauth_sessions ────────────────────────────────────────────────
  // Mirrors the inline block in routes/edu-integrations.ts (≈ line 30).
  {
    name: 'table:edu_oauth_sessions',
    sql: `
      CREATE TABLE IF NOT EXISTS edu_oauth_sessions (
        id         UUID PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '15 minutes'
      );
    `,
  },
];

export async function runMigrations(): Promise<void> {
  console.log('[migrate] starting database migrations…');
  let ok = 0;
  let failed = 0;
  for (const m of MIGRATIONS) {
    try {
      await pool.query(m.sql);
      ok += 1;
      console.log(`[migrate]   ✓ ${m.name}`);
    } catch (err: any) {
      failed += 1;
      // Log and continue. A failure here usually means a transient permission
      // issue (e.g. CREATE EXTENSION without superuser) — not a reason to keep
      // the server offline.
      console.error(`[migrate]   ✗ ${m.name}: ${err.message}`);
    }
  }
  console.log(`[migrate] done — ${ok} ok, ${failed} failed`);
}
