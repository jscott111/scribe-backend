#!/usr/bin/env node

/**
 * Database Migration Script
 * 
 * This script handles database migrations for both SQLite and PostgreSQL.
 * It can be run manually or automatically during deployment.
 * 
 * Usage:
 *   node migrate.js                    # Run all pending migrations
 *   node migrate.js --status           # Show migration status
 *   node migrate.js --rollback         # Rollback last migration (not implemented yet)
 */

const config = require('./config');

// Import PostgreSQL database module
const { initDatabase } = require('./config/database-postgres');

async function runMigrations() {
  try {
    console.log('🚀 Starting database migrations...');
    console.log(`📊 Environment: ${config.NODE_ENV}`);
    console.log(`🗄️  Database: ${config.DB_TYPE}`);
    
    if (config.DB_TYPE === 'postgres') {
      console.log(`🔗 Host: ${config.DB_HOST}:${config.DB_PORT}`);
      console.log(`📋 Database: ${config.DB_NAME}`);
    } else {
      console.log(`📁 Path: ${config.DB_PATH}`);
    }
    
    console.log('');
    
    // Initialize database and run migrations
    await initDatabase();
    
    console.log('');
    console.log('✅ All migrations completed successfully!');
    console.log('🎉 Database is ready for use.');
    
  } catch (error) {
    console.error('');
    console.error('❌ Migration failed:');
    console.error(error.message);
    console.error('');
    console.error('🔧 Troubleshooting:');
    console.error('1. Check database connection details');
    console.error('2. Ensure database exists and is accessible');
    console.error('3. Verify user has proper permissions');
    console.error('4. Check network connectivity');
    
    process.exit(1);
  }
}

async function showStatus() {
  try {
    console.log('📊 Migration Status');
    console.log('==================');
    
    if (config.DB_TYPE === 'postgres') {
      const { Pool } = require('pg');
      const pool = new Pool({
        host: config.DB_HOST,
        port: config.DB_PORT,
        database: config.DB_NAME,
        user: config.DB_USER,
        password: config.DB_PASSWORD,
        ssl: config.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      });
      
      const result = await pool.query(`
        SELECT filename, applied_at 
        FROM migrations 
        ORDER BY applied_at ASC
      `);
      
      if (result.rows.length === 0) {
        console.log('No migrations found.');
      } else {
        result.rows.forEach(row => {
          console.log(`✅ ${row.filename} - ${row.applied_at}`);
        });
      }
      
      await pool.end();
    } else {
      const sqlite3 = require('sqlite3').verbose();
      const db = new sqlite3.Database(config.DB_PATH);
      
      db.all('SELECT filename, applied_at FROM migrations ORDER BY applied_at ASC', (err, rows) => {
        if (err) {
          console.error('Error:', err.message);
          return;
        }
        
        if (rows.length === 0) {
          console.log('No migrations found.');
        } else {
          rows.forEach(row => {
            console.log(`✅ ${row.filename} - ${row.applied_at}`);
          });
        }
        
        db.close();
      });
    }
    
  } catch (error) {
    console.error('❌ Error checking migration status:', error.message);
    process.exit(1);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.includes('--status')) {
  showStatus();
} else if (args.includes('--rollback')) {
  console.log('❌ Rollback functionality not implemented yet.');
  console.log('💡 For now, you can manually drop tables and re-run migrations.');
  process.exit(1);
} else {
  runMigrations();
}
