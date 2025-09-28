console.log('Testing backend startup...');

try {
  require('./server.js');
  console.log('✅ Backend started successfully');
} catch (error) {
  console.error('❌ Backend startup failed:', error.message);
  console.error('Stack trace:', error.stack);
}

