/**
 * Log — the transparency log: every moderation action the network takes,
 * public, in the shape the registry's append-only log will serve.
 */
import { MOD_LOG, LogAction } from "../data";

function actionChip(action: LogAction) {
  switch (action) {
    case "freeze":
      return <span className="chip caution">freeze</span>;
    case "quarantine":
      return <span className="chip caution">quarantine</span>;
    case "delist":
      return <span className="chip caution">delist</span>;
    case "strike":
      return <span className="chip caution">strike</span>;
    case "restore":
      return <span className="chip on">restore</span>;
    case "ratify":
      return <span className="chip">ratify</span>;
    case "panel":
      return <span className="chip">panel drawn</span>;
  }
}

export default function Log() {
  return (
    <>
      <h1 className="pagetitle">Transparency log</h1>
      <p className="pagelede">
        Every moderation action on these shelves — automatic thresholds,
        curator panels, emergency freezes — lands here, append-only, on
        chain. Power that isn't logged doesn't exist.
      </p>

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
          {MOD_LOG.map((e, i) => (
            <tr key={i}>
              <td className="when">{e.at}</td>
              <td>{actionChip(e.action)}</td>
              <td>
                <span className="chip">{e.target}</span>
              </td>
              <td className="actor">{e.actor}</td>
              <td className="why">{e.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="hint">
        Mocked in the registry log's shape — entries become live chain reads
        when the registry canister lands. Cases referenced here (like
        case&nbsp;#7) will link to their full on-chain vote record.
      </p>
    </>
  );
}
