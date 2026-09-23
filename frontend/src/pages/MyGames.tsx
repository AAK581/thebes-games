/**
 * MyGames — the manage page: everything the signed-in anchor has published,
 * with unpublish. Reads my_games (auth'd) from the registry.
 */
import { useEffect, useState } from "react";
import type { MemphisAuth } from "../useMemphis";
import type { Game } from "../data";
import { myGames, unpublish } from "../registry";
import MemphisGate from "../MemphisGate";

export default function MyGames({ auth }: { auth: MemphisAuth }) {
  const token = auth.session?.session_token_hex;
  const [games, setGames] = useState<Game[] | null>(null);
  const [msg, setMsg] = useState("");

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
      await refresh();
    } catch (e) {
      setMsg("couldn't remove: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  if (!auth.signedIn) {
    return (
      <>
        <h1 className="pagetitle">My games</h1>
        <p className="pagelede">Sign in to see and manage your uploads.</p>
        <MemphisGate auth={auth} />
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
              <tr key={g.slug}>
                <td>
                  <a href={`#/game/${g.slug}`}>{g.title}</a>
                </td>
                <td>
                  {g.status === "quarantined" ? (
                    <span className="chip caution">quarantined</span>
                  ) : (
                    <span className="chip on">live</span>
                  )}
                </td>
                <td>{g.plays}</td>
                <td>{g.favorites}</td>
                <td>{g.vaultSlug ? "vault" : "canister"}</td>
                <td>
                  <button className="quiet" onClick={() => void remove(g.slug)}>
                    unpublish
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
