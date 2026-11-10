-- ============================================================================
-- Migration: 001_performance_indexes.sql
-- Purpose: Add targeted indexes to support 6,000+ students without table scans
-- Target Tables: students, attendance
-- Execution Scope: Stage/Test/Prod (run during maintenance window)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PRE-CHECK: Existing indexes on affected tables
--   students: PRIMARY KEY (id), UNIQUE KEY (email)
--   attendance: PRIMARY KEY (id), UNIQUE KEY (student_id, date)
-- ----------------------------------------------------------------------------

-- 1. Index on students (department, semester)
--    Benefit: Optimizes class-level lookups for Attendance and Results views
--    Eliminates 6,000-row table scan on every class filter
CREATE INDEX idx_students_dept_sem ON students (department, semester);

-- 2. Index on students (created_at)
--    Benefit: Eliminates filesort during paginated directory browsing
CREATE INDEX idx_students_created ON students (created_at);

-- 3. Index on students (status)
--    Benefit: Optimizes active student counting and filtering in dashboard
CREATE INDEX idx_students_status ON students (status);

-- 4. Index on attendance (date, status)
--    Benefit: Optimizes daily attendance counts and 7-day trend calculations
--    (Existing unique key is (student_id, date); cannot be used when filtering by date alone)
CREATE INDEX idx_attendance_date_status ON attendance (date, status);

-- ============================================================================
-- ROLLBACK SCRIPT (Execute only if reversing this migration):
-- ----------------------------------------------------------------------------
-- DROP INDEX idx_students_dept_sem ON students;
-- DROP INDEX idx_students_created ON students;
-- DROP INDEX idx_students_status ON students;
-- DROP INDEX idx_attendance_date_status ON attendance;
-- ============================================================================


