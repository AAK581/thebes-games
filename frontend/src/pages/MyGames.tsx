/**
 * MyGames — the manage page: everything the signed-in anchor has published,
 * with unpublish and an inline listing editor. Reads my_games (auth'd) from
 * the registry; edits go through update_game — metadata only, no re-upload,
 * and the slug (shelf address) never changes.
 */
import { useEffect, useState } from "react";
import type { MemphisAuth } from "../useMemphis";
import type { Game, Rating } from "../data";
import { myGames, unpublish, updateGame } from "../registry";
import { TagsInput, ResolutionFields, RatingPick } from "../components";

export default function MyGames({
  auth,
  onRequestSignIn,
}: {
  auth: MemphisAuth;
  onRequestSignIn: () => void;
}) {
  const token = auth.session?.session_token_hex;
  const [games, setGames] = useState<Game[] | null>(null);
  const [msg, setMsg] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  async function refresh() {
    if (!token) {
      setGames(null);
      return;
    }
    try {
      setGames(await myGames(token));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function remove(slug: string) {
    if (!token) return;
    if (!window.confirm(`Unpublish "${slug}"? This deletes its bytes from the vault.`))
      return;
    setMsg("removing…");
    try {
      await unpublish(token, slug);
      setMsg(`removed ${slug}`);
      if (editing === slug) setEditing(null);
      await refresh();
    } catch (e) {
      setMsg("couldn't remove: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  if (!auth.signedIn) {
    return (
      <>
        <h1 className="pagetitle">My games</h1>
        <p className="pagelede">
          Sign in to see and manage your uploads.{" "}
          <button className="quiet" onClick={onRequestSignIn}>
            Sign in
          </button>
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="pagetitle">My games</h1>
      <p className="pagelede">
        Everything you've published, owned by your anchor.
      </p>
      {msg && <p className="hint">{msg}</p>}
      {games === null ? (
        <p className="hint">Loading…</p>
      ) : games.length === 0 ? (
        <div className="emptystate">
          <p>
            Nothing published yet. <a href="#/upload">Publish a game.</a>
          </p>
        </div>
      ) : (
        <table className="logtable">
          <thead>
            <tr>
              <th>game</th>
              <th>status</th>
              <th>plays</th>
              <th>★</th>
              <th>served</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {games.map((g) => (
              <GameRow
                key={g.slug}
                game={g}
                token={token!}
                editing={editing === g.slug}
                onToggleEdit={() =>
                  setEditing((cur) => (cur === g.slug ? null : g.slug))
                }
                onSaved={async () => {
                  setEditing(null);
                  setMsg(`updated ${g.slug}`);
                  await refresh();
                }}
                onRemove={() => void remove(g.slug)}
              />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function GameRow({
  game,
  token,
  editing,
  onToggleEdit,
  onSaved,
  onRemove,
}: {
  game: Game;
  token: string;
  editing: boolean;
  onToggleEdit: () => void;
  onSaved: () => Promise<void>;
  onRemove: () => void;
}) {
  return (
    <>
      <tr>
        <td>
          <a href={`#/game/${game.slug}`}>{game.title}</a>
        </td>
        <td>
          {game.status === "quarantined" ? (
            <span className="chip caution">quarantined</span>
          ) : (
            <span className="chip on">live</span>
          )}
        </td>
        <td>{game.plays}</td>
        <td>{game.favorites}</td>
        <td>{game.vaultSlug ? "vault" : "canister"}</td>
        <td>
          <button className="quiet" onClick={onToggleEdit}>
            {editing ? "close" : "edit"}
          </button>{" "}
          <button className="quiet" onClick={onRemove}>
            unpublish
          </button>
        </td>
      </tr>
      {editing && (
        <tr className="editrow">
          <td colSpan={6}>
            <ListingEditor game={game} token={token} onSaved={onSaved} onCancel={onToggleEdit} />
          </td>
        </tr>
      )}
    </>
  );
}

/** The inline listing editor — the same declaration fields as Publish,
    prefilled. Saving replaces the listing's metadata on chain; the game's
    bytes and shelf address stay exactly as they are. */
function ListingEditor({
  game,
  token,
  onSaved,
  onCancel,
}: {
  game: Game;
  token: string;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(game.title);
  const [tagline, setTagline] = useState(game.tagline);
  const [description, setDescription] = useState(game.description);
  const [tags, setTags] = useState<string[]>(game.tags);
  const [rating, setRating] = useState<Rating>(game.rating);
  const [resW, setResW] = useState(game.resW ?? 816);
  const [resH, setResH] = useState(game.resH ?? 624);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const id = (s: string) => `ed-${game.slug}-${s}`;

  async function save() {
    setBusy(true);
    setErr("");
    try {
      await updateGame(token, game.slug, {
        title: title.trim(),
        tagline: tagline.trim(),
        description: description.trim(),
        tags,
        rating,
        resW,
        resH,
      });
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="editpanel">
      <div className="field">
        <label htmlFor={id("title")}>Title</label>
        <input
          id={id("title")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
        />
        <p className="sub">
          The shelf address <code>#/game/{game.slug}</code> stays the same —
          retitling doesn't move the game.
        </p>
      </div>

      <div className="field">
        <label htmlFor={id("tagline")}>Tagline</label>
        <input
          id={id("tagline")}
          value={tagline}
          onChange={(e) => setTagline(e.target.value)}
          disabled={busy}
        />
      </div>

      <div className="field">
        <label htmlFor={id("desc")}>Description</label>
        <textarea
          id={id("desc")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={busy}
        />
      </div>

      <div className="field">
        <label htmlFor={id("res-w")}>Game resolution (px)</label>
        <ResolutionFields
          w={resW}
          h={resH}
          onW={setResW}
          onH={setResH}
          disabled={busy}
          idPrefix={id("res")}
        />
        <p className="hint">
          Your game's native size, so it fills the player without black bars.
          RPG Maker MZ is 816×624; 2560 max per side.
        </p>
      </div>

      <div className="field">
        <label htmlFor={id("tags")}>Tags</label>
        <TagsInput tags={tags} onTags={setTags} disabled={busy} id={id("tags")} />
      </div>

      <div className="field">
        <span className="label">Rating — your declaration, on the record</span>
        <RatingPick
          value={rating}
          onChange={setRating}
          disabled={busy}
          name={id("rating")}
        />
      </div>

      {err && <p className="error">{err}</p>}
      <div className="actions">
        <button className="btn" onClick={() => void save()} disabled={busy || !title.trim()}>
          {busy ? "Saving…" : "Save changes"}
        </button>
        <button className="btn secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
