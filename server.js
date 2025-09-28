const express = require('express')
const http = require('http')
const socketIo = require('socket.io')
const cors = require('cors')
const path = require('path')
require('dotenv').config()
const config = require('./src/config')
const { authenticateToken, authenticateSocket } = require('./src/middleware/auth')
const authRoutes = require('./src/routes/auth')
const { initDatabase, runQuery } = require('./src/database/database')
const Session = require('./src/models/Session')
const User = require('./src/models/User')
const speechToTextService = require('./src/services/speechToTextService')
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
const streamingSessions = new Map() // Track streaming sessions per socket

const emitConnectionCount = (sessionId = null) => {
  const connectionsByLanguage = {}
  let totalConnections = 0
  
  activeConnections.forEach((connection) => {
    if (sessionId && connection.sessionId !== sessionId) {
      return
    }
    
    if (!connection.sessionId) {
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
  
  if (sessionId) {
    const sessionConnections = Array.from(activeConnections.entries())
      .filter(([_, conn]) => conn.sessionId === sessionId)
      .map(([socketId, _]) => socketId)
    
    
    sessionConnections.forEach(socketId => {
      const targetSocket = io.sockets.sockets.get(socketId)
      if (targetSocket) {
        targetSocket.emit('connectionCount', connectionData)
      }
    })
  } else {
    const validConnections = Array.from(activeConnections.entries())
      .filter(([_, conn]) => conn.sessionId)
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

io.on('connection', (socket) => {
  console.log(`🔌 Client connected: ${socket.user?.email || 'Listener'} (${socket.sessionId || 'No Session'})`)
  
  activeConnections.set(socket.id, {
    userId: socket.user?.id,
    userEmail: socket.user?.email,
    sessionId: socket.sessionId,
    isStreaming: false,
    sourceLanguage: null,
    targetLanguage: null,
    needsTokenRefresh: socket.needsTokenRefresh || false
  })

  if (socket.needsTokenRefresh) {
    socket.emit('tokenExpired', {
      message: 'Your session has expired. Please refresh your token.',
      code: 'TOKEN_EXPIRED'
    })
  }
  
  emitConnectionCount(socket.sessionId)

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
      }

      const currentConnection = activeConnections.get(socket.id)
      emitConnectionCount(currentConnection?.sessionId)
      
      if (currentConnection?.sessionId) {
        const sessionConnections = Array.from(activeConnections.entries())
          .filter(([_, conn]) => conn.sessionId === currentConnection.sessionId)
          .map(([socketId, _]) => socketId)
        
        const translationConnections = sessionConnections.filter(socketId => {
          const conn = activeConnections.get(socketId)
          return conn && !conn.userId && conn.targetLanguage
        })
        
        sessionConnections.forEach(socketId => {
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
                const characterCount = transcription.length
                await Session.updateCharacterCount(characterCount, currentConnection.sessionId)
                await Session.updateLastActivity(currentConnection.sessionId)

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
        speechEndTimeout = 2.0
      } = data

      const connection = activeConnections.get(socket.id)
      if (connection) {
        connection.isStreaming = true
        connection.sourceLanguage = sourceLanguage
      }

      const currentConnection = activeConnections.get(socket.id)
      emitConnectionCount(currentConnection?.sessionId)

      // If we have audio data, process it with Google Cloud Speech-to-Text
      if (audioData && audioData.length > 0) {
        try {
          const audioBuffer = Buffer.from(audioData, 'base64')

          audioChunkCounter++
          
          // Check if this is LINEAR16 format from frontend
          const audioFormat = data.audioFormat || 'WEBM';
          const sampleRate = data.sampleRate || 48000;
          
          if (audioFormat === 'LINEAR16') {
            // Start streaming recognition on first chunk for this socket
            if (!streamingSessions.has(socket.id)) {
              console.log('🎤 Starting Google Cloud streaming recognition...');
              
              const recognizeStream = await speechToTextService.startStreamingRecognition(sourceLanguage, {
                onResult: (result) => {
                  // Send transcription result to frontend
                  socket.emit('transcriptionUpdate', {
                    transcript: result.transcript,
                    isFinal: result.isFinal,
                    confidence: result.confidence,
                    bubbleId: bubbleId
                  });
                },
                onError: (error) => {
                  console.error('❌ Google Cloud streaming error:', error);
                },
                onEnd: () => {
                  console.log('🎤 Google Cloud streaming ended');
                },
                onRestart: async () => {
                  console.log('🔄 Restarting Google Cloud stream...');
                  // End current stream
                  speechToTextService.endStreamingRecognition(recognizeStream);
                  streamingSessions.delete(socket.id);
                  
                  // Create new stream
                  const newRecognizeStream = await speechToTextService.startStreamingRecognition(sourceLanguage, {
                    onResult: (result) => {
                      socket.emit('transcriptionUpdate', {
                        transcript: result.transcript,
                        isFinal: result.isFinal,
                        confidence: result.confidence,
                        bubbleId: bubbleId
                      });
                    },
                    onError: (error) => {
                      console.error('❌ Google Cloud streaming error:', error);
                    },
                    onEnd: () => {
                      console.log('🎤 Google Cloud streaming ended');
                    },
                    onRestart: arguments.callee // Recursive restart
                  });
                  
                  // Store new stream
                  streamingSessions.set(socket.id, newRecognizeStream);
                }
              });
              
              // Store the stream for this socket
              streamingSessions.set(socket.id, recognizeStream);
            }
            
            // Send audio chunk to Google Cloud streaming
            const recognizeStream = streamingSessions.get(socket.id);
            if (recognizeStream) {
              speechToTextService.sendAudioToStream(recognizeStream, audioBuffer);
            } else {
              console.error('❌ No stream found for socket:', socket.id);
            }
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
        if (currentConnection?.sessionId) {
          const sessionConnections = Array.from(activeConnections.entries())
            .filter(([_, conn]) => conn.sessionId === currentConnection.sessionId)
            .map(([socketId, _]) => socketId)
          
          const translationConnections = sessionConnections.filter(socketId => {
            const conn = activeConnections.get(socketId)
            return conn && !conn.userId && conn.targetLanguage
          })
          
          sessionConnections.forEach(socketId => {
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

              translations.forEach(({ socketId, translation, targetLanguage }) => {
                if (socketId && translation) {
                  const targetSocket = io.sockets.sockets.get(socketId)
                  if (targetSocket) {
                    targetSocket.emit('translation', {
                      translation,
                      sourceLanguage,
                      targetLanguage,
                      bubbleId
                    })
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


  socket.on('stopStreaming', () => {
    const connection = activeConnections.get(socket.id)
    if (connection) {
      connection.isStreaming = false
    }
    
    // End Google Cloud streaming session
    const recognizeStream = streamingSessions.get(socket.id)
    if (recognizeStream) {
      speechToTextService.endStreamingRecognition(recognizeStream)
      streamingSessions.delete(socket.id)
    }
  })

  socket.on('setTargetLanguage', (data) => {
    const connection = activeConnections.get(socket.id)
    if (connection) {
      connection.targetLanguage = data.targetLanguage
      emitConnectionCount(connection.sessionId)
    }
  })

  socket.on('getConnectionCount', () => {
    const currentConnection = activeConnections.get(socket.id)
    const sessionId = currentConnection?.sessionId
    
    const connectionsByLanguage = {}
    let totalConnections = 0
    
    activeConnections.forEach((connection) => {
      if (sessionId && connection.sessionId !== sessionId) {
        return
      }
      
      if (!connection.sessionId) {
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

  socket.on('disconnect', () => {
    const connection = activeConnections.get(socket.id)
    activeConnections.delete(socket.id)
    
    // Clean up streaming session
    const recognizeStream = streamingSessions.get(socket.id)
    if (recognizeStream) {
      speechToTextService.endStreamingRecognition(recognizeStream)
      streamingSessions.delete(socket.id)
    }
    
    console.log(`🔌 Client disconnected: ${socket.user?.email || 'Listener'} (${socket.sessionId || 'No Session'})`)
    
    emitConnectionCount(connection?.sessionId)
  })
})

async function processTranscription(transcription, sourceLanguage, targetLanguage) {
  try {
    const createClient = require('@azure-rest/ai-translation-text').default
    
    const client = createClient(config.AZURE_TRANSLATOR_ENDPOINT, {
      key: config.AZURE_TRANSLATOR_KEY,
      region: config.AZURE_TRANSLATOR_REGION
    })
    
    const azureSourceLang = sourceLanguage
    const azureTargetLang = targetLanguage
    
    const result = await client.path('/translate').post({
      body: [{
        text: transcription
      }],
      queryParameters: {
        'api-version': '3.0',
        'from': azureSourceLang,
        'to': azureTargetLang
      }
    })
    
    if (result.body && result.body[0] && result.body[0].translations && result.body[0].translations[0]) {
      const translatedText = result.body[0].translations[0].text
      return translatedText
    } else {
      console.error('❌ Invalid response structure:', {
        hasBody: !!result.body,
        bodyLength: result.body?.length,
        firstItem: result.body?.[0],
        hasTranslations: result.body?.[0]?.translations,
        translationsLength: result.body?.[0]?.translations?.length
      });
      throw new Error('Invalid response from Azure Translator')
    }
    
  } catch (error) {
    console.error('❌ Translation error:', error.message)
    
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

app.post('/sessions', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.body
    const userId = req.user.id
    
    if (!sessionId || !/^[A-Z0-9]{8}$/.test(sessionId)) {
      return res.status(400).json({ error: 'Valid session ID required' })
    }
    
    await Session.deactivateAllForUserExcept(userId, sessionId)
    
    let session = await Session.findById(sessionId)
    
    if (session) {
      if (!session.userId) {
        await runQuery(
          `UPDATE sessions SET user_id = $1, is_active = true WHERE id = $2`,
          [userId, sessionId]
        )
      } else {
        await runQuery(
          `UPDATE sessions SET is_active = true WHERE id = $1`,
          [sessionId]
        )
      }
      res.json({ sessionId, message: 'Session found and associated' })
    } else {
      session = await Session.create(sessionId, userId)
      res.json({ sessionId, message: 'Session created' })
    }
  } catch (error) {
    console.error('Session creation error:', error)
    res.status(500).json({ error: 'Failed to create session' })
  }
})

app.get('/sessions/:sessionId/validate', async (req, res) => {
  try {
    const { sessionId } = req.params
    
    if (!sessionId || !/^[A-Z0-9]{8}$/.test(sessionId)) {
      return res.status(400).json({ 
        valid: false, 
        error: 'Invalid session ID format' 
      })
    }
    
    const session = await Session.findById(sessionId)
    
    if (session) {
      res.json({ 
        valid: true, 
        sessionId,
        message: 'Session is valid and active' 
      })
    } else {
      res.json({ 
        valid: false, 
        error: 'Session not found or inactive' 
      })
    }
  } catch (error) {
    console.error('Session validation error:', error)
    res.status(500).json({ 
      valid: false, 
      error: 'Failed to validate session' 
    })
  }
})

app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ error: 'Something went wrong!' })
})

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

const cleanupExpiredSessions = async () => {
  try {
    const cleanedCount = await Session.cleanupExpired()
    if (cleanedCount > 0) {
      console.log(`🧹 Cleaned up ${cleanedCount} expired sessions`)
    }
  } catch (error) {
    console.error('Error cleaning up sessions:', error)
  }
}

setInterval(cleanupExpiredSessions, 60 * 60 * 1000)

const startServer = async () => {
  try {
    console.log('🔧 Starting server initialization...')
    console.log(`📊 Environment: ${config.NODE_ENV}`)
    console.log(`🌐 Port: ${config.PORT}`)
    console.log(`🏠 Host: ${config.HOST}`)
    
    await initDatabase()
    console.log('✅ Database initialized')
    
    await cleanupExpiredSessions()
    console.log('✅ Expired sessions cleaned up')
    
    // Initialize Google Cloud client early to avoid startup delays
    try {
      await speechToTextService.getSpeechClient()
      console.log('✅ Google Cloud Speech client initialized')
    } catch (error) {
      console.warn('⚠️ Google Cloud Speech client initialization failed:', error.message)
    }
    
    server.listen(config.PORT, config.HOST, () => {
      console.log(`🚀 Server running on ${config.HOST}:${config.PORT}`)
      console.log('✅ Server is ready to accept connections')
    })
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
