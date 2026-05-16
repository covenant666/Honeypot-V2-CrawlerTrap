// ============================================================
// HoneyPot v2 — Next.js Middleware Example
// App Router (Next.js 13+)
// Place in: src/middleware.ts or app/middleware.ts
// ============================================================

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { initHoneypot, processRequest } from "honeypot-v2";

// Call ONCE at module init
initHoneypot({
  // REQUIRED: regex for your real application paths
  // These paths ALWAYS pass through — never challenged/blocked/tarpitted
  realAppRegex: /^\/(home|about|blog|dashboard|api\/health|login|register)\/?/,

  // OPTIONAL: Upstash Redis (leave blank for zero-dependency in-memory mode)
  // redisUrl: process.env.UPSTASH_REDIS_REST_URL,
  // redisToken: process.env.UPSTASH_REDIS_REST_TOKEN,

  // OPTIONAL: Custom vulnerability path patterns
  // vulnPaths: [/^\/\.env/i, /^\/wp-/i, /^\/\.git/i],

  // OPTIONAL: TTL for IP data in seconds (default: 86400 = 24h)
  // ipTtl: 3600,

  // OPTIONAL: Max concurrent tarpits (default: 50)
  // maxTarpits: 30,

  // OPTIONAL: External logging callback (Slack, Discord, Datadog...)
  onEvent: async (event) => {
    console.warn(
      `[Honeypot] ${event.action.toUpperCase()} | ` +
      `IP: ${event.ip} | Path: ${event.path} | Score: ${event.score}/100`
    );
    // Slack example:
    // await fetch(process.env.SLACK_WEBHOOK!, {
    //   method: "POST",
    //   body: JSON.stringify({ text: `🚨 Honeypot ${event.action}: ${event.ip} → ${event.path}` }),
    // });
  },
});

// Paths to completely skip honeypot processing
const SKIP_PATHS = ["/_next", "/favicon.ico", "/api/health", "/images"];

// Custom trap path detection
// Add patterns for YOUR bait links (from getBaitScript paths)
function isTrapPath(pathname: string): boolean {
  return (
    pathname.includes("/.env") ||
    pathname.includes("/admin/") ||
    pathname.startsWith("/wp-") ||
    pathname.includes("/hidden/")
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip static assets entirely
  if (SKIP_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Extract request metadata
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "127.0.0.1";

  const cfBotScore = parseInt(
    request.headers.get("cf-bot-score") ?? "50"
  ) || 50;

  const hasProofCookie = !!request.cookies.get("_hpv")?.value;

  // Run the honeypot graduated response
  const result = await processRequest(
    { pathname, ip, cfBotScore, hasProofCookie },
    isTrapPath(pathname),
  );

  if (!result.pass && result.response) {
    return result.response;
  }

  return NextResponse.next();
}

export const config = {
  // Match all paths except static assets
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
