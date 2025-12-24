const { TranslationServiceClient } = require('@google-cloud/translate');
const fs = require('fs');
const config = require('../config');
const { getBaseLanguageCode, isSameLanguage } = require('../utils/languageCodeMapper');

class GoogleTranslationService {
  constructor() {
    this.projectId = config.GOOGLE_CLOUD_PROJECT_ID;
    this.client = null;
    this.credentials = null;
    this.clientCreatedAt = null;
    this.lastError = null;
    this.errorCount = 0;
    this.successCount = 0;
    this.lastSuccessAt = null;
    this.clientHealthCheckInterval = null;
    this.MAX_RETRIES = 3;
    this.RETRY_DELAY_BASE = 1000; // 1 second base delay
    this.CLIENT_REFRESH_INTERVAL = 30 * 60 * 1000; // Refresh client every 30 minutes
    this.initializeClient();
    this.startHealthCheck();
  }

  async initializeCredentials() {
    if (this.credentials) {
      return this.credentials;
    }

    try {
      const isProduction = process.env.NODE_ENV === 'prod' || process.env.NODE_ENV === 'production';
      
      if (isProduction) {
        // Production: always use service account (ADC)
        console.log('☁️ Translation: Using default service account (production)');
        this.credentials = null;
        return this.credentials;
      }
      
      // Development: try local credentials file
      if (fs.existsSync('./google-credentials.json')) {
        console.log('🔧 Translation: Loading credentials from local file (development)');
        this.credentials = JSON.parse(fs.readFileSync('./google-credentials.json', 'utf8'));
        return this.credentials;
      }

      // Fallback to ADC
      console.log('☁️ Translation: Using default service account');
      this.credentials = null;
      return this.credentials;
    } catch (error) {
      console.error('❌ Translation: Failed to load credentials:', error);
      console.log('⚠️ Translation: Falling back to default service account');
      this.credentials = null;
      return this.credentials;
    }
  }

  async getTranslationClient(forceRecreate = false) {
    // Force recreation if requested or if client is stale
    const shouldRecreate = forceRecreate || 
                          !this.client || 
                          (this.clientCreatedAt && Date.now() - this.clientCreatedAt > this.CLIENT_REFRESH_INTERVAL) ||
                          (this.lastError && this.errorCount > 5);
    
    if (shouldRecreate) {
      console.log('🔄 Recreating Translation client...', {
        forceRecreate,
        hasClient: !!this.client,
        clientAge: this.clientCreatedAt ? `${Math.round((Date.now() - this.clientCreatedAt) / 1000)}s` : 'N/A',
        errorCount: this.errorCount
      });
      
      // Clean up old client
      if (this.client) {
        try {
          // Close any existing connections
          this.client.close?.();
        } catch (e) {
          console.warn('⚠️ Error closing old translation client:', e.message);
        }
      }
      
      this.client = null;
      this.clientCreatedAt = null;
      this.errorCount = 0;
    }
    
    if (this.client) {
      return this.client;
    }

    const credentials = await this.initializeCredentials();
    
    try {
      // Use default credentials if no explicit credentials found
      if (credentials) {
        this.client = new TranslationServiceClient({
          projectId: this.projectId,
          credentials: {
            client_email: credentials.client_email,
            private_key: credentials.private_key
          },
          // Add timeout and retry configuration
          fallback: 'rest',
          timeout: 30000, // 30 second timeout
        });
      } else {
        // Use default service account (Cloud Run)
        this.client = new TranslationServiceClient({
          projectId: this.projectId,
          // Add timeout and retry configuration
          fallback: 'rest',
          timeout: 30000, // 30 second timeout
        });
      }
      
      this.clientCreatedAt = Date.now();
      console.log('✅ Translation client created successfully');
      return this.client;
    } catch (error) {
      console.error('❌ Failed to create Translation client:', error);
      this.client = null;
      throw error;
    }
  }

  /**
   * Translate text with retry logic
   * @param {string} text - Text to translate
   * @param {string} sourceLanguage - Source language code
   * @param {string} targetLanguage - Target language code
   * @param {number} retryCount - Current retry attempt
   * @returns {Promise<string>} Translated text
   */
  async translateTextWithRetry(text, sourceLanguage, targetLanguage, retryCount = 0) {
    const startTime = Date.now();
    let lastError = null;
    
    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const client = await this.getTranslationClient(attempt > 0); // Force recreate on retry
        
        // Get base language codes for translation API
        const sourceCode = getBaseLanguageCode(sourceLanguage);
        const targetCode = getBaseLanguageCode(targetLanguage);
        
        // Prepare the translation request
        const request = {
          parent: `projects/${this.projectId}/locations/global`,
          contents: [text],
          mimeType: 'text/plain',
          sourceLanguageCode: sourceCode,
          targetLanguageCode: targetCode
        };

        const logPrefix = attempt > 0 ? `[Retry ${attempt}/${this.MAX_RETRIES}]` : '';
        console.log(`${logPrefix} 🌐 Translating from ${sourceLanguage} (${sourceCode}) to ${targetLanguage} (${targetCode}): "${text.substring(0, 50)}..."`);

        // Add timeout wrapper
        const translationPromise = client.translateText(request);
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Translation request timeout after 30 seconds')), 30000);
        });
        
        const [response] = await Promise.race([translationPromise, timeoutPromise]);

        if (response.translations && response.translations.length > 0) {
          const translatedText = response.translations[0].translatedText;
          const duration = Date.now() - startTime;
          this.successCount++;
          this.lastSuccessAt = Date.now();
          this.errorCount = 0; // Reset error count on success
          console.log(`✅ Translation successful (${duration}ms): "${translatedText.substring(0, 50)}..."`);
          return translatedText;
        } else {
          throw new Error('Invalid response from Google Translation API: no translations in response');
        }
      } catch (error) {
        lastError = error;
        const duration = Date.now() - startTime;
        this.errorCount++;
        this.lastError = {
          message: error.message,
          code: error.code,
          timestamp: Date.now()
        };
        
        const isRetryable = this.isRetryableError(error);
        const shouldRetry = attempt < this.MAX_RETRIES && isRetryable;
        
        console.error(`❌ Translation error (attempt ${attempt + 1}/${this.MAX_RETRIES + 1}, ${duration}ms):`, {
          message: error.message,
          code: error.code,
          details: error.details,
          isRetryable,
          willRetry: shouldRetry
        });
        
        if (shouldRetry) {
          const delay = this.RETRY_DELAY_BASE * Math.pow(2, attempt); // Exponential backoff
          console.log(`⏳ Retrying translation in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          break;
        }
      }
    }
    
    // All retries failed
    const duration = Date.now() - startTime;
    console.error(`❌ Translation failed after ${this.MAX_RETRIES + 1} attempts (${duration}ms):`, {
      error: lastError?.message,
      code: lastError?.code,
      sourceLanguage,
      targetLanguage,
      textLength: text.length
    });
    
    throw lastError || new Error('Translation failed after all retry attempts');
  }

  /**
   * Check if an error is retryable
   */
  isRetryableError(error) {
    // Retry on network errors, timeouts, and temporary service errors
    const retryableCodes = [
      4, // DEADLINE_EXCEEDED
      8, // RESOURCE_EXHAUSTED
      10, // ABORTED
      13, // INTERNAL
      14, // UNAVAILABLE
      16, // UNAUTHENTICATED (might be temporary auth issue)
    ];
    
    const retryableMessages = [
      'timeout',
      'network',
      'connection',
      'unavailable',
      'temporary',
      'rate limit',
      'quota',
      'deadline exceeded'
    ];
    
    if (error.code && retryableCodes.includes(error.code)) {
      return true;
    }
    
    if (error.message) {
      const lowerMessage = error.message.toLowerCase();
      return retryableMessages.some(msg => lowerMessage.includes(msg));
    }
    
    return false;
  }

  /**
   * Translate text from source language to target language
   * @param {string} text - Text to translate
   * @param {string} sourceLanguage - Source language code (e.g., 'en', 'fr')
   * @param {string} targetLanguage - Target language code (e.g., 'en', 'fr')
   * @param {string} context - Optional context from previous translations
   * @returns {Promise<string>} Translated text
   */
  async translateText(text, sourceLanguage, targetLanguage, context = null) {
    try {
      // Check if source and target are the same language
      if (isSameLanguage(sourceLanguage, targetLanguage)) {
        console.log(`🔄 Source and target are same language (${sourceLanguage} / ${targetLanguage}), skipping translation`);
        return text;
      }
      
      return await this.translateTextWithRetry(text, sourceLanguage, targetLanguage);
    } catch (error) {
      console.error('❌ Translation error (final):', {
        message: error.message,
        code: error.code,
        sourceLanguage,
        targetLanguage,
        textLength: text.length
      });
      throw error;
    }
  }

  /**
   * Health check for translation service
   */
  async healthCheck() {
    try {
      const client = await this.getTranslationClient();
      const health = {
        healthy: true,
        hasClient: !!this.client,
        clientAge: this.clientCreatedAt ? Math.round((Date.now() - this.clientCreatedAt) / 1000) : null,
        errorCount: this.errorCount,
        successCount: this.successCount,
        lastError: this.lastError,
        lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
        errorRate: this.successCount + this.errorCount > 0 
          ? (this.errorCount / (this.successCount + this.errorCount) * 100).toFixed(2) + '%'
          : '0%'
      };
      
      // Test translation with a simple text
      try {
        const testResult = await Promise.race([
          client.translateText({
            parent: `projects/${this.projectId}/locations/global`,
            contents: ['test'],
            mimeType: 'text/plain',
            sourceLanguageCode: 'en',
            targetLanguageCode: 'fr'
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Health check timeout')), 5000))
        ]);
        
        health.testTranslation = testResult[0]?.translations?.[0]?.translatedText || 'failed';
      } catch (testError) {
        health.healthy = false;
        health.testError = testError.message;
      }
      
      return health;
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
        hasClient: !!this.client,
        errorCount: this.errorCount,
        successCount: this.successCount
      };
    }
  }

  /**
   * Start periodic health check
   */
  startHealthCheck() {
    // Run health check every 5 minutes
    this.clientHealthCheckInterval = setInterval(async () => {
      try {
        const health = await this.healthCheck();
        if (!health.healthy) {
          console.warn('⚠️ Translation service health check failed:', health);
          // Force recreate client if unhealthy
          if (health.errorCount > 10 || (health.lastError && Date.now() - health.lastError.timestamp > 60000)) {
            console.log('🔄 Forcing translation client recreation due to health check failure');
            await this.getTranslationClient(true);
          }
        } else {
          console.log('✅ Translation service health check passed:', {
            clientAge: health.clientAge,
            errorRate: health.errorRate
          });
        }
      } catch (error) {
        console.error('❌ Health check error:', error);
      }
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  initializeClient() {
    // Service initialized
  }

  /**
   * Get service statistics
   */
  getStats() {
    return {
      errorCount: this.errorCount,
      successCount: this.successCount,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
      clientAge: this.clientCreatedAt ? Math.round((Date.now() - this.clientCreatedAt) / 1000) : null,
      errorRate: this.successCount + this.errorCount > 0 
        ? (this.errorCount / (this.successCount + this.errorCount) * 100).toFixed(2) + '%'
        : '0%'
    };
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    if (this.clientHealthCheckInterval) {
      clearInterval(this.clientHealthCheckInterval);
      this.clientHealthCheckInterval = null;
    }
    if (this.client) {
      try {
        this.client.close?.();
      } catch (e) {
        console.warn('⚠️ Error closing translation client:', e.message);
      }
    }
  }
}

module.exports = new GoogleTranslationService();

