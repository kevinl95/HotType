import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, type ChangeEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  ApiEndpoint,
  type InitResponse,
  type LeaderEntry,
  type Post,
  type ScoreResponse,
  type StartResponse,
} from "../shared/api.ts";

const ROWS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l", "'"],
  ["z", "x", "c", "v", "b", "n", "m", ",", ".", "?"],
];
const HOME = new Set(["a", "s", "d", "f", "j", "k", "l"]);
const BUMP = new Set(["f", "j"]);
const eq = (a?: string, b?: string) => a != null && b != null && a.toLowerCase() === b.toLowerCase();
const fmt = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : "" + n);
type LayoutMode = "desktop-wide" | "desktop-compact" | "mobile";
type RunStatus = "idle" | "starting" | "typing" | "done";

const DESKTOP_WIDTH_QUERY = "(min-width: 1100px)";
const KEYBOARD_QUERY = "(min-width: 980px) and (min-height: 760px)";

function getDevvitClient(): { name: string } | undefined {
  return (globalThis as typeof globalThis & { devvit?: { context?: { client?: { name: string } } } }).devvit?.context?.client;
}

function hasDevvitContext(): boolean {
  return Boolean((globalThis as typeof globalThis & { devvit?: { context?: unknown } }).devvit?.context);
}

function detectLayoutMode(): LayoutMode {
  if (getDevvitClient()) return "mobile";
  if (hasDevvitContext()) return window.matchMedia?.(DESKTOP_WIDTH_QUERY).matches ? "desktop-wide" : "desktop-compact";
  return window.matchMedia?.(DESKTOP_WIDTH_QUERY).matches ? "desktop-wide" : "mobile";
}

function canShowKeyboard(): boolean {
  return window.matchMedia?.(KEYBOARD_QUERY).matches ?? false;
}

function activeCharIndex(typed: string, target: string, status: RunStatus): number {
  const maxIndex = Math.max(target.length - 1, 0);
  if (status === "done") return Math.min(Math.max(typed.length - 1, 0), maxIndex);
  return Math.min(typed.length, maxIndex);
}

function escapeTargetChar(ch: string): string {
  switch (ch) {
    case "&":
      return "&amp;";
    case "<":
      return "&lt;";
    case ">":
      return "&gt;";
    case '"':
      return "&quot;";
    case "'":
      return "&#39;";
    default:
      return ch;
  }
}

function buildTargetMarkup(target: string): string {
  const parts = target.match(/\S+\s*|\s+/g) ?? [];
  let charIndex = 0;

  return parts
    .map((part) => {
      const chars = part
        .split("")
        .map((ch) => {
          const content = ch === " " ? "&nbsp;" : escapeTargetChar(ch);
          return `<span id="ch${charIndex++}" class="c u">${content}</span>`;
        })
        .join("");
      return `<span class="tok">${chars}</span>`;
    })
    .join("");
}

function charClassName(index: number, typed: string, target: string, status: RunStatus): string {
  let cls = "u";
  if (index < typed.length) cls = eq(typed[index], target[index]) ? "ok" : "err";
  else if (index === typed.length && status !== "done") cls = "cur";
  return "c " + cls;
}

function syncCharClass(node: HTMLElement, index: number, typed: string, target: string, status: RunStatus): void {
  const next = charClassName(index, typed, target, status);
  if (node.className !== next) node.className = next;
}

function HotType() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [username, setUsername] = useState("anon");
  const [board, setBoard] = useState<LeaderEntry[] | null>(null);
  const [best, setBest] = useState(0);
  const [streak, setStreak] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [layout, setLayout] = useState<LayoutMode>(() => detectLayoutMode());

  const [idx, setIdx] = useState(0);
  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState<RunStatus>("idle");
  const [startTime, setStartTime] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [keystrokes, setKeystrokes] = useState(0);
  const [errors, setErrors] = useState(0);
  const [finishWpm, setFinishWpm] = useState(0);
  const [finishAcc, setFinishAcc] = useState(100);
  const [finishAccepted, setFinishAccepted] = useState(false);
  const [finishCircuitComplete, setFinishCircuitComplete] = useState(false);
  const [finishBeatBest, setFinishBeatBest] = useState(false);
  const [submittingScore, setSubmittingScore] = useState(false);
  const [showKb, setShowKb] = useState(() => canShowKeyboard());

  const inputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLParagraphElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const charEls = useRef<HTMLElement[]>([]);
  const previousRender = useRef<{ target: string; typed: string; status: RunStatus }>({
    target: "",
    typed: "",
    status: "idle",
  });
  const particles = useRef<any[]>([]);
  const pending = useRef<{ index: number; type: string } | null>(null);
  const reduce = useRef(false);
  const ksRef = useRef(0); // authoritative keystroke count (no async lag)
  const startTimeRef = useRef<number | null>(null);
  const typedRef = useRef("");
  const [rejected, setRejected] = useState<string | null>(null);

  const activePost = posts[idx];
  const target = activePost?.text ?? "";
  const targetMarkup = useMemo(() => ({ __html: buildTargetMarkup(target) }), [target]);

  /* init from server */
  useEffect(() => {
    reduce.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    (async () => {
      try {
        const r = await fetch(ApiEndpoint.Init);
        const d = (await r.json()) as InitResponse;
        if (d.type === "init") {
          setPosts(d.posts);
          setUsername(d.username);
          setBoard(d.leaderboard);
          setBest(d.best);
          setStreak(d.streak);
        }
      } catch (e) {
        console.error("init failed", e);
        setBoard([]);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    const layoutMedia = window.matchMedia?.(DESKTOP_WIDTH_QUERY);
    const keyboardMedia = window.matchMedia?.(KEYBOARD_QUERY);
    if (!layoutMedia || !keyboardMedia) return;

    const sync = () => {
      setLayout(detectLayoutMode());
      if (!keyboardMedia.matches) setShowKb(false);
    };
    sync();

    if (typeof layoutMedia.addEventListener === "function") {
      layoutMedia.addEventListener("change", sync);
      keyboardMedia.addEventListener("change", sync);
      return () => {
        layoutMedia.removeEventListener("change", sync);
        keyboardMedia.removeEventListener("change", sync);
      };
    }

    layoutMedia.addListener(sync);
    keyboardMedia.addListener(sync);
    return () => {
      layoutMedia.removeListener(sync);
      keyboardMedia.removeListener(sync);
    };
  }, []);

  useEffect(() => {
    if (loaded && posts.length > 0) inputRef.current?.focus();
  }, [loaded, posts.length, idx]);

  /* live timer */
  useEffect(() => {
    if (status !== "typing") return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [status]);

  /* particles */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d")!;
    let raf = 0;
    const resize = () => {
      const r = surfaceRef.current!.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      cv.width = r.width * dpr;
      cv.height = r.height * dpr;
      cv.style.width = r.width + "px";
      cv.style.height = r.height + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    const tri = (x: number, y: number, s: number, up: boolean, color: string, a: number) => {
      ctx.globalAlpha = a;
      ctx.fillStyle = color;
      ctx.beginPath();
      if (up) {
        ctx.moveTo(x, y - s);
        ctx.lineTo(x - s * 0.85, y + s * 0.7);
        ctx.lineTo(x + s * 0.85, y + s * 0.7);
      } else {
        ctx.moveTo(x, y + s);
        ctx.lineTo(x - s * 0.85, y - s * 0.7);
        ctx.lineTo(x + s * 0.85, y - s * 0.7);
      }
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    const tick = () => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      const ps = particles.current;
      for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.g;
        p.life -= 0.022;
        if (p.life <= 0) {
          ps.splice(i, 1);
          continue;
        }
        tri(p.x, p.y, p.s, p.up, p.color, Math.max(0, p.life));
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const spawn = (index: number, type: string) => {
    if (reduce.current) return;
    const el = document.getElementById("ch" + index);
    const cv = canvasRef.current;
    if (!el || !cv) return;
    const cr = cv.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const x = r.left - cr.left + r.width / 2;
    const y = r.top - cr.top + r.height / 2;
    const up = type === "ok";
    const color = up ? "#ff4500" : "#7193ff";
    for (let i = 0; i < (up ? 9 : 7); i++) {
      particles.current.push({
        x,
        y,
        vx: (Math.random() - 0.5) * 2.6,
        vy: up ? -(1.4 + Math.random() * 1.8) : 0.6 + Math.random() * 1.2,
        g: up ? 0.06 : 0.12,
        s: 3 + Math.random() * 3,
        up,
        color,
        life: 1,
      });
    }
  };

  useEffect(() => {
    if (pending.current) {
      spawn(pending.current.index, pending.current.type);
      pending.current = null;
    }
  }, [typed]);

  useLayoutEffect(() => {
    const root = textRef.current;
    charEls.current = root ? Array.from(root.querySelectorAll<HTMLElement>(".c")) : [];
    for (let i = 0; i < charEls.current.length; i++) {
      syncCharClass(charEls.current[i], i, typed, target, status);
    }
    previousRender.current = { target, typed, status };
  }, [target, targetMarkup]);

  useLayoutEffect(() => {
    const nodes = charEls.current;
    if (nodes.length === 0) return;

    const previous = previousRender.current;
    if (previous.target !== target) {
      previousRender.current = { target, typed, status };
      return;
    }

    const changed = new Set<number>();
    const start = Math.max(0, Math.min(previous.typed.length, typed.length) - 1);
    const end = Math.max(previous.typed.length, typed.length);
    for (let i = start; i <= end; i++) changed.add(i);
    changed.add(activeCharIndex(previous.typed, target, previous.status));
    changed.add(activeCharIndex(typed, target, status));

    for (const index of changed) {
      if (index >= 0 && index < nodes.length) syncCharClass(nodes[index], index, typed, target, status);
    }

    previousRender.current = { target, typed, status };
  }, [status, target, typed]);

  useLayoutEffect(() => {
    if (!target || (typed.length === 0 && status === "idle")) return;

    const current = document.getElementById("ch" + activeCharIndex(typed, target, status));
    if (!(current instanceof HTMLElement)) return;

    const rect = current.getBoundingClientRect();
    const topGuard = 120;
    const bottomGuard = window.innerHeight - Math.min(window.innerHeight * 0.28, 180);
    if (rect.top >= topGuard && rect.bottom <= bottomGuard) return;

    current.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
  }, [idx, status, target, typed]);

  const syncInputValue = (value: string) => {
    if (inputRef.current && inputRef.current.value !== value) inputRef.current.value = value;
  };

  const setTypedValue = (value: string) => {
    typedRef.current = value;
    setTyped(value);
  };

  const applyProgress = (
    val: string,
    previous: string,
    options?: { allowFinish?: boolean; animate?: boolean },
  ) => {
    const allowFinish = options?.allowFinish ?? true;
    const animate = options?.animate ?? true;

    if (val.length > previous.length) {
      const inserted = val.length - previous.length;
      let errorCount = 0;
      let lastPending: { index: number; type: string } | null = null;

      for (let i = previous.length; i < val.length; i++) {
        const correct = eq(val[i], target[i]);
        if (!correct) {
          errorCount += 1;
          if (animate) lastPending = { index: i, type: "err" };
        } else if (animate && (target[i] === " " || i === target.length - 1)) {
          lastPending = { index: i, type: "ok" };
        }
      }

      ksRef.current += inserted;
      setKeystrokes((k) => k + inserted);
      if (errorCount > 0) setErrors((x) => x + errorCount);
      if (lastPending) pending.current = lastPending;
    }
    setTypedValue(val);
    setNow(Date.now());
    if (allowFinish && val.length === target.length) void finish(val);
  };

  async function beginRun(): Promise<void> {
    setStatus("starting");
    setRejected(null);
    try {
      const r = await fetch(ApiEndpoint.Start, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: idx }),
      });
      const d = (await r.json()) as StartResponse;
      if (d.type !== "start" || !d.ok) throw new Error(d.reason ?? "couldn't start run");

      const startedAt = Date.now();
      startTimeRef.current = startedAt;
      setStartTime(startedAt);
      setStatus("typing");
      if (typedRef.current.length === target.length) void finish(typedRef.current);
    } catch (e) {
      console.error("start failed", e);
      setStatus("idle");
      setTypedValue("");
      setStartTime(null);
      startTimeRef.current = null;
      setKeystrokes(0);
      setErrors(0);
      setFinishWpm(0);
      setFinishAcc(100);
      setFinishAccepted(false);
      setFinishCircuitComplete(false);
      setFinishBeatBest(false);
      setSubmittingScore(false);
      ksRef.current = 0;
      syncInputValue("");
      setRejected(e instanceof Error ? e.message : "couldn't start run");
    }
  }

  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    if (status === "done" || !target) return;

    const previous = typedRef.current;
    const nativeEvent = e.nativeEvent as Event & { inputType?: string };
    const inputType = nativeEvent.inputType;

    let val = e.target.value;
    if (val.length > target.length) val = val.slice(0, target.length);
    if (!val.startsWith(previous) && !previous.startsWith(val)) {
      syncInputValue(previous);
      setRejected("only sequential typing is allowed");
      return;
    }

    const delta = val.length - previous.length;
    if (delta > 1) {
      if (inputType === "insertFromPaste" || inputType === "insertFromDrop") {
        syncInputValue(previous);
        setRejected("paste is disabled");
        return;
      }
      if (!target.startsWith(val)) {
        syncInputValue(previous);
        setRejected("bulk input must match the post text");
        return;
      }
    }

    setRejected(null);

    if (status === "idle") {
      if (delta <= 0) {
        syncInputValue(previous);
        return;
      }
      applyProgress(val, previous, { allowFinish: false, animate: false });
      void beginRun();
      return;
    }

    if (status === "starting") {
      applyProgress(val, previous, { allowFinish: false, animate: false });
      return;
    }

    applyProgress(val, previous);
  };

  const correctCount = (s: string) => {
    let c = 0;
    for (let i = 0; i < s.length; i++) if (eq(s[i], target[i])) c++;
    return c;
  };
  const minutes = Math.max((now - (startTime || now)) / 60000, 1 / 600);
  const liveWpm = startTime ? Math.max(0, Math.round(correctCount(typed) / 5 / minutes)) : 0;
  const accuracy = keystrokes ? Math.round(((keystrokes - errors) / keystrokes) * 100) : 100;
  const displayAccuracy = status === "done" ? finishAcc : accuracy;

  async function finish(finalTyped: string) {
    setStatus("done");
    setSubmittingScore(true);
    setFinishAccepted(false);
    setFinishCircuitComplete(false);
    setFinishBeatBest(false);
    // Optimistic local number for instant feedback; the server's value wins.
    const localStart = startTimeRef.current ?? startTime ?? Date.now();
    const localMin = Math.max((Date.now() - localStart) / 60000, 1 / 600);
    setFinishWpm(Math.max(0, Math.round(correctCount(finalTyped) / 5 / localMin)));
    setFinishAcc(Math.max(0, Math.min(100, Math.round((correctCount(finalTyped) / Math.max(ksRef.current, 1)) * 100))));
    try {
      const bestBeforeSubmit = best;
      const r = await fetch(ApiEndpoint.Score, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: idx, typed: finalTyped, keystrokes: ksRef.current }),
      });
      const d = (await r.json()) as ScoreResponse;
      if (d.type === "score") {
        setBoard(d.leaderboard);
        setBest(d.best);
        setStreak(d.streak);
        setFinishAcc(d.acc);
        setFinishCircuitComplete(d.circuitComplete);
        if (d.accepted) {
          setFinishAccepted(true);
          setFinishBeatBest(d.circuitComplete && d.wpm > bestBeforeSubmit);
          setFinishWpm(d.wpm); // authoritative score replaces the local guess
          setRejected(null);
        } else {
          setFinishAccepted(false);
          setRejected(d.reason ?? "not recorded");
        }
      }
    } catch (e) {
      console.error("score submit failed", e);
      setFinishAccepted(false);
      setRejected("network error");
    } finally {
      setSubmittingScore(false);
    }
  }

  const reset = useCallback(() => {
    setTypedValue("");
    setStatus("idle");
    setStartTime(null);
    startTimeRef.current = null;
    setKeystrokes(0);
    setErrors(0);
    setFinishWpm(0);
    setFinishAcc(100);
    setFinishAccepted(false);
    setFinishCircuitComplete(false);
    setFinishBeatBest(false);
    setSubmittingScore(false);
    setRejected(null);
    ksRef.current = 0;
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.focus();
    }
  }, []);
  const hasNextPost = idx < posts.length - 1;
  const canAdvance = finishAccepted && !submittingScore && hasNextPost;
  const restartCircuit = useCallback(() => {
    setIdx(0);
    reset();
  }, [reset]);
  const nextPost = () => {
    if (!canAdvance) return;
    setIdx((i) => Math.min(i + 1, posts.length - 1));
    reset();
  };
  const focusInput = () => inputRef.current?.focus();
  const nextChar = status === "done" ? null : target[typed.length];
  const remainingPosts = Math.max(posts.length - idx - 1, 0);

  if (!loaded) return <div className={`ht-root ht-${layout} ht-center`}>loading today's posts…</div>;
  if (posts.length === 0)
    return (
      <div className={`ht-root ht-${layout} ht-center`}>
        <style>{CSS}</style>
        <div className="ht-mark">hot<span>type</span></div>
        <p className="empty">no text-heavy posts in this community qualified yet today — check back later.</p>
      </div>
    );

  return (
    <div className={`ht-root ht-${layout}`} onClick={focusInput}>
      <style>{CSS}</style>
      <header className="ht-head">
        <div className="ht-mark">hot<span>type</span></div>
        <div className="ht-streak">{streak > 0 ? `${streak}-day streak` : "no streak yet"}</div>
      </header>

      <div className="ht-eyebrow">
        r/{activePost.sub} <span className="dot">·</span> today's text post <span className="dot">·</span>{" "}
        {fmt(activePost.score)} upvotes <span className="dot">·</span> post {idx + 1}/{posts.length}
      </div>

      <h2 className="ht-post-title">{activePost.title}</h2>

      <div className="ht-main">
        <div className="ht-primary">
          <section className="ht-surface" ref={surfaceRef}>
            <canvas ref={canvasRef} className="ht-canvas" />
            <p ref={textRef} className="ht-text" dangerouslySetInnerHTML={targetMarkup} />
            <input
              ref={inputRef}
              className="ht-input"
              value={typed}
              onChange={onInput}
              onPaste={(e) => {
                e.preventDefault();
                setRejected("paste is disabled");
              }}
              onDrop={(e) => {
                e.preventDefault();
                setRejected("paste is disabled");
              }}
              autoFocus
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-label="typing field"
            />
            {status === "idle" && <div className="ht-hint">start typing to begin</div>}
            {status === "starting" && <div className="ht-hint">locking in the run...</div>}
          </section>

          {rejected && status !== "done" && <div className="ht-notice">{rejected}</div>}

          <div className="ht-stats">
            <div className="stat">
              <span className="num" style={{ color: "#ff4500" }}>{status === "done" ? finishWpm : liveWpm}</span>
              <span className="lbl">wpm</span>
            </div>
            <div className="stat"><span className="num">{displayAccuracy}</span><span className="lbl">% acc</span></div>
            <div className="stat"><span className="num">{best}</span><span className="lbl">best run</span></div>
            <div className="bar"><div className="bar-fill" style={{ width: `${(typed.length / target.length) * 100}%` }} /></div>
          </div>

          {status === "done" && (
            <div className="ht-done">
              <span>
                {finishWpm} wpm <span className="dot">·</span> {finishAcc}% accurate
                {rejected ? (
                  <span className="reject"> · not recorded ({rejected})</span>
                ) : submittingScore ? (
                  <span className="queued"> · recording…</span>
                ) : finishCircuitComplete ? (
                  finishBeatBest ? "  - new circuit best!" : <span className="queued"> · full circuit recorded</span>
                ) : finishAccepted ? (
                  <span className="queued"> · post cleared; {remainingPosts} to go for the board</span>
                ) : (
                  ""
                )}
              </span>
              <div className="ht-actions">
                <button className="btn ghost" onClick={finishAccepted ? restartCircuit : reset} disabled={submittingScore}>
                  {finishAccepted ? (finishCircuitComplete ? "run again" : "restart circuit") : "retry post"}
                </button>
                <button className="btn" onClick={nextPost} disabled={!canAdvance}>
                  {submittingScore ? "recording..." : hasNextPost ? "next post →" : "done for today"}
                </button>
              </div>
            </div>
          )}
        </div>

        <aside className="ht-secondary">
          {showKb && (
            <div className="ht-kb" aria-hidden="true">
              {ROWS.map((row, ri) => (
                <div className="kb-row" key={ri}>
                  {row.map((k) => (
                    <span
                      key={k}
                      className={"key" + (HOME.has(k) ? " home" : "") + (BUMP.has(k) ? " bump" : "") + (nextChar && nextChar.toLowerCase() === k ? " on" : "")}
                    >
                      {k}
                    </span>
                  ))}
                </div>
              ))}
              <div className="kb-row"><span className={"key space" + (nextChar === " " ? " on" : "")}>space</span></div>
            </div>
          )}

          <footer className="ht-foot">
            <div className="lb">
              <div className="lb-title">
                today's circuit leaderboard
                {canShowKeyboard() && (
                  <button className="kb-toggle" onClick={() => setShowKb((s) => !s)}>{showKb ? "hide keys" : "show keys"}</button>
                )}
              </div>
              {board === null ? (
                <div className="lb-empty">loading…</div>
              ) : board.length === 0 ? (
                <div className="lb-empty">be the first to finish the full set today</div>
              ) : (
                <ol className="lb-list">
                  {board.slice(0, 6).map((e, i) => (
                    <li key={i} className={e.name === username ? "me" : ""}>
                      <span className="rank">{i + 1}</span>
                      <span className="who">{e.name}</span>
                      <span className="score">{e.wpm}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="handle">
              <label>playing as</label>
              <div className="who-name">u/{username}</div>
              <p className="note">your fastest full-set run shows on the community board</p>
            </div>
          </footer>
        </aside>
      </div>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Reddit+Sans:wght@400;500;600;700;800&family=Reddit+Mono:wght@400;500;600&display=swap');
.ht-root{--orange:#ff4500;--blue:#7193ff;--ink:#1a1a1b;--muted:#c2c6ca;--line:#ededef;--soft:#f6f7f8;
  font-family:'Reddit Sans',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:var(--ink);background:#fff;
  min-height:100vh;width:100%;margin:0 auto;padding:28px 22px 40px;-webkit-font-smoothing:antialiased;cursor:text;}
.ht-root.ht-mobile{max-width:760px;}
.ht-root.ht-desktop-compact{max-width:820px;padding:32px 26px 42px;}
.ht-root.ht-desktop-wide{max-width:1180px;padding:36px 28px 48px;}
*{box-sizing:border-box;}
.ht-center{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#8a8e93;font-weight:500;}
.empty{font-size:14px;color:#8a8e93;text-align:center;max-width:340px;}
.ht-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:22px;}
.ht-mark{font-weight:800;font-size:20px;letter-spacing:-0.02em;}
.ht-mark span{color:var(--orange);}
.ht-streak{font-size:12.5px;color:#8a8e93;font-weight:500;}
.ht-eyebrow{font-size:13px;color:#8a8e93;margin-bottom:14px;font-weight:500;}
.ht-eyebrow .dot{color:var(--muted);margin:0 4px;}
.ht-post-title{font-size:22px;line-height:1.25;letter-spacing:-0.02em;margin:0 0 18px;max-width:24ch;}
.ht-main{display:flex;flex-direction:column;gap:26px;}
.ht-primary,.ht-secondary{min-width:0;}
.ht-root.ht-desktop-compact .ht-head{margin-bottom:18px;}
.ht-root.ht-desktop-compact .ht-post-title{font-size:26px;max-width:28ch;margin-bottom:20px;}
.ht-root.ht-desktop-compact .ht-text{font-size:25px;line-height:1.58;}
.ht-root.ht-desktop-compact .ht-stats{gap:22px;}
.ht-root.ht-desktop-wide .ht-main{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:36px;align-items:start;}
.ht-root.ht-desktop-wide .ht-post-title{font-size:28px;max-width:30ch;margin-bottom:22px;}
.ht-surface{position:relative;padding:30px 4px 26px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);}
.ht-canvas{position:absolute;inset:0;pointer-events:none;}
.ht-text{font-family:'Reddit Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:27px;line-height:1.7;margin:0;
  font-weight:500;letter-spacing:0.2px;word-break:normal;overflow-wrap:normal;white-space:pre-wrap;position:relative;}
.ht-text .tok{display:inline-block;white-space:pre;vertical-align:top;}
.ht-text .c{color:var(--muted);transition:color .05s linear;scroll-margin-block:96px;}
.ht-text .c.ok{color:var(--ink);}
.ht-text .c.err{color:var(--blue);background:rgba(113,147,255,.13);border-radius:3px;}
.ht-text .c.cur{color:var(--muted);box-shadow:inset 0 -3px 0 var(--orange);border-radius:1px;animation:blink 1s steps(1) infinite;}
@keyframes blink{50%{box-shadow:inset 0 -3px 0 rgba(255,69,0,.25);}}
.ht-input{position:absolute;opacity:0;left:0;top:0;width:1px;height:1px;border:0;padding:0;}
.ht-hint{position:absolute;left:4px;bottom:6px;font-size:12.5px;color:#b3b7bb;font-weight:500;}
.ht-notice{margin-top:10px;font-size:12.5px;color:var(--blue);font-weight:600;}
.ht-stats{display:flex;align-items:center;gap:26px;margin:22px 2px 0;}
.stat{display:flex;align-items:baseline;gap:6px;}
.stat .num{font-family:'Reddit Mono',monospace;font-size:24px;font-weight:600;}
.stat .lbl{font-size:12px;color:#8a8e93;font-weight:500;}
.bar{flex:1;height:4px;background:var(--soft);border-radius:99px;overflow:hidden;min-width:60px;}
.bar-fill{height:100%;background:var(--orange);border-radius:99px;transition:width .08s linear;}
.ht-done{margin-top:18px;font-size:14.5px;font-weight:500;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;}
.ht-done .dot{color:var(--muted);margin:0 4px;}
.ht-done .reject{color:var(--blue);font-weight:600;}
.ht-done .queued{color:#8a8e93;font-weight:600;}
.ht-actions{display:flex;gap:8px;}
.btn{font-family:inherit;font-weight:600;font-size:13.5px;border:0;border-radius:99px;padding:9px 18px;background:var(--orange);color:#fff;cursor:pointer;}
.btn.ghost{background:var(--soft);color:var(--ink);}
.btn:active{transform:translateY(1px);}
.btn:disabled{opacity:.56;cursor:default;transform:none;}
.ht-kb{margin:12px 0 2px;display:flex;flex-direction:column;gap:6px;align-items:center;user-select:none;}
.ht-root.ht-desktop-wide .ht-kb{margin:0;}
.kb-row{display:flex;gap:6px;justify-content:center;}
.key{font-family:'Reddit Mono',monospace;font-size:12.5px;color:#9aa0a6;width:34px;height:34px;display:flex;
  align-items:center;justify-content:center;background:var(--soft);border-radius:7px;position:relative;transition:all .08s ease;}
.key.space{width:200px;font-size:11px;letter-spacing:.08em;}
.key.home{box-shadow:inset 0 -2px 0 #e6e8ea;}
.key.bump::after{content:"";position:absolute;bottom:6px;width:8px;height:2px;background:#cfd3d7;border-radius:2px;}
.key.on{background:var(--orange);color:#fff;transform:translateY(-2px);box-shadow:0 4px 10px rgba(255,69,0,.35);}
.ht-foot{display:grid;gap:18px;margin-top:26px;padding-top:22px;border-top:1px solid var(--line);}
.ht-root.ht-desktop-wide .ht-foot{margin-top:0;padding-top:0;border-top:0;flex-direction:column;gap:24px;}
.lb{min-width:0;}
.lb-title{font-size:13px;font-weight:700;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}
.kb-toggle{background:none;border:0;color:#8a8e93;font-family:inherit;font-size:12px;font-weight:500;cursor:pointer;text-decoration:underline;text-underline-offset:3px;}
.lb-empty{font-size:13px;color:#9aa0a6;}
.lb-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;}
.lb-list li{display:flex;align-items:baseline;gap:10px;font-size:14px;min-width:0;}
.lb-list .rank{font-family:'Reddit Mono',monospace;color:#b3b7bb;width:18px;flex:none;font-size:12.5px;}
.lb-list .who{flex:1;min-width:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lb-list .score{font-family:'Reddit Mono',monospace;font-weight:600;flex:none;white-space:nowrap;}
.lb-list li.me .who,.lb-list li.me .score{color:var(--orange);}
.handle{min-width:0;padding-top:18px;border-top:1px solid var(--line);}
.handle label{font-size:13px;font-weight:700;display:block;margin-bottom:8px;}
.who-name{font-family:'Reddit Mono',monospace;font-size:14px;font-weight:600;}
.note{font-size:11.5px;line-height:1.45;color:#aab0b5;margin:10px 0 0;max-width:32ch;}
@media (min-width:620px){.ht-root.ht-desktop-compact .ht-foot{grid-template-columns:minmax(0,1fr) minmax(200px,240px);gap:20px;align-items:start;}.ht-root.ht-desktop-compact .handle{padding-top:0;border-top:0;}}
@media (max-width:720px){.ht-foot{margin-top:18px;gap:18px;}.ht-post-title{max-width:none;}.ht-text{font-size:23px;line-height:1.62;}}
@media (max-width:540px){.ht-root{padding:24px 18px 34px;}.ht-text{font-size:21px;}.ht-stats{gap:18px;flex-wrap:wrap;}.stat .num{font-size:22px;}.bar{width:100%;flex-basis:100%;}.ht-done{align-items:flex-start;}.ht-actions{width:100%;}.ht-actions .btn{flex:1;}.key{width:28px;height:28px;font-size:11px;}.key.space{width:150px;}}
@media (prefers-reduced-motion:reduce){.ht-text .c.cur{animation:none;}}
`;

createRoot(document.getElementById("root")!).render(<HotType />);
