// ============================================================
// HoneyPot v2 — Middleware Orchestrator
// MIT License — see LICENSE
//
// Framework-agnostic orchestrator. Call this from your
// middleware (Next.js, Express, Cloudflare Workers, etc.)
// ============================================================

import {
  configure,
  recordRequest,
  scoreIP,
  logEvent,
} from "./scoring";
import { createTarpitResponse } from "./tarpit";
import type { HoneypotConfig, ScoringResult } from "./types";

const JS_CHALLENGE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Checking...</title>
<style>body{background:#0a0e17;color:#e2eaf3;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;opacity:0;animation:fade 0.5s 0.2s forwards}@keyframes fade{to{opacity:1}}
</style></head><body><div class="box"><p>Verifying browser...</p><p style="font-size:12px;opacity:0.5">This page checks that you are human.</p></div>
<script>
(function(){
  var t=Date.now(),h=0;
  for(var i=0;i<1e5;i++)h=(h*31+i)>>>0;
  var tok=btoa(t+':'+h);
  document.cookie='_hpv='+tok+';path=/;max-age=86400;SameSite=Lax;Secure';
  setTimeout(function(){location.reload()},800);
})();
</script></body></html>`;

export interface HoneypotRequest {
  pathname: string;
  ip: string;
  cfBotScore: number;
  hasProofCookie: boolean;
}

export interface HoneypotResult {
  /** true = let request pass, false = handled (response should be sent) */
  pass: boolean;
  /** Response to send if pass is false */
  response?: Response;
  /** Scoring details (available even on pass) */
  scoring?: ScoringResult;
}

let initialized = false;
let _config: HoneypotConfig | null = null;

/**
 * Initialize the honeypot with configuration.
 * Call once at app startup.
 */
export function initHoneypot(cfg: HoneypotConfig): void {
  configure(cfg);
  _config = cfg;
  initialized = true;
}

/**
 * Process a request through the honeypot graduated response system.
 *
 * @param req - The incoming request info
 * @param isTrapPath - Whether this path is a known trap pattern
 * @returns HoneypotResult with pass flag and optional response
 */
export async function processRequest(
  req: HoneypotRequest,
  isTrapPath: boolean,
): Promise<HoneypotResult> {
  if (!initialized || !_config) {
    throw new Error("Honeypot not initialized. Call initHoneypot() first.");
  }

  // Real app paths ALWAYS pass through
  if (_config.realAppRegex.test(req.pathname)) {
    return { pass: true };
  }

  try {
    await recordRequest(req.ip, req.pathname, req.cfBotScore, isTrapPath);
    const scoring = await scoreIP(req.ip, req.pathname, req.cfBotScore);

    // Challenge: serve JS page if no proof cookie
    if (scoring.action === "challenge" && !req.hasProofCookie) {
      await logEvent("challenge", req.ip, req.pathname, scoring.score, scoring.signals);
      return {
        pass: false,
        scoring,
        response: new Response(JS_CHALLENGE_HTML, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        }),
      };
    }

    // Block
    if (scoring.action === "block") {
      await logEvent("block", req.ip, req.pathname, scoring.score, scoring.signals);
      return {
        pass: false,
        scoring,
        response: new Response("Forbidden", { status: 403 }),
      };
    }

    // Tarpit
    if (scoring.action === "tarpit") {
      await logEvent("tarpit", req.ip, req.pathname, scoring.score, scoring.signals);
      const tarpitRes = await createTarpitResponse();
      return {
        pass: false,
        scoring,
        response: tarpitRes ?? new Response("Forbidden", { status: 403 }),
      };
    }

    // Degrade: return 404 for non-real paths
    if (scoring.action === "degrade") {
      return {
        pass: false,
        scoring,
        response: new Response("Not Found", { status: 404 }),
      };
    }

    // Pass: let through
    return { pass: true, scoring };
  } catch {
    // Redis down / error — FAIL OPEN: let request through
    return { pass: true };
  }
}
