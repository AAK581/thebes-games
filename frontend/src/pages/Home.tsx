/**
 * Home — the browse page: one featured game up top, a tag rail, and the
 * catalogue grid. Quarantined games are never shown here; they surface
 * only on their own page (as an interstitial) and in the public log.
 */
import { useState } from "react";
import { GameCard, SectionHead } from "../components";
import { coverFor, spriteURI } from "../cover";
import { useCatalogue } from "../useCatalogue";

export default function Home() {
  const [tag, setTag] = useState<string | null>(null);
  const { games } = useCatalogue();

  const visible = games.filter((g) => g.status === "live");
  const tags = Array.from(new Set(visible.flatMap((g) => g.tags))).sort();
  const hero = visible.find((g) => g.featured) ?? visible[0];
  const catalogue = visible
    .filter((g) => (tag ? g.tags.includes(tag) : true))
    .sort((a, b) => (a.updated < b.updated ? 1 : -1));

  return (
    <>
      {hero && (
        <section className="hero">
          <div className="copy">
            <p className="kicker">★ staff shelf · featured</p>
            <h2>{hero.title}</h2>
            <p className="tagline">{hero.tagline}</p>
            <p className="byline">
              by {hero.owner} · ▶ {hero.plays} · ☆ {hero.favorites}
            </p>
            <div className="actions">
              <a className="btn" href={`#/game/${hero.slug}`}>
                ▶ Play now
              </a>
              <a className="btn secondary" href="#/upload">
                Publish yours
              </a>
            </div>
          </div>
          <a
            className="artlink"
            href={`#/game/${hero.slug}`}
            aria-label={`Open ${hero.title}`}
          >
            <img className="art" src={coverFor(hero.slug)} alt="" />
            <span className="playbadge" aria-hidden="true">
              <span>▶</span>
            </span>
          </a>
        </section>
      )}

      <SectionHead title="Browse the shelves" />
      <div className="chiprow" role="group" aria-label="filter by tag">
        <button
          className={tag === null ? "chip on" : "chip"}
          onClick={() => setTag(null)}
        >
          all
        </button>
        {tags.map((t) => (
          <button
            key={t}
            className={tag === t ? "chip on" : "chip"}
            onClick={() => setTag(tag === t ? null : t)}
          >
            {t}
          </button>
        ))}
      </div>

      <SectionHead title="New this week" more="transparency log" moreHref="#/log" />
      {catalogue.length > 0 ? (
        <div className="grid">
          {catalogue.map((g) => (
            <GameCard key={g.slug} game={g} />
          ))}
        </div>
      ) : (
        <div className="emptystate">
          <img className="pixelglyph" src={spriteURI("scarab")} alt="" />
          <p>Nothing on this shelf yet — try another tag.</p>
        </div>
      )}
    </>
  );
}
