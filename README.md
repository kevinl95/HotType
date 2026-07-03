# Hot Type — Devvit Web scaffold

A daily touch-typing race built on **your community's own top posts**. Each day the
server pulls the subreddit's top posts, picks the typeable ones, and everyone races the
same set. Fastest run lands on the daily leaderboard; play every day to build a streak.

This is the Devvit Web port of the standalone prototype. It runs *inside* a Reddit post.

```
src/
  shared/api.ts     types + endpoint names shared by client and server
  server/           Node server: reddit.getTopPosts + redis leaderboard/streak
  client/game.tsx   React UI (typing engine, vote-arrow particles, key coach)
  client/splash.ts  lightweight in-feed card (no React) -> expands into the game
public/game.html    host page for the bundled game client
public/splash.html  the inline feed card (default entrypoint)
devvit.json         app config (splash + game entrypoints, server, menu, triggers)
tools/build.ts      esbuild bundler (client -> public/game.js, server -> dist/server)
```

---

## Crash course: setup, deploy, test

### 1. Setup (once)

- **Node 22.6+** is required (`.nvmrc` pins it; run `nvm use`). Older Node will fail.
- Create a Reddit account for development and a **private test subreddit** you moderate —
  this is where you'll iterate. Never test in a real community.
- Install deps and log in:
  ```bash
  npm install
  npm run login      # devvit login — opens a browser to authorize the CLI
  ```
- The app `name` in `devvit.json` and `package.json` must be globally unique and
  lowercase-with-dashes. Rename `hot-type` to something you own before first upload.

If you're starting fresh instead of from this scaffold, `npm create devvit@latest` runs the
official wizard and gives you the same project shape.

### 2. The dev loop (this is where you live)

```bash
npm run dev        # devvit playtest
```

`playtest` uploads a dev build to your test subreddit and **hot-reloads on every save**.
Open the post it points you to and iterate there. A few things to internalize:

- **Server code runs on Reddit, not your laptop.** `context`, `reddit`, and `redis` only
  exist in that sandbox, so you can't meaningfully run the server locally — playtest *is*
  your runtime. `console.log` from the server shows up in the playtest terminal.
- **The viewport is small and fixed.** Judges open posts on mobile and desktop; design for
  the post frame, not a full browser tab. Test both. The hackathon explicitly dings apps
  whose UI doesn't fit the viewport.
- **Redis is your only persistence.** No filesystem, no external DB. Keys are per-app and
  shared across all installs of your app, so namespace them (`lb:{sub}:{date}`) and set
  `expire` on anything daily so old keys clean themselves up.
- **Reddit API calls cost latency.** Cache results (this scaffold caches the daily post set
  for ~36h) instead of refetching on every `init`.

### 3. Testing what matters

- **Multi-user state.** A leaderboard looks fine with one player. Open the post as two
  different Reddit accounts (or an alt + incognito) and confirm scores, ranks, and the
  "you" highlight behave. Race conditions hide here — this scaffold keeps only a player's
  *best of the day* and clamps absurd WPM server-side.
- **Empty + first-run states.** New community, no posts yet, no leaderboard entries, brand
  new user with no streak. The scaffold renders explicit copy for each; keep it that way.
- **The daily reset.** The whole hook is "fresh tomorrow." Manually bump the date logic (or
  wait a day) and confirm a new post set loads and a continued streak increments rather
  than resets.
- **Reduced motion + keyboard focus.** The particle layer respects
  `prefers-reduced-motion`; don't regress that.

### 4. Deploy and publish

```bash
npm run deploy     # build + devvit upload  -> a new private version on Reddit
npm run launch     # build + upload + devvit publish -> submits for review
```

- `upload` ships a version only you/your test sub can see. Do this constantly.
- `publish` sends the app for Reddit review so it can be installed in public communities.
  Review takes time — **publish days before the deadline**, not on it.
- For the hackathon you submit: the **app listing** on developers.reddit.com **and a public
  demo post** in a subreddit running the game. Judging is mostly "open the post and play,"
  so the demo post must be self-explanatory with zero setup.

### 5. Retention checklist (the actual scoring criteria)

The prize is literally "best hook." This build leans on: daily-fresh content (top posts
rotate), a per-day leaderboard that resets, personal best, and a streak counter. Before
submitting, make sure a returning player visibly *gains* something on day 2 — that's what
judges look for.

---

## Notes / things to tune

- **Which posts?** This pulls the *current subreddit's* top posts (community-minded, avoids
  cross-sub permission issues). To race a fixed flagship sub instead, hardcode the
  `subredditName` in `server.ts`. Reading `r/all`/`r/popular` is more restricted — test it.
- **Sanitization** strips anything the on-screen keyboard can't show and filters by length.
  Loosen `[^a-zA-Z0-9 ,.'?-]` if you add more keys.
- **Score validation** is server-authoritative. On the first keystroke the client hits
  `/api/start`; the server stamps the start time on its own clock and stores the target text
  in a single-use Redis run record (10-min TTL). On submit the client sends only the *typed
  text* and keystroke count — never a WPM. The server recomputes WPM from its own elapsed
  time and its own target, burns the run record so a start can't be replayed, and rejects
  runs that are unfinished, have too few keystrokes, are impossibly fast (>300 wpm), or have
  no live run. A forged POST has nothing to forge against.
  - **Residual gap:** a scripted client could still call `/api/start`, wait the minimum
    plausible time, then submit the correct text to fake a high-but-plausible score. Fully
    closing that needs keystroke-timing telemetry / behavioral checks — overkill for a
    hackathon, but noted if this ever goes wide.
- The build uses esbuild only; `npm run type-check` runs `tsc` separately and is optional.

## The splash screen (the in-feed card)

`devvit.json` declares two entrypoints. The `default` one is marked `"inline": true`, so
Reddit renders `splash.html` directly in the feed — this is the card people see *before*
they tap in, and it's the single biggest lever on whether they do. The `game` entrypoint is
the full-screen React app.

`src/client/splash.ts` is deliberately framework-free (no React) so the feed card loads
fast. It fetches `/api/init` to tease today's state — current leader and WPM, your streak,
your personal best — then a single button calls `requestExpandedMode(e, "game")`, which
expands the same post in place into the game entrypoint. That call must run inside a user
gesture (the click handler), so don't move it.

Tuning ideas: the teaser copy and which stats you surface are the levers to A/B once it's
live. Keep the card short — inline cards get little vertical space — and make the value
obvious in the first line.
```
```
