import { NextRequest, NextResponse } from "next/server";
import { getJob, toPublicJob, updateJob } from "@/lib/transcription-jobs/store";
import { enqueueJob, initJobs } from "@/lib/transcription-jobs/worker";

export const runtime = "nodejs";

export async function POST(
  _request: NextRequest,
  ctx: RouteContext<"/api/transcriptions/[id]/retry">,
) {
  await initJobs();
  const { id } = await ctx.params;
  const job = getJob(id);
  if (!job) {
    return NextResponse.json({ error: "Trascrizione non trovata." }, { status: 404 });
  }
  if (job.status !== "error") {
    return NextResponse.json(
      { error: "Si possono riprovare solo le trascrizioni non riuscite." },
      { status: 409 },
    );
  }

  const updated = await updateJob(id, { status: "queued", error: null });
  enqueueJob(id);
  return NextResponse.json({ job: toPublicJob(updated ?? job) });
}
