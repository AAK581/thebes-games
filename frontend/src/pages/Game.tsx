/**
 * Game — a single game's page: the sandboxed player (or the quarantine
 * interstitial), the description, and the on-chain facts rail.
 */
import { useEffect, useState } from "react";
import { gameBySlug, type Game } from "../data";
import { getGame, isFavorite, report, toggleFavorite } from "../registry";
import { PlayerShell, RatingChip } from "../components";
import { spriteURI } from "../cover";
import type { MemphisAuth } from "../useMemphis";

export default function GamePage({
  slug,
  auth,
  onRequestSignIn,
}: {
  slug: string;
  auth: MemphisAuth;
  onRequestSignIn: () => void;
}) {
  // undefined = loading, null = not found. Prefer the chain; on a network
  // error (e.g. the registry isn't deployed yet) fall back to the mock.
  const [game, setGame] = useState<Game | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setGame(undefined);
    getGame(slug)
      .then((g) => {
        if (alive) setGame(g);
      })
      .catch(() => {
        if (alive) setGame(gameBySlug(slug) ?? null);
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  const token = auth.session?.session_token_hex;
  const [fav, setFav] = useState(false);
  const [favCount, setFavCount] = useState(0);
  const [reportMsg, setReportMsg] = useState("");
  useEffect(() => {
    if (game) setFavCount(game.favorites);
  }, [game]);
  useEffect(() => {
    if (token && game) isFavorite(token, game.slug).then(setFav).catch(() => {});
    else setFav(false);
  }, [token, game]);

  if (game === undefined) {
    return (
      <div className="emptystate">
        <img className="pixelglyph" src={spriteURI("scarab")} alt="" />
        <p>Loading from the chain…</p>
      </div>
    );
  }

  if (!game) {
    return (
      <div className="emptystate">
        <img className="pixelglyph" src={spriteURI("eye")} alt="" />
        <p>
          No game answers to that name. <a href="#/">Back to the shelves.</a>
        </p>
      </div>
    );
  }

  const quarantined = game.status === "quarantined";
  const g = game; // narrowed to Game past the guards

  async function toggleFav() {
    if (!token) return onRequestSignIn();
    try {
      const now = await toggleFavorite(token, g.slug);
      setFav(now);
      setFavCount((c) => c + (now ? 1 : -1));
    } catch (e) {
      setReportMsg(e instanceof Error ? e.message : String(e));
    }
  }

  async function doReport() {
    if (!token) return onRequestSignIn();
    const reason = window
      .prompt("Why report this game? (stolen, malware, harassment, other)")
      ?.trim();
    if (!reason) return;
    setReportMsg("reporting…");
    try {
      await report(token, g.slug, reason);
      setReportMsg("Reported — thank you. Curators review at the threshold.");
    } catch (e) {
      setReportMsg("Couldn't report: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  return (
    <>
      <p className="crumb">
        <a href="#/">← shelves</a>
      </p>

      <div className="gamepage">
        <div>
          <header className="head">
            <h1>{game.title}</h1>
            <p className="tagline">{game.tagline}</p>
          </header>

          {quarantined ? (
            <div className="interstitial">
              <h2>Under curator review</h2>
              <p>
                This game crossed the community report threshold and is
                quarantined while a randomly-drawn panel of three curators
                reviews it — case&nbsp;#{game.caseId}, verdict due within 72
                hours of the first vote.
              </p>
              <p>
                Every action in the case is public on the{" "}
                <a href="#/log">transparency log</a>. If the reports are not
                substantiated, the game returns exactly as it was.
              </p>
            </div>
          ) : (
            <PlayerShell
              game={game}
              auth={auth}
              onRequestSignIn={onRequestSignIn}
            />
          )}

          {g.shotUrls && g.shotUrls.length > 0 && (
            <ShotGallery urls={g.shotUrls} title={g.title} />
          )}

          <div className="prose">
            <p>{game.description}</p>
          </div>
        </div>

        <aside className="facts">
          <dl>
            <dt>creator</dt>
            <dd>{g.owner}</dd>
            <dt>updated</dt>
            <dd>{g.updated}</dd>
            {g.sizeMB > 0 && (
              <>
                <dt>size</dt>
                <dd>{g.sizeMB.toFixed(1)} MB</dd>
              </>
            )}
            <dt>plays</dt>
            <dd>{g.plays}</dd>
            <dt>favorites</dt>
            <dd>★ {favCount}</dd>
          </dl>
          <div className="chiprow">
            {g.tags.map((t) => (
              <span key={t} className="chip">
                {t}
              </span>
            ))}
            <RatingChip rating={g.rating} />
          </div>
          <div className="factactions">
            <button className="quiet" onClick={() => void toggleFav()}>
              {fav ? "★ favorited" : "☆ favorite"}
            </button>
            <button className="quiet report" onClick={() => void doReport()}>
              ⚑ report
            </button>
          </div>
          {reportMsg && <p className="hint">{reportMsg}</p>}
        </aside>
      </div>
    </>
  );
}

/** The creator's screenshots: a strip of thumbnails, click to open one full
    size. Kept below the player — you came to play, not to browse stills. */
function ShotGallery({ urls, title }: { urls: string[]; title: string }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <div className="shotstrip">
        {urls.map((u, i) => (
          <button
            key={u}
            type="button"
            className="shotthumb"
            onClick={() => setOpen(i)}
            aria-label={`${title} screenshot ${i + 1} of ${urls.length}`}
          >
            <img src={u} alt="" loading="lazy" />
          </button>
        ))}
      </div>
      {open !== null && (
        <div
          className="shotveil"
          role="dialog"
          aria-modal="true"
          aria-label={`${title} screenshot ${open + 1}`}
          onClick={() => setOpen(null)}
        >
          <img src={urls[open]} alt="" />
          <button className="shotclose" type="button" aria-label="close">
            ×
          </button>
        </div>
      )}
    </>
  );
}
