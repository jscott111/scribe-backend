// Language codes enum for Google Cloud Translation API
const LanguageCode = {
  // Major World Languages
  EN: 'en',      // English
  ES: 'es',      // Spanish
  FR: 'fr',      // French
  DE: 'de',      // German
  IT: 'it',      // Italian
  PT: 'pt',      // Portuguese
  RU: 'ru',      // Russian
  JA: 'ja',      // Japanese
  KO: 'ko',      // Korean
  ZH: 'zh-CN',   // Chinese Simplified (Google format)
  ZH_TW: 'zh-TW', // Chinese Traditional (Google format)
  AR: 'ar',      // Arabic
  HI: 'hi',      // Hindi
  
  // European Languages
  NL: 'nl',      // Dutch
  SV: 'sv',      // Swedish
  DA: 'da',      // Danish
  NO: 'nb',      // Norwegian Bokmål
  FI: 'fi',      // Finnish
  PL: 'pl',      // Polish
  CS: 'cs',      // Czech
  SK: 'sk',      // Slovak
  HU: 'hu',      // Hungarian
  RO: 'ro',      // Romanian
  BG: 'bg',      // Bulgarian
  HR: 'hr',      // Croatian
  SR: 'sr',      // Serbian
  SL: 'sl',      // Slovenian
  ET: 'et',      // Estonian
  LV: 'lv',      // Latvian
  LT: 'lt',      // Lithuanian
  EL: 'el',      // Greek
  TR: 'tr',      // Turkish
  UK: 'uk',      // Ukrainian
  BE: 'be',      // Belarusian
  MK: 'mk',      // Macedonian
  SQ: 'sq',      // Albanian
  CA: 'ca',      // Catalan
  EU: 'eu',      // Basque
  GL: 'gl',      // Galician
  IS: 'is',      // Icelandic
  FO: 'fo',      // Faroese
  GA: 'ga',      // Irish
  MT: 'mt',      // Maltese
  CY: 'cy',      // Welsh
  
  // Asian Languages
  TH: 'th',      // Thai
  VI: 'vi',      // Vietnamese
  ID: 'id',      // Indonesian
  MS: 'ms',      // Malay
  TA: 'ta',      // Tamil
  TE: 'te',      // Telugu
  KN: 'kn',      // Kannada
  ML: 'ml',      // Malayalam
  BN: 'bn',      // Bangla
  PA: 'pa',      // Punjabi
  GU: 'gu',      // Gujarati
  MR: 'mr',      // Marathi
  OR: 'or',      // Odia
  AS: 'as',      // Assamese
  NE: 'ne',      // Nepali
  SI: 'si',      // Sinhala
  MY: 'my',      // Myanmar (Burmese)
  KM: 'km',      // Khmer
  LO: 'lo',      // Lao
  MN: 'mn',      // Mongolian
  KK: 'kk',      // Kazakh
  KY: 'ky',      // Kyrgyz
  UZ: 'uz',      // Uzbek
  TK: 'tk',      // Turkmen
  TJ: 'tg',      // Tajik
  PS: 'ps',      // Pashto
  FA: 'fa',      // Persian
  UR: 'ur',      // Urdu
  SD: 'sd',      // Sindhi
  YUE: 'yue',    // Cantonese
  
  // African Languages
  AF: 'af',      // Afrikaans
  SW: 'sw',      // Swahili
  SO: 'so',      // Somali
  AM: 'am',      // Amharic
  HA: 'ha',      // Hausa
  IG: 'ig',      // Igbo
  YO: 'yo',      // Yoruba
  ZU: 'zu',      // Zulu
  XH: 'xh',      // Xhosa
  ST: 'st',      // Southern Sotho
  TN: 'tn',      // Tswana
  VE: 've',      // Venda
  TS: 'ts',      // Tsonga
  SS: 'ss',      // Swati
  NR: 'nr',      // Southern Ndebele
  ND: 'nd',      // Northern Ndebele
  
  // Middle Eastern Languages
  HE: 'he',      // Hebrew
  KU: 'ku',      // Kurdish
  DV: 'dv',      // Divehi
  
  // Pacific Languages
  MI: 'mi',      // Maori
  SM: 'sm',      // Samoan
  TO: 'to',      // Tongan
  FJ: 'fj',      // Fijian
  TY: 'ty',      // Tahitian
  
  // Indigenous Languages
  IU: 'iu',      // Inuktitut
}

// Language metadata mapping
const LANGUAGE_METADATA = {
  // Major World Languages
  [LanguageCode.EN]: { name: 'English', flag: '🇺🇸' },
  [LanguageCode.ES]: { name: 'Spanish', flag: '🇪🇸' },
  [LanguageCode.FR]: { name: 'French', flag: '🇫🇷' },
  [LanguageCode.DE]: { name: 'German', flag: '🇩🇪' },
  [LanguageCode.IT]: { name: 'Italian', flag: '🇮🇹' },
  [LanguageCode.PT]: { name: 'Portuguese', flag: '🇵🇹' },
  [LanguageCode.RU]: { name: 'Russian', flag: '🇷🇺' },
  [LanguageCode.JA]: { name: 'Japanese', flag: '🇯🇵' },
  [LanguageCode.KO]: { name: 'Korean', flag: '🇰🇷' },
  [LanguageCode.ZH]: { name: 'Chinese (Simplified)', flag: '🇨🇳' },
  [LanguageCode.ZH_TW]: { name: 'Chinese (Traditional)', flag: '🇹🇼' },
  [LanguageCode.AR]: { name: 'Arabic', flag: '🇸🇦' },
  [LanguageCode.HI]: { name: 'Hindi', flag: '🇮🇳' },
  
  // European Languages
  [LanguageCode.NL]: { name: 'Dutch', flag: '🇳🇱' },
  [LanguageCode.SV]: { name: 'Swedish', flag: '🇸🇪' },
  [LanguageCode.DA]: { name: 'Danish', flag: '🇩🇰' },
  [LanguageCode.NO]: { name: 'Norwegian', flag: '🇳🇴' },
  [LanguageCode.FI]: { name: 'Finnish', flag: '🇫🇮' },
  [LanguageCode.PL]: { name: 'Polish', flag: '🇵🇱' },
  [LanguageCode.CS]: { name: 'Czech', flag: '🇨🇿' },
  [LanguageCode.SK]: { name: 'Slovak', flag: '🇸🇰' },
  [LanguageCode.HU]: { name: 'Hungarian', flag: '🇭🇺' },
  [LanguageCode.RO]: { name: 'Romanian', flag: '🇷🇴' },
  [LanguageCode.BG]: { name: 'Bulgarian', flag: '🇧🇬' },
  [LanguageCode.HR]: { name: 'Croatian', flag: '🇭🇷' },
  [LanguageCode.SR]: { name: 'Serbian', flag: '🇷🇸' },
  [LanguageCode.SL]: { name: 'Slovenian', flag: '🇸🇮' },
  [LanguageCode.ET]: { name: 'Estonian', flag: '🇪🇪' },
  [LanguageCode.LV]: { name: 'Latvian', flag: '🇱🇻' },
  [LanguageCode.LT]: { name: 'Lithuanian', flag: '🇱🇹' },
  [LanguageCode.EL]: { name: 'Greek', flag: '🇬🇷' },
  [LanguageCode.TR]: { name: 'Turkish', flag: '🇹🇷' },
  [LanguageCode.UK]: { name: 'Ukrainian', flag: '🇺🇦' },
  [LanguageCode.BE]: { name: 'Belarusian', flag: '🇧🇾' },
  [LanguageCode.MK]: { name: 'Macedonian', flag: '🇲🇰' },
  [LanguageCode.SQ]: { name: 'Albanian', flag: '🇦🇱' },
  [LanguageCode.CA]: { name: 'Catalan', flag: '🏴󠁥󠁳󠁣󠁴󠁿' },
  [LanguageCode.EU]: { name: 'Basque', flag: '🏴󠁥󠁳󠁰󠁶󠁿' },
  [LanguageCode.GL]: { name: 'Galician', flag: '🏴󠁥󠁳󠁧󠁡󠁿' },
  [LanguageCode.IS]: { name: 'Icelandic', flag: '🇮🇸' },
  [LanguageCode.FO]: { name: 'Faroese', flag: '🇫🇴' },
  [LanguageCode.GA]: { name: 'Irish', flag: '🇮🇪' },
  [LanguageCode.MT]: { name: 'Maltese', flag: '🇲🇹' },
  [LanguageCode.CY]: { name: 'Welsh', flag: '🏴󠁧󠁢󠁷󠁬󠁳󠁿' },
  
  // Asian Languages
  [LanguageCode.TH]: { name: 'Thai', flag: '🇹🇭' },
  [LanguageCode.VI]: { name: 'Vietnamese', flag: '🇻🇳' },
  [LanguageCode.ID]: { name: 'Indonesian', flag: '🇮🇩' },
  [LanguageCode.MS]: { name: 'Malay', flag: '🇲🇾' },
  [LanguageCode.TA]: { name: 'Tamil', flag: '🇮🇳' },
  [LanguageCode.TE]: { name: 'Telugu', flag: '🇮🇳' },
  [LanguageCode.KN]: { name: 'Kannada', flag: '🇮🇳' },
  [LanguageCode.ML]: { name: 'Malayalam', flag: '🇮🇳' },
  [LanguageCode.BN]: { name: 'Bangla', flag: '🇧🇩' },
  [LanguageCode.PA]: { name: 'Punjabi', flag: '🇮🇳' },
  [LanguageCode.GU]: { name: 'Gujarati', flag: '🇮🇳' },
  [LanguageCode.MR]: { name: 'Marathi', flag: '🇮🇳' },
  [LanguageCode.OR]: { name: 'Odia', flag: '🇮🇳' },
  [LanguageCode.AS]: { name: 'Assamese', flag: '🇮🇳' },
  [LanguageCode.NE]: { name: 'Nepali', flag: '🇳🇵' },
  [LanguageCode.SI]: { name: 'Sinhala', flag: '🇱🇰' },
  [LanguageCode.MY]: { name: 'Myanmar', flag: '🇲🇲' },
  [LanguageCode.KM]: { name: 'Khmer', flag: '🇰🇭' },
  [LanguageCode.LO]: { name: 'Lao', flag: '🇱🇦' },
  [LanguageCode.MN]: { name: 'Mongolian', flag: '🇲🇳' },
  [LanguageCode.KK]: { name: 'Kazakh', flag: '🇰🇿' },
  [LanguageCode.KY]: { name: 'Kyrgyz', flag: '🇰🇬' },
  [LanguageCode.UZ]: { name: 'Uzbek', flag: '🇺🇿' },
  [LanguageCode.TK]: { name: 'Turkmen', flag: '🇹🇲' },
  [LanguageCode.TJ]: { name: 'Tajik', flag: '🇹🇯' },
  [LanguageCode.PS]: { name: 'Pashto', flag: '🇦🇫' },
  [LanguageCode.FA]: { name: 'Persian', flag: '🇮🇷' },
  [LanguageCode.UR]: { name: 'Urdu', flag: '🇵🇰' },
  [LanguageCode.SD]: { name: 'Sindhi', flag: '🇵🇰' },
  [LanguageCode.YUE]: { name: 'Cantonese', flag: '🇭🇰' },
  
  // African Languages
  [LanguageCode.AF]: { name: 'Afrikaans', flag: '🇿🇦' },
  [LanguageCode.SW]: { name: 'Swahili', flag: '🇹🇿' },
  [LanguageCode.SO]: { name: 'Somali', flag: '🇸🇴' },
  [LanguageCode.AM]: { name: 'Amharic', flag: '🇪🇹' },
  [LanguageCode.HA]: { name: 'Hausa', flag: '🇳🇬' },
  [LanguageCode.IG]: { name: 'Igbo', flag: '🇳🇬' },
  [LanguageCode.YO]: { name: 'Yoruba', flag: '🇳🇬' },
  [LanguageCode.ZU]: { name: 'Zulu', flag: '🇿🇦' },
  [LanguageCode.XH]: { name: 'Xhosa', flag: '🇿🇦' },
  [LanguageCode.ST]: { name: 'Southern Sotho', flag: '🇱🇸' },
  [LanguageCode.TN]: { name: 'Tswana', flag: '🇧🇼' },
  [LanguageCode.VE]: { name: 'Venda', flag: '🇿🇦' },
  [LanguageCode.TS]: { name: 'Tsonga', flag: '🇿🇦' },
  [LanguageCode.SS]: { name: 'Swati', flag: '🇸🇿' },
  [LanguageCode.NR]: { name: 'Southern Ndebele', flag: '🇿🇦' },
  [LanguageCode.ND]: { name: 'Northern Ndebele', flag: '🇿🇼' },
  
  // Middle Eastern Languages
  [LanguageCode.HE]: { name: 'Hebrew', flag: '🇮🇱' },
  [LanguageCode.KU]: { name: 'Kurdish', flag: '🇮🇶' },
  [LanguageCode.DV]: { name: 'Divehi', flag: '🇲🇻' },
  
  // Pacific Languages
  [LanguageCode.MI]: { name: 'Maori', flag: '🇳🇿' },
  [LanguageCode.SM]: { name: 'Samoan', flag: '🇼🇸' },
  [LanguageCode.TO]: { name: 'Tongan', flag: '🇹🇴' },
  [LanguageCode.FJ]: { name: 'Fijian', flag: '🇫🇯' },
  [LanguageCode.TY]: { name: 'Tahitian', flag: '🇵🇫' },
  
  // Indigenous Languages
  [LanguageCode.IU]: { name: 'Inuktitut', flag: '🇨🇦' },
}

// Helper functions to get language information
const getLanguageName = (code) => {
  return LANGUAGE_METADATA[code]?.name || 'Unknown'
}

const getLanguageFlag = (code) => {
  return LANGUAGE_METADATA[code]?.flag || '🏳️'
}

const getLanguageInfo = (code) => {
  return {
    code,
    name: getLanguageName(code),
    flag: getLanguageFlag(code)
  }
}

// Get all supported languages as an array
const getSupportedLanguages = () => {
  return Object.values(LanguageCode).map(code => getLanguageInfo(code))
}

module.exports = {
  LanguageCode,
  LANGUAGE_METADATA,
  getLanguageName,
  getLanguageFlag,
  getLanguageInfo,
  getSupportedLanguages
}

