const express = require('express')
const http = require('http')
const socketIo = require('socket.io')
const cors = require('cors')
const path = require('path')
require('dotenv').config()

const config = require('./config')
const { getSupportedLanguages } = require('./azureLangs')
const { authenticateToken, authenticateSocket } = require('./middleware/auth')
const authRoutes = require('./routes/auth')

// Debug: Log environment variables
console.log('🔍 Environment variables debug:');
console.log('  NODE_ENV:', process.env.NODE_ENV);
console.log('  DB_HOST:', process.env.DB_HOST);
console.log('  DB_NAME:', process.env.DB_NAME);
console.log('  DB_USER:', process.env.DB_USER);
console.log('  DB_PASSWORD:', process.env.DB_PASSWORD ? '[SET]' : '[NOT SET]');
console.log('  All DB_ variables:', Object.keys(process.env).filter(key => key.startsWith('DB_')));

// Import PostgreSQL database module
const { initDatabase } = require('./config/database-postgres');

const app = express()
const server = http.createServer(app)

// Debug CORS configuration
console.log('🔍 CORS Configuration Debug:');
console.log('  CORS_ORIGIN:', config.CORS_ORIGIN);
console.log('  Split origins:', config.CORS_ORIGIN.split(','));

app.use(cors({
  origin: config.CORS_ORIGIN.split(',').map(origin => origin.trim()),
  methods: ["GET", "POST", "OPTIONS"],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200
}))

const io = socketIo(server, {
  cors: {
    origin: true, // Allow all origins for socket connections
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 200
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true
})

// Socket authentication middleware
io.use(authenticateSocket)

app.use(express.json({ limit: '50mb' }))
app.use(express.static(path.join(__dirname, 'public')))

// Authentication routes
app.use('/api/auth', authRoutes)

const activeConnections = new Map()

const emitConnectionCount = (sessionId = null) => {
  const connectionsByLanguage = {}
  let totalConnections = 0
  
  activeConnections.forEach((connection) => {
    // If sessionId is provided, only count connections in that session
    if (sessionId && connection.sessionId !== sessionId) {
      return
    }
    
    // Only count connections that have a valid session ID
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
    // Emit to all connections with valid sessions
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
  console.log(`🔌 Client connected: ${socket.user?.email || 'Anonymous'} (${socket.sessionId || 'No Session'})`)
  
  activeConnections.set(socket.id, {
    userId: socket.user?.id,
    userEmail: socket.user?.email,
    sessionId: socket.sessionId,
    isStreaming: false,
    sourceLanguage: null,
    targetLanguage: null,
    needsTokenRefresh: socket.needsTokenRefresh || false
  })

  // Notify client if they need to refresh their token
  if (socket.needsTokenRefresh) {
    socket.emit('tokenExpired', {
      message: 'Your session has expired. Please refresh your token.',
      code: 'TOKEN_EXPIRED'
    })
  }
  
  emitConnectionCount(socket.sessionId)

  // Handle token refresh requests
  socket.on('refreshToken', async (data) => {
    try {
      const { refreshToken } = data
      
      if (!refreshToken) {
        socket.emit('tokenRefreshError', { message: 'Refresh token required' })
        return
      }

      // Verify refresh token
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

          // Generate new tokens
          const { generateToken, generateRefreshToken } = require('./middleware/auth')
          const newAccessToken = generateToken(user)
          const newRefreshToken = generateRefreshToken(user)

          // Update socket user and clear refresh flag
          socket.user = user
          socket.needsTokenRefresh = false
          
          // Update connection info
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
      // Check if socket needs token refresh
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
        
        // Find TranslationApp connections (those without userId) and translate for them
        const translationConnections = sessionConnections.filter(socketId => {
          const conn = activeConnections.get(socketId)
          return conn && !conn.userId && conn.targetLanguage
        })
        
        // Send original transcription to InputApp (authenticated connections)
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
        
        // Translate and send to TranslationApp connections
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
            // Send error to translation connections
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

app.get('/api/websocket-status', authenticateToken, (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    activeConnections: activeConnections.size,
    totalClients: io.engine.clientsCount,
    websocketEnabled: true,
    user: {
      id: req.user.id,
      email: req.user.email
    }
  })
})

async function processTranscription(transcription, sourceLanguage, targetLanguage) {
  try {
    console.log(`🌍 Processing: "${transcription}" (${sourceLanguage} → ${targetLanguage})`)
    
    const createClient = require('@azure-rest/ai-translation-text').default
    
    const client = createClient(process.env.AZURE_TRANSLATOR_ENDPOINT, {
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
      console.log(`✅ Translated: "${transcription}" → "${translatedText}"`)
      return translatedText
    } else {
      throw new Error('Invalid response from Azure Translator')
    }
    
  } catch (error) {
    console.error('❌ Translation error:', error.message)
    
    return `Translation error: ${error.message}`
  }
}

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    activeConnections: activeConnections.size,
    totalClients: io.engine.clientsCount
  })
})

app.get('/api/languages', authenticateToken, (req, res) => {
  const languages = getSupportedLanguages()
  res.json(languages)
})

// Authenticated translation endpoint
app.post('/api/translate', authenticateToken, async (req, res) => {
  try {
    const { text, from, to } = req.body
    
    if (!text || !from || !to) {
      return res.status(400).json({ error: 'Missing required fields: text, from, to' })
    }

    console.log(`🌍 User ${req.user.email} translating: "${text}" (${from} → ${to})`)
    const translatedText = await processTranscription(text, from, to)
    
    res.json({
      translatedText,
      originalText: text,
      sourceLanguage: from,
      targetLanguage: to,
      userId: req.user.id
    })
    
  } catch (error) {
    console.error('Translation API error:', error)
    res.status(500).json({ error: 'Translation failed' })
  }
})

// Session-based translation endpoint for TranslationApp
app.post('/api/translate/session', async (req, res) => {
  try {
    const { text, from, to, sessionId } = req.body
    
    if (!text || !from || !to || !sessionId) {
      return res.status(400).json({ error: 'Missing required fields: text, from, to, sessionId' })
    }

    // Validate session ID format
    if (!/^[A-Z0-9]{8}$/.test(sessionId)) {
      return res.status(400).json({ error: 'Invalid session ID format' })
    }

    console.log(`🌍 Session ${sessionId} translating: "${text}" (${from} → ${to})`)
    const translatedText = await processTranscription(text, from, to)
    
    res.json({
      translatedText,
      originalText: text,
      sourceLanguage: from,
      targetLanguage: to,
      sessionId
    })
    
  } catch (error) {
    console.error('Session translation API error:', error)
    res.status(500).json({ error: 'Translation failed' })
  }
})

app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ error: 'Something went wrong!' })
})

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

// Initialize database and start server
const startServer = async () => {
  try {
    // Initialize database
    await initDatabase()
    
    // Start server
    server.listen(config.PORT, config.HOST, () => {
      console.log(`🚀 Server running on ${config.HOST}:${config.PORT}`)
    })
  } catch (error) {
    console.error('Failed to start server:', error)
    process.exit(1)
  }
}

startServer()

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully')
  server.close(() => {
    console.log('Process terminated')
  })
})
