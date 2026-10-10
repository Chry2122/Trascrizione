import { NextRequest, NextResponse } from "next/server";
import { TRANSCRIBE_FORMATS, validateMediaFile } from "@/lib/media-validation";
import {
  createOpenAIClient,
  missingApiKeyResponse,
  openAIErrorResponse,
} from "@/lib/openai-server";
import { diarizeTranscript } from "@/lib/speaker-diarization";

export async function POST(request: NextRequest) {
  const openai = createOpenAIClient();
  if (!openai) return missingApiKeyResponse();

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Richiesta non valida: FormData mancante o corrotto." },
      { status: 400 },
    );
  }

  const fileEntry = formData.get("file");
  if (!(fileEntry instanceof File)) {
    return NextResponse.json(
      { error: 'Campo "file" mancante nel FormData.' },
      { status: 400 },
    );
  }

  const validationError = validateMediaFile(fileEntry, TRANSCRIBE_FORMATS);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  let rawText: string;
  try {
    const transcription = await openai.audio.transcriptions.create(
      { file: fileEntry, model: "whisper-1" },
      { signal: request.signal },
    );
    rawText = (transcription.text ?? "").trim();
  } catch (error: unknown) {
    return openAIErrorResponse(error, "Trascrizione fallita");
  }

  if (!rawText) {
    return NextResponse.json({ text: "", rawText: "", tier: null });
  }

  try {
    const { text, tier } = await diarizeTranscript(openai, rawText, request.signal);
    return NextResponse.json({ text, rawText, tier });
  } catch (error: unknown) {
    return openAIErrorResponse(error, "Riconoscimento dei parlanti fallito");
  }
}
