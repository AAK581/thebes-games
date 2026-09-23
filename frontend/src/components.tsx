/**
 * components.tsx — the catalogue's shared pieces: the mark, chips,
 * section heads, game cards, and the sandboxed player.
 */
import { useEffect, useRef, useState } from "react";
import type { Game } from "./data";
import type { MemphisAuth } from "./useMemphis";
import { useDelegationBridge } from "./useDelegationBridge";
import type { ConsentRequest } from "./useDelegationBridge";
import { coverFor, friezeURI } from "./cover";

/** Step pyramid + sun — inline SVG because unicode hieroglyphs render
    as tofu on common platforms. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="18.6" cy="5" r="2.7" fill="var(--gold)" />
      <rect x="9" y="8" width="6" height="5" fill="var(--lapis)" />
      <rect x="6" y="13" width="12" height="4" fill="var(--lapis)" />
      <rect x="3" y="17" width="18" height="4" fill="var(--lapis)" />
    </svg>
  );
}

/** A repeating strip of the site's pixel glyphs. The SVG is applied as a
    CSS mask so the strip takes whatever color the stylesheet gives it —
    one asset serves both themes. */
export function Frieze() {
  const uri = `url("${friezeURI()}")`;
  return (
    <div
      className="frieze"
      aria-hidden="true"
      style={{ WebkitMaskImage: uri, maskImage: uri }}
    />
  );
}

export function SectionHead({
  title,
  more,
  moreHref,
}: {
  title: string;
  more?: string;
  moreHref?: string;
}) {
  return (
    <div className="sectionhead">
      <h2>{title}</h2>
      <span className="rule" aria-hidden="true" />
      {more && moreHref && (
        <a className="more" href={moreHref}>
          {more} →
        </a>
      )}
    </div>
  );
}

export function RatingChip({ rating }: { rating: Game["rating"] }) {
  const label =
    rating === "E" ? "E · everyone" : rating === "T" ? "T · teen" : "M · mature";
  return <span className={`chip rating ${rating.toLowerCase()}`}>{label}</span>;
}

export function GameCard({ game }: { game: Game }) {
  const quarantined = game.status === "quarantined";
  return (
    <a
      className={quarantined ? "card dim" : "card"}
      href={`#/game/${game.slug}`}
    >
      <div className="cover">
        <img src={coverFor(game.slug)} alt="" loading="lazy" />
        {game.featured && !quarantined && (
          <span className="chip gold flag">★ staff shelf</span>
        )}
        {quarantined && <span className="chip caution flag">under review</span>}
        {!quarantined && (
          <span className="playbadge" aria-hidden="true">
            <span>▶</span>
          </span>
        )}
      </div>
      <div className="meta">
        <h3>{game.title}</h3>
        <p className="owner">{game.owner}</p>
        <p className="stats">
          ▶ {game.plays} · ☆ {game.favorites}
        </p>
        <div className="chiprow">
          {game.tags.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
          <RatingChip rating={game.rating} />
        </div>
      </div>
    </a>
  );
}

/* ─── the player ─────────────────────────────────────────────────────── */

/**
 * The opaque-origin sandbox (below) means the game document has NO
 * localStorage/sessionStorage/cookies — the accessors THROW, and games
 * that read storage during boot (Basra does, in a useState initializer)
 * white-screen. So the player doesn't point the iframe at the game
 * directly: it fetches the game's index.html, injects (1) a <base> tag
 * so the game's relative assets still resolve against its canister path,
 * and (2) a first-to-run script that replaces window storage with an
 * in-memory shim.
 *
 * The <base> href MUST be absolute (origin + path). A path-only href
 * like "/_/raw/<cid>/" is resolved against the document's fallback base
 * URL, and for an about:srcdoc frame in a sandbox that omits
 * allow-same-origin the fallback is unreliable — the browser drops it
 * and the game's "./assets/x.js" resolves against the SITE ROOT instead
 * (http://host/assets/x.js), which 404s / fails CORS. An absolute base
 * needs no fallback, so the assets resolve to the canister path and load
 * (the gateway serves them with `access-control-allow-origin: *`, which
 * is what lets an opaque-origin frame fetch them cross-origin at all).
 *
 * Saves don't persist between sessions yet — a
 * postMessage save API to the platform (and the chain) is the planned
 * upgrade. indexedDB is not shimmed; games that hard-require it get the
 * standalone link.
 */
function wrapGameHtml(html: string, baseHref: string): string {
  const shim =
    "<script>(function(){" +
    "function mem(){var m=new Map();return{" +
    "get length(){return m.size}," +
    "key:function(i){return Array.from(m.keys())[i]!==undefined?Array.from(m.keys())[i]:null}," +
    "getItem:function(k){return m.has(String(k))?m.get(String(k)):null}," +
    "setItem:function(k,v){m.set(String(k),String(v))}," +
    "removeItem:function(k){m.delete(String(k))}," +
    "clear:function(){m.clear()}};}" +
    "try{Object.defineProperty(window,'localStorage',{value:mem(),configurable:true});}catch(e){}" +
    "try{Object.defineProperty(window,'sessionStorage',{value:mem(),configurable:true});}catch(e){}" +
    "try{Object.defineProperty(Document.prototype,'cookie',{get:function(){return ''},set:function(){},configurable:true});}catch(e){}" +
    "})();</scr" +
    "ipt>";
  const base = `<base href="${baseHref}">`;
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], head[0] + base + shim);
  return base + shim + html;
}

type Phase = "idle" | "loading" | "running" | "error";

/**
 * Games render into a fixed virtual desktop viewport and the iframe is
 * CSS-scaled to fit the stage. Without this, the iframe inherits the
 * article column's width (~790px) and games' own responsive headers
 * break — Basra's topbar piles its buttons over its title. 1280×800
 * matches the stage's 16:10 and is a size every embedded game already
 * handles standalone.
 */
const VIRTUAL_W = 1280;
const VIRTUAL_H = 800;

/**
 * PlayerShell — where a game actually runs.
 *
 * SECURITY INVARIANT — the one rule that keeps the whole site safe on
 * this substrate: every app on the gateway shares ONE origin, so a game
 * iframed with same-origin rights could read the platform's localStorage
 * — including Memphis session tokens for this and every other app the
 * user has visited. The sandbox attribute below deliberately OMITS
 * `allow-same-origin`, giving the game an opaque origin: scripts run,
 * the game plays, but cookies, storage, and the parent DOM do not exist
 * for it (the boot shim above fills the storage gap). Never add
 * `allow-same-origin` or `allow-top-navigation` here.
 *
 * `allow-forms` IS present and IS safe: it only lets the game submit its
 * own in-frame forms (without it, a game's <form> submit is blocked and
 * console-errors). It grants no origin, storage, or parent access, so it
 * does not weaken the invariant above. Note passkey sign-in inside a
 * game still can't work here — WebAuthn refuses an opaque origin, and by
 * design the game cannot reach the parent's Memphis session; use the
 * standalone link to sign into a game's own account.
 */
export function PlayerShell({
  game,
  auth,
  onRequestSignIn,
}: {
  game: Game;
  auth: MemphisAuth;
  onRequestSignIn: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [doc, setDoc] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [bootCount, setBootCount] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [fit, setFit] = useState({ scale: 0, x: 0, y: 0 });
  const src = game.cid ? `/_/raw/${game.cid}/index.html` : null;

  // Memphis delegated sign-in (dormant unless window.THEBES_DELEGATION).
  // Answers the game SDK's handshake while the game is running; returns a
  // consent request to render when the user hasn't yet allowed this game.
  const { consent } = useDelegationBridge({
    frameRef,
    game,
    auth,
    running: phase === "running",
    onRequestSignIn,
  });

  // Scale the virtual viewport to the stage, letterboxing on mismatch.
  // The observer also covers fullscreen: the stage is the fullscreen
  // element, so entering/leaving refits automatically.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const refit = () => {
      const r = el.getBoundingClientRect();
      const scale = Math.min(r.width / VIRTUAL_W, r.height / VIRTUAL_H);
      setFit({
        scale,
        x: (r.width - VIRTUAL_W * scale) / 2,
        y: (r.height - VIRTUAL_H * scale) / 2,
      });
    };
    refit();
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  async function boot() {
    if (!src || !game.cid) return;
    setPhase("loading");
    try {
      const r = await fetch(src, { cache: "no-store" });
      if (!r.ok) throw new Error(`gateway answered ${r.status}`);
      // Absolute base — see wrapGameHtml. window.location.origin is the
      // dev host under `npm run dev` (assets proxy through /_) and the
      // gateway origin in production; both make /_/raw/<cid>/ resolve.
      const base = `${window.location.origin}/_/raw/${game.cid}/`;
      setDoc(wrapGameHtml(await r.text(), base));
      setPhase("running");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  if (!src) {
    return (
      <div className="player">
        <div className="stage">
          <img className="backdrop" src={coverFor(game.slug)} alt="" />
          <div className="boot">
            <span className="sandboxnote">
              playable build not in the vault yet — registry entry only
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="player">
      <div className="stage" ref={stageRef}>
        {phase === "running" && doc ? (
          <iframe
            key={bootCount}
            ref={frameRef}
            srcDoc={doc}
            title={game.title}
            sandbox="allow-scripts allow-pointer-lock allow-forms"
            allow="fullscreen; gamepad; autoplay"
            referrerPolicy="no-referrer"
            width={VIRTUAL_W}
            height={VIRTUAL_H}
            style={{
              transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})`,
            }}
          />
        ) : (
          <>
            <img className="backdrop" src={coverFor(game.slug)} alt="" />
            {phase === "loading" && (
              <div className="statusline">fetching the bundle from the chain…</div>
            )}
            {phase === "error" && (
              <div className="statusline iserror">
                couldn't fetch the game — {error}. Try again, or open it
                standalone below.
              </div>
            )}
            {(phase === "idle" || phase === "error") && (
              <div className="boot">
                <button className="play" onClick={() => void boot()}>
                  ▶ {phase === "error" ? "Retry" : "Play"}
                </button>
                <span className="sandboxnote">
                  runs sandboxed · opaque origin · no access to your session
                </span>
              </div>
            )}
          </>
        )}
      </div>
      <div className="deck">
        {phase === "running" ? (
          <>
            <button
              className="quiet"
              onClick={() => setBootCount((n) => n + 1)}
            >
              ↺ restart
            </button>
            <button
              className="quiet"
              onClick={() => void stageRef.current?.requestFullscreen()}
            >
              ⛶ fullscreen
            </button>
            <button
              className="quiet"
              onClick={() => {
                setPhase("idle");
                setDoc(null);
              }}
            >
              ■ stop
            </button>
          </>
        ) : (
          <span className="chip">{game.sizeMB.toFixed(1)} MB</span>
        )}
        <span className="spacer" />
        <a
          className="standalone"
          href={src}
          target="_blank"
          rel="noopener noreferrer"
        >
          standalone ↗
        </a>
      </div>
    </div>
    <p className="playernote">
      <span aria-hidden="true">⊙</span> Sign-in and saves live in the
      game's own window. Play here runs sandboxed — an opaque origin with
      no reach into your account or the chain — so a game's own sign-in
      button can't work embedded.{" "}
      <a href={src} target="_blank" rel="noopener noreferrer">
        Open it standalone ↗
      </a>{" "}
      to sign in.
    </p>
    {consent && <ConsentDialog consent={consent} />}
    </>
  );
}

/**
 * Consent gate for handing a game your identity. Rendered by the PLATFORM
 * (top-level), never inside the game frame — the game cannot fake or skip
 * it. Approving mints a token scoped only to this game.
 */
function ConsentDialog({ consent }: { consent: ConsentRequest }) {
  return (
    <div
      className="consentveil"
      role="dialog"
      aria-modal="true"
      aria-label="Sign in to this game"
    >
      <div className="consentcard">
        <h3>Play as {consent.anchorName || "you"}?</h3>
        <p>
          Sign in to <strong>{consent.gameName}</strong> as{" "}
          <strong>{consent.anchorName || "your Memphis identity"}</strong>. The
          game receives a token scoped <em>only</em> to itself — never your
          Thebes session or any other app — and it expires shortly.
        </p>
        <div className="row">
          <button onClick={consent.onAllow}>
            Play as {consent.anchorName || "me"}
          </button>
          <button className="secondary" onClick={consent.onDeny}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
