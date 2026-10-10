import { NextRequest, NextResponse } from "next/server";
import { deleteJob, getJob } from "@/lib/transcription-jobs/store";
import { cancelJob, initJobs } from "@/lib/transcription-jobs/worker";

export const runtime = "nodejs";

export async function DELETE(_request: NextRequest, ctx: RouteContext<"/api/transcriptions/[id]">) {
  await initJobs();
  const { id } = await ctx.params;
  if (!getJob(id)) {
    return NextResponse.json({ error: "Trascrizione non trovata." }, { status: 404 });
  }
  cancelJob(id);
  await deleteJob(id);
  return NextResponse.json({ deleted: id });
}
