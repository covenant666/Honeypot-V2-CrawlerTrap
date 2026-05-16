// ============================================================
// HoneyPot v2 — Shared Types
// MIT License — see LICENSE
// ============================================================

export interface BehaviorData {
  totalRequests: number;
  uniquePaths: number;
  avgDwellMs: number;
  minDwellMs: number;
  burstCount: number;
  suspiciousPaths: number;
  trapHits: number;
  cfBotScoreAvg: number;
  firstSeen: number;
  lastSeen: number;
}

export interface ScoringSignals {
  name: string;
  contribution: number;
  detail: string;
}

export interface ScoringResult {
  score: number;
  signals: ScoringSignals[];
  action: "pass" | "challenge" | "degrade" | "block" | "tarpit";
  behaviorData: BehaviorData;
}

export interface HoneypotConfig {
  /** Redis REST URL (optional — set or leave blank for in-memory mode) */
  redisUrl?: string;
  /** Redis REST token (optional) */
  redisToken?: string;
  /** IP TTL in seconds (default: 86400 = 24h) */
  ipTtl?: number;
  /** Maximum concurrent tarpits (default: 50) */
  maxTarpits?: number;
  /** Real app paths regex — requests matching these ALWAYS pass through */
  realAppRegex: RegExp;
  /** Vulnerability path patterns to detect scanner probes */
  vulnPaths?: RegExp[];
  /** Custom bait trap path patterns */
  trapPatterns?: RegExp[];
  /** Enable event logging (default: true) */
  enableLogging?: boolean;
  /** Callback for external logging (e.g. Slack, Datadog) */
  onEvent?: (event: HoneypotEvent) => void;
}

export interface HoneypotEvent {
  action: string;
  ip: string;
  path: string;
  score: number;
  signals: string[];
  timestamp: string;
}

export interface BaitOptions {
  /** Trap link paths to inject */
  paths: string[];
  /** Cookie name for proof-of-JS (default: "_hpv") */
  cookieName?: string;
  /** Delay before injecting bait links in ms (default: 3000) */
  injectDelay?: number;
  /** Cookie expiry in days (default: 1) */
  cookieExpiryDays?: number;
}
