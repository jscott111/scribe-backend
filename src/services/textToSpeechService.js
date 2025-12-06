const fs = require('fs');
const textToSpeech = require('@google-cloud/text-to-speech');
const config = require('../config');

class TextToSpeechService {
  constructor() {
    this.projectId = config.GOOGLE_CLOUD_PROJECT_ID;
    this.client = null;
    this.credentials = null;
  }

  async initializeCredentials() {
    if (this.credentials) {
      return this.credentials;
    }

    try {
      if (fs.existsSync('./google-credentials.json')) {
        this.credentials = JSON.parse(fs.readFileSync('./google-credentials.json', 'utf8'));
        return this.credentials;
      }

      this.credentials = null;
      return this.credentials;
    } catch (error) {
      console.error('❌ TTS: Failed to load credentials:', error);
      console.log('⚠️ TTS: Falling back to default service account');
      this.credentials = null;
      return this.credentials;
    }
  }

  async getTTSClient() {
    if (this.client) {
      return this.client;
    }

    const credentials = await this.initializeCredentials();
    
    if (credentials) {
      this.client = new textToSpeech.TextToSpeechClient({
        projectId: this.projectId,
        credentials: {
          client_email: credentials.client_email,
          private_key: credentials.private_key
        }
      });
    } else {
      this.client = new textToSpeech.TextToSpeechClient({
        projectId: this.projectId
      });
    }

    console.log('✅ TTS: Client initialized');
    return this.client;
  }

  /**
   * Map translation language codes to TTS language codes
   * TTS uses different codes than Translation API
   */
  getTTSLanguageCode(ctLanguageCode) {
    const mapping = {
      // Arabic variants all map to ar-XA
      'ar': 'ar-XA',
      'ar-SA': 'ar-XA',
      
      // Afrikaans
      'af': 'af-ZA',
      
      // Bengali
      'bn': 'bn-IN',
      'bn-IN': 'bn-IN',
      
      // Bulgarian
      'bg': 'bg-BG',
      
      // Catalan
      'ca': 'ca-ES',
      
      // Chinese
      'zh': 'cmn-CN',
      'zh-CN': 'cmn-CN',
      'zh-Hans': 'cmn-CN',
      'zh-TW': 'cmn-TW',
      'zh-Hant': 'cmn-TW',
      'zh-HK': 'yue-HK',
      
      // Czech
      'cs': 'cs-CZ',
      
      // Danish
      'da': 'da-DK',
      
      // Dutch
      'nl': 'nl-NL',
      'nl-BE': 'nl-BE',
      
      // English
      'en': 'en-US',
      'en-AU': 'en-AU',
      'en-CA': 'en-US',
      'en-GB': 'en-GB',
      'en-NZ': 'en-AU',
      'en-PH': 'en-US',
      'en-US': 'en-US',
      'en-ZA': 'en-GB',
      
      // Estonian
      'et': 'et-EE',
      
      // Filipino
      'fil': 'fil-PH',
      
      // Finnish
      'fi': 'fi-FI',
      
      // French
      'fr': 'fr-FR',
      'fr-CA': 'fr-CA',
      'fr-CH': 'fr-FR',
      
      // Galician
      'gl': 'gl-ES',
      
      // German
      'de': 'de-DE',
      
      // Greek
      'el': 'el-GR',
      
      // Gujarati
      'gu': 'gu-IN',
      
      // Hebrew
      'he': 'he-IL',
      'iw': 'he-IL',
      
      // Hindi
      'hi': 'hi-IN',
      
      // Hungarian
      'hu': 'hu-HU',
      
      // Icelandic
      'is': 'is-IS',
      
      // Indonesian
      'id': 'id-ID',
      
      // Italian
      'it': 'it-IT',
      
      // Japanese
      'ja': 'ja-JP',
      
      // Kannada
      'kn': 'kn-IN',
      
      // Korean
      'ko': 'ko-KR',
      
      // Latvian
      'lv': 'lv-LV',
      
      // Lithuanian
      'lt': 'lt-LT',
      
      // Malay
      'ms': 'ms-MY',
      
      // Malayalam
      'ml': 'ml-IN',
      
      // Marathi
      'mr': 'mr-IN',
      
      // Norwegian
      'nb': 'nb-NO',
      'no': 'nb-NO',
      
      // Polish
      'pl': 'pl-PL',
      
      // Portuguese
      'pt': 'pt-PT',
      'pt-BR': 'pt-BR',
      
      // Punjabi
      'pa': 'pa-IN',
      
      // Romanian
      'ro': 'ro-RO',
      
      // Russian
      'ru': 'ru-RU',
      
      // Serbian
      'sr': 'sr-RS',
      
      // Slovak
      'sk': 'sk-SK',
      
      // Spanish
      'es': 'es-ES',
      'es-US': 'es-US',
      
      // Swedish
      'sv': 'sv-SE',
      
      // Tamil
      'ta': 'ta-IN',
      
      // Telugu
      'te': 'te-IN',
      
      // Thai
      'th': 'th-TH',
      
      // Turkish
      'tr': 'tr-TR',
      
      // Ukrainian
      'uk': 'uk-UA',
      
      // Vietnamese
      'vi': 'vi-VN',
    };

    // Check direct mapping first
    if (mapping[ctLanguageCode]) {
      return mapping[ctLanguageCode];
    }

    // Try base code
    const baseCode = ctLanguageCode.split('-')[0];
    return mapping[baseCode] || null;
  }

  /**
   * Get the best voice for a language
   * Prioritizes Neural2 > Wavenet > Standard voices
   */
  getVoiceConfig(languageCode) {
    // Neural2 voices for best quality (available for many languages)
    const neural2Voices = {
      'ar-XA': { name: 'ar-XA-Wavenet-A', ssmlGender: 'FEMALE' },
      'bn-IN': { name: 'bn-IN-Wavenet-A', ssmlGender: 'FEMALE' },
      'bg-BG': { name: 'bg-BG-Standard-A', ssmlGender: 'FEMALE' },
      'ca-ES': { name: 'ca-ES-Standard-A', ssmlGender: 'FEMALE' },
      'cmn-CN': { name: 'cmn-CN-Wavenet-A', ssmlGender: 'FEMALE' },
      'cmn-TW': { name: 'cmn-TW-Wavenet-A', ssmlGender: 'FEMALE' },
      'yue-HK': { name: 'yue-HK-Standard-A', ssmlGender: 'FEMALE' },
      'cs-CZ': { name: 'cs-CZ-Wavenet-A', ssmlGender: 'FEMALE' },
      'da-DK': { name: 'da-DK-Neural2-D', ssmlGender: 'FEMALE' },
      'nl-BE': { name: 'nl-BE-Wavenet-A', ssmlGender: 'FEMALE' },
      'nl-NL': { name: 'nl-NL-Wavenet-A', ssmlGender: 'FEMALE' },
      'en-AU': { name: 'en-AU-Neural2-A', ssmlGender: 'FEMALE' },
      'en-GB': { name: 'en-GB-Neural2-A', ssmlGender: 'FEMALE' },
      'en-US': { name: 'en-US-Neural2-C', ssmlGender: 'FEMALE' },
      'et-EE': { name: 'et-EE-Standard-A', ssmlGender: 'FEMALE' },
      'fil-PH': { name: 'fil-PH-Wavenet-A', ssmlGender: 'FEMALE' },
      'fi-FI': { name: 'fi-FI-Wavenet-A', ssmlGender: 'FEMALE' },
      'fr-CA': { name: 'fr-CA-Neural2-A', ssmlGender: 'FEMALE' },
      'fr-FR': { name: 'fr-FR-Neural2-A', ssmlGender: 'FEMALE' },
      'gl-ES': { name: 'gl-ES-Standard-A', ssmlGender: 'FEMALE' },
      'de-DE': { name: 'de-DE-Neural2-A', ssmlGender: 'FEMALE' },
      'el-GR': { name: 'el-GR-Wavenet-A', ssmlGender: 'FEMALE' },
      'gu-IN': { name: 'gu-IN-Wavenet-A', ssmlGender: 'FEMALE' },
      'he-IL': { name: 'he-IL-Wavenet-A', ssmlGender: 'FEMALE' },
      'hi-IN': { name: 'hi-IN-Neural2-A', ssmlGender: 'FEMALE' },
      'hu-HU': { name: 'hu-HU-Wavenet-A', ssmlGender: 'FEMALE' },
      'is-IS': { name: 'is-IS-Standard-A', ssmlGender: 'FEMALE' },
      'id-ID': { name: 'id-ID-Wavenet-A', ssmlGender: 'FEMALE' },
      'it-IT': { name: 'it-IT-Neural2-A', ssmlGender: 'FEMALE' },
      'ja-JP': { name: 'ja-JP-Neural2-B', ssmlGender: 'FEMALE' },
      'kn-IN': { name: 'kn-IN-Wavenet-A', ssmlGender: 'FEMALE' },
      'ko-KR': { name: 'ko-KR-Neural2-A', ssmlGender: 'FEMALE' },
      'lv-LV': { name: 'lv-LV-Standard-A', ssmlGender: 'FEMALE' },
      'lt-LT': { name: 'lt-LT-Standard-A', ssmlGender: 'FEMALE' },
      'ms-MY': { name: 'ms-MY-Wavenet-A', ssmlGender: 'FEMALE' },
      'ml-IN': { name: 'ml-IN-Wavenet-A', ssmlGender: 'FEMALE' },
      'mr-IN': { name: 'mr-IN-Wavenet-A', ssmlGender: 'FEMALE' },
      'nb-NO': { name: 'nb-NO-Wavenet-A', ssmlGender: 'FEMALE' },
      'pl-PL': { name: 'pl-PL-Wavenet-A', ssmlGender: 'FEMALE' },
      'pt-BR': { name: 'pt-BR-Neural2-A', ssmlGender: 'FEMALE' },
      'pt-PT': { name: 'pt-PT-Wavenet-A', ssmlGender: 'FEMALE' },
      'pa-IN': { name: 'pa-IN-Wavenet-A', ssmlGender: 'FEMALE' },
      'ro-RO': { name: 'ro-RO-Wavenet-A', ssmlGender: 'FEMALE' },
      'ru-RU': { name: 'ru-RU-Wavenet-A', ssmlGender: 'FEMALE' },
      'sr-RS': { name: 'sr-RS-Standard-A', ssmlGender: 'FEMALE' },
      'sk-SK': { name: 'sk-SK-Wavenet-A', ssmlGender: 'FEMALE' },
      'es-ES': { name: 'es-ES-Neural2-A', ssmlGender: 'FEMALE' },
      'es-US': { name: 'es-US-Neural2-A', ssmlGender: 'FEMALE' },
      'sv-SE': { name: 'sv-SE-Wavenet-A', ssmlGender: 'FEMALE' },
      'ta-IN': { name: 'ta-IN-Wavenet-A', ssmlGender: 'FEMALE' },
      'te-IN': { name: 'te-IN-Standard-A', ssmlGender: 'FEMALE' },
      'th-TH': { name: 'th-TH-Neural2-C', ssmlGender: 'FEMALE' },
      'tr-TR': { name: 'tr-TR-Wavenet-A', ssmlGender: 'FEMALE' },
      'uk-UA': { name: 'uk-UA-Wavenet-A', ssmlGender: 'FEMALE' },
      'vi-VN': { name: 'vi-VN-Neural2-A', ssmlGender: 'FEMALE' },
      'af-ZA': { name: 'af-ZA-Standard-A', ssmlGender: 'FEMALE' },
    };

    return neural2Voices[languageCode] || { name: null, ssmlGender: 'FEMALE' };
  }

  /**
   * Synthesize speech from text
   * @param {string} text - Text to convert to speech
   * @param {string} languageCode - Translation language code (e.g., 'fr', 'es-ES')
   * @returns {Promise<Buffer>} - MP3 audio buffer
   */
  async synthesizeSpeech(text, languageCode) {
    try {
      const client = await this.getTTSClient();
      
      const ttsLanguageCode = this.getTTSLanguageCode(languageCode);
      if (!ttsLanguageCode) {
        throw new Error(`Language ${languageCode} is not supported for text-to-speech`);
      }

      const voiceConfig = this.getVoiceConfig(ttsLanguageCode);
      
      console.log(`🔊 TTS: Synthesizing "${text.substring(0, 50)}..." in ${ttsLanguageCode} using ${voiceConfig.name || 'default voice'}`);

      const request = {
        input: { text },
        voice: {
          languageCode: ttsLanguageCode,
          ...(voiceConfig.name && { name: voiceConfig.name }),
          ssmlGender: voiceConfig.ssmlGender
        },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: 1.0,
          pitch: 0,
          volumeGainDb: 0
        }
      };

      const [response] = await client.synthesizeSpeech(request);
      
      console.log(`✅ TTS: Generated ${response.audioContent.length} bytes of audio`);
      
      return response.audioContent;
    } catch (error) {
      console.error('❌ TTS: Synthesis error:', error);
      throw error;
    }
  }

  /**
   * Check if a language is supported for TTS
   * @param {string} languageCode - Translation language code
   * @returns {boolean}
   */
  isLanguageSupported(languageCode) {
    return this.getTTSLanguageCode(languageCode) !== null;
  }
}

module.exports = new TextToSpeechService();

