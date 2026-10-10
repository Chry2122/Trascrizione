import type { NextRequest } from "next/server";
import { removeStorageDir } from "@/lib/temp-storage";

export const runtime = "nodejs";

export async function DELETE(
  _request: NextRequest,
  ctx: RouteContext<"/api/verify-transcript/upload/[id]">,
) {
  const { id } = await ctx.params;
  await removeStorageDir("verify", id);
  return new Response(null, { status: 204 });
}
