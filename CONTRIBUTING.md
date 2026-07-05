# Contributing

Built on Devvit Web. The game is React; the in-feed card is plain TypeScript. Scores are validated on the server, and leaderboards, streaks, and the daily post set live in Redis. There is no external server or database to run.

Needs Node 22.6 or newer.

```
npm install
npm run login    # authorize the Devvit CLI
npm run dev      # playtest with hot reload on your test subreddit
```

To ship:

```
npm run deploy   # build and upload a private version
npm run launch   # build, upload, and submit for review
```

## Project layout

```
src/
  shared/api.ts     types and endpoints shared by client and server
  server/           reads posts, validates scores, owns the leaderboard
  client/game.tsx   the typing game (React)
  client/splash.ts  the in-feed card
public/             host pages for the two entry points
devvit.json         app config: entry points, menu items, dev subreddit
assets/icon.png     app icon, referenced from devvit.json marketingAssets
```