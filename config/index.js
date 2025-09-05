const path = require('path');

// Get environment from NODE_ENV or default to dev
const environment = process.env.NODE_ENV || 'dev';
console.log('🔍 Environment detection:');
console.log('  process.env.NODE_ENV:', process.env.NODE_ENV);
console.log('  resolved environment:', environment);

// Normalize environment names
const normalizedEnv = environment === 'dev' ? 'dev' : 
                     environment === 'prod' ? 'prod' : 
                     environment;

// Load environment-specific configuration
let config;
try {
  console.log(`🔍 Loading config for environment: ${normalizedEnv}`);
  config = require(`./environments/${normalizedEnv}`);
  console.log('✅ Config loaded successfully');
} catch (error) {
  console.warn(`No configuration found for environment: ${normalizedEnv}, falling back to dev`);
  console.error('Config load error:', error.message);
  config = require('./environments/dev');
}

// Override with environment variables if they exist
const finalConfig = {
  ...config,
  // Override with process.env values if they exist
  NODE_ENV: process.env.NODE_ENV || config.NODE_ENV,
  PORT: process.env.PORT || config.PORT,
  HOST: process.env.HOST || config.HOST,
  DB_TYPE: process.env.DB_TYPE || config.DB_TYPE,
  DB_HOST: process.env.DB_HOST || config.DB_HOST,
  DB_USER: process.env.DB_USER || config.DB_USER,
  DB_PASSWORD: process.env.DB_PASSWORD || config.DB_PASSWORD,
  DB_NAME: process.env.DB_NAME || config.DB_NAME,
  DB_PORT: process.env.DB_PORT || config.DB_PORT,
  DB_SSL: process.env.DB_SSL || config.DB_SSL,
  JWT_SECRET: process.env.JWT_SECRET || config.JWT_SECRET,
  JWT_ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN || config.JWT_ACCESS_EXPIRES_IN,
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || config.JWT_REFRESH_EXPIRES_IN,
  AZURE_TRANSLATOR_KEY: process.env.AZURE_TRANSLATOR_KEY || config.AZURE_TRANSLATOR_KEY,
  AZURE_TRANSLATOR_REGION: process.env.AZURE_TRANSLATOR_REGION || config.AZURE_TRANSLATOR_REGION,
  CORS_ORIGIN: process.env.CORS_ORIGIN || config.CORS_ORIGIN,
  LOG_LEVEL: process.env.LOG_LEVEL || config.LOG_LEVEL
};

// Validate required environment variables for all environments
const requiredVars = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'NODE_ENV'];
const missingVars = requiredVars.filter(varName => !finalConfig[varName]);

if (missingVars.length > 0) {
  console.error(`Missing required environment variables: ${missingVars.join(', ')}`);
  console.error('All environments now require PostgreSQL. Please set DB_HOST, DB_USER, and DB_PASSWORD.');
  process.exit(1);
}

// Log configuration (without sensitive data)
console.log(`🔧 Environment: ${finalConfig.NODE_ENV}`);
console.log(`🔧 Port: ${finalConfig.PORT}`);
console.log(`🔧 Database: ${finalConfig.DB_TYPE} at ${finalConfig.DB_HOST}`);
console.log(`🔧 CORS Origin: ${finalConfig.CORS_ORIGIN}`);
console.log(`🔧 DB_HOST: ${finalConfig.DB_HOST}`);
console.log(`🔧 DB_NAME: ${finalConfig.DB_NAME}`);
console.log(`🔧 DB_USER: ${finalConfig.DB_USER}`);

module.exports = finalConfig;
