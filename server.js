const express = require('express')
const http = require('http')
const socketIo = require('socket.io')
const cors = require('cors')
const path = require('path')
require('dotenv').config()
const config = require('./src/config')
const { authenticateSocket } = require('./src/middleware/auth')
const authRoutes = require('./src/routes/auth')
const { initFirestore } = require('./src/database/firestore')
const User = require('./src/models/User')
const speechToTextService = require('./src/services/speechToTextService')
const googleTranslationService = require('./src/services/googleTranslationService')
const textToSpeechService = require('./src/services/textToSpeechService')
const app = express()
const server = http.createServer(app)

app.use(cors({
  origin: config.CORS_ORIGIN.split(',').map(origin => origin.trim()),
  methods: ["GET", "POST", "OPTIONS"],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200
}))

const io = socketIo(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 200
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true
})

io.use(authenticateSocket)

app.use(express.json({ limit: '50mb' }))
app.use(express.static(path.join(__dirname, 'public')))

app.use('/auth', authRoutes)

const activeConnections = new Map()
let audioChunkCounter = 0
let lastAudioLogTime = Date.now()
const streamingSessions = new Map() // Track streaming sessions per socket
const processedTranscripts = new Map() // Track processed transcripts to prevent duplicates
const restartingStreams = new Map() // Track sockets that are currently restarting their stream
const audioBufferDuringRestart = new Map() // Buffer audio during stream restart
const overlappingStreams = new Map() // Track overlapping streams during restart (old stream still active)
const lastTranscriptionTime = new Map() // Track when last transcription was received per socket
const audioChunksPerSocket = new Map() // Track audio chunks sent per socket for watchdog
const currentBubbleIds = new Map() // Track current bubbleId per socket (updated by incoming audio)

const emitConnectionCount = (userCode = null) => {
  const connectionsByLanguage = {}
  let totalConnections = 0
  
  activeConnections.forEach((connection) => {
    if (userCode && connection.userCode !== userCode) {
      return
    }
    
    if (!connection.userCode) {
      return
    }
    
    totalConnections++
    if (connection.targetLanguage) {
      connectionsByLanguage[connection.targetLanguage] = (connectionsByLanguage[connection.targetLanguage] || 0) + 1
    }
  })
  
  const connectionData = {
    total: totalConnections,
    byLanguage: connectionsByLanguage
  }
  
  if (userCode) {
    const userCodeConnections = Array.from(activeConnections.entries())
      .filter(([_, conn]) => conn.userCode === userCode)
      .map(([socketId, _]) => socketId)
    
    
    userCodeConnections.forEach(socketId => {
      const targetSocket = io.sockets.sockets.get(socketId)
      if (targetSocket) {
        targetSocket.emit('connectionCount', connectionData)
      }
    })
  } else {
    const validConnections = Array.from(activeConnections.entries())
      .filter(([_, conn]) => conn.userCode)
      .map(([socketId, _]) => socketId)
    
    validConnections.forEach(socketId => {
      const targetSocket = io.sockets.sockets.get(socketId)
      if (targetSocket) {
        targetSocket.emit('connectionCount', connectionData)
      }
    })
  }
}

async function processTranslations(translationConnections, transcript, sourceLanguage, bubbleId) {
  try {
    console.log('Processing translations:', translationConnections, transcript, sourceLanguage, bubbleId)
  } catch (translationError) {
    console.error('Translation error:', translationError)
    translationConnections.forEach(socketId => {
      const targetSocket = io.sockets.sockets.get(socketId)
      if (targetSocket) {
        targetSocket.emit('translationError', {
          message: 'Translation failed: ' + translationError.message,
          bubbleId
        })
      }
    })
  }
}

io.on('connection', async (socket) => {
  console.log(`🔌 Client connected: ${socket.user?.email || 'Listener'} (${socket.userCode || 'No User Code'})`)
  
  activeConnections.set(socket.id, {
    userId: socket.user?.id,
    userEmail: socket.user?.email,
    userCode: socket.userCode,
    isStreaming: false,
    sourceLanguage: null,
    targetLanguage: null,
    needsTokenRefresh: socket.needsTokenRefresh || false,
    lastPing: Date.now(),
    pingTimeout: null,
    connectionQuality: 'good', // good, poor, critical
    messageCount: 0,
    errorCount: 0,
    lastActivity: Date.now(),
    streamStartTime: null,  // Track when streaming session started
    sessionCounted: false   // Prevent double-counting sessions
  })
  
  // Update lastActive for authenticated users
  if (socket.user?.id) {
    try {
      await User.updateLastActive(socket.user.id);
    } catch (err) {
      console.warn('⚠️ Failed to update lastActive:', err.message);
    }
  }

  // Set up heartbeat mechanism
  const connection = activeConnections.get(socket.id)
  if (connection) {
    // Set initial ping timeout (60 seconds - more lenient for initial connection)
    connection.pingTimeout = setTimeout(() => {
      console.log(`💔 Heartbeat timeout for socket ${socket.id}, disconnecting...`)
      socket.disconnect(true)
    }, 60000)
  }

  if (socket.needsTokenRefresh) {
    socket.emit('tokenExpired', {
      message: 'Your session has expired. Please refresh your token.',
      code: 'TOKEN_EXPIRED'
    })
  }
  
  emitConnectionCount(socket.userCode)

  // Handle ping/pong for heartbeat
  socket.on('ping', () => {
    const connection = activeConnections.get(socket.id)
    if (connection) {
      // Calculate time since last ping BEFORE updating it
      const timeSinceLastPing = connection.lastPing ? Date.now() - connection.lastPing : 0
      
      // Update connection quality based on ping interval
      // Expected ping interval is ~15 seconds, so longer intervals indicate poor connection
      if (timeSinceLastPing > 30000) {
        connection.connectionQuality = 'critical'
      } else if (timeSinceLastPing > 20000) {
        connection.connectionQuality = 'poor'
      } else {
        connection.connectionQuality = 'good'
      }
      
      // Update last ping time after calculating quality
      connection.lastPing = Date.now()
      connection.lastActivity = Date.now()
      
      // Clear existing timeout and set new one
      if (connection.pingTimeout) {
        clearTimeout(connection.pingTimeout)
      }
      
      // Adaptive timeout based on connection quality - more lenient timeouts
      // Even with "critical" quality, give 45 seconds to recover
      const timeoutDuration = connection.connectionQuality === 'critical' ? 45000 : 
                            connection.connectionQuality === 'poor' ? 60000 : 90000
      
      connection.pingTimeout = setTimeout(() => {
        console.log(`💔 Heartbeat timeout for socket ${socket.id} (quality: ${connection.connectionQuality}), disconnecting...`)
        socket.disconnect(true)
      }, timeoutDuration)
    }
    socket.emit('pong')
  })

  socket.on('refreshToken', async (data) => {
    try {
      const { refreshToken } = data
      
      if (!refreshToken) {
        socket.emit('tokenRefreshError', { message: 'Refresh token required' })
        return
      }

      const jwt = require('jsonwebtoken')
      const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production'
      
      jwt.verify(refreshToken, JWT_SECRET, async (err, decoded) => {
        if (err) {
          socket.emit('tokenRefreshError', { message: 'Invalid refresh token' })
          return
        }

        try {
          const user = await User.findUserById(decoded.userId)
          if (!user || !user.isActive) {
            socket.emit('tokenRefreshError', { message: 'User not found' })
            return
          }

          const { generateToken, generateRefreshToken } = require('./src/middleware/auth')
          const newAccessToken = generateToken(user)
          const newRefreshToken = generateRefreshToken(user)

          socket.user = user
          socket.needsTokenRefresh = false
          
          const connection = activeConnections.get(socket.id)
          if (connection) {
            connection.userId = user.id
            connection.userEmail = user.email
            connection.needsTokenRefresh = false
          }

          socket.emit('tokenRefreshed', {
            accessToken: newAccessToken,
            refreshToken: newRefreshToken
          })

          console.log(`🔄 Token refreshed: ${user.email}`)
        } catch (error) {
          console.error('Error refreshing token:', error)
          socket.emit('tokenRefreshError', { message: 'Token refresh failed' })
        }
      })
    } catch (error) {
      console.error('Token refresh error:', error)
      socket.emit('tokenRefreshError', { message: 'Token refresh failed' })
    }
  })

  socket.on('speechTranscription', async (data) => {
    try {
      
      if (socket.needsTokenRefresh) {
        socket.emit('tokenExpired', {
          message: 'Your session has expired. Please refresh your token.',
          code: 'TOKEN_EXPIRED'
        })
        return
      }
      
      const { transcription, sourceLanguage, bubbleId } = data
      
      const connection = activeConnections.get(socket.id)
      if (connection) {
        connection.isStreaming = true
        connection.sourceLanguage = sourceLanguage
        connection.messageCount++
        connection.lastActivity = Date.now()
        
        // Track streaming session start
        if (!connection.streamStartTime) {
          connection.streamStartTime = Date.now();
          if (socket.user?.id && !connection.sessionCounted) {
            connection.sessionCounted = true;
            User.incrementSessionCount(socket.user.id).catch(() => {});
          }
        }
      }

      const currentConnection = activeConnections.get(socket.id)
      emitConnectionCount(currentConnection?.userCode)
      
      if (currentConnection?.userCode) {
        const userCodeConnections = Array.from(activeConnections.entries())
          .filter(([_, conn]) => conn.userCode === currentConnection.userCode)
          .map(([socketId, _]) => socketId)
        
        const translationConnections = userCodeConnections.filter(socketId => {
          const conn = activeConnections.get(socketId)
          return conn && !conn.isStreaming && conn.targetLanguage
        })
        
        userCodeConnections.forEach(socketId => {
          const targetSocket = io.sockets.sockets.get(socketId)
          const conn = activeConnections.get(socketId)
          if (targetSocket && conn?.userId) {
            targetSocket.emit('transcriptionComplete', {
              transcription,
              sourceLanguage,
              bubbleId,
              userId: currentConnection.userId,
              userEmail: currentConnection.userEmail
            })
          }
        })
        
        if (translationConnections.length > 0) {
          try {
            for (const socketId of translationConnections) {
              const conn = activeConnections.get(socketId)
              if (conn?.targetLanguage) {
                const translatedText = await processTranscription(transcription, sourceLanguage, conn.targetLanguage)
                
                const targetSocket = io.sockets.sockets.get(socketId)
                if (targetSocket) {
                  targetSocket.emit('translationComplete', {
                    originalText: transcription,
                    translatedText,
                    sourceLanguage,
                    targetLanguage: conn.targetLanguage,
                    bubbleId,
                    userId: currentConnection.userId,
                    userEmail: currentConnection.userEmail
                  })
                }
              }
            }
          } catch (error) {
            console.error('Translation error:', error)
            translationConnections.forEach(socketId => {
              const targetSocket = io.sockets.sockets.get(socketId)
              if (targetSocket) {
                targetSocket.emit('translationError', {
                  error: 'Translation failed',
                  bubbleId
                })
              }
            })
          }
        }
      } else {
        io.emit('transcriptionComplete', {
          transcription,
          sourceLanguage,
          bubbleId,
          userId: currentConnection?.userId,
          userEmail: currentConnection?.userEmail
        })
      }
      
    } catch (error) {
      console.error('Error processing speech transcription:', error)
      
      // Track error for connection quality monitoring
      const connection = activeConnections.get(socket.id)
      if (connection) {
        connection.errorCount++
        connection.lastActivity = Date.now()
        
        // Update connection quality based on error rate
        const errorRate = connection.errorCount / Math.max(connection.messageCount, 1)
        if (errorRate > 0.1) {
          connection.connectionQuality = 'critical'
        } else if (errorRate > 0.05) {
          connection.connectionQuality = 'poor'
        }
      }
      
      socket.emit('error', { message: 'Failed to process transcription: ' + error.message })
    }
  })

  // Google Cloud Speech-to-Text streaming handler
  socket.on('googleSpeechTranscription', async (data) => {
    try {
      if (socket.needsTokenRefresh) {
        console.log('❌ Token needs refresh');
        socket.emit('tokenExpired', {
          message: 'Your session has expired. Please refresh your token.',
          code: 'TOKEN_EXPIRED'
        })
        return
      }

      const {
        audioData, 
        sourceLanguage, 
        bubbleId, 
        isFinal, 
        interimTranscript,
        finalTranscript,
        wordCount,
        maxWordsPerBubble = 15,
        speechEndTimeout = 1.0
      } = data

      const connection = activeConnections.get(socket.id)
      if (connection) {
        connection.isStreaming = true
        connection.sourceLanguage = sourceLanguage
        
        // Track streaming session start
        if (!connection.streamStartTime) {
          connection.streamStartTime = Date.now();
          if (socket.user?.id && !connection.sessionCounted) {
            connection.sessionCounted = true;
            User.incrementSessionCount(socket.user.id).catch(() => {});
          }
        }
      }

      const currentConnection = activeConnections.get(socket.id)
      emitConnectionCount(currentConnection?.userCode)
      
      // Track the current bubbleId from frontend (important for stream restarts)
      if (bubbleId) {
        currentBubbleIds.set(socket.id, bubbleId);
      }

      // If we have audio data, process it with Google Cloud Speech-to-Text
      if (audioData && audioData.length > 0) {
        try {
          const audioBuffer = Buffer.from(audioData, 'base64')

          audioChunkCounter++
          
          // Log audio reception periodically (every 5 seconds) to track if audio is flowing
          const now = Date.now()
          if (now - lastAudioLogTime > 5000) {
            console.log(`🎵 Audio flowing: ${audioChunkCounter} chunks received, buffer size: ${audioBuffer.length} bytes`)
            lastAudioLogTime = now
          }
          
          // Check if this is LINEAR16 format from frontend
          const audioFormat = data.audioFormat || 'WEBM';
          const sampleRate = data.sampleRate || 48000;
          
          if (audioFormat === 'LINEAR16') {
            // Start streaming recognition on first chunk for this socket
            if (!streamingSessions.has(socket.id)) {
              console.log(`🎤 Starting Google Cloud streaming recognition for socket ${socket.id}, sourceLanguage: ${sourceLanguage}, speechEndTimeout: ${speechEndTimeout}s`);
              
              try {
                const recognizeStream = await speechToTextService.startStreamingRecognition(sourceLanguage, speechEndTimeout, {
                onResult: async (result) => {
                  // Track that we received a transcription - reset watchdog
                  lastTranscriptionTime.set(socket.id, Date.now());
                  audioChunksPerSocket.set(socket.id, 0);
                  
                  // Send transcription result to frontend
                  // Use tracked bubbleId (updated by incoming audio) to handle stream restarts
                  const activeBubbleId = currentBubbleIds.get(socket.id) || bubbleId;
                  socket.emit('transcriptionUpdate', {
                    transcript: result.transcript,
                    isFinal: result.isFinal,
                    confidence: result.confidence,
                    bubbleId: activeBubbleId
                  });

                  // Handle translation for final results
                  if (result.isFinal && result.transcript.trim()) {
                    // Notify frontend that we've received a final result to prevent duplicate finalization
                    socket.emit('finalResultReceived', { bubbleId: activeBubbleId });
                    // Create a unique key based on transcript content to prevent duplicates
                    const transcriptKey = `${socket.id}-${result.transcript.trim()}`;
                    const currentTime = Date.now();
                    
                    // Check if we've already processed this exact transcript recently (within 3 seconds)
                    const lastProcessed = processedTranscripts.get(transcriptKey);
                    if (lastProcessed && (currentTime - lastProcessed) < 3000) {
                      console.log('🔄 Skipping duplicate transcript:', result.transcript.trim());
                      return;
                    }
                    
                    // Mark this transcript as processed
                    processedTranscripts.set(transcriptKey, currentTime);
                    
                    // Clean up old processed transcripts (older than 5 minutes)
                    const fiveMinutesAgo = currentTime - (5 * 60 * 1000);
                    for (const [key, timestamp] of processedTranscripts.entries()) {
                      if (timestamp < fiveMinutesAgo) {
                        processedTranscripts.delete(key);
                      }
                    }
                    
                    const currentConnection = activeConnections.get(socket.id);
                    if (currentConnection?.userCode) {
                      const userCodeConnections = Array.from(activeConnections.entries())
                        .filter(([_, conn]) => conn.userCode === currentConnection.userCode)
                        .map(([socketId, _]) => socketId);
                      
                      const translationConnections = userCodeConnections.filter(socketId => {
                        const conn = activeConnections.get(socketId);
                        const isListener = conn && !conn.isStreaming && conn.targetLanguage;
                        return isListener;
                      });
                      
                      console.log(`📢 [STT] Found ${translationConnections.length} listener(s)`)
                      
                      // Send transcription to input clients
                      userCodeConnections.forEach(socketId => {
                        const targetSocket = io.sockets.sockets.get(socketId);
                        const conn = activeConnections.get(socketId);
                        if (targetSocket && conn?.userId) {
                          targetSocket.emit('transcriptionComplete', {
                            transcription: result.transcript,
                            sourceLanguage,
                            bubbleId: activeBubbleId,
                            userId: currentConnection.userId,
                            userEmail: currentConnection.userEmail
                          });
                        }
                      });
                      
                      // Process translations
                      if (translationConnections.length > 0) {
                        try {
                          const translations = await Promise.all(
                            translationConnections.map(async (socketId) => {
                              const conn = activeConnections.get(socketId);
                              if (conn?.targetLanguage) {
                                const translation = await processTranscription(
                                  result.transcript,
                                  sourceLanguage,
                                  conn.targetLanguage
                                );
                                return { socketId, translation, targetLanguage: conn.targetLanguage };
                              }
                              return null;
                            })
                          );

                          // Filter out null translations and emit to listeners
                          translations.filter(Boolean).forEach((item) => {
                            const { socketId, translation, targetLanguage } = item;
                            if (socketId && translation) {
                              const targetSocket = io.sockets.sockets.get(socketId);
                              if (targetSocket) {
                                console.log(`📤 [STT] Emitting translationComplete to ${socketId}: "${translation.substring(0, 50)}..."`);
                                targetSocket.emit('translationComplete', {
                                  originalText: result.transcript,
                                  translatedText: translation,
                                  sourceLanguage,
                                  targetLanguage,
                                  bubbleId: activeBubbleId
                                });
                              } else {
                                console.log(`⚠️ [STT] Target socket ${socketId} not found, cannot emit translation`);
                              }
                            }
                          });
                        } catch (translationError) {
                          console.error('Translation error:', translationError);
                          translationConnections.forEach(socketId => {
                            const targetSocket = io.sockets.sockets.get(socketId);
                            if (targetSocket) {
                              targetSocket.emit('translationError', {
                                message: 'Translation failed: ' + translationError.message,
                                bubbleId: activeBubbleId
                              });
                            }
                          });
                        }
                      }
                    }
                  }
                },
                onError: (error) => {
                  console.error('❌ Google Cloud streaming error:', error);
                  
                  // Attempt to recover from common errors
                  if (error.code === 14 || error.message.includes('UNAVAILABLE')) {
                    console.log('🔄 Attempting to recover from UNAVAILABLE error...');
                    setTimeout(() => {
                      if (socket.connected) {
                        socket.emit('streamRestart', { 
                          reason: 'recovery', 
                          error: error.message 
                        });
                      }
                    }, 1000);
                  }
                },
                onEnd: () => {
                  console.log('🎤 Google Cloud streaming ended');
                },
                onRestart: async function restartStream() {
                  console.log('🔄 Restarting Google Cloud stream with OVERLAP (no gap)...');
                  
                  // Notify the speaker to save any displayed interim text
                  socket.emit('streamRestart', { 
                    reason: '5-minute-limit-or-recovery',
                    timestamp: Date.now()
                  });
                  
                  // Get current stream - DON'T end it yet, we'll overlap
                  const oldStream = streamingSessions.get(socket.id);
                  
                  // Store old stream for overlapping - audio will continue to flow to it
                  // BUT remove its event listeners so errors don't disrupt the new stream
                  if (oldStream && !oldStream.destroyed) {
                    // Clear the restart timer from the old stream
                    if (oldStream._restartTimer) {
                      clearTimeout(oldStream._restartTimer);
                      oldStream._restartTimer = null;
                    }
                    // Remove event listeners to prevent old stream errors from triggering restarts
                    oldStream.removeAllListeners();
                    overlappingStreams.set(socket.id, oldStream);
                    console.log('📦 Old stream stored for overlap (listeners removed), will continue receiving audio');
                  }
                  
                  // Clear the main session mapping so the new stream can take over
                  streamingSessions.delete(socket.id);
                  
                  // Notify all listeners that the stream is restarting
                  const currentConnection = activeConnections.get(socket.id);
                  if (currentConnection?.userCode) {
                    const listenerConnections = Array.from(activeConnections.entries())
                      .filter(([_, conn]) => conn.userCode === currentConnection.userCode && !conn.isStreaming)
                      .map(([socketId, _]) => socketId);
                    
                    listenerConnections.forEach(socketId => {
                      const targetSocket = io.sockets.sockets.get(socketId);
                      if (targetSocket) {
                        targetSocket.emit('streamRestarting', {
                          message: 'Speaker stream is restarting, please wait...',
                          timestamp: Date.now()
                        });
                      }
                    });
                  }
                  
                  // NO delay - create new stream immediately for seamless transition
                  
                  // Create new stream with the same restart function
                  try {
                    const newRecognizeStream = await speechToTextService.startStreamingRecognition(sourceLanguage, speechEndTimeout, {
                      onResult: async (result) => {
                        // Track that we received a transcription - reset watchdog
                        lastTranscriptionTime.set(socket.id, Date.now());
                        audioChunksPerSocket.set(socket.id, 0);
                        
                        // Use tracked bubbleId (updated by incoming audio) to handle stream restarts
                        const activeBubbleId = currentBubbleIds.get(socket.id) || bubbleId;
                        socket.emit('transcriptionUpdate', {
                          transcript: result.transcript,
                          isFinal: result.isFinal,
                          confidence: result.confidence,
                          bubbleId: activeBubbleId
                        });

                        // Handle translation for final results
                        if (result.isFinal && result.transcript.trim()) {
                          socket.emit('finalResultReceived', { bubbleId: activeBubbleId });
                          const transcriptKey = `${socket.id}-${result.transcript.trim()}`;
                          const currentTime = Date.now();
                          
                          const lastProcessed = processedTranscripts.get(transcriptKey);
                          if (lastProcessed && (currentTime - lastProcessed) < 3000) {
                            return;
                          }
                          
                          processedTranscripts.set(transcriptKey, currentTime);
                          
                          const fiveMinutesAgo = currentTime - (5 * 60 * 1000);
                          for (const [key, timestamp] of processedTranscripts.entries()) {
                            if (timestamp < fiveMinutesAgo) {
                              processedTranscripts.delete(key);
                            }
                          }
                          
                          const currentConnection = activeConnections.get(socket.id);
                          if (currentConnection?.userCode) {
                            const userCodeConnections = Array.from(activeConnections.entries())
                              .filter(([_, conn]) => conn.userCode === currentConnection.userCode)
                              .map(([socketId, _]) => socketId);
                            
                            const translationConnections = userCodeConnections.filter(socketId => {
                              const conn = activeConnections.get(socketId);
                              return conn && !conn.isStreaming && conn.targetLanguage;
                            });
                            
                            userCodeConnections.forEach(socketId => {
                              const targetSocket = io.sockets.sockets.get(socketId);
                              const conn = activeConnections.get(socketId);
                              if (targetSocket && conn?.userId) {
                                targetSocket.emit('transcriptionComplete', {
                                  transcription: result.transcript,
                                  sourceLanguage,
                                  bubbleId: activeBubbleId,
                                  userId: currentConnection.userId,
                                  userEmail: currentConnection.userEmail
                                });
                              }
                            });
                            
                            if (translationConnections.length > 0) {
                              try {
                                const translations = await Promise.all(
                                  translationConnections.map(async (socketId) => {
                                    const conn = activeConnections.get(socketId);
                                    if (conn?.targetLanguage) {
                                      const translation = await processTranscription(
                                        result.transcript,
                                        sourceLanguage,
                                        conn.targetLanguage
                                      );
                                      return { socketId, translation, targetLanguage: conn.targetLanguage };
                                    }
                                    return null;
                                  })
                                );

                                // Filter out null translations and emit to listeners
                                translations.filter(Boolean).forEach((item) => {
                                  const { socketId, translation, targetLanguage } = item;
                                  if (socketId && translation) {
                                    const targetSocket = io.sockets.sockets.get(socketId);
                                    if (targetSocket) {
                                      console.log(`📤 [STT-interim] Emitting translationComplete to ${socketId}: "${translation.substring(0, 50)}..."`);
                                      targetSocket.emit('translationComplete', {
                                        originalText: result.transcript,
                                        translatedText: translation,
                                        sourceLanguage,
                                        targetLanguage,
                                        bubbleId: activeBubbleId
                                      });
                                    } else {
                                      console.log(`⚠️ [STT-interim] Target socket ${socketId} not found`);
                                    }
                                  }
                                });
                              } catch (translationError) {
                                console.error('Translation error:', translationError);
                              }
                            }
                          }
                        }
                      },
                      onError: (error) => {
                        console.error('❌ Google Cloud streaming error:', error);
                        if (error.code === 14 || error.message.includes('UNAVAILABLE')) {
                          console.log('🔄 Attempting to recover from UNAVAILABLE error...');
                        }
                      },
                      onEnd: () => {
                        console.log('🎤 Google Cloud streaming ended');
                      },
                      onRestart: restartStream // Reference the named function
                    });
                    
                    // Store new stream
                    if (newRecognizeStream) {
                      streamingSessions.set(socket.id, newRecognizeStream);
                      
                      // Flush buffered audio to the new stream
                      const bufferedAudio = audioBufferDuringRestart.get(socket.id) || [];
                      if (bufferedAudio.length > 0) {
                        console.log(`📤 Flushing ${bufferedAudio.length} buffered audio chunks to new stream`);
                        for (const audioBuffer of bufferedAudio) {
                          speechToTextService.sendAudioToStream(newRecognizeStream, audioBuffer);
                        }
                      }
                      
                      // Clear restart state
                      restartingStreams.delete(socket.id);
                      audioBufferDuringRestart.delete(socket.id);
                      
                      console.log('✅ Stream restarted successfully');
                      
                      // End the overlapping (old) stream after a delay to ensure no gaps
                      // The old stream may still produce final results during this overlap period
                      const overlappingStream = overlappingStreams.get(socket.id);
                      if (overlappingStream) {
                        setTimeout(() => {
                          console.log('🔄 Ending overlapping (old) stream after overlap period');
                          try {
                            speechToTextService.endStreamingRecognition(overlappingStream);
                          } catch (e) {
                            // Ignore errors when ending old stream
                          }
                          overlappingStreams.delete(socket.id);
                        }, 2000); // 2 second overlap to catch any final results
                      }
                    }
                  } catch (error) {
                    console.error('❌ Failed to restart stream:', error);
                    // Clear restart state on error too
                    restartingStreams.delete(socket.id);
                    // Also clean up overlapping stream on error
                    const overlappingStream = overlappingStreams.get(socket.id);
                    if (overlappingStream) {
                      try {
                        speechToTextService.endStreamingRecognition(overlappingStream);
                      } catch (e) {}
                      overlappingStreams.delete(socket.id);
                    }
                    audioBufferDuringRestart.delete(socket.id);
                  }
                }
                });
                
                // Store the stream for this socket
                if (recognizeStream) {
                  streamingSessions.set(socket.id, recognizeStream);
                  console.log(`✅ Stream created and stored for socket ${socket.id}`);
                } else {
                  console.error('❌ Stream creation returned null/undefined for socket:', socket.id);
                }
              } catch (streamError) {
                console.error('❌ Failed to create streaming recognition:', streamError);
                console.error('Error details:', {
                  message: streamError.message,
                  stack: streamError.stack,
                  sourceLanguage: sourceLanguage
                });
                socket.emit('error', {
                  message: 'Failed to start speech recognition: ' + streamError.message
                });
                return; // Don't try to send audio if stream creation failed
              }
            }
            
            // Check if we're in the middle of a stream restart
            if (restartingStreams.get(socket.id)) {
              // Buffer the audio for when the new stream is ready
              const buffer = audioBufferDuringRestart.get(socket.id) || [];
              buffer.push(audioBuffer);
              audioBufferDuringRestart.set(socket.id, buffer);
              // Limit buffer size to prevent memory issues (keep last 100 chunks ~2 seconds of audio)
              if (buffer.length > 100) {
                buffer.shift();
              }
              // Log buffering every second
              if (buffer.length % 50 === 0) {
                console.log(`📦 Buffering audio during restart: ${buffer.length} chunks`);
              }
              // ALSO send to overlapping stream if it exists (ensures no gaps)
              const overlappingStream = overlappingStreams.get(socket.id);
              if (overlappingStream && !overlappingStream.destroyed) {
                speechToTextService.sendAudioToStream(overlappingStream, audioBuffer);
              }
            } else {
              // Send audio chunk to Google Cloud streaming
              const recognizeStream = streamingSessions.get(socket.id);
              if (recognizeStream && !recognizeStream.destroyed) {
                speechToTextService.sendAudioToStream(recognizeStream, audioBuffer);
                
                // Also send to overlapping stream during overlap period
                const overlappingStream = overlappingStreams.get(socket.id);
                if (overlappingStream && !overlappingStream.destroyed) {
                  speechToTextService.sendAudioToStream(overlappingStream, audioBuffer);
                }
                
                // Increment audio chunk counter for this socket
                const chunkCount = (audioChunksPerSocket.get(socket.id) || 0) + 1;
                audioChunksPerSocket.set(socket.id, chunkCount);
                
                // Watchdog: If we've sent 1000+ chunks (about 20+ seconds) without any transcription,
                // the stream might be in a zombie state - trigger restart
                const lastTranscript = lastTranscriptionTime.get(socket.id) || Date.now();
                const timeSinceLastTranscript = Date.now() - lastTranscript;
                
                if (chunkCount > 1000 && timeSinceLastTranscript > 20000) {
                  console.log(`⚠️ Watchdog: ${chunkCount} audio chunks sent, no transcription for ${Math.round(timeSinceLastTranscript/1000)}s - restarting stream`);
                  
                  // Reset counters
                  audioChunksPerSocket.set(socket.id, 0);
                  lastTranscriptionTime.set(socket.id, Date.now());
                  
                  // End the current stream
                  speechToTextService.endStreamingRecognition(recognizeStream);
                  streamingSessions.delete(socket.id);
                  
                  // Immediately create a new stream (don't wait for next audio chunk)
                  const connection = activeConnections.get(socket.id);
                  if (connection?.isStreaming) {
                    console.log('🔄 Watchdog: Creating new stream immediately...');
                    // Re-emit the startGoogleSpeechRecognition event to trigger stream creation
                    socket.emit('watchdogRestart', { reason: 'zombie_stream_detected' });
                  }
                }
              } else {
                // Only log error if we're not in a transient state
                if (!streamingSessions.has(socket.id)) {
                  // No stream exists - might need to create one
                  console.log(`⚠️ No stream exists for socket ${socket.id}, audio will be lost. Consider restarting transcription.`);
                } else {
                  console.error('❌ No valid stream found for socket:', socket.id, {
                    hasStream: !!recognizeStream,
                    isDestroyed: recognizeStream?.destroyed,
                    sessionExists: streamingSessions.has(socket.id),
                    isRestarting: restartingStreams.get(socket.id)
                  });
                }
              }
            }
          } else {
            console.log('🎤 Stream already exists for socket:', socket.id, '- using existing stream');
          }
        } catch (speechError) {
          console.error('❌ Google Cloud Speech-to-Text error:', speechError)
          socket.emit('error', { 
            message: 'Speech recognition failed: ' + speechError.message 
          })
        }
      }

      // Handle manual finalization (when frontend sends final transcript)
      if (finalTranscript && isFinal && !audioData) {
        if (currentConnection?.userCode) {
          const userCodeConnections = Array.from(activeConnections.entries())
            .filter(([_, conn]) => conn.userCode === currentConnection.userCode)
            .map(([socketId, _]) => socketId)
          
          const translationConnections = userCodeConnections.filter(socketId => {
            const conn = activeConnections.get(socketId)
            const isListener = conn && !conn.isStreaming && conn.targetLanguage
            return isListener
          })
          
          userCodeConnections.forEach(socketId => {
            const targetSocket = io.sockets.sockets.get(socketId)
            const conn = activeConnections.get(socketId)
            if (targetSocket && conn?.userId) {
              targetSocket.emit('transcriptionComplete', {
                transcription: finalTranscript,
                sourceLanguage,
                bubbleId,
                userId: currentConnection.userId,
                userEmail: currentConnection.userEmail
              })
            }
          })
          
          if (translationConnections.length > 0) {
            try {
              const translations = await Promise.all(
                translationConnections.map(async (socketId) => {
                  const conn = activeConnections.get(socketId)
                  if (conn?.targetLanguage) {
                    const translation = await processTranscription(
                      finalTranscript, 
                      sourceLanguage, 
                      conn.targetLanguage
                    )
                    return { socketId, translation, targetLanguage: conn.targetLanguage }
                  }
                  return null
                })
              )

              // Filter out null translations and emit to listeners
              translations.filter(Boolean).forEach((item) => {
                const { socketId, translation, targetLanguage } = item;
                if (socketId && translation) {
                  const targetSocket = io.sockets.sockets.get(socketId)
                  if (targetSocket) {
                    console.log(`📤 [STT-final] Emitting translationComplete to ${socketId}: "${translation.substring(0, 50)}..."`);
                    targetSocket.emit('translationComplete', {
                      originalText: finalTranscript,
                      translatedText: translation,
                      sourceLanguage,
                      targetLanguage,
                      bubbleId
                    })
                  } else {
                    console.log(`⚠️ [STT-final] Target socket ${socketId} not found`);
                  }
                }
              })
            } catch (translationError) {
              console.error('Translation error:', translationError)
              translationConnections.forEach(socketId => {
                const targetSocket = io.sockets.sockets.get(socketId)
                if (targetSocket) {
                  targetSocket.emit('translationError', {
                    message: 'Translation failed: ' + translationError.message,
                    bubbleId
                  })
                }
              })
            }
          }
        } else {
          io.emit('transcriptionComplete', {
            transcription: finalTranscript,
            sourceLanguage,
            bubbleId,
            userId: currentConnection?.userId,
            userEmail: currentConnection?.userEmail
          })
        }
      }

    } catch (error) {
      console.error('Error processing Google Cloud speech transcription:', error)
      socket.emit('error', { message: 'Failed to process speech transcription: ' + error.message })
    }
  })


  socket.on('stopStreaming', async () => {
    const connection = activeConnections.get(socket.id)
    if (connection) {
      connection.isStreaming = false
      
      // Record usage minutes
      if (connection.streamStartTime && socket.user?.id) {
        const usageMinutes = (Date.now() - connection.streamStartTime) / 60000;
        if (usageMinutes >= 0.1) {
          User.addUsageMinutes(socket.user.id, usageMinutes).catch(() => {});
        }
        connection.streamStartTime = null;
      }
    }
    
    // End Google Cloud streaming session
    const recognizeStream = streamingSessions.get(socket.id)
    if (recognizeStream) {
      speechToTextService.endStreamingRecognition(recognizeStream)
      streamingSessions.delete(socket.id)
    }
  })

  socket.on('setTargetLanguage', (data) => {
    console.log(`🎯 setTargetLanguage received: ${data.targetLanguage} for socket ${socket.id}`)
    const connection = activeConnections.get(socket.id)
    if (connection) {
      connection.targetLanguage = data.targetLanguage
      console.log(`✅ Target language set to ${data.targetLanguage} for listener (userCode: ${connection.userCode})`)
      emitConnectionCount(connection.userCode)
    } else {
      console.log(`⚠️ No connection found for socket ${socket.id}`)
    }
  })

  socket.on('getConnectionCount', () => {
    const currentConnection = activeConnections.get(socket.id)
    const userCode = currentConnection?.userCode
    
    const connectionsByLanguage = {}
    let totalConnections = 0
    
    activeConnections.forEach((connection) => {
      if (userCode && connection.userCode !== userCode) {
        return
      }
      
      if (!connection.userCode) {
        return
      }
      
      totalConnections++
      if (connection.targetLanguage) {
        connectionsByLanguage[connection.targetLanguage] = (connectionsByLanguage[connection.targetLanguage] || 0) + 1
      }
    })
    
    const connectionData = {
      total: totalConnections,
      byLanguage: connectionsByLanguage
    }
    
    socket.emit('connectionCount', connectionData)
  })

  socket.on('disconnect', async () => {
    const connection = activeConnections.get(socket.id)
    
    // Clean up ping timeout
    if (connection && connection.pingTimeout) {
      clearTimeout(connection.pingTimeout)
    }
    
    // Record usage minutes if user was streaming when disconnected
    if (connection?.streamStartTime && socket.user?.id) {
      const usageMinutes = (Date.now() - connection.streamStartTime) / 60000;
      if (usageMinutes >= 0.1) {
        User.addUsageMinutes(socket.user.id, usageMinutes).catch(() => {});
      }
    }
    
    // Clean up streaming session
    const recognizeStream = streamingSessions.get(socket.id)
    if (recognizeStream) {
      speechToTextService.endStreamingRecognition(recognizeStream)
      streamingSessions.delete(socket.id)
    }
    
    // Clean up restart state
    restartingStreams.delete(socket.id)
    audioBufferDuringRestart.delete(socket.id)
    
    // Clean up overlapping stream if any
    const overlappingStream = overlappingStreams.get(socket.id)
    if (overlappingStream) {
      try {
        speechToTextService.endStreamingRecognition(overlappingStream)
      } catch (e) {}
      overlappingStreams.delete(socket.id)
    }
    
    // Clean up watchdog state
    lastTranscriptionTime.delete(socket.id)
    audioChunksPerSocket.delete(socket.id)
    currentBubbleIds.delete(socket.id)
    
    // Clean up processed transcripts for this socket
    const socketPrefix = `${socket.id}-`;
    for (const [key, _] of processedTranscripts.entries()) {
      if (key.startsWith(socketPrefix)) {
        processedTranscripts.delete(key);
      }
    }
    
    // Log connection quality metrics before cleanup
    if (connection) {
      const sessionDuration = Date.now() - connection.lastActivity
      const errorRate = connection.errorCount / Math.max(connection.messageCount, 1)
      console.log(`📊 Connection metrics for ${socket.user?.email || 'Listener'}:`, {
        duration: `${Math.round(sessionDuration / 1000)}s`,
        messages: connection.messageCount,
        errors: connection.errorCount,
        errorRate: `${Math.round(errorRate * 100)}%`,
        quality: connection.connectionQuality
      })
    }
    
    activeConnections.delete(socket.id)
    
    console.log(`🔌 Client disconnected: ${socket.user?.email || 'Listener'} (${socket.userCode || 'No User Code'})`)
    
    emitConnectionCount(connection?.userCode)
  })
})

async function processTranscription(transcription, sourceLanguage, targetLanguage) {
  const startTime = Date.now();
  const translationId = `trans-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // If source and target languages are the same, return the transcription directly
    if (sourceLanguage === targetLanguage) {
      console.log(`🔄 [${translationId}] Source and target languages match (${sourceLanguage}), returning transcription directly`);
      return transcription;
    }

    // Use Google Cloud Translation API
    const translatedText = await googleTranslationService.translateText(
      transcription,
      sourceLanguage,
      targetLanguage
    );
    
    const duration = Date.now() - startTime;
    
    return translatedText;
    
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`❌ [${translationId}] Translation error after ${duration}ms:`, {
      message: error.message,
      code: error.code,
      details: error.details,
      sourceLanguage,
      targetLanguage,
      textLength: transcription.length,
      stack: error.stack
    });
    
    // Return error message but don't throw - let listeners know translation failed
    return `Translation error: ${error.message}`
  }
}

app.get('/health', (req, res) => {
  try {
    // Simple health check that doesn't depend on external services
    res.status(200).json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      port: config.PORT,
      environment: config.NODE_ENV
    })
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({ 
      status: 'ERROR', 
      error: error.message,
      timestamp: new Date().toISOString()
    })
  }
})

// Translation service health check endpoint
app.get('/health/translation', async (req, res) => {
  try {
    const health = await googleTranslationService.healthCheck();
    const stats = googleTranslationService.getStats();
    
    res.status(health.healthy ? 200 : 503).json({
      service: 'translation',
      healthy: health.healthy,
      timestamp: new Date().toISOString(),
      stats: stats,
      health: health
    });
  } catch (error) {
    console.error('Translation health check error:', error);
    res.status(503).json({
      service: 'translation',
      healthy: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
})

// Translation service statistics endpoint
app.get('/api/translation/stats', (req, res) => {
  try {
    const stats = googleTranslationService.getStats();
    res.json({
      ...stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Translation stats error:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
})

// Force translation client recreation (for testing/debugging)
app.post('/api/translation/recreate-client', async (req, res) => {
  try {
    console.log('🔄 Manual client recreation requested');
    await googleTranslationService.getTranslationClient(true);
    const health = await googleTranslationService.healthCheck();
    res.json({
      success: true,
      message: 'Translation client recreated',
      health: health,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Failed to recreate translation client:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
})

app.post('/api/tts', async (req, res) => {
  try {
    const { text, languageCode } = req.body
    
    if (!text || !languageCode) {
      return res.status(400).json({ 
        error: 'Missing required fields: text and languageCode' 
      })
    }

    // Check if language is supported
    if (!textToSpeechService.isLanguageSupported(languageCode)) {
      return res.status(400).json({ 
        error: `Language ${languageCode} is not supported for text-to-speech` 
      })
    }

    // Generate audio
    const audioBuffer = await textToSpeechService.synthesizeSpeech(text, languageCode)
    
    // Send audio as MP3
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length,
      'Cache-Control': 'no-cache'
    })
    
    res.send(audioBuffer)
  } catch (error) {
    console.error('TTS endpoint error:', error)
    res.status(500).json({ 
      error: 'Text-to-speech synthesis failed: ' + error.message 
    })
  }
})

// Check TTS language support
app.get('/api/tts/supported', (req, res) => {
  const { languageCode } = req.query
  
  if (!languageCode) {
    return res.status(400).json({ error: 'Missing languageCode query parameter' })
  }
  
  const supported = textToSpeechService.isLanguageSupported(languageCode)
  res.json({ languageCode, supported })
})

app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ error: 'Something went wrong!' })
})

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

const startServer = async () => {
  try {
    console.log('🔧 Starting server initialization...')
    console.log(`📊 Environment: ${config.NODE_ENV}`)
    console.log(`🌐 Port: ${config.PORT}`)
    console.log(`🏠 Host: ${config.HOST}`)
    
    // Start listening on the port FIRST to satisfy Cloud Run health checks
    // This ensures the container responds to health checks quickly
    await new Promise((resolve, reject) => {
      server.listen(config.PORT, config.HOST, () => {
        console.log(`🚀 Server listening on ${config.HOST}:${config.PORT}`)
        resolve()
      })
      server.on('error', reject)
    })
    
    console.log('🔧 Starting Firestore initialization...')
    try {
      await initFirestore()
      console.log('✅ Firestore initialized')
    } catch (dbError) {
      console.error('❌ Firestore initialization failed:', dbError.message)
      console.log('⚠️ Server will continue but database features may not work')
    }
    
    // Initialize Google Cloud client in the background to avoid startup delays
    try {
      await speechToTextService.getSpeechClient()
      console.log('✅ Google Cloud Speech client initialized')
    } catch (error) {
      console.warn('⚠️ Google Cloud Speech client initialization failed:', error.message)
      console.log('⚠️ Continuing without Google Cloud Speech (transcription will not work)')
    }
    
    // Set up periodic cleanup to prevent memory leaks
    setInterval(() => {
      const now = Date.now()
      
      // Clean up old processed transcripts (older than 10 minutes)
      for (const [key, timestamp] of processedTranscripts.entries()) {
        if (now - timestamp > 10 * 60 * 1000) {
          processedTranscripts.delete(key)
        }
      }
      
      // Health check: detect and clean up stale connections
      // Reduced to 45 seconds - connections should ping every 10-25 seconds
      const staleConnectionTimeout = 45000 // 45 seconds (allows for 1-2 missed pings)
      const staleSockets = []
      
      for (const [socketId, connection] of activeConnections.entries()) {
        const socket = io.sockets.sockets.get(socketId)
        
        // Check if socket is still connected
        if (!socket || !socket.connected) {
          console.log(`🧹 Cleaning up disconnected socket: ${socketId}`)
          staleSockets.push(socketId)
          continue
        }
        
        // Check if connection is stale (no ping received in too long)
        const timeSinceLastPing = now - connection.lastPing
        if (timeSinceLastPing > staleConnectionTimeout) {
          console.log(`🧹 Detected stale connection: ${socketId} (last ping: ${Math.round(timeSinceLastPing / 1000)}s ago)`)
          staleSockets.push(socketId)
        }
      }
      
      // Clean up stale sockets
      for (const socketId of staleSockets) {
        const socket = io.sockets.sockets.get(socketId)
        const connection = activeConnections.get(socketId)
        
        if (connection && connection.pingTimeout) {
          clearTimeout(connection.pingTimeout)
        }
        
        // Clean up streaming session if exists
        const recognizeStream = streamingSessions.get(socketId)
        if (recognizeStream) {
          speechToTextService.endStreamingRecognition(recognizeStream)
          streamingSessions.delete(socketId)
        }
        
        // Clean up processed transcripts for this socket
        const socketPrefix = `${socketId}-`
        for (const [key, _] of processedTranscripts.entries()) {
          if (key.startsWith(socketPrefix)) {
            processedTranscripts.delete(key)
          }
        }
        
        // Emit connection count update before cleanup
        if (connection?.userCode) {
          emitConnectionCount(connection.userCode)
        }
        
        // Remove from active connections
        activeConnections.delete(socketId)
        
        // Disconnect the socket if it still exists
        if (socket && socket.connected) {
          socket.disconnect(true)
        }
        
        console.log(`✅ Cleaned up stale connection: ${socketId}`)
      }
      
      // Log connection statistics
      console.log(`📊 Active connections: ${activeConnections.size}, Processed transcripts: ${processedTranscripts.size}, Cleaned: ${staleSockets.length}`)
    }, 15000) // Run every 15 seconds for faster cleanup during development
    
    console.log('✅ Server is ready to accept connections')
  } catch (error) {
    console.error('❌ Failed to start server:', error)
    process.exit(1)
  }
}

process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

startServer()
