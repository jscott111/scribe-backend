const { Pool } = require('pg');
const config = require('../config');

let pool;

const initDatabase = () => {
  return new Promise((resolve, reject) => {
    try {
      if (!config.DB_HOST) {
        console.error('❌ DB_HOST is not set');
        console.error('Available environment variables:', Object.keys(process.env).filter(key => key.startsWith('DB_')));
        return reject(new Error('DB_HOST environment variable is required'));
      }
      if (!config.DB_NAME) {
        console.error('❌ DB_NAME is not set');
        return reject(new Error('DB_NAME environment variable is required'));
      }
      if (!config.DB_USER) {
        console.error('❌ DB_USER is not set');
        return reject(new Error('DB_USER environment variable is required'));
      }
      if (!config.DB_PASSWORD) {
        console.error('❌ DB_PASSWORD is not set');
        return reject(new Error('DB_PASSWORD environment variable is required'));
      }

      console.log('🔧 Attempting database connection...');
      console.log(`📊 DB_HOST: ${config.DB_HOST}`);
      console.log(`📊 DB_PORT: ${config.DB_PORT}`);
      console.log(`📊 DB_NAME: ${config.DB_NAME}`);
      console.log(`📊 DB_USER: ${config.DB_USER}`);
      console.log(`📊 DB_SSL: ${config.DB_SSL}`);

      pool = new Pool({
        host: config.DB_HOST,
        port: config.DB_PORT,
        database: config.DB_NAME,
        user: config.DB_USER,
        password: config.DB_PASSWORD,
        ssl: config.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 30000, // Increased from 10s to 30s
      });

      pool.query('SELECT 1', (err, result) => {
        if (err) {
          console.error('❌ Database connection failed:');
          console.error('Error code:', err.code);
          console.error('Error message:', err.message);
          console.error('Error detail:', err.detail);
          console.error('Error hint:', err.hint);
          console.error('Full error:', err);
          return reject(err);
        }
        
        console.log('✅ Connected to PostgreSQL database');
        
        runMigrations()
          .then(() => {
            console.log('✅ Database migrations completed');
            resolve();
          })
          .catch((migrationErr) => {
            console.error('❌ Migration failed:', migrationErr);
            reject(migrationErr);
          });
      });
    } catch (error) {
      console.error('❌ Database initialization error:', error);
      reject(error);
    }
  });
};

const runMigrations = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const migrations = [
    {
      filename: '001_create_users_table.sql',
      sql: `
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          name VARCHAR(255) NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `
    },
    {
      filename: '002_create_sessions_table.sql',
      sql: `
        CREATE TABLE IF NOT EXISTS sessions (
          id VARCHAR(255) PRIMARY KEY,
          user_id INTEGER,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP,
          is_active BOOLEAN DEFAULT true,
          FOREIGN KEY (user_id) REFERENCES users (id)
        )
      `
    },
    {
      filename: '003_create_indexes.sql',
      sql: `
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
        CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_id ON sessions(id);
      `
    },
    {
      filename: '20250908225803_add_character_count_to_sessions.sql',
      sql:`
        ALTER TABLE sessions ADD COLUMN character_count INTEGER DEFAULT 0;
      `
    },
    {
      filename: '20250109000000_remove_expires_at_column.sql',
      sql: `
        ALTER TABLE sessions DROP COLUMN IF EXISTS expires_at;
        DROP INDEX IF EXISTS idx_sessions_expires_at;
      `
    },
    {
      filename: '20250109000001_add_last_activity_to_sessions.sql',
      sql: `
        ALTER TABLE sessions ADD COLUMN last_activity TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity);
        UPDATE sessions SET last_activity = created_at WHERE last_activity IS NULL;
      `
    },
    {
      filename: '20250910000529_add_totp_to_users.sql',
      sql: `
        ALTER TABLE users 
        ADD COLUMN totp_secret VARCHAR(255) NULL,
        ADD COLUMN totp_enabled BOOLEAN DEFAULT FALSE,
        ADD COLUMN totp_backup_codes TEXT[] NULL;
      `
    },
    {
      filename: '20250910010343_add_password_reset_tokens.sql',
      sql: `
        -- Create password reset tokens table
        CREATE TABLE password_reset_tokens (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token VARCHAR(255) NOT NULL UNIQUE,
            expires_at TIMESTAMP NOT NULL,
            used BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- Create index for faster token lookups
        CREATE INDEX idx_password_reset_tokens_token ON password_reset_tokens(token);
        CREATE INDEX idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
        CREATE INDEX idx_password_reset_tokens_expires_at ON password_reset_tokens(expires_at);
      `
    },
    {
      filename: '20250110000000_add_user_code_to_users.sql',
      sql: `
        -- Add user_code field to users table
        -- This field will be used instead of sessions for user identification
        ALTER TABLE users ADD COLUMN user_code VARCHAR(8) UNIQUE;

        -- Create index on user_code for faster lookups
        CREATE INDEX IF NOT EXISTS idx_users_user_code ON users(user_code);

        -- Add constraint to ensure user_code is between 3 and 8 characters
        ALTER TABLE users ADD CONSTRAINT check_user_code_length 
        CHECK (user_code IS NULL OR (LENGTH(user_code) >= 3 AND LENGTH(user_code) <= 8));
      `
    },
    {
      filename: '20250110000001_remove_sessions_table.sql',
      sql: `
        -- Remove sessions table as we're moving to user codes
        -- This migration should be run after ensuring all session-based functionality has been migrated

        -- Drop indexes first
        DROP INDEX IF EXISTS idx_sessions_user_id;
        DROP INDEX IF EXISTS idx_sessions_is_active;
        DROP INDEX IF EXISTS idx_sessions_expires_at;

        -- Drop the sessions table
        DROP TABLE IF EXISTS sessions;
      `
    }
  ];

  for (const migration of migrations) {
    try {
      const result = await pool.query('SELECT id FROM migrations WHERE filename = $1', [migration.filename]);
      
      if (result.rows.length > 0) {
        console.log(`⏭️  Migration ${migration.filename} already applied`);
        continue;
      }

      await pool.query(migration.sql);
      
      await pool.query('INSERT INTO migrations (filename) VALUES ($1)', [migration.filename]);
      
      console.log(`✅ Migration ${migration.filename} completed`);
    } catch (error) {
      console.error(`❌ Migration ${migration.filename} failed:`, error.message);
      throw error;
    }
  }
};

const runQuery = (query, params = []) => {
  return new Promise((resolve, reject) => {
    pool.query(query, params, (err, result) => {
      if (err) {
        console.error('❌ Query error:', err.message);
        return reject(err);
      }
      resolve(result);
    });
  });
};

const getQuery = async (query, params = []) => {
  const result = await runQuery(query, params);
  return result.rows[0] || null;
};

const allQuery = async (query, params = []) => {
  const result = await runQuery(query, params);
  return result.rows;
};

module.exports = { initDatabase, runQuery, getQuery, allQuery };
