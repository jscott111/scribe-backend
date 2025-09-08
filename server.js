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

app.use('/api/auth', authRoutes)

const activeConnections = new Map()

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

  socket.on('audioStream', async (data) => {
    try {
      const { audioData, sourceLanguage, targetLanguage } = data
      
      const connection = activeConnections.get(socket.id)
      if (connection) {
        connection.isStreaming = true
        connection.sourceLanguage = sourceLanguage
        connection.targetLanguage = targetLanguage
      }

      const translatedText = await processAudioStream(audioData, sourceLanguage, targetLanguage)
      
      if (translatedText) {
        socket.emit('translation', {
          translatedText,
          sourceLanguage,
          targetLanguage,
          timestamp: new Date().toISOString()
        })
      }
      
    } catch (error) {
      console.error('Error processing audio stream:', error)
      socket.emit('error', { message: 'Failed to process audio stream' })
    }
  })

  socket.on('stopStreaming', () => {
    const connection = activeConnections.get(socket.id)
    if (connection) {
      connection.isStreaming = false
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

app.get('/api/health', (req, res) => {
  try {
    res.status(200).json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      activeConnections: activeConnections.size,
      totalClients: io.engine.clientsCount
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

app.post('/api/sessions', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.body
    const userId = req.user.id
    
    if (!sessionId || !/^[A-Z0-9]{8}$/.test(sessionId)) {
      return res.status(400).json({ error: 'Valid session ID required' })
    }
    
    let session = await Session.findById(sessionId)
    
    if (session) {
      if (!session.userId) {
        await runQuery(
          `UPDATE sessions SET user_id = $1 WHERE id = $2`,
          [userId, sessionId]
        )
      }
      res.json({ sessionId, message: 'Session found and associated' })
    } else {
      session = await Session.create(sessionId, userId, 24)
      res.json({ sessionId, message: 'Session created' })
    }
  } catch (error) {
    console.error('Session creation error:', error)
    res.status(500).json({ error: 'Failed to create session' })
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
    await initDatabase()
    
    await cleanupExpiredSessions()
    
    server.listen(config.PORT, config.HOST, () => {
      console.log(`🚀 Server running on ${config.HOST}:${config.PORT}`)
    })
  } catch (error) {
    console.error('Failed to start server:', error)
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
