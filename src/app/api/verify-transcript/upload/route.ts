import { writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { formatBytes, VERIFY_FORMATS } from "@/lib/media-validation";
import { receiveRawUpload, UploadError } from "@/lib/raw-upload";
import { createStorageDir, removeStorageDir, sweepOldStorage } from "@/lib/temp-storage";

export const runtime = "nodejs";

/**
 * Stores the audio to verify. The Whisper transcript is cached next to it, so verifying an
 * edited text against the same audio does not transcribe it again.
 */
export async function POST(request: NextRequest) {
  void sweepOldStorage("verify");
  const { id, dir } = await createStorageDir("verify");
  try {
    const upload = await receiveRawUpload(request, VERIFY_FORMATS, dir);
    await writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify({ fileName: upload.fileName, extension: upload.extension }),
      "utf8",
    );
    console.log(`[verify-transcript] ricevuto "${upload.fileName}" (${formatBytes(upload.size)})`);
    return NextResponse.json({ uploadId: id }, { status: 201 });
  } catch (error: unknown) {
    await removeStorageDir("verify", id);
    if (error instanceof UploadError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
