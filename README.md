# Hot Type

A daily typing game that runs inside a Reddit post. You retype the day's text posts from the community you're in, and your speed lands on that community's leaderboard. It's meant to help people learn to touch type on writing they'd actually read.

## The idea

Most typing trainers hand you random word lists. Hot Type uses your own subreddit's posts, refreshed daily, so the practice text is current and worth reading. An on-screen keyboard highlights the next key and marks the home row, so it teaches finger position, not just speed.

What brings people back:

- New posts every day, pulled live from the community.
- A per-community leaderboard that resets daily.
- A personal best and a daily streak.

## Play

The game is a post. A moderator creates one from the subreddit menu ("Create a Hot Type post"). Open it, start typing, and your fastest run of the day goes on the board.

## Develop

Needs Node 22.6 or newer.

```
npm install
npm run login    # authorize the Devvit CLI
npm run dev      # playtest with hot reload on your test subreddit
```

`npm run dev` installs a live build to the subreddit named in `devvit.json` (`dev.subreddit`) and reloads on save. The game only renders inside a post, so create one from the mod menu after it loads. If the community has few text posts, use "Refresh today's Hot Type posts" from the menu to rebuild the set.

To ship:

```
npm run deploy   # build and upload a private version
npm run launch   # build, upload, and submit for review
```

`launch` enters Reddit's review queue, so run it a few days before you need it live.

## How it works

Built on Devvit Web. The game is React; the in-feed splash card is plain TypeScript so it loads fast.

- The server reads the community's recent text posts, strips markdown to plain text, filters them, and caches the day's set in Redis.
- Scoring is server-authoritative. The server stamps the start time on its own clock, keeps the target text, and recomputes WPM when you finish, so the client can't report a fake number. Paste and out-of-order edits are blocked on the client too.
- Leaderboards, streaks, and personal bests live in Redis. There's no external database or server to run. Reddit hosts all of it.

## Notes

Works best in text-heavy communities, where posts have real bodies instead of just links or images. The profanity filter that screens post text is a small starter list; extend it before running in a large community.