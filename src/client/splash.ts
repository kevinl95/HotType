import { requestExpandedMode } from "@devvit/web/client";
import { ApiEndpoint, type InitResponse } from "../shared/api.ts";

const startButton = document.getElementById("start-button") as HTMLButtonElement;
const teaser = document.getElementById("teaser") as HTMLDivElement;
const hook = document.getElementById("hook") as HTMLParagraphElement;

// Tapping expands the post into the layout that matches the user's device.
startButton.addEventListener("click", (e) => {
  requestExpandedMode(e, "game");
});

function chip(html: string, cls = ""): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "chip" + (cls ? " " + cls : "");
  el.innerHTML = html;
  return el;
}

// Pull today's state so the feed card sells the race: who's fastest, your
// streak, your best. This is the moment that earns the tap.
async function loadTeaser(): Promise<void> {
  try {
    const r = await fetch(ApiEndpoint.Init);
    const d = (await r.json()) as InitResponse;
    if (d.type !== "init") return;

    teaser.replaceChildren();

    if (d.posts.length === 0) {
      hook.textContent = "fresh posts are landing — check back soon.";
    }

    const leader = d.leaderboard[0];
    teaser.appendChild(
      leader
        ? chip(`top today &middot; u/${leader.name} &middot; <span class="mono">${leader.wpm}</span> wpm`)
        : chip("be the first to set a time today"),
    );
    if (d.streak > 0) teaser.appendChild(chip(`🔥 ${d.streak}-day streak`, "fire"));
    if (d.best > 0) teaser.appendChild(chip(`your best <span class="mono">${d.best}</span> wpm`));
  } catch {
    // Card still works without live stats — the Start button is what matters.
  }
}

void loadTeaser();
