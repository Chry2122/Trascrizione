import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { NextRequest, NextResponse } from "next/server";
import { FFMPEG_MISSING_MESSAGE, resolveFfmpegPath } from "@/lib/ffmpeg-binary";
import {
  formatBytes,
  getExtension,
  LONG_TRANSCRIBE_FORMATS,
  validateMediaMeta,
} from "@/lib/media-validation";
import { createOpenAIClient, missingApiKeyResponse } from "@/lib/openai-server";
import { createJob, createUploadDir, listJobs, toPublicJob } from "@/lib/transcription-jobs/store";
import { SUPPORTED_LANGUAGES } from "@/lib/transcription-jobs/types";
import { enqueueJob, initJobs } from "@/lib/transcription-jobs/worker";

export const runtime = "nodejs";

class UploadTooLargeError extends Error {}

export async function GET() {
  await initJobs();
  return NextResponse.json({ jobs: listJobs().map(toPublicJob) });
}

/** Receives the raw file as the request body and streams it to disk without buffering it. */
export async function POST(request: NextRequest) {
  await initJobs();

  if (!createOpenAIClient()) return missingApiKeyResponse();
  if (!resolveFfmpegPath("[transcriptions]")) {
    return NextResponse.json({ error: FFMPEG_MISSING_MESSAGE }, { status: 500 });
  }

  let fileName: string;
  try {
    fileName = decodeURIComponent(request.headers.get("x-file-name") ?? "").trim();
  } catch {
    fileName = "";
  }
  if (!fileName) {
    return NextResponse.json({ error: 'Intestazione "x-file-name" mancante.' }, { status: 400 });
  }

  const declaredSize = Number(request.headers.get("content-length"));
  if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
    return NextResponse.json({ error: "Dimensione del file mancante o non valida." }, { status: 411 });
  }

  const validationError = validateMediaMeta(
    { name: fileName, type: request.headers.get("content-type") ?? "", size: declaredSize },
    LONG_TRANSCRIBE_FORMATS,
  );
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const language = (request.headers.get("x-language") ?? "").trim();
  if (language && !SUPPORTED_LANGUAGES.has(language)) {
    return NextResponse.json({ error: `Lingua non supportata: ${language}.` }, { status: 400 });
  }

  if (!request.body) {
    return NextResponse.json({ error: "Corpo della richiesta vuoto." }, { status: 400 });
  }

  const { id, dir } = await createUploadDir();
  const sourceExtension = getExtension(fileName);
  let received = 0;
  const sizeGuard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > LONG_TRANSCRIBE_FORMATS.maxBytes) callback(new UploadTooLargeError());
      else callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>),
      sizeGuard,
      createWriteStream(path.join(dir, `source${sourceExtension}`)),
    );
  } catch (error: unknown) {
    await rm(dir, { recursive: true, force: true });
    if (error instanceof UploadTooLargeError) {
      return NextResponse.json(
        { error: `Il file supera ${formatBytes(LONG_TRANSCRIBE_FORMATS.maxBytes)}.` },
        { status: 413 },
      );
    }
    console.error(`[transcriptions] caricamento interrotto: ${String(error)}`);
    return NextResponse.json({ error: "Caricamento interrotto." }, { status: 400 });
  }

  if (received === 0) {
    await rm(dir, { recursive: true, force: true });
    return NextResponse.json({ error: "Il file è vuoto." }, { status: 400 });
  }

  const job = await createJob({
    id,
    fileName,
    size: received,
    language: language || null,
    sourceExtension,
    labelSpeakers: request.headers.get("x-label-speakers") === "1",
  });
  console.log(`[transcriptions] ricevuto "${fileName}" (${formatBytes(received)}), lavoro ${id}`);
  enqueueJob(id);

  return NextResponse.json({ job: toPublicJob(job) }, { status: 201 });
}
