// ============================================================
// HoneyPot v2 — Bounded Tarpit
// MIT License — see LICENSE
//
// Creates a slow-stream HTTP response that wastes attacker resources.
// Enforces a global cap to prevent DOS via tarpit exhaustion.
// ============================================================

import { canTarpit, tarpitStart, tarpitEnd } from "./scoring";

export interface TarpitOptions {
  /** Maximum number of chunks (default: 60) */
  maxChunks?: number;
  /** Minimum delay between chunks in ms (default: 300) */
  minDelay?: number;
  /** Maximum delay between chunks in ms (default: 800) */
  maxDelay?: number;
  /** TextEncoder instance (pass in to reuse) */
  encoder?: TextEncoder;
}

/**
 * Creates a bounded tarpit response.
 *
 * Sends whitespace chunks at randomized intervals for up to ~30 seconds.
 * Global cap enforced — if too many active tarpits, returns 403 instead.
 *
 * @param opts - Tarpit configuration options
 * @returns Response object, or null if the tarpit cap is exceeded
 */
export async function createTarpitResponse(opts: TarpitOptions = {}): Promise<Response | null> {
  const {
    maxChunks = 60,
    minDelay = 300,
    maxDelay = 800,
    encoder = new TextEncoder(),
  } = opts;

  const allowed = await canTarpit();
  if (!allowed) {
    return new Response("Forbidden", { status: 403 });
  }

  await tarpitStart();

  let chunks = 0;
  let closed = false;

  const stream = new ReadableStream({
    async pull(controller) {
      if (chunks >= maxChunks || closed) {
        if (!closed) {
          closed = true;
          await tarpitEnd().catch(() => {});
        }
        controller.close();
        return;
      }
      const delay = minDelay + Math.floor(Math.random() * (maxDelay - minDelay));
      await new Promise(r => setTimeout(r, delay));
      controller.enqueue(encoder.encode(" "));
      chunks++;
    },
    cancel() {
      if (!closed) {
        closed = true;
        tarpitEnd().catch(() => {});
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store, no-cache",
      "X-Robots-Tag": "noindex, nofollow",
      "Transfer-Encoding": "chunked",
      "Connection": "keep-alive",
    },
  });
}
