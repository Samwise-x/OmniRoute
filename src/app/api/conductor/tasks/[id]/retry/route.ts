/**
 * POST /api/conductor/tasks/[id]/retry — re-queues a terminal Conductor task.
 *
 * The hub keeps the task id (so dashboard links and event history survive) and owns
 * the retry cap. A refusal is forwarded as the hub's own sanitized message: the
 * operator needs to know *why* (cap reached, or still running) to act on it.
 */

import { NextResponse } from "next/server";

import { createErrorResponse } from "@/lib/api/errorResponse";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { retryConductorTask } from "@/lib/conductor/hubProxy";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const { id } = await ctx.params;
  const result = await retryConductorTask(id);
  if (!result.ok) {
    return createErrorResponse({
      status: result.status >= 400 && result.status <= 599 ? result.status : 502,
      message: result.error || `Conductor hub refused the retry (HTTP ${result.status})`,
    });
  }
  return NextResponse.json({ ok: true, id, retries: result.retries ?? null });
}
