/**
 * Utility per gestire le etichette dei parlanti ("Voce 1", "Voce 2", ...)
 * inserite nella trascrizione dalla diarizzazione.
 */

/** Prefisso usato per le etichette dei parlanti. */
export const SPEAKER_LABEL_PREFIX = "Voce";

/**
 * "Voce N" non preceduto né seguito da lettere/cifre/underscore (Unicode),
 * così "Voce 1" non corrisponde dentro "Voce 10" né dentro "Supervoce 1".
 */
const SPEAKER_LABEL_SOURCE = "(?<![\\p{L}\\p{N}_])Voce \\d+(?![\\p{L}\\p{N}_])";

function speakerLabelRegex(): RegExp {
  return new RegExp(SPEAKER_LABEL_SOURCE, "gu");
}

function labelNumber(label: string): number {
  const n = Number.parseInt(label.slice(SPEAKER_LABEL_PREFIX.length + 1), 10);
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
}

/** Restituisce tutte le occorrenze delle etichette, nell'ordine del testo. */
function matchSpeakerLabels(text: string): string[] {
  if (!text) return [];
  return Array.from(text.matchAll(speakerLabelRegex()), (m) => m[0]);
}

/**
 * Etichette uniche presenti nel testo, ordinate numericamente
 * ("Voce 2" prima di "Voce 10"); a parità di numero vale l'ordine di apparizione.
 */
export function extractSpeakerLabels(text: string): string[] {
  const unique = Array.from(new Set(matchSpeakerLabels(text)));
  return unique.sort((a, b) => labelNumber(a) - labelNumber(b));
}

/** Numero di occorrenze di ciascuna etichetta nel testo. */
export function countSpeakerTurns(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const label of matchSpeakerLabels(text)) {
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

/** True se almeno un nome (dopo trim) è non vuoto. */
export function hasSpeakerNames(mapping: Record<string, string>): boolean {
  return Object.values(mapping).some((name) => name.trim().length > 0);
}

/**
 * Sostituisce in un solo passaggio ogni etichetta con il nome associato (trim).
 * Le etichette senza nome restano invariate. I nomi sono inseriti alla lettera
 * (nessuna interpretazione di `$&`, `$1`, ...), e lo scambio
 * "Voce 1" <-> "Voce 2" funziona perché il testo sostituito non viene rianalizzato.
 */
export function replaceSpeakerLabels(
  text: string,
  mapping: Record<string, string>,
): string {
  if (!text) return text;
  return text.replace(speakerLabelRegex(), (label) => {
    const name = Object.prototype.hasOwnProperty.call(mapping, label)
      ? mapping[label]?.trim()
      : undefined;
    return name ? name : label;
  });
}
