#!/usr/bin/env node

/**
 * Migration script: PostgreSQL -> Firestore
 * 
 * This script migrates all data from Cloud SQL (PostgreSQL) to Firestore.
 * It is IDEMPOTENT - safe to run multiple times, will skip already migrated data.
 * 
 * Usage:
 *   DB_HOST=xxx DB_NAME=xxx DB_USER=xxx DB_PASSWORD=xxx npm run migrate:firestore
 */

require('dotenv').config();

const { Pool } = require('pg');
const { Firestore, Timestamp } = require('@google-cloud/firestore');
const path = require('path');
const fs = require('fs');

// Configuration
const config = {
  // PostgreSQL (source)
  DB_HOST: process.env.DB_HOST || 'localhost',
  DB_PORT: process.env.DB_PORT || 5432,
  DB_NAME: process.env.DB_NAME || 'scribe-dev',
  DB_USER: process.env.DB_USER || 'johnascott',
  DB_PASSWORD: process.env.DB_PASSWORD || 'password',
  DB_SSL: process.env.DB_SSL || 'false',
  
  // Firestore (destination)
  GOOGLE_CLOUD_PROJECT_ID: process.env.GOOGLE_CLOUD_PROJECT_ID || 'scribe-471123',
};

// Collection names
const Collections = {
  USERS: 'users',
  SESSIONS: 'sessions',
  PASSWORD_RESET_TOKENS: 'passwordResetTokens',
  MIGRATION_STATUS: '_migration_status',
};

let pool;
let firestore;

// ID mapping: PostgreSQL integer IDs -> Firestore document IDs
const userIdMap = new Map();

async function initConnections() {
  console.log('🔧 Initializing database connections...\n');
  
  // Initialize PostgreSQL
  console.log('📊 Connecting to PostgreSQL...');
  console.log(`   Host: ${config.DB_HOST}`);
  console.log(`   Database: ${config.DB_NAME}`);
  
  pool = new Pool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    ssl: config.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  
  await pool.query('SELECT 1');
  console.log('✅ PostgreSQL connected\n');
  
  // Initialize Firestore
  console.log('📊 Connecting to Firestore...');
  console.log(`   Project: ${config.GOOGLE_CLOUD_PROJECT_ID}`);
  
  const credentialsPath = path.join(__dirname, '..', 'google-credentials.json');
  const databaseId = 'scribe-db';
  
  if (fs.existsSync(credentialsPath)) {
    console.log('   Using local credentials file');
    console.log(`   Database: ${databaseId}`);
    firestore = new Firestore({
      projectId: config.GOOGLE_CLOUD_PROJECT_ID,
      keyFilename: credentialsPath,
      databaseId: databaseId,
    });
  } else {
    console.log('   Using Application Default Credentials');
    console.log(`   Database: ${databaseId}`);
    firestore = new Firestore({
      projectId: config.GOOGLE_CLOUD_PROJECT_ID,
      databaseId: databaseId,
    });
  }
  
  // Test connection
  await firestore.collection('_health').limit(1).get();
  console.log('✅ Firestore connected\n');
}

async function checkMigrationStatus() {
  console.log('🔍 Checking migration status...');
  
  const statusDoc = await firestore.collection(Collections.MIGRATION_STATUS).doc('postgres_migration').get();
  
  if (statusDoc.exists) {
    const data = statusDoc.data();
    console.log(`   Previous migration found: ${data.completedAt?.toDate?.() || data.completedAt}`);
    console.log(`   Source database: ${data.sourceDatabase}`);
    console.log(`   Users migrated: ${data.userCount}`);
    return data;
  }
  
  console.log('   No previous migration found');
  return null;
}

async function loadExistingUserMappings() {
  // Load existing users from Firestore to build ID mapping
  const snapshot = await firestore.collection(Collections.USERS).get();
  
  snapshot.docs.forEach(doc => {
    const data = doc.data();
    if (data._legacyId) {
      userIdMap.set(data._legacyId, doc.id);
    }
  });
  
  console.log(`   Loaded ${userIdMap.size} existing user mappings from Firestore`);
}

async function migrateUsers() {
  console.log('👤 Migrating users...');
  
  const result = await pool.query('SELECT * FROM users ORDER BY id');
  const users = result.rows;
  
  console.log(`   Found ${users.length} users in PostgreSQL`);
  
  // Check which users are already migrated (by email)
  const existingEmails = new Set();
  const existingSnapshot = await firestore.collection(Collections.USERS).get();
  existingSnapshot.docs.forEach(doc => {
    const data = doc.data();
    existingEmails.add(data.email);
    if (data._legacyId) {
      userIdMap.set(data._legacyId, doc.id);
    }
  });
  
  console.log(`   Found ${existingEmails.size} users already in Firestore`);
  
  let migrated = 0;
  let skipped = 0;
  
  for (const user of users) {
    // Skip if already migrated
    if (existingEmails.has(user.email)) {
      skipped++;
      continue;
    }
    
    const docRef = firestore.collection(Collections.USERS).doc();
    
    // Map old integer ID to new Firestore document ID
    userIdMap.set(user.id, docRef.id);
    
    const userData = {
      email: user.email,
      name: user.name,
      passwordHash: user.password_hash,
      isActive: user.is_active !== false,
      userCode: user.user_code || null,
      totpSecret: user.totp_secret || null,
      totpEnabled: user.totp_enabled || false,
      totpBackupCodes: user.totp_backup_codes || null,
      createdAt: user.created_at ? Timestamp.fromDate(new Date(user.created_at)) : Timestamp.now(),
      updatedAt: user.updated_at ? Timestamp.fromDate(new Date(user.updated_at)) : Timestamp.now(),
      _legacyId: user.id,
    };
    
    await docRef.set(userData);
    migrated++;
  }
  
  console.log(`✅ Users: ${migrated} migrated, ${skipped} skipped (already exist)\n`);
  return migrated;
}

async function migrateSessions() {
  console.log('📋 Migrating sessions...');
  
  try {
    const result = await pool.query('SELECT * FROM sessions ORDER BY created_at');
    const sessions = result.rows;
    
    console.log(`   Found ${sessions.length} sessions in PostgreSQL`);
    
    if (sessions.length === 0) {
      console.log('✅ No sessions to migrate\n');
      return 0;
    }
    
    // Check which sessions already exist
    const existingSessionIds = new Set();
    const existingSnapshot = await firestore.collection(Collections.SESSIONS).get();
    existingSnapshot.docs.forEach(doc => existingSessionIds.add(doc.id));
    
    let migrated = 0;
    let skipped = 0;
    
    for (const session of sessions) {
      // Skip if already exists
      if (existingSessionIds.has(session.id)) {
        skipped++;
        continue;
      }
      
      // Map user ID if exists
      let firestoreUserId = null;
      if (session.user_id) {
        firestoreUserId = userIdMap.get(session.user_id);
        if (!firestoreUserId) {
          console.log(`   ⚠️ User ID ${session.user_id} not found, skipping session ${session.id}`);
          skipped++;
          continue;
        }
      }
      
      const docRef = firestore.collection(Collections.SESSIONS).doc(session.id);
      const sessionData = {
        userId: firestoreUserId,
        characterCount: session.character_count || 0,
        isActive: session.is_active !== false,
        lastActivity: session.last_activity ? Timestamp.fromDate(new Date(session.last_activity)) : Timestamp.now(),
        createdAt: session.created_at ? Timestamp.fromDate(new Date(session.created_at)) : Timestamp.now(),
      };
      
      await docRef.set(sessionData);
      migrated++;
    }
    
    console.log(`✅ Sessions: ${migrated} migrated, ${skipped} skipped\n`);
    return migrated;
  } catch (error) {
    if (error.message.includes('relation "sessions" does not exist')) {
      console.log('   Sessions table does not exist, skipping...\n');
      return 0;
    }
    throw error;
  }
}

async function migratePasswordResetTokens() {
  console.log('🔑 Migrating password reset tokens...');
  
  try {
    const result = await pool.query('SELECT * FROM password_reset_tokens ORDER BY created_at');
    const tokens = result.rows;
    
    console.log(`   Found ${tokens.length} tokens in PostgreSQL`);
    
    if (tokens.length === 0) {
      console.log('✅ No tokens to migrate\n');
      return 0;
    }
    
    // Check existing tokens
    const existingTokens = new Set();
    const existingSnapshot = await firestore.collection(Collections.PASSWORD_RESET_TOKENS).get();
    existingSnapshot.docs.forEach(doc => existingTokens.add(doc.data().token));
    
    let migrated = 0;
    let skipped = 0;
    
    for (const token of tokens) {
      // Skip if token already exists
      if (existingTokens.has(token.token)) {
        skipped++;
        continue;
      }
      
      const firestoreUserId = userIdMap.get(token.user_id);
      if (!firestoreUserId) {
        console.log(`   ⚠️ User ID ${token.user_id} not found, skipping token`);
        skipped++;
        continue;
      }
      
      const docRef = firestore.collection(Collections.PASSWORD_RESET_TOKENS).doc();
      const tokenData = {
        userId: firestoreUserId,
        token: token.token,
        expiresAt: token.expires_at ? Timestamp.fromDate(new Date(token.expires_at)) : Timestamp.now(),
        used: token.used || false,
        createdAt: token.created_at ? Timestamp.fromDate(new Date(token.created_at)) : Timestamp.now(),
      };
      
      await docRef.set(tokenData);
      migrated++;
    }
    
    console.log(`✅ Tokens: ${migrated} migrated, ${skipped} skipped\n`);
    return migrated;
  } catch (error) {
    if (error.message.includes('relation "password_reset_tokens" does not exist')) {
      console.log('   Password reset tokens table does not exist, skipping...\n');
      return 0;
    }
    throw error;
  }
}

async function recordMigrationStatus(userCount, sessionCount, tokenCount) {
  await firestore.collection(Collections.MIGRATION_STATUS).doc('postgres_migration').set({
    completedAt: Timestamp.now(),
    sourceDatabase: `${config.DB_HOST}/${config.DB_NAME}`,
    userCount,
    sessionCount,
    tokenCount,
    lastRunAt: Timestamp.now(),
  }, { merge: true });
  
  console.log('📝 Migration status recorded\n');
}

async function cleanup() {
  if (pool) {
    await pool.end();
    console.log('🔌 PostgreSQL connection closed');
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       Scribe: PostgreSQL -> Firestore Migration Script        ');
  console.log('              (Idempotent - safe to run multiple times)        ');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  try {
    await initConnections();
    
    const previousMigration = await checkMigrationStatus();
    
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                      Starting Migration                       ');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    const userCount = await migrateUsers();
    const sessionCount = await migrateSessions();
    const tokenCount = await migratePasswordResetTokens();
    
    await recordMigrationStatus(userCount, sessionCount, tokenCount);
    
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                    Migration Complete! 🎉                     ');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    if (userCount === 0 && sessionCount === 0 && tokenCount === 0) {
      console.log('ℹ️  No new data to migrate - all data already exists in Firestore\n');
    }
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await cleanup();
  }
}

main();
