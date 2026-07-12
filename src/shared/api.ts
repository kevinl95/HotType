// Shared types + endpoint names. Imported by BOTH client and server so the
// request/response shapes can never drift apart.

export type PostOrigin = "top-day" | "new-recent" | "top-week" | "top-month" | "bundled-fallback";
export type Post = { sub: string; title: string; text: string; score: number; origin: PostOrigin };
export type LeaderEntry = { name: string; wpm: number };

export type InitResponse = {
  type: "init";
  username: string;
  date: string;
  posts: Post[];
  leaderboard: LeaderEntry[];
  best: number;
  streak: number;
  corpusDescription: string;
  usesFallback: boolean;
};

// Client tells the server which post it's starting; the server stamps the start
// time on its OWN clock and remembers the target text it served.
export type StartRequest = { index: number };
export type StartResponse = { type: "start"; ok: boolean; reason?: string };

// The client no longer sends a WPM. It sends the raw evidence of the run and
// the server recomputes the score authoritatively.
export type ScoreRequest = { index: number; typed: string; keystrokes: number };

export type ScoreResponse = {
  type: "score";
  accepted: boolean;
  reason?: string;
  wpm: number; // server-computed
  acc: number; // server-computed
  leaderboard: LeaderEntry[];
  best: number;
  streak: number;
  circuitComplete: boolean;
};

export const ApiEndpoint = {
  Init: "/api/init",
  Start: "/api/start",
  Score: "/api/score",
  OnPostCreate: "/internal/menu/post-create",
  OnRefreshPosts: "/internal/menu/refresh-posts",
} as const;
export type ApiEndpoint = (typeof ApiEndpoint)[keyof typeof ApiEndpoint];
