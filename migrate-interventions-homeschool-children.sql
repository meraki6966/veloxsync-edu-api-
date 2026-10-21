-- migrate-interventions-homeschool-children.sql
-- DRAFT. Run by hand as the database owner. Not run by the app, and the code
-- that uses it is not written yet (see notes at the bottom).
--
-- Why: homeschool families keep their children in homeschool_children, but
-- learning_interventions.student_id is NOT NULL and references students(id).
-- No homeschool support plan can ever be saved. This adds a second, optional
-- link to homeschool_children and requires exactly one of the two.

BEGIN;

ALTER TABLE learning_interventions
  ALTER COLUMN student_id DROP NOT NULL;

ALTER TABLE learning_interventions
  ADD COLUMN IF NOT EXISTS homeschool_child_id UUID
    REFERENCES homeschool_children(id) ON DELETE CASCADE;

-- Exactly one owner per plan: a classroom student or a homeschool child.
-- (aetherflow-api allows class-level rows with neither; this database does
-- not have that feature, so it stays strict here.)
ALTER TABLE learning_interventions
  ADD CONSTRAINT learning_interventions_one_owner
  CHECK ((student_id IS NULL) <> (homeschool_child_id IS NULL));

CREATE INDEX IF NOT EXISTS idx_interventions_homeschool_child
  ON learning_interventions(homeschool_child_id);

COMMIT;

-- Check afterwards:
--   SELECT column_name, is_nullable FROM information_schema.columns
--   WHERE table_name = 'learning_interventions'
--     AND column_name IN ('student_id', 'homeschool_child_id');
--
-- Code change that follows, once this has run:
--   API  POST /interventions accepts homeschool_child_id, checks it belongs to
--        the caller's org (and parent) the way assertStudentInOrg does, and
--        GET /interventions joins homeschool_children for the name.
--   Web  Interventions.tsx sends intervention_type / recommendation /
--        homeschool_child_id instead of type / description / student_id,
--        drops the sample rows, and reports failed saves.
