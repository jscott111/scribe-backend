const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({
  origin: ['http://speaker.localhost:5174', 'http://listener.localhost:5174', 'http://api.localhost:3001'],
  methods: ["GET", "POST", "OPTIONS"],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200
}));

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Test server running' });
});

app.get('/test-cors', (req, res) => {
  res.json({ message: 'CORS test successful' });
});

const PORT = 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Test server running on port ${PORT}`);
});