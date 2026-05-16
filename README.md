# HoneyPot v2

> **Behavioral honeypot & graduated response system for web applications.**
>
> Watches what bots do, scores their behavior, and responds proportionally — from silent observation to active tarpitting. Zero dependencies in memory mode. MIT licensed.

```
                     ┌──────────────────────────────────┐
 User → Cloudflare →  │         HONEYPOT MIDDLEWARE        │ → Your App
                      │                                    │
                      │  1. recordRequest()  → Redis/Map  │
                      │  2. scoreIP()         → 0..100    │
                      │  3. graduated response            │
                      │                                    │
                      │   0–19   → PASS (let through)     │
                      │  20–39  → CHALLENGE (prove JS)    │
                      │  40–69  → DEGRADE (404 Not Found) │
                      │  70–89  → BLOCK (403 Forbidden)   │
                      │  90–100 → TARPIT (waste 30s)      │
                      └──────────────────────────────────┘
                                │
                          Upstash Redis
                          (optional)
```

---

## Table of Contents

- [Why HoneyPot v2?](#why-honeypot-v2)
- [How It Works](#how-it-works)
- [Features](#features)
- [Installation](#installation)
- [Quick Start (Next.js)](#quick-start-nextjs)
- [Architecture](#architecture)
  - [6 Behavioral Signals](#6-behavioral-signals)
  - [Graduated Response](#graduated-response)
  - [JavaScript Challenge](#javascript-challenge)
  - [Bait Injection](#bait-injection)
  - [Tarpit](#tarpit)
  - [Backend Modes](#backend-modes)
  - [Redis Data Structure](#redis-data-structure)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Framework Examples](#framework-examples)
- [Production Deployment](#production-deployment)
- [Security Model](#security-model)
- [FAQ](#faq)
- [vs Rate Limiters](#vs-rate-limiters)
- [License](#license)

---

## Why HoneyPot v2?

Rate limiters say "you're asking too fast." They're blunt, predictable, and bots easily work around them by slowing down.

**HoneyPot v2 watches behavior, not just speed.**

- A scanner hitting `/.env`, `/wp-admin`, `/phpmyadmin`, and `/graphql`? That's not speed — that's **intent**. Score: +25.
- A bot following invisible bait links hidden in your HTML? Real users never see them. Score: +40.
- 50 requests per second from the same IP? That's a **burst attack**. Score: +15.

Each signal accumulates. Reach 20 points → JavaScript challenge (prove you have a real browser). Reach 70 → blocked. Reach 90 → tarpitted for 30 seconds of wasted connection time.

The system **never blocks real users** — your actual app routes (`/home`, `/dashboard`, `/login`) are matched by a regex and always pass through. Only mystery paths get scored.

---

## How It Works

A full walkthrough of what happens when a request arrives:

```
REQUEST ARRIVES
      │
      ▼
┌─────────────────┐
│ REAL APP PATH?   │── YES ──→ PASS (let through, no scoring)
│ (regex match)    │
└────────┬────────┘
         │ NO
         ▼
┌─────────────────┐
│ RECORD REQUEST   │  Writes to Redis/Map:
│                  │  • Increment totalRequests
│                  │  • Add path to unique paths set
│                  │  • Push timestamp to times list
│                  │  • Check if path matches vuln patterns
│                  │  • Check if trap path
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ SCORE IP         │  Reads Redis/Map data, computes:
│                  │
│ Signal 1: CF bot score (0-30 pts)
│   avg < 10  → +30  │  very likely bot
│   avg < 30  → +20  │  probably bot
│   avg < 50  → +10  │  possibly bot
│
│ Signal 2: Request velocity (0-20 pts)
│   min interval < 50ms  → +15  │  burst
│   min interval < 200ms → +8   │  rapid
│   avg interval < 500ms → +10  │  high velocity
│   > 5 bursts in 50    → +5   │  burst pattern
│
│ Signal 3: Path entropy (0-20 pts)
│   unique/total > 0.8  → +15  │  scanner behavior
│
│ Signal 4: Vuln scanning (0-25 pts)
│   suspiciousPaths > 0 → +8 per hit (max +25)
│
│ Signal 5: Trap hits (0-40 pts)
│   trapHits > 0        → +20 per hit (max +40)
│
│ Signal 6: Current vuln (0-15 pts)
│   current path is vuln → +15
│
│ Total: clamp to 0-100
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────┐
│ GRADUATED RESPONSE              │
│                                 │
│ 0-19   PASS                    │  Request goes through
│ 20-39  CHALLENGE               │  If no _hpv cookie:
│        → JS page (100k hash)   │    "Prove you have JS"
│        → Set _hpv cookie       │
│        → Reload after 800ms    │
│        → If cookie exists: PASS │
│ 40-69  DEGRADE                 │  404 Not Found
│ 70-89  BLOCK                   │  403 Forbidden
│ 90-100 TARPIT                  │  60 chunks, 300-800ms each
│        → ~30s slow stream      │  Wastes attacker resources
│        → Max 50 concurrent     │  Prevents self-DoS
└─────────────────────────────────┘
```

---

## Features

- **6 behavioral signals** — Cloudflare bot score, request velocity/burst, path entropy, vulnerability scanning, trap hits, current vuln path
- **Graduated response** — pass → JS challenge → degrade (404) → block (403) → tarpit (slow stream)
- **Dynamic bait injection** — invisible trap links that only bots follow
- **JavaScript challenge** — forces real browsers to prove they can execute JS (100k-iteration hash + cookie)
- **Bounded tarpit** — slow-stream response wastes attacker resources (capped at 50 concurrent to prevent self-DoS)
- **Fail-open architecture** — Redis down? All requests pass through. Your app never breaks.
- **Dual backend** — Zero-dependency in-memory `Map` for dev/single-instance, Upstash Redis for production multi-instance
- **Event logging** — Redis streams + optional callback (Slack, Discord, Datadog, custom)
- **Framework agnostic** — core logic is pure TypeScript, works with any runtime
- **MIT licensed** — free for personal and commercial use

---

## Installation

```bash
npm install honeypot-v2
```

No required dependencies. The library ships with a built-in lightweight Redis REST client.

**Optional:** For production Redis persistence using the official SDK:

```bash
npm install @upstash/redis
```

---

## Quick Start (Next.js)

### 1. Create middleware

Create `src/middleware.ts`:

```ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { initHoneypot, processRequest } from "honeypot-v2";

// Initialize once at module load
initHoneypot({
  // Only paths NOT matching this regex are scored
  realAppRegex: /^\/(home|about|blog|api\/health)\/?/,
  // For production: add Upstash Redis env vars
  // redisUrl: process.env.UPSTASH_REDIS_REST_URL,
  // redisToken: process.env.UPSTASH_REDIS_REST_TOKEN,
  onEvent: async (event) => {
    if (event.action === "block" || event.action === "tarpit") {
      console.warn(`🚨 Honeypot ${event.action}: ${event.ip} scored ${event.score}`);
    }
  },
});

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Extract CF headers (available when behind Cloudflare proxy)
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "127.0.0.1";

  const cfBotScore = parseInt(
    request.headers.get("cf-bot-score") ?? "50"
  ) || 50;

  const hasProofCookie = !!request.cookies.get("_hpv")?.value;

  // Detect trap paths (must match your bait paths)
  const isTrap =
    pathname.includes("/.env") ||
    pathname.startsWith("/wp-") ||
    pathname.includes("/hidden/");

  const result = await processRequest(
    { pathname, ip, cfBotScore, hasProofCookie },
    isTrap,
  );

  if (!result.pass && result.response) {
    return result.response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
```

### 2. Inject bait into layout

In `app/layout.tsx`:

```tsx
import { getBaitScript } from "honeypot-v2/bait";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: getBaitScript({
              paths: [
                "/hidden/admin-login",
                "/api/v2/internal-users",
                "/portal/settings/database",
              ],
            }).replace(/<script>|<\/script>/g, "")
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

### 3. Test

```bash
# Should PASS (real app route):
curl http://localhost:3000/home

# Should get CHALLENGED or BLOCKED:
curl http://localhost:3000/.env
curl http://localhost:3000/wp-admin
curl http://localhost:3000/hidden/admin-login  # bait path!

# Without Cloudflare proxy, cf-bot-score defaults to 50 (neutral)
# Add Cloudflare in production for real bot-score signal
```

---

## Architecture

### 6 Behavioral Signals

Each signal contributes points to a cumulative 0–100 behavioral score:

| # | Signal | Max | Threshold | What triggers it |
|---|--------|-----|-----------|-----------------|
| 1 | **CF Bot Score** | 30 | avg < 10 | Cloudflare's ML model scores 0 (definitely bot) to 99 (definitely human) |
| | | 20 | avg < 30 | Lower bound — probably automated |
| | | 10 | avg < 50 | Medium confidence of automation |
| 2 | **Request Velocity** | 15 | interval < 50ms | Machine-gun request bursts |
| | | 8 | interval < 200ms | Very rapid requests |
| | | 10 | avg < 500ms + >10 reqs | Sustained high rate |
| | | 5 | >5 bursts | Repeated burst pattern |
| 3 | **Path Entropy** | 15 | unique/total > 0.8 | Scanner scanning every route it can find |
| 4 | **Vuln Scanning** | 25 | ≥1 hit | Hits on known vulnerability paths (+8 per hit, max +25) |
| 5 | **Trap Hits** | 40 | ≥1 hit | Clicked invisible bait link (+20 per hit, max +40) |
| 6 | **Current Vuln** | 15 | matches pattern | The current request itself targets a vuln path |

**Key design principle:** Scores accumulate. A bot that both bursts requests AND hits vuln paths AND follows trap links scores 15+20+25+40+15 = 100 (instant tarpit). A cautious scanner that only probes a few vuln paths slowly might only score 25 — it gets a 404, not immediately blocked.

### Vulnerability Paths Detected (default)

```
/.env           /.git          /wp-admin      /wp-login
/phpmyadmin     /xmlrpc.php    /actuator      /server-status
/debug          /graphql       /package.json  /tsconfig.json
/vercel.json    /next.config   /.htaccess     /admin
```

Customize with the `vulnPaths` config option.

### Graduated Response

| Score | Action | What happens | Why this response |
|-------|--------|-------------|-------------------|
| **0–19** | `pass` | Request goes through normally | Low risk — probably just a curious visitor or search engine |
| **20–39** | `challenge` | JS challenge page: computes 100k-iteration hash, sets `_hpv` cookie, reloads after 800ms | Filters out bots that can't execute JavaScript or manage cookies |
| **40–69** | `degrade` | Returns `404 Not Found` | Hides real routes from scanners. They get a 404 and move on, never knowing what's actually there |
| **70–89** | `block` | Returns `403 Forbidden` | High confidence this is a bad actor. Immediate block — no more information given |
| **90–100** | `tarpit` | Slow-stream: 60 chunks at 300–800ms intervals (~30s total) | Extreme confidence. Waste their resources — keep connections open, consume their thread pool |

### JavaScript Challenge

When an IP scores 20–39 and has no `_hpv` cookie:

```html
<!-- Served as HTML response -->
<script>
  var t = Date.now(), h = 0;
  for (var i = 0; i < 100000; i++) h = (h * 31 + i) >>> 0;
  var token = btoa(t + ':' + h);
  document.cookie = '_hpv=' + token + ';path=/;max-age=86400;SameSite=Lax;Secure';
  setTimeout(function() { location.reload(); }, 800);
</script>
```

Three things happen:
1. **100k-iteration hash** — computationally cheap for browsers (0.1ms), detectable cost for headless scrapers
2. **Cookie set** — `_hpv` cookie proves JavaScript execution occurred
3. **Auto-reload** — 800ms later, the page reloads. This time, middleware sees `_hpv` cookie → passes challenge

If the IP returns with the cookie: **pass** (score is remembered but action downgraded). If they keep hitting without the cookie: score keeps climbing → block → tarpit.

### Bait Injection

The `getBaitScript()` function generates JavaScript for your HTML `<head>`:

1. **On page load (immediate):** Sets a proof-of-JS cookie (`_hpv`). Real browsers execute JS → cookie exists. Bot that doesn't execute JS → no cookie → higher score.

2. **After 3 seconds (delayed):** Dynamically creates invisible `<a>` links:
   ```html
   <nav aria-hidden="true" style="position:absolute;width:1px;height:1px;
        overflow:hidden;clip-path:inset(50%);z-index:-9999">
     <a href="/hidden/admin-login" tabindex="-1" rel="nofollow">admin-login</a>
     <a href="/api/v2/internal-users" tabindex="-1" rel="nofollow">internal-users</a>
     <a href="/portal/settings/database" tabindex="-1" rel="nofollow">database</a>
   </nav>
   ```

3. **Who gets caught:** Bots that blindly follow every link on the page (common crawler behavior). Each trap hit adds +20 to the behavioral score. Two trap hits = +40 = very likely blocked or tarpitted.

4. **Who is safe:** Real users — they can't see, can't click, can't interact with these links. Screen readers ignore them (`aria-hidden`). Search engines respect `nofollow`.

### Tarpit

The most aggressive response — wasted connection time:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxChunks` | 60 | Number of whitespace chunks to send |
| `minDelay` | 300ms | Minimum delay between chunks |
| `maxDelay` | 800ms | Maximum delay between chunks |
| **Total time** | **~18-48s** | Total connection held open |
| **Concurrent cap** | 50 | Global limit to prevent self-DoS |

Each chunk is a single space character (`0x20`). The attacker's connection stays open, consuming their socket/thread pool. When 50 tarpits are active, new offenders get a 403 instead (graceful degradation).

The tarpit respects `Connection: keep-alive` and `Transfer-Encoding: chunked` — the attacker's HTTP client waits for the stream to end. If they disconnect, the cleanup fires immediately.

### Backend Modes

| Mode | Storage | Dependencies | Cold Start | Multi-Instance |
|------|---------|-------------|-----------|----------------|
| **Memory** | In-process `Map<string, MemEntry>` | Zero | Fresh state | ❌ Not shared |
| **Redis** | Upstash Redis REST API | Built-in REST client (or `@upstash/redis`) | Redis persists | ✅ Shared state |

The library auto-detects mode: if `redisUrl` + `redisToken` are configured → Redis mode. Otherwise → Memory mode.

### Redis Data Structure

When using Redis mode, the following keys are created per IP:

| Key | Type | TTL | Content |
|-----|------|-----|---------|
| `hp:{ip}` | Hash | 24h | `totalRequests`, `suspiciousPaths`, `trapHits`, `firstSeen`, `lastSeen` |
| `hp:{ip}:paths` | Set | 24h | Unique paths visited by this IP |
| `hp:{ip}:times` | List | 24h | Last 50 request timestamps (newest first) |
| `hp:{ip}:cfscores` | List | 24h | Last 20 Cloudflare bot scores |
| `hp:events` | Stream | 10k max | Audit log of all actions (challenge, block, tarpit) |
| `hp:tarpit:active` | Counter | — | Number of currently active tarpits (0–50) |

---

## Configuration

```ts
import { initHoneypot } from "honeypot-v2";

initHoneypot({
  /**
   * REQUIRED — Regex matching YOUR application routes.
   * Paths matching this ALWAYS pass through, never scored or blocked.
   * Example: all routes under /app/, /api/health, /login
   */
  realAppRegex: /^\/(app|api\/health|login|register)\/?/,

  /**
   * OPTIONAL — Upstash Redis REST endpoint.
   * Omit for zero-dependency memory mode.
   * Get your credentials at https://console.upstash.com
   */
  redisUrl: process.env.UPSTASH_REDIS_REST_URL,
  redisToken: process.env.UPSTASH_REDIS_REST_TOKEN,

  /**
   * OPTIONAL — Custom vulnerability path patterns.
   * Default includes: /.env, /.git, /wp-*, /admin, /phpmyadmin,
   *   /xmlrpc, /actuator, /server-status, /debug, /graphql,
   *   /package.json, /tsconfig*, /vercel.json, /next.config,
   *   /.htaccess
   */
  vulnPaths: [/^\/\.env/i, /^\/wp-/i, /^\/secret\//i],

  /**
   * OPTIONAL — TTL for IP behavioral data in seconds.
   * After this time, data expires and scoring resets.
   * Default: 86400 (24 hours)
   */
  ipTtl: 86400,

  /**
   * OPTIONAL — Maximum concurrent tarpit connections.
   * Prevents attackers from exhausting YOUR resources.
   * When cap is reached, additional offenders get a 403.
   * Default: 50
   */
  maxTarpits: 50,

  /**
   * OPTIONAL — Enable event logging to Redis stream (hp:events).
   * Disable if you don't need the audit trail.
   * Default: true
   */
  enableLogging: true,

  /**
   * OPTIONAL — Callback invoked on block/tarpit events.
   * Use for Slack alerts, Discord webhooks, Datadog metrics, etc.
   */
  onEvent: async (event) => {
    console.warn(
      `[Honeypot] ${event.action.toUpperCase()} | ` +
      `IP: ${event.ip} | Path: ${event.path} | Score: ${event.score}/100`
    );

    // Slack notification example:
    // if (event.action === "block" || event.action === "tarpit") {
    //   await fetch(process.env.SLACK_WEBHOOK_URL!, {
    //     method: "POST",
    //     headers: { "Content-Type": "application/json" },
    //     body: JSON.stringify({
    //       text: `🚨 Honeypot ${event.action}: ${event.ip} → ${event.path} (score: ${event.score}/100)\nSignals: ${event.signals.join(", ")}`
    //     }),
    //   });
    // }
  },
});
```

---

## API Reference

### Core

| Function | Description |
|----------|-------------|
| `initHoneypot(config)` | Initialize with configuration. Call once at startup. |
| `processRequest(req, isTrap)` → `Promise<HoneypotResult>` | Process a single request through graduated response. |

```ts
interface HoneypotRequest {
  pathname: string;       // Request path, e.g. "/wp-admin"
  ip: string;             // Client IP, e.g. "1.2.3.4"
  cfBotScore: number;     // Cloudflare bot score (0-99, default 50 if no CF)
  hasProofCookie: boolean; // Does the _hpv cookie exist on this request?
}

interface HoneypotResult {
  pass: boolean;           // true → let through, false → send response
  response?: Response;      // JS challenge HTML, 403, 404, or tarpit stream
  scoring?: ScoringResult;  // Full scoring breakdown (available even on pass)
}
```

### Bait Injection

| Function | Description |
|----------|-------------|
| `getBaitScript(opts?)` → `string` | Returns `<script>...</script>` HTML string for injection into `<head>` |

```ts
getBaitScript({
  paths: ["/hidden/admin", "/api/internal/users"],
  cookieName: "_hpv",      // Proof-of-JS cookie name (default)
  injectDelay: 3000,        // ms before injecting bait links (default: 3000)
  cookieExpiryDays: 1,      // Proof cookie lifetime in days (default: 1)
});
```

### Low-Level (direct access)

| Function | Description |
|----------|-------------|
| `recordRequest(ip, path, cfBotScore, isTrapHit)` | Write request data to Redis/Map |
| `scoreIP(ip, currentPath, cfBotScore)` → `ScoringResult` | Score an IP, return action + signals |
| `canTarpit()` → `boolean` | Check if tarpit capacity is available |
| `tarpitStart()` / `tarpitEnd()` | Manage tarpit counter |
| `logEvent(action, ip, path, score, signals)` | Write to event stream + callback |

### Tarpit

| Function | Description |
|----------|-------------|
| `createTarpitResponse(opts?)` → `Promise<Response \| null>` | Create bounded tarpit stream |

```ts
createTarpitResponse({
  maxChunks: 60,     // default
  minDelay: 300,      // default (ms)
  maxDelay: 800,      // default (ms)
});
```

---

## Framework Examples

| Framework | File | Notes |
|-----------|------|-------|
| **Next.js App Router** | `examples/nextjs-middleware.ts` | Edge middleware, cookie reading, CF headers |
| **Express** | `examples/express-middleware.ts` | Classic middleware, `req.ip`, `req.cookies` |
| **Cloudflare Workers** | `examples/cloudflare-worker.ts` | Service worker format, env binding pro Redis |
| **Bait Injection** | `examples/bait-injection.ts` | Next.js layout, Express middleware, static HTML |

---

## Production Deployment

### 1. Put Cloudflare in front

The bot-score signal requires Cloudflare's proxy. Without it, `cfBotScore` defaults to 50 (neutral).

```dns
; Point your domain to Cloudflare
yourdomain.com  A  192.0.2.1  proxied: true
www              CNAME  yourdomain.com  proxied: true
```

### 2. Set up Upstash Redis (recommended for production)

```bash
# Vercel
vercel env add UPSTASH_REDIS_REST_URL
vercel env add UPSTASH_REDIS_REST_TOKEN

# Or in .env.local
UPSTASH_REDIS_REST_URL=https://your-instance.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token
```

### 3. Add CSP headers

The JS challenge page and bait script require inline script execution:

```
Content-Security-Policy: script-src 'self' 'unsafe-inline'
```

If your app already uses a strict CSP, add a nonce or hash for the challenge/bait scripts.

### 4. Verify it works

```bash
# Should pass (real route):
curl -v https://yourdomain.com/app/dashboard

# Should be challenged/blocked:
curl -v https://yourdomain.com/.env
curl -v https://yourdomain.com/wp-admin

# Check with Cloudflare headers (simulate bot):
curl -v -H "cf-bot-score: 5" https://yourdomain.com/wp-login.php
```

### 5. Monitor

Watch the `onEvent` callback output. In production, route it to Slack, Discord, or your monitoring stack. High block/tarpit counts from a single IP indicate active attacks.

---

## Security Model

### What this protects against

| Threat | How |
|--------|-----|
| **Vulnerability scanners** | Paths like `/.env`, `/wp-admin`, `/phpmyadmin` get scored + blocked |
| **Scrapers / crawlers** | Bait links + path entropy signal catch systematic crawling |
| **Burst attacks** | Request velocity signal detects sub-50ms bursts |
| **Credential stuffing** | Rapid requests to `/login` patterns trigger velocity + entropy |
| **Dumb bots** | No JS execution → no `_hpv` cookie → challenged and blocked |
| **Smart bots** | Even with JS, hitting vuln paths + traps accumulates score over time |

### What this does NOT protect against

| Limitation | Mitigation |
|-----------|------------|
| **Sophisticated targeted attacks** | This is a behavioral layer. Combine with WAF, auth, and input validation. |
| **Application-level exploits** | XSS, SQL injection, CSRF — this is NOT a WAF. Sanitize inputs separately. |
| **DDoS at network layer** | Cloudflare handles L3/L4 DDoS. This handles L7 behavioral anomalies. |
| **Insider threats** | If an attacker knows your real app routes, they can bypass scoring entirely. |

### Design philosophy

> **Fail open, never break the app.**

- Redis down? → All requests pass through.
- Error in scoring? → Caught, request passes through.
- Tarpit cap reached? → Falls back to 403.
- Unknown path? → Scored, not blocked by default.

The worst case is always: the honeypot does nothing, and your app works normally. The best case: bots get progressively punished while real users never notice.

---

## FAQ

**Q: Does this work without Cloudflare?**
A: Yes. Without CF, `cfBotScore` defaults to 50 (neutral). Signals 2–6 still work — you lose only the bot-score signal (0–30 points). For production, Cloudflare is strongly recommended for the ML-based bot detection signal.

**Q: What's the performance impact?**
A: In memory mode: ~0.1ms per request (single `Map` lookup). In Redis mode: ~5–20ms (network roundtrip to Upstash). Pipelines are used to batch Redis commands. Real app routes are checked with a regex and skip all scoring — effectively zero overhead.

**Q: Will this block Googlebot or legitimate crawlers?**
A: No, provided you add their paths to `realAppRegex` or your `robots.txt`. Legitimate crawlers won't hit `/.env` or your bait paths. They also typically have high CF bot scores (95+).

**Q: Can I use this in a serverless environment (Vercel, Netlify)?**
A: Yes. Memory mode works in single-instance environments. For multi-instance (Vercel with traffic), use Redis mode so all instances share the same IP reputation data. The built-in REST client uses `fetch()` which works in Edge runtimes.

**Q: How do I add custom vulnerability path patterns?**
A: Pass them to `vulnPaths` in `initHoneypot()`: `vulnPaths: [/^\/\.secret/i, /^\/backup/i]`.

**Q: Can I override the scoring thresholds?**
A: Not directly — the graduated response thresholds (20/40/70/90) are fixed. You can modify `src/scoring.ts` and rebuild if you need different thresholds. This is kept simple intentionally — the 6-signal model covers most use cases.

**Q: What happens to the bait script on slow connections?**
A: The bait injection runs after 3 seconds via `setTimeout`. If the page hasn't loaded by then, the bait is inserted whenever `document.body` becomes available. The proof cookie is set immediately on script execution — it doesn't wait for the bait delay.

---

## vs Rate Limiters

| Feature | Express Rate Limit | Vercel KV Rate Limit | **HoneyPot v2** |
|---------|-------------------|---------------------|-----------------|
| **Detection** | Request count per window | Request count per window | **6 behavioral signals** |
| **Response** | 429 Too Many Requests | 429 Too Many Requests | **Challenge → 404 → 403 → Tarpit** |
| **Adaptive** | No — fixed threshold | No — fixed threshold | **Yes — score accumulates** |
| **Bait traps** | No | No | **Yes — invisible links** |
| **JS challenge** | No | No | **Yes — proves real browser** |
| **Tarpit** | No | No | **Yes — wastes attacker time** |
| **Vuln scanning detection** | No | No | **Yes — detects pattern** |
| **Cloudflare integration** | Manual | Manual | **Built-in CF bot-score signal** |
| **Zero deps (memory mode)** | Varies | No (needs KV SDK) | **Yes** |
| **Redis required** | Optional | Required | **Optional** |

---

## License

MIT — free for personal and commercial use. Attribution appreciated but not required.

---

*Built by [Lukáš Pištěk](https://github.com/covenant666)*
