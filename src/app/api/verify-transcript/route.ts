import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";
import { FFMPEG_MISSING_MESSAGE, resolveFfmpegPath } from "@/lib/ffmpeg-binary";
import { transcribeAudioFile } from "@/lib/long-audio-transcription";
import { TranscriptMismatchError, verifyLongTranscript } from "@/lib/long-verification";
import { MAX_TRANSCRIPT_CHARS } from "@/lib/media-validation";
import { ndjsonResponse } from "@/lib/ndjson-response";
import {
  createOpenAIClient,
  describeOpenAIError,
  missingApiKeyResponse,
} from "@/lib/openai-server";
import { storageDir } from "@/lib/temp-storage";
import { runTiered, TieredAIError, toTierInfo } from "@/lib/tiered-ai";
import {
  describeDifference,
  isRealError,
  normalizeForComparison,
  type Difference,
} from "@/lib/transcript-compare";
import type {
  VerificationOutcome,
  VerifyRequestBody,
  VerifyStreamEvent,
  VerifyTranscriptResult,
} from "@/lib/transcript-verification";
import { SUPPORTED_LANGUAGES } from "@/lib/transcription-jobs/types";

export const runtime = "nodejs";

// Up to this combined length both texts fit in one model call; longer texts are aligned
// locally and only the differing passages are sent to the model.
const SHORT_TEXT_MAX_CHARS = 12_000;

const SYSTEM_PROMPT = `Confronta la trascrizione fornita dall'utente con la trascrizione reale registrata dall'audio.
Se la trascrizione fornita è corretta (tollerando solo punteggiatura minima), restituisci JSON: { "isCorrect": true }.
SE E SOLO SE ci sono parole errate, omesso testo o inesattezze, restituisci JSON: { "isCorrect": false, "errors": ["descrizione errore 1", ...], "correctedTranscript": "testo corretto completo" }.

Procedura obbligatoria:
1. Allinea i due testi parola per parola e inserisci nell'array "differences" ogni punto in cui differiscono, come oggetto { "fornito": "...", "audio": "...", "tipo": "equivalente" | "errore" }. Usa "" in "fornito" per il testo omesso dall'utente e "" in "audio" per il testo in più.
2. "tipo" è "equivalente" quando le due forme si leggono ad alta voce allo stesso modo o hanno lo stesso significato: numeri in lettere o in cifre ("tre" / "3"), unità di misura per esteso o abbreviate ("chili" / "kg"), punteggiatura, maiuscole, apostrofi, varianti ortografiche. In tutti gli altri casi (parola diversa, testo omesso, testo in più) "tipo" è "errore".
3. La trascrizione reale è generata automaticamente: in caso di dubbio su un singolo suono simile, preferisci "equivalente".
4. "isCorrect" è true se e solo se nessuna differenza è di tipo "errore".
5. Se "isCorrect" è false: "errors" contiene una descrizione in italiano per ciascuna differenza di tipo "errore" e MAI per quelle equivalenti; "correctedTranscript" è il testo dell'utente in cui correggi SOLO le differenze di tipo "errore", lasciando le parti equivalenti esattamente come le ha scritte l'utente.
6. "text" è uguale a "correctedTranscript" se "isCorrect" è false, altrimenti è la trascrizione fornita dall'utente invariata.
7. "unclearWords" elenca le parole della trascrizione reale che Whisper potrebbe aver frainteso o per cui non è chiaro se la differenza sia un vero errore; "confidenceScore" indica quanto sei sicuro della classificazione delle differenze.

Esempio
Trascrizione fornita: "Ho comprato due chili di pere"
Trascrizione reale: "Ho comprato 2 kg di mele."
Risposta: {"differences":[{"fornito":"due","audio":"2","tipo":"equivalente"},{"fornito":"chili","audio":"kg","tipo":"equivalente"},{"fornito":"pere","audio":"mele","tipo":"errore"}],"isCorrect":false,"errors":["\\"pere\\" non corrisponde all'audio: è stato detto \\"mele\\"."],"correctedTranscript":"Ho comprato due chili di mele","text":"Ho comprato due chili di mele","confidenceScore":95,"unclearWords":[],"needsEscalation":false}`;

function readDifferences(value: unknown): Difference[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(
    (item): item is Difference =>
      typeof item === "object" && item !== null && typeof (item as Difference).tipo === "string",
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyMissingCorrections(corrected: string, errors: Difference[]): string {
  let result = corrected;
  for (const { fornito, audio } of errors) {
    if (!fornito.trim() || !audio.trim()) continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(fornito.trim())}(?![\\p{L}\\p{N}])`, "iu");
    if (pattern.test(result)) result = result.replace(pattern, audio.trim());
  }
  return result;
}

function buildUserMessage(providedTranscript: string, whisperTranscript: string): string {
  return [
    "TRASCRIZIONE FORNITA DALL'UTENTE:",
    "<<<",
    providedTranscript,
    ">>>",
    "",
    "TRASCRIZIONE REALE DELL'AUDIO:",
    "<<<",
    whisperTranscript,
    ">>>",
  ].join("\n");
}

function parseVerification(
  record: Record<string, unknown>,
  whisperTranscript: string,
): VerificationOutcome | null {
  if (!("isCorrect" in record)) return null;

  const differences = readDifferences(record.differences);
  if (differences) {
    console.log(`[verify-transcript] differenze rilevate: ${JSON.stringify(differences)}`);
  }
  const errorDifferences = differences?.filter(isRealError) ?? null;

  // The per-difference classification is more reliable than the model's own verdict.
  const isCorrect = errorDifferences ? errorDifferences.length === 0 : record.isCorrect === true;
  if (isCorrect) return { isCorrect: true };
  if (!errorDifferences && record.isCorrect !== false) return null;

  const modelErrors = Array.isArray(record.errors)
    ? record.errors.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
  const errors =
    errorDifferences && modelErrors.length !== errorDifferences.length
      ? errorDifferences.map(describeDifference)
      : modelErrors;
  const corrected =
    typeof record.correctedTranscript === "string" && record.correctedTranscript.trim() !== ""
      ? record.correctedTranscript
      : whisperTranscript;

  return {
    isCorrect: false,
    errors,
    correctedTranscript: errorDifferences
      ? applyMissingCorrections(
          corrected,
          errorDifferences.filter((item) => item.tipo !== "errore"),
        )
      : corrected,
  };
}

/** The single-call comparison, tuned and tested on short texts. */
async function verifyShortTranscript(
  openai: OpenAI,
  providedTranscript: string,
  whisperTranscript: string,
  signal: AbortSignal,
): Promise<VerifyTranscriptResult> {
  const run = await runTiered<VerificationOutcome>({
    client: openai,
    taskName: "verify-transcript",
    instructions: SYSTEM_PROMPT,
    input: buildUserMessage(providedTranscript, whisperTranscript),
    parseExtra: (record) => parseVerification(record, whisperTranscript),
    maxOutputTokens: 8192,
    signal,
  });
  return { ...run.extra, tier: toTierInfo(run) };
}

async function loadUpload(uploadId: string) {
  const dir = storageDir("verify", uploadId);
  if (!dir) return null;
  try {
    const meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8")) as {
      fileName: string;
      extension: string;
    };
    return { dir, meta, sourcePath: path.join(dir, `source${meta.extension}`) };
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  if (error instanceof TieredAIError) {
    console.error(`[verify-transcript] ${error.message}`);
    return "Il modello ha restituito una risposta non valida. Riprova.";
  }
  const message = describeOpenAIError(error);
  console.error(`[verify-transcript] verifica fallita: ${message}`);
  return error instanceof TranscriptMismatchError ? message : `Verifica fallita: ${message}`;
}

/**
 * Body: { uploadId, providedTranscript, language } after the audio was sent to ./upload.
 * Streams the progress as NDJSON and ends with the verification result.
 */
export async function POST(request: NextRequest) {
  const openai = createOpenAIClient();
  if (!openai) return missingApiKeyResponse();
  const ffmpeg = resolveFfmpegPath("[verify-transcript]");
  if (!ffmpeg) return NextResponse.json({ error: FFMPEG_MISSING_MESSAGE }, { status: 500 });

  let body: Partial<VerifyRequestBody>;
  try {
    body = (await request.json()) as Partial<VerifyRequestBody>;
  } catch {
    return NextResponse.json({ error: "Richiesta non valida." }, { status: 400 });
  }

  const providedTranscript =
    typeof body.providedTranscript === "string" ? body.providedTranscript.trim() : "";
  if (!providedTranscript) {
    return NextResponse.json({ error: "Inserisci la trascrizione da verificare." }, { status: 400 });
  }
  if (providedTranscript.length > MAX_TRANSCRIPT_CHARS) {
    return NextResponse.json(
      {
        error: `La trascrizione supera il limite di ${MAX_TRANSCRIPT_CHARS.toLocaleString("it-IT")} caratteri.`,
      },
      { status: 400 },
    );
  }
  const language = typeof body.language === "string" ? body.language.trim() : "";
  if (language && !SUPPORTED_LANGUAGES.has(language)) {
    return NextResponse.json({ error: `Lingua non supportata: ${language}.` }, { status: 400 });
  }
  const upload = typeof body.uploadId === "string" ? await loadUpload(body.uploadId) : null;
  if (!upload) {
    return NextResponse.json(
      { error: "Audio non trovato o scaduto: caricalo di nuovo." },
      { status: 404 },
    );
  }

  const cachePath = path.join(upload.dir, `whisper-${language || "auto"}.txt`);
  return ndjsonResponse<VerifyStreamEvent>(
    request,
    async (send, signal) => {
      let whisperTranscript = await readFile(cachePath, "utf8").catch(() => null);
      if (whisperTranscript === null) {
        whisperTranscript = await transcribeAudioFile({
          openai,
          ffmpegPath: ffmpeg.path,
          inputPath: upload.sourcePath,
          workDir: upload.dir,
          language: language || null,
          signal,
          onProgress: (progress) => send({ type: "progress", ...progress }),
        });
        await writeFile(cachePath, whisperTranscript, "utf8");
      } else {
        console.log(`[verify-transcript] uso la trascrizione già fatta di "${upload.meta.fileName}"`);
      }

      if (!whisperTranscript.trim()) {
        throw new TranscriptMismatchError(
          "Whisper non ha rilevato parlato nell'audio: impossibile verificare.",
        );
      }

      let result: VerifyTranscriptResult;
      if (normalizeForComparison(providedTranscript) === normalizeForComparison(whisperTranscript)) {
        result = { isCorrect: true, tier: null };
      } else if (providedTranscript.length + whisperTranscript.length <= SHORT_TEXT_MAX_CHARS) {
        send({ type: "progress", stage: "comparing", done: 0, total: 1 });
        result = await verifyShortTranscript(openai, providedTranscript, whisperTranscript, signal);
      } else {
        result = await verifyLongTranscript({
          openai,
          provided: providedTranscript,
          whisper: whisperTranscript,
          signal,
          onProgress: (progress) => send({ type: "progress", stage: "comparing", ...progress }),
        });
      }
      send({ type: "result", result });
    },
    describeError,
  );
}
