import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { CLEAN_OUTPUT_FORMATS, type CleanResult } from "@/lib/clean-audio";
import { baseNameOf } from "@/lib/download";
import { removeStorageDir, storageDir } from "@/lib/temp-storage";

export const runtime = "nodejs";

async function loadResult(id: string): Promise<{ meta: CleanResult; filePath: string } | null> {
  const dir = storageDir("clean", id);
  if (!dir) return null;
  try {
    const meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8")) as CleanResult;
    return { meta, filePath: path.join(dir, `output.${meta.format}`) };
  } catch {
    return null;
  }
}

function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Math.min(Number(match[2]), size);
    return { start: size - suffix, end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end } : null;
}

/** Serves the cleaned audio with Range support, so the player can seek in multi-GB files. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/clean-audio/[id]">) {
  const { id } = await ctx.params;
  const result = await loadResult(id);
  const info = result ? await stat(result.filePath).catch(() => null) : null;
  if (!result || !info) {
    return NextResponse.json({ error: "Audio pulito non trovato o scaduto." }, { status: 404 });
  }

  const mimeType =
    CLEAN_OUTPUT_FORMATS.find((format) => format.value === result.meta.format)?.mimeType ??
    "application/octet-stream";
  const headers = new Headers({
    "Content-Type": mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  });
  if (request.nextUrl.searchParams.get("download") === "1") {
    const fileName = `${baseNameOf(result.meta.fileName, "audio")}-pulito.${result.meta.format}`;
    headers.set(
      "Content-Disposition",
      `attachment; filename="audio-pulito.${result.meta.format}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
  }

  const rangeHeader = request.headers.get("range");
  const range = parseRange(rangeHeader, info.size);
  if (rangeHeader && !range) {
    headers.set("Content-Range", `bytes */${info.size}`);
    return new Response(null, { status: 416, headers });
  }
  const { start, end } = range ?? { start: 0, end: info.size - 1 };
  headers.set("Content-Length", String(end - start + 1));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${info.size}`);

  const body = Readable.toWeb(createReadStream(result.filePath, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, { status: range ? 206 : 200, headers });
}

export async function DELETE(_request: NextRequest, ctx: RouteContext<"/api/clean-audio/[id]">) {
  const { id } = await ctx.params;
  await removeStorageDir("clean", id);
  return new Response(null, { status: 204 });
}
