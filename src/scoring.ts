// ============================================================
// HoneyPot v2 — Behavioral Scoring Engine
// MIT License — see LICENSE
//
// Dual-backend architecture:
//   REDIS MODE: Uses Upstash Redis (REST API) — persistent, multi-instance
//   MEMORY MODE: In-Memory Map — zero dependencies, single-instance
// ============================================================

import type { BehaviorData, ScoringResult, HoneypotConfig } from "./types";

// ── In-Memory store (fallback when no Redis configured) ────

interface MemEntry {
  totalRequests: number;
  uniquePaths: Set<string>;
  times: number[];
  cfScores: number[];
  suspiciousPaths: number;
  trapHits: number;
  firstSeen: number;
  lastSeen: number;
}

const memoryStore = new Map<string, MemEntry>();

// ── Config ────────────────────────────────────────────────

let config: HoneypotConfig | null = null;

export function configure(cfg: HoneypotConfig): void {
  config = {
    ipTtl: 86400,
    maxTarpits: 50,
    enableLogging: true,
    ...cfg,
  };
}

// ── Redis REST client (lightweight, no Upstash SDK dependency) ──

interface RedisREST {
  pipeline(): Pipeline;
  hget(key: string, field: string): Promise<any>;
  hgetall(key: string): Promise<Record<string, string> | null>;
  scard(key: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  xadd(stream: string, id: string, fields: Record<string, string>): Promise<void>;
  xtrim(stream: string, opts: { strategy: string; threshold: number }): Promise<void>;
  hincrby(key: string, field: string, incr: number): Promise<number>;
  sadd(key: string, member: string): Promise<number>;
  lpush(key: string, value: any): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  hsetnx(key: string, field: string, value: any): Promise<number>;
  hset(key: string, fields: Record<string, string>): Promise<number>;
  expire(key: string, ttl: number): Promise<number>;
  get(key: string): Promise<any>;
  set(key: string, value: any): Promise<void>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  del(key: string): Promise<number>;
}

interface Pipeline {
  hincrby(key: string, field: string, incr: number): Pipeline;
  sadd(key: string, member: string): Pipeline;
  lpush(key: string, value: any): Pipeline;
  ltrim(key: string, start: number, stop: number): Pipeline;
  hsetnx(key: string, field: string, value: any): Pipeline;
  hset(key: string, fields: Record<string, string>): Pipeline;
  expire(key: string, ttl: number): Pipeline;
  hgetall(key: string): Pipeline;
  scard(key: string): Pipeline;
  lrange(key: string, start: number, stop: number): Pipeline;
  exec(): Promise<any[]>;
}

// ── In-Memory "fake redis" implementation ──

class MemPipeline implements Pipeline {
  private commands: Array<() => any> = [];
  private results: any[] = [];

  hincrby(key: string, field: string, incr: number) { this.commands.push(() => { const e = memGet(key); e.totalRequests += incr; return e.totalRequests; }); return this; }
  sadd(key: string, member: string) { this.commands.push(() => { const e = memGet(key); e.uniquePaths.add(member); return 1; }); return this; }
  lpush(key: string, value: any) { this.commands.push(() => { const e = memGet(key); e.times.unshift(Number(value) || Date.now()); if (e.times.length > 50) e.times.length = 50; return e.times.length; }); return this; }
  ltrim() { return this; }
  hsetnx(key: string, field: string, value: any) { this.commands.push(() => { const e = memGet(key); if (!(field in e as any)) { (e as any)[field] = value; return 1; } return 0; }); return this; }
  hset(key: string, fields: Record<string, string>) { this.commands.push(() => { const e = memGet(key); Object.assign(e, fields); return 1; }); return this; }
  expire() { return this; }
  hgetall(key: string) { this.commands.push(() => { const e = memoryStore.get(key); if (!e) return null; return { totalRequests: String(e.totalRequests || 0), suspiciousPaths: String(e.suspiciousPaths || 0), trapHits: String(e.trapHits || 0), firstSeen: String(e.firstSeen || 0), lastSeen: String(e.lastSeen || 0) }; }); return this; }
  scard(key: string) { this.commands.push(() => { const e = memoryStore.get(key); return e?.uniquePaths?.size ?? 0; }); return this; }
  lrange(key: string, start: number, stop: number) { this.commands.push(() => { const e = memoryStore.get(key); return (e?.times ?? []).slice(start, stop + 1).map(String); }); return this; }
  exec() { this.results = this.commands.map(fn => fn()); return Promise.resolve(this.results); }
}

const memRedis: RedisREST = {
  pipeline: () => new MemPipeline(),
  hget: async (k, f) => { const e = memoryStore.get(k); return e ? (e as any)[f] : null; },
  hgetall: async (k) => { const e = memoryStore.get(k); if (!e) return null; return { totalRequests: String(e.totalRequests || 0), suspiciousPaths: String(e.suspiciousPaths || 0), trapHits: String(e.trapHits || 0), firstSeen: String(e.firstSeen || 0), lastSeen: String(e.lastSeen || 0) }; },
  scard: async (k) => memoryStore.get(k)?.uniquePaths?.size ?? 0,
  lrange: async (k, s, e) => (memoryStore.get(k)?.times ?? []).slice(s, e + 1).map(String),
  xadd: async () => {},
  xtrim: async () => {},
  hincrby: async (k, f, i) => { const e = memGet(k); (e as any)[f] = ((e as any)[f] || 0) + i; return (e as any)[f]; },
  sadd: async (k, m) => { memGet(k).uniquePaths.add(m); return 1; },
  lpush: async (k, v) => { const e = memGet(k); e.times.unshift(Number(v) || Date.now()); if (e.times.length > 50) e.times.length = 50; return e.times.length; },
  ltrim: async () => {},
  hsetnx: async (k, f, v) => { const e = memGet(k); if (!((e as any)[f])) { (e as any)[f] = v; return 1; } return 0; },
  hset: async (k, f) => { Object.assign(memGet(k), f); return 1; },
  expire: async () => 1,
  get: async (k) => { const e = memoryStore.get(k); return e ? (e as any).value : null; },
  set: async (k, v) => { let e = memoryStore.get(k); if (!e) e = memGet(k); (e as any).value = v; },
  incr: async (k) => { const e = memGet(k); (e as any).value = ((e as any).value || 0) + 1; return (e as any).value; },
  decr: async (k) => { const e = memGet(k); (e as any).value = ((e as any).value || 0) - 1; if ((e as any).value < 0) (e as any).value = 0; return (e as any).value; },
  del: async (k) => { memoryStore.delete(k); return 1; },
};

function memGet(key: string): MemEntry {
  let e = memoryStore.get(key);
  if (!e) {
    e = { totalRequests: 0, uniquePaths: new Set(), times: [], cfScores: [], suspiciousPaths: 0, trapHits: 0, firstSeen: Date.now(), lastSeen: Date.now() };
    memoryStore.set(key, e);
  }
  return e;
}

// ── Upstash REST client (lightweight, no SDK) ──

class UpstashREST implements RedisREST {
  private url: string;
  private token: string;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
  }

  private async cmd(command: string, args: any[] = []): Promise<any> {
    const body = JSON.stringify([command, ...args.map(a => String(a))]);
    const res = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) throw new Error(`Redis error: ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data) && data.length === 1) return data[0];
    return data;
  }

  async hget(k: string, f: string) { return this.cmd("HGET", [k, f]); }
  async hgetall(k: string) { const r = await this.cmd("HGETALL", [k]); if (!Array.isArray(r)) return null; const o: Record<string, string> = {}; for (let i = 0; i < r.length; i += 2) o[r[i]] = r[i + 1]; return o; }
  async scard(k: string) { return this.cmd("SCARD", [k]); }
  async lrange(k: string, s: number, e: number) { return this.cmd("LRANGE", [k, s, e]); }
  async xadd(s: string, id: string, f: Record<string, string>) { const a: string[] = [s, id]; for (const [k, v] of Object.entries(f)) a.push(k, v); return this.cmd("XADD", a); }
  async xtrim(s: string, o: { strategy: string; threshold: number }) { return this.cmd("XTRIM", [s, o.strategy, "~", o.threshold]); }
  async hincrby(k: string, f: string, i: number) { return this.cmd("HINCRBY", [k, f, i]); }
  async sadd(k: string, m: string) { return this.cmd("SADD", [k, m]); }
  async lpush(k: string, v: any) { return this.cmd("LPUSH", [k, v]); }
  async ltrim(k: string, s: number, e: number) { return this.cmd("LTRIM", [k, s, e]); }
  async hsetnx(k: string, f: string, v: any) { return this.cmd("HSETNX", [k, f, v]); }
  async hset(k: string, f: Record<string, string>) { const a: string[] = [k]; for (const [fk, fv] of Object.entries(f)) a.push(fk, fv); return this.cmd("HSET", a); }
  async expire(k: string, t: number) { return this.cmd("EXPIRE", [k, t]); }
  async get(k: string) { return this.cmd("GET", [k]); }
  async set(k: string, v: any) { return this.cmd("SET", [k, v]); }
  async incr(k: string) { return this.cmd("INCR", [k]); }
  async decr(k: string) { return this.cmd("DECR", [k]); }
  async del(k: string) { return this.cmd("DEL", [k]); }
  pipeline() { return new UpstashPipeline(this.url, this.token); }
}

class UpstashPipeline implements Pipeline {
  private commands: any[][] = [];
  constructor(private url: string, private token: string) {}
  private add(cmd: string, args: any[]) { this.commands.push([cmd, ...args.map(a => String(a))]); return this; }
  hincrby(k: string, f: string, i: number) { return this.add("HINCRBY", [k, f, i]); }
  sadd(k: string, m: string) { return this.add("SADD", [k, m]); }
  lpush(k: string, v: any) { return this.add("LPUSH", [k, v]); }
  ltrim(k: string, s: number, e: number) { return this.add("LTRIM", [k, s, e]); }
  hsetnx(k: string, f: string, v: any) { return this.add("HSETNX", [k, f, v]); }
  hset(k: string, f: Record<string, string>) { const a: string[] = [k]; for (const [fk, fv] of Object.entries(f)) a.push(fk, fv); return this.add("HSET", a); }
  expire(k: string, t: number) { return this.add("EXPIRE", [k, t]); }
  hgetall(k: string) { return this.add("HGETALL", [k]); }
  scard(k: string) { return this.add("SCARD", [k]); }
  lrange(k: string, s: number, e: number) { return this.add("LRANGE", [k, s, e]); }
  async exec() {
    const res = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(this.commands),
    });
    if (!res.ok) throw new Error(`Redis pipeline error: ${res.status}`);
    return res.json();
  }
}

// ── Redis client selection ──

let redis: RedisREST | null = null;

function getRedis(): RedisREST {
  if (redis) return redis;
  if (config?.redisUrl && config?.redisToken) {
    redis = new UpstashREST(config.redisUrl, config.redisToken);
  } else {
    redis = memRedis;
  }
  return redis;
}

// ── Constants ──────────────────────────────────────────────

const KEY_PREFIX = "hp:";
const EVENT_STREAM = "hp:events";
const TARPIT_COUNTER = "hp:tarpit:active";

const DEFAULT_VULN_PATHS: RegExp[] = [
  /^\/\.env/i, /^\/\.git/i, /^\/wp-/i, /^\/admin/i,
  /^\/phpmyadmin/i, /^\/xmlrpc/i, /^\/actuator/i,
  /^\/server-status/i, /^\/debug/i, /^\/graphql$/i,
  /^\/package\.json$/i, /^\/tsconfig/i, /^\/vercel\.json$/i,
  /^\/next\.config/i, /^\/\.htaccess/i,
];

function getVulnPaths(): RegExp[] {
  return config?.vulnPaths ?? DEFAULT_VULN_PATHS;
}

// ── Public API ─────────────────────────────────────────────

/**
 * Record a request for a given IP. Called on every non-real-app request.
 * Pipeline ensures atomic Redis writes.
 */
export async function recordRequest(
  ip: string,
  path: string,
  cfBotScore: number,
  isTrapHit: boolean,
): Promise<void> {
  const now = Date.now();
  const key = `${KEY_PREFIX}${ip}`;
  const ttl = config?.ipTtl ?? 86400;
  const pipe = getRedis().pipeline();

  pipe.hincrby(key, "totalRequests", 1);
  pipe.sadd(`${key}:paths`, path);
  pipe.lpush(`${key}:times`, now);
  pipe.ltrim(`${key}:times`, 0, 49);

  if (getVulnPaths().some(p => p.test(path))) {
    pipe.hincrby(key, "suspiciousPaths", 1);
  }
  if (isTrapHit) {
    pipe.hincrby(key, "trapHits", 1);
  }

  pipe.lpush(`${key}:cfscores`, cfBotScore);
  pipe.ltrim(`${key}:cfscores`, 0, 19);
  pipe.hsetnx(key, "firstSeen", now);
  pipe.hset(key, { lastSeen: String(now) });
  pipe.expire(key, ttl);
  pipe.expire(`${key}:paths`, ttl);
  pipe.expire(`${key}:times`, ttl);
  pipe.expire(`${key}:cfscores`, ttl);

  await pipe.exec();
}

/**
 * Score an IP based on behavioral signals.
 * Returns a score 0–100 and a graduated action.
 */
export async function scoreIP(
  ip: string,
  currentPath: string,
  cfBotScore: number,
): Promise<ScoringResult> {
  const key = `${KEY_PREFIX}${ip}`;
  const signals: ScoringResult["signals"] = [];
  let score = 0;

  const r = getRedis();
  const pipe = r.pipeline();
  pipe.hgetall(key);
  pipe.scard(`${key}:paths`);
  pipe.lrange(`${key}:times`, 0, 49);
  pipe.lrange(`${key}:cfscores`, 0, 19);

  const [rawData, uniquePaths, rawTimes, rawCfScores] = await pipe.exec();
  const data = (rawData ?? {}) as Record<string, string>;
  const pathCount = (uniquePaths ?? 0) as number;
  const times = ((rawTimes ?? []) as string[]).map(Number).filter(n => !isNaN(n));
  const cfScores = ((rawCfScores ?? []) as string[]).map(Number).filter(n => !isNaN(n));

  const totalRequests = parseInt(data.totalRequests ?? "0");
  const suspiciousPaths = parseInt(data.suspiciousPaths ?? "0");
  const trapHits = parseInt(data.trapHits ?? "0");

  const avgCfScore = cfScores.length > 0
    ? cfScores.reduce((a, b) => a + b, 0) / cfScores.length
    : cfBotScore;

  // Signal 1: Cloudflare Bot Score (0–30 points)
  if (avgCfScore < 10) {
    score += 30;
    signals.push({ name: "cf-bot-score", contribution: 30, detail: `very-low:${avgCfScore.toFixed(0)}` });
  } else if (avgCfScore < 30) {
    score += 20;
    signals.push({ name: "cf-bot-score", contribution: 20, detail: `low:${avgCfScore.toFixed(0)}` });
  } else if (avgCfScore < 50) {
    score += 10;
    signals.push({ name: "cf-bot-score", contribution: 10, detail: `medium:${avgCfScore.toFixed(0)}` });
  }

  // Signal 2: Request velocity / burst detection (0–20 points)
  if (times.length >= 3) {
    const intervals: number[] = [];
    for (let i = 0; i < times.length - 1; i++) intervals.push(Math.abs(times[i] - times[i + 1]));
    const minInterval = Math.min(...intervals);
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const burstCount = intervals.filter(i => i < 200).length;

    if (minInterval < 50) {
      score += 15;
      signals.push({ name: "burst-sub-50ms", contribution: 15, detail: `${minInterval}ms` });
    } else if (minInterval < 200) {
      score += 8;
      signals.push({ name: "burst-sub-200ms", contribution: 8, detail: `${minInterval}ms` });
    }
    if (avgInterval < 500 && totalRequests > 10) {
      score += 10;
      signals.push({ name: "high-velocity", contribution: 10, detail: `avg:${avgInterval.toFixed(0)}ms` });
    }
    if (burstCount > 5) {
      score += 5;
      signals.push({ name: "burst-pattern", contribution: 5, detail: `${burstCount} bursts` });
    }
  }

  // Signal 3: Path navigation entropy (0–20 points)
  if (totalRequests > 5) {
    const pathRequestRatio = pathCount / totalRequests;
    if (pathRequestRatio > 0.8 && totalRequests > 10) {
      score += 15;
      signals.push({ name: "high-path-entropy", contribution: 15, detail: `${pathCount} unique / ${totalRequests} total` });
    }
  }

  // Signal 4: Suspicious path history (0–25 points)
  if (suspiciousPaths > 0) {
    const pts = Math.min(suspiciousPaths * 8, 25);
    score += pts;
    signals.push({ name: "vuln-scanning", contribution: pts, detail: `${suspiciousPaths} hits` });
  }

  // Signal 5: Trap hits (0–40 points)
  if (trapHits > 0) {
    const pts = Math.min(trapHits * 20, 40);
    score += pts;
    signals.push({ name: "trap-hit", contribution: pts, detail: `${trapHits} hits` });
  }

  // Signal 6: Current request on a vulnerability path (0–15 points)
  if (getVulnPaths().some(p => p.test(currentPath))) {
    score += 15;
    signals.push({ name: "current-vuln-path", contribution: 15, detail: currentPath });
  }

  score = Math.min(score, 100);

  const action: ScoringResult["action"] =
    score >= 90 ? "tarpit" :
    score >= 70 ? "block" :
    score >= 40 ? "degrade" :
    score >= 20 ? "challenge" : "pass";

  return {
    score, signals, action,
    behaviorData: {
      totalRequests, uniquePaths: pathCount,
      avgDwellMs: times.length >= 2 ? intervalsAvg(times) : 0,
      minDwellMs: times.length >= 2 ? Math.min(...intervalsMake(times)) : 0,
      burstCount: times.length >= 2 ? intervalsMake(times).filter(i => i < 200).length : 0,
      suspiciousPaths, trapHits, cfBotScoreAvg: avgCfScore,
      firstSeen: parseInt(data.firstSeen ?? String(Date.now())),
      lastSeen: Date.now(),
    },
  };
}

function intervalsMake(times: number[]): number[] {
  const r: number[] = [];
  for (let i = 0; i < times.length - 1; i++) r.push(Math.abs(times[i] - times[i + 1]));
  return r;
}
function intervalsAvg(times: number[]): number {
  const ints = intervalsMake(times);
  return ints.length ? ints.reduce((a, b) => a + b, 0) / ints.length : 0;
}

// ── Tarpit management ────────────────────────────────────

export async function canTarpit(): Promise<boolean> {
  const count = Number(await getRedis().get(TARPIT_COUNTER)) || 0;
  return count < (config?.maxTarpits ?? 50);
}

export async function tarpitStart(): Promise<void> {
  await getRedis().incr(TARPIT_COUNTER);
}

export async function tarpitEnd(): Promise<void> {
  const val = await getRedis().decr(TARPIT_COUNTER);
  if (val < 0) await getRedis().set(TARPIT_COUNTER, 0);
}

// ── Event logging ─────────────────────────────────────────

export async function logEvent(
  action: string,
  ip: string,
  path: string,
  score: number,
  signals: ScoringResult["signals"],
): Promise<void> {
  if (config?.enableLogging === false) return;

  const signalNames = signals.map(s => s.name).join(",");

  try {
    await getRedis().xadd(EVENT_STREAM, "*", {
      action, ip, path, score: String(score),
      signals: signalNames, ts: new Date().toISOString(),
    });
    await getRedis().xtrim(EVENT_STREAM, { strategy: "MAXLEN", threshold: 10000 });
  } catch {
    // Redis might not support streams (e.g. Upstash free tier) — ignore
  }

  // External callback (e.g. Slack, Datadog)
  if (config?.onEvent && (action === "block" || action === "tarpit")) {
    config.onEvent({
      action, ip, path, score,
      signals: signals.map(s => `${s.name}:${s.detail}`),
      timestamp: new Date().toISOString(),
    });
  }
}
