import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { context, reddit, redis } from "@devvit/web/server";
import type { PartialJsonValue, UiResponse } from "@devvit/web/shared";
import {
  ApiEndpoint,
  type InitResponse,
  type LeaderEntry,
  type Post,
  type ScoreRequest,
  type ScoreResponse,
  type StartRequest,
  type StartResponse,
} from "../shared/api.ts";

const DAY = () => new Date().toISOString().slice(0, 10);
const TTL = 60 * 60 * 36; // daily keys self-expire after ~36h
const EMPTY_POSTS_TTL = 60 * 5; // empty daily sets are cached briefly to avoid refetch loops
const RUN_TTL = 60 * 10; // a run must be finished within 10 minutes
const BOARD_MAX = 50;
const POSTS_PER_DAY = 4;
const SCORE_TX_RETRIES = 4;
const POSTS_CACHE_VERSION = 3;
const SCORE_STATE_VERSION = "v2";
const CIRCUIT_STATE_VERSION = 1;
const DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_POST_TEXT = 40;
const APP_POST_TITLE = "Hot Type — daily typing race";

// Plausibility bounds for the server-recomputed score.
const MIN_MS_PER_CHAR = 40; // faster than ~300 wpm is rejected as non-human
const MAX_WPM = 300;

/* ---------- routing ---------- */
export async function serverOnRequest(req: IncomingMessage, rsp: ServerResponse): Promise<void> {
  try {
    const url = req.url ?? "";
    switch (url) {
      case ApiEndpoint.Init:
        return writeJSON(200, await onInit(), rsp);
      case ApiEndpoint.Start:
        return writeJSON(200, await onStart(req), rsp);
      case ApiEndpoint.Score:
        return writeJSON(200, await onScore(req), rsp);
      case ApiEndpoint.OnPostCreate:
        return writeJSON(200, await onMenuNewPost(), rsp);
      case ApiEndpoint.OnRefreshPosts:
        return writeJSON(200, await onMenuRefreshPosts(), rsp);
      default:
        return writeJSON(404, { error: "not found", status: 404 }, rsp);
    }
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`;
    console.error(msg);
    writeJSON(500, { error: msg, status: 500 }, rsp);
  }
}

/* ---------- keys ---------- */
const postsKey = (sub: string, day: string) => `posts:${sub}:${day}`;
const boardKey = (sub: string, day: string, corpusId: string) => `lb:${SCORE_STATE_VERSION}:${sub}:${day}:${corpusId}`;
const bestKey = (user: string) => `best:${SCORE_STATE_VERSION}:${user}`;
const streakKey = (user: string) => `streak:${SCORE_STATE_VERSION}:${user}`;
const circuitKey = (sub: string, day: string, user: string) => `circuit:${SCORE_STATE_VERSION}:${sub}:${day}:${user}`;
const runKey = (sub: string, day: string, user: string) => `run:${SCORE_STATE_VERSION}:${sub}:${day}:${user}`;

type StreakState = { streak: number; last: string };
type CachedPosts = { version: number; posts: Post[] };
type RunState = { startedAt: number; target: string; index: number };
type CircuitState = {
  version: number;
  corpusId: string;
  totalPosts: number;
  nextIndex: number;
  correct: number;
  keystrokes: number;
  elapsedMs: number;
};

function isCachedPosts(raw: unknown): raw is CachedPosts {
  return (
    raw != null &&
    typeof raw === "object" &&
    (raw as CachedPosts).version === POSTS_CACHE_VERSION &&
    Array.isArray((raw as CachedPosts).posts) &&
    (raw as CachedPosts).posts.every(
      (post) =>
        post != null &&
        typeof post === "object" &&
        typeof (post as Post).sub === "string" &&
        typeof (post as Post).title === "string" &&
        typeof (post as Post).text === "string" &&
        typeof (post as Post).score === "number",
    )
  );
}

function parseStreakState(raw: string | undefined): StreakState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StreakState>;
    if (typeof parsed.streak === "number" && typeof parsed.last === "string") {
      return { streak: parsed.streak, last: parsed.last };
    }
  } catch {
    // Treat corrupt streak data as a cold start instead of crashing the request.
  }
  return null;
}

function parseRunState(raw: string | undefined): RunState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RunState>;
    if (
      typeof parsed.startedAt === "number" &&
      typeof parsed.target === "string" &&
      typeof parsed.index === "number"
    ) {
      return { startedAt: parsed.startedAt, target: parsed.target, index: parsed.index };
    }
  } catch {
    // Treat corrupt run data as missing.
  }
  return null;
}

function parseCircuitState(raw: string | undefined): CircuitState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CircuitState>;
    if (
      parsed.version === CIRCUIT_STATE_VERSION &&
      typeof parsed.corpusId === "string" &&
      typeof parsed.totalPosts === "number" &&
      typeof parsed.nextIndex === "number" &&
      typeof parsed.correct === "number" &&
      typeof parsed.keystrokes === "number" &&
      typeof parsed.elapsedMs === "number"
    ) {
      return {
        version: parsed.version,
        corpusId: parsed.corpusId,
        totalPosts: parsed.totalPosts,
        nextIndex: parsed.nextIndex,
        correct: parsed.correct,
        keystrokes: parsed.keystrokes,
        elapsedMs: parsed.elapsedMs,
      };
    }
  } catch {
    // Treat corrupt circuit data as missing.
  }
  return null;
}

function newCircuitState(corpusId: string, totalPosts: number): CircuitState {
  return {
    version: CIRCUIT_STATE_VERSION,
    corpusId,
    totalPosts,
    nextIndex: 0,
    correct: 0,
    keystrokes: 0,
    elapsedMs: 0,
  };
}

/* ---------- content ---------- */
// Only letters, digits, spaces and light punctuation survive — anything the
// on-screen keyboard can't show is stripped so the typing target stays typeable.
function sanitizeTypeableText(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9 ,.'?-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^\)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\r/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTypeablePostText(body: string | undefined): string {
  if (!body) return "";
  return sanitizeTypeableText(toPlainText(body));
}

function isRecentPost(date: Date, nowMs: number): boolean {
  return nowMs - date.getTime() <= DAY_WINDOW_MS;
}

function toTypeablePost(post: { title: string; body: string | undefined; score: number }, sub: string): Post | null {
  if (post.title === APP_POST_TITLE) return null;

  const rawBody = post.body?.trim();
  if (!rawBody) return null;

  const text = getTypeablePostText(rawBody);
  if (text.length < MIN_POST_TEXT) return null;
  if (!isClean(post.title) || !isClean(rawBody) || !isClean(text)) return null;

  return { sub, title: post.title.trim(), text, score: post.score };
}

function currentSubredditName(): string | null {
  const sub = context.subredditName?.trim();
  return sub ? sub : null;
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function corpusIdForPosts(posts: Post[]): string {
  return hashText(posts.map((post) => `${post.title}\u001f${post.text}`).join("\u001e"));
}

// Profanity/slur guard so the game never renders hateful or obscene text, even
// from a SFW post. Reddit's content rules prohibit surfacing such content.
// This is a STARTER list — before going wide, swap in a maintained word-list
// library and expand the slur patterns. Patterns are leetspeak-tolerant and
// match word fragments, so they over-block slightly on purpose.
const BLOCKLIST: RegExp[] = [
  /f+u+c+k/i,
  /s+h+i+t/i,
  /\bc+u+n+t/i,
  /\bb+i+t+c+h/i,
  /n[i1]gg/i,
  /f[a4]gg/i,
  /ret[a4]rd/i,
  /\brap(e|ing|ist)\b/i,
  /\bporn/i,
  /\bcum\b/i,
];
function isClean(text: string): boolean {
  return !BLOCKLIST.some((re) => re.test(text));
}

async function getDailyPosts(sub: string, day: string): Promise<Post[]> {
  const cached = await redis.get(postsKey(sub, day));
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as unknown;
      if (isCachedPosts(parsed)) return parsed.posts;
    } catch {
      // Fall through and rebuild the corpus if the cache is corrupt.
    }
    await redis.del(postsKey(sub, day));
  }

  const raw = await reddit
    .getTopPosts({ subredditName: sub, timeframe: "day", limit: 30 })
    .all();

  const picked: Post[] = [];
  const seen = new Set<string>();
  const nowMs = Date.now();

  const appendPosts = (
    posts: Array<{ id: string; title: string; body: string | undefined; score: number; stickied: boolean; nsfw: boolean; removed: boolean; createdAt: Date }>,
    recentOnly: boolean,
  ) => {
    for (const post of posts) {
      if (picked.length >= POSTS_PER_DAY) break;
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      if (post.stickied || post.nsfw || post.removed) continue;
      if (recentOnly && !isRecentPost(post.createdAt, nowMs)) continue;

      const candidate = toTypeablePost(post, sub);
      if (candidate) picked.push(candidate);
    }
  };

  appendPosts(raw, false);

  if (picked.length < POSTS_PER_DAY) {
    const fresh = await reddit.getNewPosts({ subredditName: sub, limit: 50 }).all();
    appendPosts(fresh, true);
  }

  await redis.set(postsKey(sub, day), JSON.stringify({ version: POSTS_CACHE_VERSION, posts: picked }));
  await redis.expire(postsKey(sub, day), picked.length > 0 ? TTL : EMPTY_POSTS_TTL);
  return picked;
}

async function readBoard(sub: string, day: string, corpusId: string): Promise<LeaderEntry[]> {
  const rows = await redis.zRange(boardKey(sub, day, corpusId), 0, 9, { reverse: true, by: "rank" });
  return rows.map((r) => ({ name: r.member, wpm: r.score }));
}

async function readPlayerStats(username: string): Promise<{ best: number; streak: number }> {
  return {
    best: Number((await redis.get(bestKey(username))) ?? 0),
    streak: parseStreakState(await redis.get(streakKey(username)))?.streak ?? 0,
  };
}

async function recordAcceptedScore(
  sub: string,
  day: string,
  corpusId: string,
  username: string,
  wpm: number,
): Promise<{ best: number; streak: number }> {
  const board = boardKey(sub, day, corpusId);
  const best = bestKey(username);
  const streak = streakKey(username);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  for (let attempt = 0; attempt < SCORE_TX_RETRIES; attempt++) {
    const tx = await redis.watch(board, best, streak);
    try {
      // Devvit queues tx-client reads until EXEC, so the optimistic read phase
      // must stay on the base client after WATCH.
      const existing = await redis.zScore(board, username);
      const bestRaw = await redis.get(best);
      const currentBest = Number(bestRaw ?? 0);
      const prevRaw = await redis.get(streak);
      const prev = parseStreakState(prevRaw);

      let nextStreak = prev?.streak ?? 0;
      const shouldUpdateStreak = prev?.last !== day;
      if (shouldUpdateStreak) nextStreak = prev?.last === yesterday ? nextStreak + 1 : 1;

      const shouldUpdateBoard = existing === undefined || wpm > existing;
      const nextBest = Math.max(currentBest, wpm);
      const shouldUpdateBest = nextBest !== currentBest;

      if (!shouldUpdateBoard && !shouldUpdateBest && !shouldUpdateStreak) {
        await tx.unwatch();
        return { best: currentBest, streak: nextStreak };
      }

      await tx.multi();
      if (shouldUpdateBoard) {
        await tx.zAdd(board, { member: username, score: wpm });
        await tx.expire(board, TTL);
      }
      if (shouldUpdateBest) await tx.set(best, String(nextBest));
      if (shouldUpdateStreak) await tx.set(streak, JSON.stringify({ streak: nextStreak, last: day }));

      const committed = await tx.exec();
      if (!Array.isArray(committed) || committed.length === 0) continue;

      if (shouldUpdateBoard) {
        const card = await redis.zCard(board);
        if (card > BOARD_MAX) await redis.zRemRangeByRank(board, 0, card - BOARD_MAX - 1);
      }
      return { best: nextBest, streak: nextStreak };
    } catch (err) {
      try {
        await tx.discard();
      } catch {
        // The transaction may not have entered MULTI yet, or EXEC may already have cleaned it up.
      }
      if (attempt === SCORE_TX_RETRIES - 1) throw err;
    }
  }

  throw new Error("score update conflict");
}

// Same matching rule the client uses: case-insensitive on letters.
function correctChars(typed: string, target: string): number {
  let c = 0;
  const n = Math.min(typed.length, target.length);
  for (let i = 0; i < n; i++) if (typed[i]?.toLowerCase() === target[i]?.toLowerCase()) c++;
  return c;
}

/* ---------- handlers ---------- */
async function onInit(): Promise<InitResponse> {
  const day = DAY();
  const username = context.username ?? "anon";
  const sub = currentSubredditName();

  if (!sub) {
    return { type: "init", username, date: day, posts: [], leaderboard: [], best: 0, streak: 0 };
  }

  const posts = await getDailyPosts(sub, day);
  const corpusId = corpusIdForPosts(posts);
  const [leaderboard, stats] = await Promise.all([readBoard(sub, day, corpusId), readPlayerStats(username)]);

  return {
    type: "init",
    username,
    date: day,
    posts,
    leaderboard,
    best: stats.best,
    streak: stats.streak,
  };
}

// The client calls this the instant the player presses the first key. The
// server records WHEN it happened (its own clock) and WHICH text was in play,
// so neither value can be spoofed at submit time.
async function onStart(req: IncomingMessage): Promise<StartResponse> {
  const day = DAY();
  const username = context.username ?? "anon";
  const { index } = await readJSON<StartRequest>(req).catch(() => ({ index: -1 }));
  const sub = currentSubredditName();
  if (!sub) return { type: "start", ok: false, reason: "not in a subreddit" };

  const posts = await getDailyPosts(sub, day);
  const post = posts[index];
  if (!post) return { type: "start", ok: false, reason: "invalid post" };

  const corpusId = corpusIdForPosts(posts);
  const runStoreKey = runKey(sub, day, username);
  const circuitStoreKey = circuitKey(sub, day, username);
  const existingRun = parseRunState(await redis.get(runStoreKey));
  const existingCircuit = parseCircuitState(await redis.get(circuitStoreKey));

  const canReuseRun =
    existingRun?.index === index &&
    (index !== 0 || existingCircuit == null || existingCircuit.corpusId === corpusId);
  if (canReuseRun) {
    await redis.expire(runStoreKey, RUN_TTL);
    return { type: "start", ok: true };
  }

  if (existingRun && index > 0) {
    return { type: "start", ok: false, reason: "finish the current post first" };
  }

  if (index === 0) {
    if (existingRun) await redis.del(runStoreKey);
    await redis.set(circuitStoreKey, JSON.stringify(newCircuitState(corpusId, posts.length)));
    await redis.expire(circuitStoreKey, TTL);
  } else {
    if (!existingCircuit) return { type: "start", ok: false, reason: "restart from the first post" };
    if (existingCircuit.corpusId !== corpusId) {
      return { type: "start", ok: false, reason: "today's post set changed; restart the circuit" };
    }
    if (existingCircuit.nextIndex !== index) {
      return { type: "start", ok: false, reason: "finish the posts in order" };
    }
  }

  await redis.set(
    runStoreKey,
    JSON.stringify({ startedAt: Date.now(), target: post.text, index }),
  );
  await redis.expire(runStoreKey, RUN_TTL);
  return { type: "start", ok: true };
}

async function onScore(req: IncomingMessage): Promise<ScoreResponse> {
  const day = DAY();
  const username = context.username ?? "anon";
  const sub = currentSubredditName();
  const body = await readJSON<ScoreRequest>(req).catch(() => ({ index: -1, typed: "", keystrokes: 0 }));

  if (!sub) {
    return {
      type: "score",
      accepted: false,
      reason: "not in a subreddit",
      wpm: 0,
      acc: 0,
      leaderboard: [],
      best: 0,
      streak: 0,
      circuitComplete: false,
    };
  }

  const posts = await getDailyPosts(sub, day);
  const currentCorpusId = corpusIdForPosts(posts);
  const runStoreKey = runKey(sub, day, username);
  const circuitStoreKey = circuitKey(sub, day, username);

  const reject = async (reason: string, boardCorpusId = currentCorpusId): Promise<ScoreResponse> => {
    const [leaderboard, stats] = await Promise.all([readBoard(sub, day, boardCorpusId), readPlayerStats(username)]);
    return {
      type: "score",
      accepted: false,
      reason,
      wpm: 0,
      acc: 0,
      leaderboard,
      best: stats.best,
      streak: stats.streak,
      circuitComplete: false,
    };
  };

  // 1. There must be a live, un-redeemed run for this user.
  const runRaw = await redis.get(runStoreKey);
  if (!runRaw) return reject("no active run");
  const run = parseRunState(runRaw);
  if (!run) {
    await redis.del(runStoreKey);
    return reject("no active run");
  }

  const circuit = parseCircuitState(await redis.get(circuitStoreKey));
  if (!circuit) {
    await redis.del(runStoreKey);
    return reject("restart from the first post");
  }
  if (run.index !== body.index || circuit.nextIndex !== body.index) {
    await redis.del(runStoreKey);
    return reject("finish the posts in order", circuit.corpusId);
  }

  // 2. Burn the run immediately — single use, so a start can't be replayed.
  await redis.del(runStoreKey);

  // 3. Score is computed from the SERVER's start time and the SERVER's target.
  const target = run.target;
  const typed = String(body.typed ?? "").slice(0, target.length);
  const elapsedMs = Date.now() - run.startedAt;
  const correct = correctChars(typed, target);
  const keystrokes = Math.max(Number(body.keystrokes) || 0, correct);

  // 4. Plausibility gates.
  if (typed.length < target.length) return reject("run not finished", circuit.corpusId);
  if (keystrokes < target.length) return reject("too few keystrokes", circuit.corpusId);
  if (elapsedMs < target.length * MIN_MS_PER_CHAR) return reject("impossibly fast", circuit.corpusId);

  const minutes = elapsedMs / 60000;
  const segmentWpm = Math.round(correct / 5 / minutes);
  if (segmentWpm <= 0 || segmentWpm > MAX_WPM) return reject("out of range", circuit.corpusId);
  const segmentAcc = Math.max(0, Math.min(100, Math.round((correct / keystrokes) * 100)));

  const nextCircuit: CircuitState = {
    ...circuit,
    nextIndex: circuit.nextIndex + 1,
    correct: circuit.correct + correct,
    keystrokes: circuit.keystrokes + keystrokes,
    elapsedMs: circuit.elapsedMs + elapsedMs,
  };

  if (nextCircuit.nextIndex < nextCircuit.totalPosts) {
    await redis.set(circuitStoreKey, JSON.stringify(nextCircuit));
    await redis.expire(circuitStoreKey, TTL);
    const [leaderboard, stats] = await Promise.all([
      readBoard(sub, day, circuit.corpusId),
      readPlayerStats(username),
    ]);
    return {
      type: "score",
      accepted: true,
      wpm: segmentWpm,
      acc: segmentAcc,
      leaderboard,
      best: stats.best,
      streak: stats.streak,
      circuitComplete: false,
    };
  }

  const totalMinutes = nextCircuit.elapsedMs / 60000;
  const circuitWpm = Math.round(nextCircuit.correct / 5 / totalMinutes);
  if (circuitWpm <= 0 || circuitWpm > MAX_WPM) return reject("out of range", circuit.corpusId);
  const circuitAcc = Math.max(0, Math.min(100, Math.round((nextCircuit.correct / nextCircuit.keystrokes) * 100)));

  // 5. Record only a completed full-set run on the board, plus all-time best and streak.
  const { best, streak } = await recordAcceptedScore(sub, day, circuit.corpusId, username, circuitWpm);
  await redis.del(circuitStoreKey);

  return {
    type: "score",
    accepted: true,
    wpm: circuitWpm,
    acc: circuitAcc,
    leaderboard: await readBoard(sub, day, circuit.corpusId),
    best,
    streak,
    circuitComplete: true,
  };
}

async function onMenuNewPost(): Promise<UiResponse> {
  if (!currentSubredditName()) {
    return { showToast: { text: "This post must be created from a subreddit", appearance: "neutral" } };
  }

  const post = await reddit.submitCustomPost({ title: APP_POST_TITLE });
  return { showToast: { text: `Created ${post.id}`, appearance: "success" }, navigateTo: post.url };
}

async function onMenuRefreshPosts(): Promise<UiResponse> {
  const sub = currentSubredditName();
  if (!sub) {
    return { showToast: { text: "This action needs a subreddit context", appearance: "neutral" } };
  }

  const day = DAY();
  await redis.del(postsKey(sub, day));
  const posts = await getDailyPosts(sub, day);
  const text = posts.length > 0 ? `Refreshed ${posts.length} posts for today` : "No text posts qualified for today yet";
  return { showToast: { text, appearance: "success" } };
}

/* ---------- io ---------- */
function writeJSON<T extends PartialJsonValue>(status: number, json: T, rsp: ServerResponse): void {
  const body = JSON.stringify(json);
  rsp.writeHead(status, { "Content-Length": Buffer.byteLength(body), "Content-Type": "application/json" });
  rsp.end(body);
}

async function readJSON<T>(req: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  req.on("data", (c) => chunks.push(c));
  await once(req, "end");
  return JSON.parse(`${Buffer.concat(chunks)}`);
}
