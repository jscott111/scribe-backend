-- Remove sessions table as we're moving to user codes
-- This migration should be run after ensuring all session-based functionality has been migrated

-- Drop indexes first
DROP INDEX IF EXISTS idx_sessions_user_id;
DROP INDEX IF EXISTS idx_sessions_is_active;
DROP INDEX IF EXISTS idx_sessions_expires_at;

-- Drop the sessions table
DROP TABLE IF EXISTS sessions;
