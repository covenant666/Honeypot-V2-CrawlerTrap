// ============================================================
// HoneyPot v2 — Cloudflare Worker Example
// ============================================================

import { initHoneypot, processRequest } from "honeypot-v2";

// NOTE: Cloudflare Workers don't support Node.js streams natively.
// The tarpit feature will fall back to 403 in CF Workers.
// For full tarpit support, use a Node.js or Deno runtime.

interface Env {
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Initialize once (lazy — CF Workers cache modules)
    initHoneypot({
      realAppRegex: /^\/(home|about|api\/health|login|register)\/?/,
      redisUrl: env.UPSTASH_REDIS_REST_URL,
      redisToken: env.UPSTASH_REDIS_REST_TOKEN,
    });

    // Skip static assets
    if (pathname.startsWith("/_next") || pathname.startsWith("/favicon.ico")) {
      return fetch(request);
    }

    const ip =
      request.headers.get("cf-connecting-ip") ??
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "127.0.0.1";

    const cfBotScore = parseInt(
      request.headers.get("cf-bot-score") ?? "50"
    ) || 50;

    const hasProof = (() => {
      const cookies = request.headers.get("cookie") ?? "";
      return cookies.includes("_hpv=");
    })();

    const isTrap = pathname.includes("/.env") ||
      pathname.startsWith("/wp-") ||
      pathname.includes("/admin/");

    const result = await processRequest(
      { pathname, ip, cfBotScore, hasProofCookie: hasProof },
      isTrap,
    );

    if (!result.pass && result.response) {
      return result.response;
    }

    // Pass through to your application
    return fetch(request);
  },
};
