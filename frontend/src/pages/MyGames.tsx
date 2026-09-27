/**
 * MyGames — the manage page: everything the signed-in anchor has published,
 * with unpublish and an inline listing editor. Reads my_games (auth'd) from
 * the registry; edits go through update_game — metadata only, no re-upload,
 * and the slug (shelf address) never changes.
 */
import { useEffect, useState } from "react";
import type { MemphisAuth } from "../useMemphis";
import type { Game, Rating } from "../data";
import {
  myGames,
  unpublish,
  updateGame,
  setCover,
  clearCover,
  adoptableGames,
  adoptGame,
  amIOwner,
  addShot,
  removeShot,
  shotUrl,
  MAX_SHOTS,
} from "../registry";
import { TagsInput, ResolutionFields, RatingPick } from "../components";
import { prepareCover, COVER_MAX_DIM } from "../coverPrep";
import { coverFor } from "../cover";

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
  // The seeded house listings nobody owns, and whether we're the one account
  // allowed to adopt them (the backend enforces it either way).
  const [adoptable, setAdoptable] = useState<Game[]>([]);
  const [owner, setOwner] = useState(false);

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
    // Non-fatal: an older backend has neither call, and the page still works.
    adoptableGames().then(setAdoptable).catch(() => setAdoptable([]));
    amIOwner(token).then(setOwner).catch(() => setOwner(false));
  }
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function adopt(slug: string) {
    if (!token) return;
    setMsg(`adopting ${slug}…`);
    try {
      await adoptGame(token, slug);
      setMsg(`adopted ${slug} — it's yours to edit now`);
      await refresh();
      setEditing(slug); // straight into the editor, which is why you adopted it
    } catch (e) {
      setMsg("couldn't adopt: " + (e instanceof Error ? e.message : String(e)));
    }
  }

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
              <th>shots</th>
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

      {owner && adoptable.length > 0 && (
        <>
          <h2 className="sectionhead" style={{ marginTop: "2rem" }}>
            House shelf
          </h2>
          <p className="sub">
            The seeded staff listings. They were published without an owner
            anchor, so nobody could edit them — adopt one to take over its
            listing (cover, description, tags, rating). The public byline keeps
            reading “{adoptable[0].owner}”.
          </p>
          <table className="logtable">
            <thead>
              <tr>
                <th>game</th>
                <th>cover</th>
                <th>shots</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {adoptable.map((g) => (
                <tr key={g.slug}>
                  <td>
                    <a href={`#/game/${g.slug}`}>{g.title}</a>
                  </td>
                  <td>{g.coverUrl ? "yes" : "—"}</td>
                  <td>{g.shotUrls?.length || "—"}</td>
                  <td>
                    <button className="quiet" onClick={() => void adopt(g.slug)}>
                      adopt
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
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
        <td>{game.shotUrls?.length || "—"}</td>
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
  // Cover: `pending` is a newly picked image not yet uploaded; `dropCover`
  // marks the existing one for removal on save. Both are applied by save() so
  // the whole edit is one confirmed action rather than surprise side effects.
  const [pending, setPending] = useState<
    { bytes: Uint8Array; type: string; w: number; h: number; name: string } | null
  >(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dropCover, setDropCover] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [status, setStatus] = useState("");

  const id = (s: string) => `ed-${game.slug}-${s}`;

  // Revoke the object URL when it's replaced or the editor closes — these leak
  // the whole image otherwise.
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  async function pickCover(f: File | null) {
    setErr("");
    if (!f) return;
    setCoverBusy(true);
    try {
      const prep = await prepareCover(f);
      setPending({ ...prep, name: f.name });
      setPreview((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(new Blob([prep.bytes], { type: prep.type }));
      });
      setDropCover(false); // picking a new one overrides a pending removal
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCoverBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setErr("");
    try {
      setStatus("saving listing…");
      await updateGame(token, game.slug, {
        title: title.trim(),
        tagline: tagline.trim(),
        description: description.trim(),
        tags,
        rating,
        resW,
        resH,
      });
      // Cover last: the metadata is the part you'd hate to lose, and a cover
      // upload is many chunked calls.
      if (pending) {
        setStatus("uploading cover…");
        await setCover(token, game.slug, pending.type, pending.bytes);
      } else if (dropCover && game.coverUrl) {
        setStatus("removing cover…");
        await clearCover(token, game.slug);
      }
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStatus("");
      setBusy(false);
    }
  }

  // What the shelf will show once saved.
  const shownCover = pending
    ? preview
    : dropCover
      ? coverFor(game.slug)
      : game.coverUrl || coverFor(game.slug);

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

      <div className="field">
        <span className="label">
          Cover image (PNG/JPG/WebP · max {COVER_MAX_DIM}px · auto-shrunk)
        </span>
        <div className="coveredit">
          <img className="coverthumb" src={shownCover ?? undefined} alt="" />
          <div className="coveredit-controls">
            <label className="dropzone">
              <input
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                disabled={busy || coverBusy}
                onChange={(e) => void pickCover(e.target.files?.[0] ?? null)}
              />
              {coverBusy
                ? "processing…"
                : pending
                  ? `${pending.name} · ${pending.w}×${pending.h} · ${(pending.bytes.length / 1024).toFixed(0)} KB — click to replace`
                  : game.coverUrl
                    ? "choose a new cover"
                    : "choose a cover"}
            </label>
            <p className="sub">
              {pending
                ? "Uploads when you save."
                : dropCover
                  ? "The cover will be removed when you save — the shelf draws one from the title."
                  : game.coverUrl
                    ? "This game has a cover."
                    : "No cover — the shelf draws one from the title."}
            </p>
            {(game.coverUrl || pending) && (
              <button
                type="button"
                className="quiet"
                disabled={busy || coverBusy}
                onClick={() => {
                  if (pending) {
                    // Just undo the pick, keeping whatever is already on chain.
                    setPending(null);
                    setPreview((old) => {
                      if (old) URL.revokeObjectURL(old);
                      return null;
                    });
                  } else {
                    setDropCover((d) => !d);
                  }
                }}
              >
                {pending ? "discard new cover" : dropCover ? "keep the cover" : "remove cover"}
              </button>
            )}
          </div>
        </div>
      </div>

      <ShotsEditor game={game} token={token} disabled={busy} />

      {err && <p className="error">{err}</p>}
      <div className="actions">
        <button className="btn" onClick={() => void save()} disabled={busy || !title.trim()}>
          {busy ? status || "Saving…" : "Save changes"}
        </button>
        <button className="btn secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Screenshots — the gallery shown on the game's page. Unlike the rest of the
 * editor these apply IMMEDIATELY rather than on save: each one is its own
 * chunked upload, so batching them behind the save button would mean a single
 * failure losing several minutes of work with nothing to show for it. The
 * count is the backend's own answer, re-read after every change.
 */
function ShotsEditor({
  game,
  token,
  disabled,
}: {
  game: Game;
  token: string;
  disabled: boolean;
}) {
  const [urls, setUrls] = useState<string[]>(game.shotUrls ?? []);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  // Cache-buster: removing shot 0 shifts every later index down, so the URLs
  // stay the same while the images behind them change. Without this the
  // browser shows the pre-delete gallery from cache.
  const [rev, setRev] = useState(0);

  const refreshFromCount = (n: number) => {
    setUrls(Array.from({ length: n }, (_, i) => shotUrl(game.slug, i)));
    setRev((r) => r + 1);
  };

  async function add(files: FileList | null) {
    if (!files || files.length === 0) return;
    setErr("");
    const room = MAX_SHOTS - urls.length;
    const picked = Array.from(files).slice(0, Math.max(0, room));
    if (files.length > room) {
      setErr(`only ${MAX_SHOTS} screenshots per game — taking the first ${room}`);
    }
    for (const [i, f] of picked.entries()) {
      try {
        setBusy(`preparing ${f.name}…`);
        const prep = await prepareCover(f); // same limits as a cover
        setBusy(`uploading ${f.name} (${i + 1}/${picked.length})…`);
        refreshFromCount(await addShot(token, game.slug, prep.type, prep.bytes));
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        break;
      }
    }
    setBusy("");
  }

  async function drop(index: number) {
    setErr("");
    setBusy("removing…");
    try {
      refreshFromCount(await removeShot(token, game.slug, index));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy("");
  }

  const full = urls.length >= MAX_SHOTS;
  return (
    <div className="field">
      <span className="label">
        Screenshots — up to {MAX_SHOTS}, shown on the game's page ({urls.length}/{MAX_SHOTS})
      </span>
      {urls.length > 0 && (
        <div className="shotedit">
          {urls.map((u, i) => (
            <div key={u} className="shotedit-item">
              <img src={`${u}?v=${rev}`} alt={`screenshot ${i + 1}`} />
              <button
                type="button"
                className="tagx"
                aria-label={`remove screenshot ${i + 1}`}
                disabled={disabled || busy !== ""}
                onClick={() => void drop(i)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {!full && (
        <label className="dropzone">
          <input
            type="file"
            accept="image/*"
            multiple
            style={{ display: "none" }}
            disabled={disabled || busy !== ""}
            onChange={(e) => {
              void add(e.target.files);
              e.target.value = ""; // let the same file be picked again after a failure
            }}
          />
          {busy || "add screenshots — pick one or several"}
        </label>
      )}
      <p className="sub">
        {full
          ? `That's the maximum of ${MAX_SHOTS}. Remove one to add another.`
          : "Large images are shrunk automatically. These apply immediately — no need to save."}
      </p>
      {err && <p className="error">{err}</p>}
    </div>
  );
}
