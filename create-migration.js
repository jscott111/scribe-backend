#!/usr/bin/env node

/**
 * Create Migration Script
 * 
 * This script helps you create new database migrations.
 * 
 * Usage:
 *   node create-migration.js "description of migration"
 * 
 * Example:
 *   node create-migration.js "add user preferences table"
 */

const fs = require('fs');
const path = require('path');

function createMigration(description) {
  // Generate migration filename
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').split('.')[0];
  const filename = `${timestamp}_${description.toLowerCase().replace(/[^a-z0-9]/g, '_')}.sql`;
  
  // Create migrations directory if it doesn't exist
  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    fs.mkdirSync(migrationsDir, { recursive: true });
  }
  
  // Create migration file
  const migrationPath = path.join(migrationsDir, filename);
  const migrationContent = `-- Migration: ${description}
-- Created: ${new Date().toISOString()}
-- 
-- Add your SQL statements here
-- Example:
-- CREATE TABLE example_table (
--   id SERIAL PRIMARY KEY,
--   name VARCHAR(255) NOT NULL,
--   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
-- );

-- Remember to update the migration arrays in:
-- - config/database.js (for SQLite)
-- - config/database-postgres.js (for PostgreSQL)
`;

  fs.writeFileSync(migrationPath, migrationContent);
  
  console.log('✅ Migration created successfully!');
  console.log(`📁 File: ${migrationPath}`);
  console.log('');
  console.log('📝 Next steps:');
  console.log('1. Edit the migration file with your SQL statements');
  console.log('2. Add the migration to the migrations array in:');
  console.log('   - config/database.js (SQLite)');
  console.log('   - config/database-postgres.js (PostgreSQL)');
  console.log('3. Test the migration locally');
  console.log('4. Deploy to production');
}

// Get description from command line arguments
const description = process.argv[2];

if (!description) {
  console.log('❌ Please provide a migration description');
  console.log('');
  console.log('Usage:');
  console.log('  node create-migration.js "description of migration"');
  console.log('');
  console.log('Example:');
  console.log('  node create-migration.js "add user preferences table"');
  process.exit(1);
}

createMigration(description);
