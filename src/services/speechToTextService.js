const fs = require('fs');
const speech = require('@google-cloud/speech');
const config = require('../config');
const { spawn } = require('child_process');

class SpeechToTextService {
  constructor() {
    // Initialize Google Cloud Speech client with service account
    
    // Set the credentials file path
    process.env.GOOGLE_APPLICATION_CREDENTIALS = './google-credentials.json';
    
    this.client = new speech.SpeechClient({
      projectId: config.GOOGLE_CLOUD_PROJECT_ID
    });
    this.initializeClient();
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
      const [response] = await this.client.recognize(request);
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
  startStreamingRecognition(languageCode, callbacks) {
    
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
    const recognizeStream = this.client.streamingRecognize(request);

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
      if (callbacks && callbacks.onError) {
        callbacks.onError(error);
      }
    });

    recognizeStream.on('end', () => {
      if (callbacks && callbacks.onEnd) {
        callbacks.onEnd();
      }
    });

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
      recognizeStream.end();
    }
  }

  initializeClient() {
    // Service initialized
  }
}

module.exports = new SpeechToTextService();
