import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { baseNameOf } from "@/lib/download";
import { getJob, transcriptPath } from "@/lib/transcription-jobs/store";
import { initJobs } from "@/lib/transcription-jobs/worker";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/transcriptions/[id]/transcript">,
) {
  await initJobs();
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) {
    return NextResponse.json({ error: "Trascrizione non trovata." }, { status: 404 });
  }
  if (job.status !== "done") {
    return NextResponse.json({ error: "La trascrizione non è ancora pronta." }, { status: 409 });
  }

  const text = await readFile(transcriptPath(id), "utf8");
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
  if (request.nextUrl.searchParams.get("download") === "1") {
    const fileName = `${baseNameOf(job.fileName, "trascrizione")}-trascrizione.txt`;
    headers.set(
      "Content-Disposition",
      `attachment; filename="trascrizione.txt"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
  }
  return new Response(text, { headers });
}
