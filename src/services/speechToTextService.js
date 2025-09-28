const fs = require('fs');
const speech = require('@google-cloud/speech');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const config = require('../config');
const { spawn } = require('child_process');

class SpeechToTextService {
  constructor() {
    this.projectId = config.GOOGLE_CLOUD_PROJECT_ID;
    this.secretClient = new SecretManagerServiceClient();
    this.client = null;
    this.credentials = null;
    this.initializeClient();
  }

  async initializeCredentials() {
    if (this.credentials) {
      return this.credentials;
    }

    try {
      // Try to load from local file first (for development)
      if (fs.existsSync('./google-credentials.json')) {
        console.log('🔧 Loading credentials from local file (development mode)');
        this.credentials = JSON.parse(fs.readFileSync('./google-credentials.json', 'utf8'));
        return this.credentials;
      }

      // For Cloud Run, use the default service account
      console.log('☁️ Using default service account (Cloud Run mode)');
      // Return null to use default credentials
      this.credentials = null;
      return this.credentials;
    } catch (error) {
      console.error('❌ Failed to load credentials:', error);
      // Don't throw error, let it use default credentials
      console.log('⚠️ Falling back to default service account');
      this.credentials = null;
      return this.credentials;
    }
  }

  async getSpeechClient() {
    if (this.client) {
      return this.client;
    }

    const credentials = await this.initializeCredentials();
    
    // Use default credentials if no explicit credentials found
    if (credentials) {
      this.client = new speech.SpeechClient({
        projectId: this.projectId,
        credentials: {
          client_email: credentials.client_email,
          private_key: credentials.private_key
        }
      });
    } else {
      // Use default service account (Cloud Run)
      this.client = new speech.SpeechClient({
        projectId: this.projectId
      });
    }

    return this.client;
  }

  /**
   * Convert WebM audio to LINEAR16 format using FFmpeg
   */
  async convertWebMToLinear16(webmBuffer) {
    return new Promise((resolve, reject) => {
      console.log('🔄 Converting WebM to LINEAR16...');
      
      const ffmpeg = spawn('ffmpeg', [
        '-i', 'pipe:0',           // Read from stdin
        '-f', 's16le',            // Output format: signed 16-bit little endian
        '-ar', '16000',           // Sample rate: 16kHz
        '-ac', '1',               // Mono channel
        '-y',                     // Overwrite output
        'pipe:1'                  // Write to stdout
      ]);

      let outputBuffer = Buffer.alloc(0);
      let errorBuffer = Buffer.alloc(0);

      ffmpeg.stdout.on('data', (data) => {
        outputBuffer = Buffer.concat([outputBuffer, data]);
      });

      ffmpeg.stderr.on('data', (data) => {
        errorBuffer = Buffer.concat([errorBuffer, data]);
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          console.log(`✅ Conversion successful: ${webmBuffer.length} bytes → ${outputBuffer.length} bytes`);
          resolve(outputBuffer);
        } else {
          const error = errorBuffer.toString();
          console.log('❌ FFmpeg conversion failed:', error);
          reject(new Error(`FFmpeg conversion failed: ${error}`));
        }
      });

      ffmpeg.on('error', (error) => {
        console.log('❌ FFmpeg spawn error:', error.message);
        reject(error);
      });

      // Send WebM data to FFmpeg
      ffmpeg.stdin.write(webmBuffer);
      ffmpeg.stdin.end();
    });
  }

  /**
   * Test LINEAR16 format with Google Cloud Speech-to-Text
   */
  async testLinear16Format(audioBuffer) {
    console.log('🧪 Testing LINEAR16 format with Google Cloud Speech-to-Text...');
    
    const client = await this.getSpeechClient();
    
    const request = {
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        languageCode: 'en-CA',
      },
      audio: {
        content: audioBuffer.toString('base64'),
      },
    };

    try {
      const [response] = await client.recognize(request);
      console.log('✅ LINEAR16 format test successful:', response);
      return response;
    } catch (error) {
      console.log('❌ LINEAR16 format test failed:', error.message);
      return null;
    }
  }

  /**
   * Start streaming recognition with Google Cloud Speech-to-Text
   */
  async startStreamingRecognition(languageCode, callbacks) {
    const client = await this.getSpeechClient();
    
    const request = {
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 48000, // Match frontend sample rate
        languageCode: languageCode,
        enableAutomaticPunctuation: true,
        model: 'latest_long', // Use latest model for better accuracy
        enableInterimResults: true, // Explicitly enable interim results
      },
      interimResults: true, // Get interim results for real-time display
    };

    // Create streaming recognition request
    const recognizeStream = client.streamingRecognize(request);

    // Track stream start time for 5-minute limit
    const streamStartTime = Date.now();
    const STREAM_DURATION_LIMIT = 4.5 * 60 * 1000; // 4.5 minutes in milliseconds

    // Set up automatic restart timer
    const restartTimer = setTimeout(() => {
      console.log('🔄 Google Cloud stream approaching 5-minute limit, restarting...');
      if (callbacks && callbacks.onRestart) {
        callbacks.onRestart();
      }
    }, STREAM_DURATION_LIMIT);

    // Handle streaming responses
    recognizeStream.on('data', (response) => {
      if (response.results && response.results.length > 0) {
        const result = response.results[0];
        const transcript = result.alternatives[0].transcript;
        const isFinal = result.isFinal;
        const confidence = result.alternatives[0].confidence || 0.8;
        
        if (callbacks && callbacks.onResult) {
          callbacks.onResult({
            transcript: transcript,
            isFinal: isFinal,
            confidence: confidence,
            resultEndTime: result.resultEndTime
          });
        }
      }
    });

    recognizeStream.on('error', (error) => {
      console.error('❌ Google Cloud streaming error:', error);
      clearTimeout(restartTimer);
      if (callbacks && callbacks.onError) {
        callbacks.onError(error);
      }
    });

    recognizeStream.on('end', () => {
      clearTimeout(restartTimer);
      if (callbacks && callbacks.onEnd) {
        callbacks.onEnd();
      }
    });

    // Store restart timer for cleanup
    recognizeStream._restartTimer = restartTimer;

    return recognizeStream;
  }

  /**
   * Send audio data to streaming recognition
   */
  sendAudioToStream(recognizeStream, audioBuffer) {
    if (recognizeStream && !recognizeStream.destroyed) {
      recognizeStream.write(audioBuffer);
    } else {
      console.error('❌ Cannot send audio - stream is null or destroyed');
    }
  }

  /**
   * End streaming recognition
   */
  endStreamingRecognition(recognizeStream) {
    if (recognizeStream && !recognizeStream.destroyed) {
      // Clear restart timer if it exists
      if (recognizeStream._restartTimer) {
        clearTimeout(recognizeStream._restartTimer);
        recognizeStream._restartTimer = null;
      }
      
      // Remove all event listeners to prevent further events
      recognizeStream.removeAllListeners();
      
      // End the stream
      recognizeStream.end();
      
      // Mark as destroyed to prevent further use
      recognizeStream.destroyed = true;
    }
  }

  initializeClient() {
    // Service initialized
  }
}

module.exports = new SpeechToTextService();
