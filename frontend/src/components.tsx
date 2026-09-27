/**
 * components.tsx — the catalogue's shared pieces: the mark, chips,
 * section heads, game cards, the sandboxed player, and the listing-form
 * fields (tags, rating, resolution) shared by Publish and My Games' editor.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Game, Rating } from "./data";
import type { MemphisAuth } from "./useMemphis";
import { useDelegationBridge } from "./useDelegationBridge";
import type { ConsentRequest } from "./useDelegationBridge";
import { VAULT_CID, recordPlay } from "./registry";
import { coverFor, friezeURI } from "./cover";
import { TAG_MAX_COUNT, cleanTag } from "./tagPolicy";

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
        <img src={game.coverUrl ?? coverFor(game.slug)} alt="" loading="lazy" />
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
 * Games render into a virtual viewport sized to the game's OWN native resolution
 * — publisher-set at upload (e.g. RPG Maker MZ's 816×624) — and the iframe is
 * CSS-scaled to fit the stage. The stage's aspect-ratio matches that resolution,
 * so the game FILLS the frame instead of letterboxing (the "weird resolution"
 * was a 4:3 game floating inside a fixed 16:10 frame). 816×624 is the fallback
 * for games published before the field existed; clamped for safety.
 */
const RES_FALLBACK_W = 816;
const RES_FALLBACK_H = 624;
const RES_MIN = 200;
const RES_MAX = 2560;
const clampRes = (n: number, fallback: number) =>
  Math.min(RES_MAX, Math.max(RES_MIN, n || fallback));

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
  const vw = clampRes(game.resW ?? RES_FALLBACK_W, RES_FALLBACK_W);
  const vh = clampRes(game.resH ?? RES_FALLBACK_H, RES_FALLBACK_H);
  // Where the game's files live: the platform vault (uploaded) at
  // /_/raw/<vault>/g/<slug>/, or the game's own canister at /_/raw/<cid>/.
  const gamePath = game.vaultSlug
    ? `/_/raw/${VAULT_CID}/g/${game.vaultSlug}/`
    : game.cid
      ? `/_/raw/${game.cid}/`
      : null;
  const src = gamePath ? `${gamePath}index.html` : null;

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
      const scale = Math.min(r.width / vw, r.height / vh);
      setFit({
        scale,
        x: (r.width - vw * scale) / 2,
        y: (r.height - vh * scale) / 2,
      });
    };
    refit();
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [vw, vh]);

  async function boot() {
    if (!src || !gamePath) return;
    setPhase("loading");
    void recordPlay(game.slug).catch(() => {}); // fire-and-forget play count
    try {
      const r = await fetch(src, { cache: "no-store" });
      if (!r.ok) throw new Error(`gateway answered ${r.status}`);
      // Absolute base — see wrapGameHtml. window.location.origin is the
      // dev host under `npm run dev` (assets proxy through /_) and the
      // gateway origin in production; both make the game path resolve.
      const base = `${window.location.origin}${gamePath}`;
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
          <img className="backdrop" src={game.coverUrl ?? coverFor(game.slug)} alt="" />
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
      <div className="stage" ref={stageRef} style={{ aspectRatio: `${vw} / ${vh}` }}>
        {phase === "running" && doc ? (
          <iframe
            key={bootCount}
            ref={frameRef}
            srcDoc={doc}
            title={game.title}
            sandbox="allow-scripts allow-pointer-lock allow-forms"
            allow="fullscreen; gamepad; autoplay"
            referrerPolicy="no-referrer"
            width={vw}
            height={vh}
            style={{
              transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.scale})`,
            }}
          />
        ) : (
          <>
            <img className="backdrop" src={game.coverUrl ?? coverFor(game.slug)} alt="" />
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

/* ─── listing-form fields — shared by Publish and My Games' editor ────── */

// A starting vocabulary people can click instead of inventing their own — keeps
// the shelf's tags consistent and browsable. Free typing still works alongside.
const SUGGESTED_TAGS = [
  "action", "adventure", "arcade", "platformer", "puzzle", "rpg",
  "shooter", "strategy", "roguelike", "simulation", "racing", "fighting",
  "horror", "survival", "sandbox", "cards", "rhythm", "visual-novel",
  "metroidvania", "tower-defense", "2d", "3d", "pixel-art", "multiplayer",
  "co-op", "retro", "casual", "classic", "comedy",
];

/**
 * Chip tokenizer for tags, itch-style: comma or Enter commits, Backspace on an
 * empty entry pops the last chip, suggestions filter as you type. Entries run
 * through tagPolicy (instant feedback; the backend enforces the same rules as
 * the guarantee). Renders the field BODY only — the caller owns the
 * surrounding .field, label, and hint line.
 */
export function TagsInput({
  tags,
  onTags,
  disabled = false,
  id = "tags",
}: {
  tags: string[];
  onTags: (next: string[]) => void;
  disabled?: boolean;
  id?: string;
}) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState("");

  function commit(raw: string) {
    if (!raw.trim()) {
      setDraft("");
      return;
    }
    const res = cleanTag(raw);
    setDraft("");
    if (!res.ok) {
      // Blocked or malformed (e.g. a slur / illegal-content tag) — say so, add nothing.
      setErr(res.reason);
      return;
    }
    setErr("");
    if (!tags.includes(res.tag) && tags.length < TAG_MAX_COUNT)
      onTags([...tags, res.tag]);
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
      onTags(tags.slice(0, -1));
    } else if (err) {
      setErr(""); // clear the warning as they keep editing
    }
  }

  const q = draft.trim().toLowerCase();
  const suggested = SUGGESTED_TAGS.filter(
    (t) => !tags.includes(t) && (q === "" || t.includes(q))
  ).slice(0, 12);

  return (
    <>
      <div className="tagsinput">
        {tags.map((t) => (
          <span key={t} className="chip on tagchip">
            {t}
            <button
              type="button"
              className="tagx"
              aria-label={`remove ${t}`}
              onClick={() => onTags(tags.filter((x) => x !== t))}
              disabled={disabled}
            >
              ×
            </button>
          </span>
        ))}
        {tags.length < TAG_MAX_COUNT && (
          <input
            id={id}
            className="tagentry"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (err) setErr("");
            }}
            onKeyDown={onKey}
            onBlur={() => commit(draft)}
            placeholder={tags.length ? "add another…" : "type your own, or pick below"}
            disabled={disabled}
          />
        )}
      </div>
      {tags.length < TAG_MAX_COUNT && suggested.length > 0 && (
        <div className="tagsuggest">
          {suggested.map((t) => (
            <button
              key={t}
              type="button"
              className="chip suggest"
              onClick={() => commit(t)}
              disabled={disabled}
            >
              + {t}
            </button>
          ))}
        </div>
      )}
      {err ? (
        <p className="error">{err}</p>
      ) : (
        <p className="sub">
          Click a suggestion or type your own — Enter or comma to add · {tags.length}/
          {TAG_MAX_COUNT}
        </p>
      )}
    </>
  );
}

/** The two native-resolution px inputs with a × between. The caller owns the
    label and hint; the backend clamps to the same 200–2560 bounds. */
export function ResolutionFields({
  w,
  h,
  onW,
  onH,
  disabled = false,
  idPrefix = "res",
}: {
  w: number;
  h: number;
  onW: (n: number) => void;
  onH: (n: number) => void;
  disabled?: boolean;
  idPrefix?: string;
}) {
  return (
    <div className="resinput">
      <input
        id={`${idPrefix}-w`}
        type="number"
        min={200}
        max={2560}
        value={w}
        onChange={(e) => onW(Number(e.target.value) || 0)}
        disabled={disabled}
      />
      <span aria-hidden="true">×</span>
      <input
        id={`${idPrefix}-h`}
        type="number"
        min={200}
        max={2560}
        value={h}
        onChange={(e) => onH(Number(e.target.value) || 0)}
        disabled={disabled}
      />
    </div>
  );
}

/** The rating declaration — full descriptions on purpose: changing a rating is
    the same on-the-record declaration as making it at publish time. */
export function RatingPick({
  value,
  onChange,
  disabled = false,
  name = "rating",
}: {
  value: Rating | null;
  onChange: (r: Rating) => void;
  disabled?: boolean;
  name?: string;
}) {
  return (
    <div className="ratingpick">
      {(["E", "T", "M"] as Rating[]).map((r) => (
        <label key={r}>
          <input
            type="radio"
            name={name}
            checked={value === r}
            onChange={() => onChange(r)}
            disabled={disabled}
          />
          <span>
            {r === "E" ? (
              <>
                <b>E · everyone</b> — no violence beyond cartoon slapstick,
                no strong language.
              </>
            ) : r === "T" ? (
              <>
                <b>T · teen</b> — stylized combat, mild language, tense
                themes.
              </>
            ) : (
              <>
                <b>M · mature</b> — realistic violence, strong language.
                Still no sexual content — there is no rating for that here.
              </>
            )}
          </span>
        </label>
      ))}
    </div>
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
