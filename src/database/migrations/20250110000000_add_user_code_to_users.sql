-- Add user_code field to users table
-- This field will be used instead of sessions for user identification
ALTER TABLE users ADD COLUMN user_code VARCHAR(8) UNIQUE;

-- Create index on user_code for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_user_code ON users(user_code);

-- Add constraint to ensure user_code is between 3 and 8 characters
ALTER TABLE users ADD CONSTRAINT check_user_code_length 
CHECK (user_code IS NULL OR (LENGTH(user_code) >= 3 AND LENGTH(user_code) <= 8));
