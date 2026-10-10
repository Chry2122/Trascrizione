import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { NextRequest } from "next/server";
import {
  formatBytes,
  getExtension,
  validateMediaMeta,
  type MediaFormats,
} from "@/lib/media-validation";

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

class UploadTooLargeError extends Error {}

export type ReceivedUpload = { fileName: string; size: number; extension: string; path: string };

/**
 * Streams the raw request body (the file itself, with its name in `x-file-name`) to
 * `<dir>/source<ext>` without buffering it in memory.
 */
export async function receiveRawUpload(
  request: NextRequest,
  formats: MediaFormats,
  dir: string,
): Promise<ReceivedUpload> {
  let fileName: string;
  try {
    fileName = decodeURIComponent(request.headers.get("x-file-name") ?? "").trim();
  } catch {
    fileName = "";
  }
  if (!fileName) throw new UploadError('Intestazione "x-file-name" mancante.', 400);

  const declaredSize = Number(request.headers.get("content-length"));
  if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
    throw new UploadError("Dimensione del file mancante o non valida.", 411);
  }

  const validationError = validateMediaMeta(
    { name: fileName, type: request.headers.get("content-type") ?? "", size: declaredSize },
    formats,
  );
  if (validationError) throw new UploadError(validationError, 400);
  if (!request.body) throw new UploadError("Corpo della richiesta vuoto.", 400);

  const extension = getExtension(fileName);
  const target = path.join(dir, `source${extension}`);
  let received = 0;
  const sizeGuard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > formats.maxBytes) callback(new UploadTooLargeError());
      else callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>),
      sizeGuard,
      createWriteStream(target),
    );
  } catch (error: unknown) {
    await rm(target, { force: true });
    if (error instanceof UploadTooLargeError) {
      throw new UploadError(`Il file supera ${formatBytes(formats.maxBytes)}.`, 413);
    }
    throw new UploadError("Caricamento interrotto.", 400);
  }

  if (received === 0) {
    await rm(target, { force: true });
    throw new UploadError("Il file è vuoto.", 400);
  }
  return { fileName, size: received, extension, path: target };
}
