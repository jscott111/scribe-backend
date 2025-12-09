const { TranslationServiceClient } = require('@google-cloud/translate');
const fs = require('fs');
const config = require('../config');
const { getBaseLanguageCode, isSameLanguage } = require('../utils/languageCodeMapper');

class GoogleTranslationService {
  constructor() {
    this.projectId = config.GOOGLE_CLOUD_PROJECT_ID;
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
        console.log('🔧 Translation: Loading credentials from local file');
        this.credentials = JSON.parse(fs.readFileSync('./google-credentials.json', 'utf8'));
        return this.credentials;
      }

      // For Cloud Run, use the default service account
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

  async getTranslationClient() {
    if (this.client) {
      return this.client;
    }

    const credentials = await this.initializeCredentials();
    
    // Use default credentials if no explicit credentials found
    if (credentials) {
      this.client = new TranslationServiceClient({
        projectId: this.projectId,
        credentials: {
          client_email: credentials.client_email,
          private_key: credentials.private_key
        }
      });
    } else {
      // Use default service account (Cloud Run)
      this.client = new TranslationServiceClient({
        projectId: this.projectId
      });
    }

    return this.client;
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
      const client = await this.getTranslationClient();
      
      // Check if source and target are the same language (e.g., en-US vs en-US, or en-US vs en-CA)
      if (isSameLanguage(sourceLanguage, targetLanguage)) {
        console.log(`🔄 Source and target are same language (${sourceLanguage} / ${targetLanguage}), skipping translation`);
        return text;
      }
      
      // Get base language codes for translation API (en-US -> en, zh-CN stays zh-CN)
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

      console.log(`🌐 Translating from ${sourceLanguage} (${sourceCode}) to ${targetLanguage} (${targetCode}): "${text.substring(0, 50)}..."`);

      const [response] = await client.translateText(request);

      if (response.translations && response.translations.length > 0) {
        const translatedText = response.translations[0].translatedText;
        console.log(`✅ Translation successful: "${translatedText.substring(0, 50)}..."`);
        return translatedText;
      } else {
        console.error('❌ No translations in response:', response);
        throw new Error('Invalid response from Google Translation API');
      }
    } catch (error) {
      console.error('❌ Translation error:', error.message);
      throw error;
    }
  }

  initializeClient() {
    // Service initialized
  }
}

module.exports = new GoogleTranslationService();

