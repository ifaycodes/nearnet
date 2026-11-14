import type { DemoState } from "@/lib/api";

export default function Cheat({
  state,
  busy,
  onAct,
}: {
  state: DemoState;
  busy: boolean;
  onAct: (path: string) => void;
}) {
  const hasCycle = state.cycle_id !== null;
  const closed = state.phase === "closed";
  const open = state.phase === "open";
  const someSent = state.companies.some((c) => c.submission);

  return (
    <section aria-labelledby="cheat-title">
      <h2 className="section-title" id="cheat-title">
        Try to cheat
      </h2>
      <p className="section-note">
        Each button makes someone misbehave for real. The system should stop every one, and say why.
      </p>

      <div className="cheat__buttons">
        <button className="btn" disabled={busy || !open || !someSent} onClick={() => onAct("attack/replay")}>
          Send a submission twice
        </button>
        <button className="btn" disabled={busy || !hasCycle} onClick={() => onAct("attack/outsider")}>
          Outsider submits invoices
        </button>
        <button className="btn" disabled={busy || !closed} onClick={() => onAct("attack/tamper")}>
          Coordinator alters a result
        </button>
      </div>
      {!hasCycle && <p className="run__hint">Open a cycle to enable these.</p>}

      {state.attacks.length > 0 && (
        <ul className="cheat__list">
          {[...state.attacks].reverse().map((a, i) => (
            <li className="cheat__item" key={`${a.id}-${state.attacks.length - i}`}>
              <span className={`stamp ${a.blocked ? "stamp--ok" : "stamp--bad"}`}>
                {a.blocked ? "Blocked" : "Not blocked"}
              </span>
              <p>
                <span className="cheat__what">{a.title}</span>
                <span className="cheat__detail">{a.detail}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}