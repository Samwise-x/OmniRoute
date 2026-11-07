/**
 * GET /api/conductor/stream — live Conductor task events (Server-Sent Events).
 *
 * Server-side proxy for the Hub's `/v1/events`: the Hub token stays in server env, and
 * the browser gets the Hub's own frames (`id:`/`event:`/`data:`), so a reconnect can
 * resume from `Last-Event-ID` without missing a transition. Degrades to a single
 * `error` frame plus close when the Hub is unset or unreachable — never a hung socket.
 */

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { conductorEventStream } from "@/lib/conductor/hubProxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const body = conductorEventStream(request);
  if (!body) {
    return new Response(
      `event: error\ndata: ${JSON.stringify({ error: "conductor hub is not configured" })}\n\n`,
      {
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      }
    );
  }
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
