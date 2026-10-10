// Each chunk is an independent Whisper request; without a shared prompt the casing and
// punctuation style drifts between chunks (e.g. one chunk in lowercase, the next in capitals).
export const STYLE_PROMPTS: Record<string, string> = {
  it: "Trascrizione fedele di una registrazione in italiano, con punteggiatura completa e maiuscole normali. Le parole vengono scritte per esteso.",
  en: "A faithful transcript of an English recording, with full punctuation and normal capitalization. Words are written out in full.",
  es: "Transcripción fiel de una grabación en español, con puntuación completa y mayúsculas normales.",
  fr: "Transcription fidèle d'un enregistrement en français, avec une ponctuation complète et des majuscules normales.",
  de: "Eine originalgetreue Transkription einer deutschen Aufnahme mit vollständiger Zeichensetzung und normaler Groß- und Kleinschreibung.",
  pt: "Transcrição fiel de uma gravação em português, com pontuação completa e maiúsculas normais.",
};
