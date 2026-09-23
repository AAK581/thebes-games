/**
 * Log — the transparency log, live from the registry: every moderation action
 * (report → threshold quarantine → curator vote → verdict, plus emergency
 * freezes and strikes), append-only. Curators get a desk to vote open cases;
 * the deployer bootstraps ownership here once.
 */
import { useEffect, useState } from "react";
import type { MemphisAuth } from "../useMemphis";
import {
  amICurator,
  claimOwner,
  modLog,
  openCases,
  vote,
  type ModLogEntry,
  type OpenCase,
} from "../registry";

function actionChip(action: string) {
  const caution = ["freeze", "emergency-freeze", "quarantine", "delist", "strike"];
  const good = ["restore"];
  const cls = caution.includes(action)
    ? "chip caution"
    : good.includes(action)
      ? "chip on"
      : "chip";
  return <span className={cls}>{action}</span>;
}

export default function Log({ auth }: { auth: MemphisAuth }) {
  const token = auth.session?.session_token_hex;
  const [log, setLog] = useState<ModLogEntry[]>([]);
  const [cases, setCases] = useState<OpenCase[]>([]);
  const [curator, setCurator] = useState(false);
  const [msg, setMsg] = useState("");
  const [loadErr, setLoadErr] = useState("");

  async function refresh() {
    try {
      const [l, c] = await Promise.all([modLog(), openCases()]);
      setLog(l);
      setCases(c);
      setLoadErr("");
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (token) amICurator(token).then(setCurator).catch(() => setCurator(false));
    else setCurator(false);
  }, [token]);

  async function doVote(id: number, restore: boolean) {
    if (!token) return;
    setMsg("recording vote…");
    try {
      await vote(token, id, restore);
      setMsg("vote recorded");
      await refresh();
    } catch (e) {
      setMsg("couldn't vote: " + (e instanceof Error ? e.message : String(e)));
    }
  }
  async function doClaim() {
    if (!token) return;
    setMsg("claiming…");
    try {
      await claimOwner(token);
      setMsg("you are the platform owner and first curator");
      setCurator(await amICurator(token));
    } catch (e) {
      setMsg("couldn't claim: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  const openOnly = cases.filter((c) => c.resolved === null);

  return (
    <>
      <h1 className="pagetitle">Transparency log</h1>
      <p className="pagelede">
        Every moderation action on these shelves — automatic thresholds, curator
        panels, emergency freezes — lands here, append-only, on chain. Power that
        isn't logged doesn't exist.
      </p>

      {token && (
        <section className="panel">
          <h2>Curator desk</h2>
          {curator ? (
            openOnly.length === 0 ? (
              <p className="hint">
                No open cases. When a game is reported past the threshold or
                emergency-frozen, its case appears here for a vote.
              </p>
            ) : (
              <div className="cases">
                {openOnly.map((c) => (
                  <div key={c.id} className="casecard panel">
                    <p>
                      <strong>case #{c.id}</strong> ·{" "}
                      <a href={`#/game/${c.slug}`}>{c.slug}</a> · {c.kind} · opened{" "}
                      {c.opened}
                    </p>
                    <p className="hint">
                      restore {c.restoreVotes} · delist {c.delistVotes} — need 2 to
                      resolve
                    </p>
                    <div className="row">
                      <button onClick={() => void doVote(c.id, true)}>Restore</button>
                      <button
                        className="secondary"
                        onClick={() => void doVote(c.id, false)}
                      >
                        Delist + strike
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : (
            <p className="hint">
              You're not a curator.{" "}
              <button className="quiet" onClick={() => void doClaim()}>
                Claim platform ownership
              </button>{" "}
              (once, by the deployer) to bootstrap the curator set.
            </p>
          )}
          {msg && <p className="hint">{msg}</p>}
        </section>
      )}

      {loadErr && (
        <p className="hint">
          Log unavailable ({loadErr}) — the registry may not be deployed yet.
        </p>
      )}

      <table className="logtable">
        <thead>
          <tr>
            <th>date</th>
            <th>action</th>
            <th>game</th>
            <th>by</th>
            <th>detail</th>
          </tr>
        </thead>
        <tbody>
          {log.map((e, i) => (
            <tr key={i}>
              <td className="when">{e.at}</td>
              <td>{actionChip(e.action)}</td>
              <td>{e.target ? <span className="chip">{e.target}</span> : "—"}</td>
              <td className="actor">{e.who}</td>
              <td className="why">
                {e.detail}
                {e.caseId > 0 ? ` (case #${e.caseId})` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {log.length === 0 && !loadErr && (
        <p className="hint">No moderation actions yet — a clean shelf.</p>
      )}
    </>
  );
}
