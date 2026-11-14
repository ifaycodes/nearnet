import type { DemoState } from "@/lib/api";

export default function RunPanel({
  state,
  busy,
  onAct,
  onSendAll,
}: {
  state: DemoState;
  busy: boolean;
  onAct: (path: string) => void;
  onSendAll: () => void;
}) {
  const sent = state.companies.filter((c) => c.submission).length;
  const total = state.companies.length;
  const opened = state.phase !== "idle";
  const closed = state.phase === "closed";
  const everyoneSent = sent === total;

  return (
    <>
      <section className="run" aria-labelledby="run-title">
        <h2 className="section-title" id="run-title">
          Run the cycle
        </h2>
        <ol className="run__list">
          <li className={`run__step${opened ? " run__step--done" : ""}`}>
            <span className="run__num" aria-hidden="true">
              1
            </span>
            <div>
              <p className="run__label">Open a cycle</p>
              <button className="btn btn--primary" disabled={busy || opened} onClick={() => onAct("start")}>
                {opened ? `Cycle ${state.cycle_id} is open` : "Open cycle"}
              </button>
              {!opened && <p className="run__hint">The engine is checked before anything is sent to it.</p>}
            </div>
          </li>

          <li className={`run__step${everyoneSent ? " run__step--done" : ""}`}>
            <span className="run__num" aria-hidden="true">
              2
            </span>
            <div>
              <p className="run__label">Companies send their invoices</p>
              <div className="chips">
                {state.companies.map((c) => (
                  <button
                    key={c.name}
                    className={`chip${c.submission ? " chip--sent" : ""}`}
                    disabled={busy || !opened || closed || !!c.submission}
                    onClick={() => onAct(`submit/${c.name}`)}
                  >
                    {c.submission ? `${c.name} sent` : c.name}
                  </button>
                ))}
              </div>
              {opened && !closed && !everyoneSent && (
                <p className="run__hint">
                  <button className="btn btn--quiet" disabled={busy} onClick={onSendAll}>
                    Send all remaining
                  </button>
                </p>
              )}
              {!opened && <p className="run__hint">Open a cycle first.</p>}
            </div>
          </li>

          <li className={`run__step${closed ? " run__step--done" : ""}`}>
            <span className="run__num" aria-hidden="true">
              3
            </span>
            <div>
              <p className="run__label">Net the cycle</p>
              <button className="btn btn--primary" disabled={busy || !everyoneSent || closed} onClick={() => onAct("close")}>
                {closed ? "Netted" : "Net the cycle"}
              </button>
              {opened && !everyoneSent && (
                <p className="run__hint">
                  Waiting for {total - sent} more {total - sent === 1 ? "company" : "companies"}.
                </p>
              )}
            </div>
          </li>
        </ol>
        <p className="run__footer">
          <button className="btn btn--quiet" disabled={busy} onClick={() => onAct("reset")}>
            Start over with new keys
          </button>
        </p>
      </section>

      <section className="feed" aria-labelledby="feed-title">
        <h2 className="section-title" id="feed-title">
          What just happened
        </h2>
        {state.log.length === 0 ? (
          <p className="feed__empty">Each step appears here, attributed to whoever did it.</p>
        ) : (
          <ol className={`feed__list${state.log.length > 6 ? " feed__list--long" : ""}`} aria-live="polite">
            {[...state.log].reverse().map((l) => {
              const [kind, who] = l.actor.split(":");
              const name = who ?? (kind === "you" ? "You" : kind[0].toUpperCase() + kind.slice(1));
              return (
                <li className="feed__line" key={l.n}>
                  <span className={`feed__actor feed__actor--${kind}`}>{name}</span>
                  {l.text}
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </>
  );
}