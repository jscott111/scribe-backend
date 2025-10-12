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
const processedTranscripts = new Map() // Track processed transcripts to prevent duplicates

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

io.on('connection', (socket) => {
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
    lastActivity: Date.now()
  })

  // Set up heartbeat mechanism
  const connection = activeConnections.get(socket.id)
  if (connection) {
    // Set initial ping timeout (30 seconds)
    connection.pingTimeout = setTimeout(() => {
      console.log(`💔 Heartbeat timeout for socket ${socket.id}, disconnecting...`)
      socket.disconnect(true)
    }, 30000)
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
      connection.lastPing = Date.now()
      connection.lastActivity = Date.now()
      
      // Update connection quality based on ping frequency
      const timeSinceLastPing = Date.now() - connection.lastPing
      if (timeSinceLastPing > 20000) {
        connection.connectionQuality = 'poor'
      } else if (timeSinceLastPing > 30000) {
        connection.connectionQuality = 'critical'
      } else {
        connection.connectionQuality = 'good'
      }
      
      // Clear existing timeout and set new one
      if (connection.pingTimeout) {
        clearTimeout(connection.pingTimeout)
      }
      
      // Adaptive timeout based on connection quality
      const timeoutDuration = connection.connectionQuality === 'critical' ? 15000 : 
                            connection.connectionQuality === 'poor' ? 25000 : 30000
      
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
        speechEndTimeout = 2.0
      } = data

      const connection = activeConnections.get(socket.id)
      if (connection) {
        connection.isStreaming = true
        connection.sourceLanguage = sourceLanguage
      }

      const currentConnection = activeConnections.get(socket.id)
      emitConnectionCount(currentConnection?.userCode)

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
                onResult: async (result) => {
                  // Send transcription result to frontend
                  socket.emit('transcriptionUpdate', {
                    transcript: result.transcript,
                    isFinal: result.isFinal,
                    confidence: result.confidence,
                    bubbleId: bubbleId
                  });

                  // Handle translation for final results
                  if (result.isFinal && result.transcript.trim()) {
                    // Notify frontend that we've received a final result to prevent duplicate finalization
                    socket.emit('finalResultReceived', { bubbleId });
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
                        return conn && !conn.isStreaming && conn.targetLanguage;
                      });
                      
                      
                      // Send transcription to input clients
                      userCodeConnections.forEach(socketId => {
                        const targetSocket = io.sockets.sockets.get(socketId);
                        const conn = activeConnections.get(socketId);
                        if (targetSocket && conn?.userId) {
                          targetSocket.emit('transcriptionComplete', {
                            transcription: result.transcript,
                            sourceLanguage,
                            bubbleId,
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

                          translations.forEach(({ socketId, translation, targetLanguage }) => {
                            if (socketId && translation) {
                              const targetSocket = io.sockets.sockets.get(socketId);
                              if (targetSocket) {
                                targetSocket.emit('translationComplete', {
                                  originalText: result.transcript,
                                  translatedText: translation,
                                  sourceLanguage,
                                  targetLanguage,
                                  bubbleId
                                });
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
                                bubbleId
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
                onRestart: async () => {
                  console.log('🔄 Restarting Google Cloud stream...');
                  
                  // Properly end current stream
                  if (recognizeStream) {
                    speechToTextService.endStreamingRecognition(recognizeStream);
                    // Remove all listeners to prevent further events
                    recognizeStream.removeAllListeners();
                  }
                  
                  // Clear the session mapping
                  streamingSessions.delete(socket.id);
                  
                  // Clear any processed transcripts for this socket to prevent conflicts
                  const socketPrefix = `${socket.id}-`;
                  for (const [key, _] of processedTranscripts.entries()) {
                    if (key.startsWith(socketPrefix)) {
                      processedTranscripts.delete(key);
                    }
                  }
                  
                  // Small delay to ensure old stream is fully closed
                  await new Promise(resolve => setTimeout(resolve, 100));
                  
                  // Create new stream
                  const newRecognizeStream = await speechToTextService.startStreamingRecognition(sourceLanguage, {
                    onResult: async (result) => {
                      socket.emit('transcriptionUpdate', {
                        transcript: result.transcript,
                        isFinal: result.isFinal,
                        confidence: result.confidence,
                        bubbleId: bubbleId
                      });

                      // Handle translation for final results
                      if (result.isFinal && result.transcript.trim()) {
                        // Notify frontend that we've received a final result to prevent duplicate finalization
                        socket.emit('finalResultReceived', { bubbleId });
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
                            return conn && !conn.userId && conn.targetLanguage;
                          });
                          
                          // Send transcription to input clients
                          userCodeConnections.forEach(socketId => {
                            const targetSocket = io.sockets.sockets.get(socketId);
                            const conn = activeConnections.get(socketId);
                            if (targetSocket && conn?.userId) {
                              targetSocket.emit('transcriptionComplete', {
                                transcription: result.transcript,
                                sourceLanguage,
                                bubbleId,
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

                              translations.forEach(({ socketId, translation, targetLanguage }) => {
                                if (socketId && translation) {
                                  const targetSocket = io.sockets.sockets.get(socketId);
                                  if (targetSocket) {
                                    targetSocket.emit('translationComplete', {
                                      originalText: result.transcript,
                                      translatedText: translation,
                                      sourceLanguage,
                                      targetLanguage,
                                      bubbleId
                                    });
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
                                    bubbleId
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
            return conn && !conn.userId && conn.targetLanguage
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

              translations.forEach(({ socketId, translation, targetLanguage }) => {
                if (socketId && translation) {
                  const targetSocket = io.sockets.sockets.get(socketId)
                  if (targetSocket) {
                    targetSocket.emit('translationComplete', {
                      originalText: finalTranscript,
                      translatedText: translation,
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
      emitConnectionCount(connection.userCode)
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

  socket.on('disconnect', () => {
    const connection = activeConnections.get(socket.id)
    
    // Clean up ping timeout
    if (connection && connection.pingTimeout) {
      clearTimeout(connection.pingTimeout)
    }
    
    // Clean up streaming session
    const recognizeStream = streamingSessions.get(socket.id)
    if (recognizeStream) {
      speechToTextService.endStreamingRecognition(recognizeStream)
      streamingSessions.delete(socket.id)
    }
    
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
    
    console.log('🔧 Starting database initialization...')
    await initDatabase()
    console.log('✅ Database initialized')
    
    // Initialize Google Cloud client early to avoid startup delays
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
      
      // Log connection statistics
      console.log(`📊 Active connections: ${activeConnections.size}, Processed transcripts: ${processedTranscripts.size}`)
    }, 5 * 60 * 1000) // Run every 5 minutes
    
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
