"use client";

import { useCallback, useEffect, useState } from "react";
import { act, getState, type DemoState, type OnChain } from "@/lib/api";
import Readers, { type Reader } from "@/components/Readers";
import RunPanel from "@/components/RunPanel";
import Cheat from "@/components/Cheat";
import Near from "@/components/Near";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function Page() {
  const [state, setState] = useState<DemoState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState("");
  const [reader, setReader] = useState<Reader>("company");
  const [onchain, setOnchain] = useState<OnChain | null>(null);

  useEffect(() => {
    getState()
      .then(setState)
      .catch((e: Error) => setError(e.message));
  }, []);

  const run = useCallback(async (path: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      setState(await act(path));
      if (path === "reset" || path === "start") setOnchain(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const sendAll = useCallback(async () => {
    if (!state) return;
    for (const c of state.companies) {
      if (c.submission) continue;
      if (!(await run(`submit/${c.name}`))) return;
      await sleep(450); // slow enough to watch the feed fill in
    }
  }, [state, run]);

  if (!state) {
    return (
      <main className="page">
        <Masthead state={null} />
        {error ? <SetupNotice message={error} /> : <p className="empty">Connecting to the demo…</p>}
      </main>
    );
  }

  const company = state.companies.find((c) => c.name === picked) ?? state.companies[0];

  return (
    <main className="page">
      <Masthead state={state} />
      {!state.coordinator_up && <SetupNotice message="The coordinator is not reachable from the demo server." />}
      {error && (
        <div className="notice" role="alert">
          {error}
        </div>
      )}

      <div className="workspace">
        <div className="stage">
          <h2 className="section-title">Who can see what</h2>
          <p className="section-note">
            Pick a company, then change who is looking. The same cycle looks completely different to each reader.
          </p>
          <div className="who" role="group" aria-label="Company">
            {state.companies.map((c) => (
              <button
                key={c.name}
                className="who__btn"
                aria-pressed={c.name === company.name}
                onClick={() => setPicked(c.name)}
              >
                <span className={`who__dot${c.submission ? " who__dot--sent" : ""}`} aria-hidden="true" />
                {c.name}
              </button>
            ))}
          </div>
          <Readers state={state} company={company} reader={reader} onPick={setReader} busy={busy} onAct={run} />
        </div>

        <aside className="rail">
          <RunPanel state={state} busy={busy} onAct={run} onSendAll={sendAll} />
        </aside>
      </div>

      <div className="lower">
        <Cheat state={state} busy={busy} onAct={run} />
        <Near state={state} onchain={onchain} setOnchain={setOnchain} />
      </div>
    </main>
  );
}

function Masthead({ state }: { state: DemoState | null }) {
  const engine = state?.engine;
  return (
    <header className="masthead">
      <h1 className="masthead__title">Net invoices between companies that can&rsquo;t see each other&rsquo;s books.</h1>
      <p className="masthead__lede">
        Five sample companies send encrypted invoices to a sealed engine. Each gets back only its own payments, and can pay them in stablecoins. Everything
        on this page is running live.
      </p>
      {state && (
        <div className="status-row">
          <span className={`status status--${state.coordinator_up ? "ok" : "bad"}`}>
            <span className="status__dot" aria-hidden="true" />
            <span className="status__text">Coordinator {state.coordinator_up ? "running" : "not reachable"}</span>
          </span>
          {engine ? (
            <span className={`status status--${engine.hardware_attested ? "ok" : "warn"}`}>
              <span className="status__dot" aria-hidden="true" />
              <span className="status__text">
                Engine {engine.hardware_attested ? "hardware attested" : "simulated"}
              </span>
              {!engine.hardware_attested && (
                <span className="status__note">no hardware proof; sample data only</span>
              )}
            </span>
          ) : (
            <span className="status">
              <span className="status__dot" aria-hidden="true" />
              <span className="status__text">Engine not checked yet</span>
              <span className="status__note">it is verified when you open a cycle</span>
            </span>
          )}
          {state.cycle_id && (
            <span className="status status--ok">
              <span className="status__dot" aria-hidden="true" />
              <span className="status__text">Cycle {state.cycle_id}</span>
              <span className="status__note">{state.phase}</span>
            </span>
          )}
        </div>
      )}
    </header>
  );
}

function SetupNotice({ message }: { message: string }) {
  return (
    <div className="notice" role="alert">
      {message}
      <code className="notice__code">python scripts/run_all.py</code>
    </div>
  );
}