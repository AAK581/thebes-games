/**
 * Game — a single game's page: the sandboxed player (or the quarantine
 * interstitial), the description, and the on-chain facts rail.
 */
import { gameBySlug } from "../data";
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
  const game = gameBySlug(slug);

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

          <div className="prose">
            <p>{game.description}</p>
          </div>
        </div>

        <aside className="facts">
          <span
            className="chip"
            title="Creator, version, plays and favorites are placeholders until the registry canister lands. The canister id is real."
          >
            demo data — registry pending
          </span>
          <dl>
            <dt>creator</dt>
            <dd>{game.owner}</dd>
            <dt>version</dt>
            <dd>{game.version}</dd>
            <dt>updated</dt>
            <dd>{game.updated}</dd>
            <dt>size</dt>
            <dd>{game.sizeMB.toFixed(1)} MB</dd>
            <dt>plays</dt>
            <dd>{game.plays}</dd>
            <dt>favorites</dt>
            <dd>☆ {game.favorites}</dd>
            {game.cid && (
              <>
                <dt>canister</dt>
                <dd>{game.cid}</dd>
              </>
            )}
          </dl>
          <div className="chiprow">
            {game.tags.map((t) => (
              <span key={t} className="chip">
                {t}
              </span>
            ))}
            <RatingChip rating={game.rating} />
          </div>
          <button className="quiet report" disabled title="lands with the registry canister">
            ⚑ report this game
          </button>
        </aside>
      </div>
    </>
  );
}
