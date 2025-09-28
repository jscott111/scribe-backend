const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true
  }
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('googleSpeechTranscription', (data) => {
    console.log('Received googleSpeechTranscription:', data);
    
    // Send back interim result
    socket.emit('interimTranscription', {
      transcript: 'Test interim result',
      bubbleId: data.bubbleId,
      wordCount: 3
    });
    
    // Send back final result
    setTimeout(() => {
      socket.emit('transcription', {
        transcription: 'Test final result',
        sourceLanguage: data.sourceLanguage,
        bubbleId: data.bubbleId
      });
    }, 1000);
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`Test server running on port ${PORT}`);
});

