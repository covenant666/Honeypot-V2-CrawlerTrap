// ============================================================
// HoneyPot v2 — Express Middleware Example
// ============================================================

import type { Request, Response, NextFunction } from "express";
import { initHoneypot, processRequest } from "honeypot-v2";

// Call ONCE at app startup
initHoneypot({
  realAppRegex: /^\/(home|about|api\/health|login|register)\/?/,
  // redisUrl: process.env.UPSTASH_REDIS_REST_URL,
  // redisToken: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function isTrapPath(pathname: string): boolean {
  return (
    pathname.includes("/.env") ||
    pathname.includes("/admin/") ||
    pathname.startsWith("/wp-")
  );
}

export async function honeypotMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const ip =
    (req.headers["cf-connecting-ip"] as string) ??
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.ip ??
    "127.0.0.1";

  const cfBotScore = parseInt(
    (req.headers["cf-bot-score"] as string) ?? "50"
  ) || 50;

  const hasProofCookie = !!req.cookies?._hpv;

  const result = await processRequest(
    { pathname: req.path, ip, cfBotScore, hasProofCookie },
    isTrapPath(req.path),
  );

  if (result.pass) {
    return next();
  }

  // Send the honeypot response (JS challenge, 403, 404, or tarpit)
  if (result.response) {
    res.status(result.response.status);
    // Copy relevant headers
    result.response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "content-encoding") {
        res.setHeader(key, value);
      }
    });
    const body = await result.response.text();
    return res.send(body);
  }

  next();
}
