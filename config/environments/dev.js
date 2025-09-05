module.exports = {
  NODE_ENV: 'dev',
  PORT: 3001,
  HOST: '0.0.0.0',
  
  // Database
  DB_TYPE: 'postgres',
  DB_HOST: process.env.DB_HOST || 'localhost',
  DB_PORT: process.env.DB_PORT || 5432,
  DB_NAME: process.env.DB_NAME || 'scribe_dev',
  DB_USER: process.env.DB_USER || 'postgres',
  DB_PASSWORD: process.env.DB_PASSWORD || 'password',
  DB_SSL: process.env.DB_SSL || 'false',
  
  // JWT Configuration
  JWT_SECRET: 'dev-super-secret-jwt-key-change-this-in-production',
  JWT_ACCESS_EXPIRES_IN: '24h',
  JWT_REFRESH_EXPIRES_IN: '7d',
  
  // Azure Translator
  AZURE_TRANSLATOR_KEY: process.env.AZURE_TRANSLATOR_KEY || 'your-azure-translator-key-here',
  AZURE_TRANSLATOR_REGION: process.env.AZURE_TRANSLATOR_REGION || 'your-azure-region-here',
  
  // CORS
  CORS_ORIGIN: 'http://speaker.localhost:5173,http://listener.localhost:5173',
  
  // Logging
  LOG_LEVEL: 'debug'
}