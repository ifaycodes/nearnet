"use client";

import { useCallback, useEffect, useState } from "react";
import {
  closeCycle,
  createCycle,
  fetchDecryptedResult,
  getCycle,
  joinCycle,
  submitEncrypted,
  fetchVerifiedEngine,
  fetchIntentsQuote,
  verifyOnNear,
  type VerifiedEngine,
  type CycleOut,
  type DecryptedResult,
  type InvoiceInput,
} from "@/lib/coord";
import { generateKeyPair, loadKeyPair, saveKeyPair, type KeyPairB64, fromB64, toHex } from "@/lib/crypto";
import { money, shortHex, Leg, type OnChain } from "@/lib/api";

type DraftRow = {
  ref: string;
  counterparty: string;
  direction: "owed" | "owe";
  dollars: string;
};

const emptyRow = (counterparty = ""): DraftRow => ({
  ref: "INV-101",
  counterparty,
  direction: "owed",
  dollars: "",
});

export default function Page() {
  const [engine, setEngine] = useState<VerifiedEngine | null>(null);
  const enginePk = engine?.encryptionPublicKey ?? null;

  const [cycle, setCycle] = useState<CycleOut | null>(null);
  const [company, setCompany] = useState("");
  const [keys, setKeys] = useState<KeyPairB64 | null>(null);
  const [seq, setSeq] = useState(1);

  // Optional payotu details to receive onchain payment
  // Optional payout details (where I want to receive stablecoins)
    const [payoutSymbol, setPayoutSymbol] = useState("");
    const [payoutChain, setPayoutChain] = useState("near");
    const [payoutAddress, setPayoutAddress] = useState("");

    const [onchain, setOnchain] = useState<OnChain | null>(null);


    // Payer NEAR Intents quote state
    const [payFromSymbol, setPayFromSymbol] = useState("USDC");
    const [payFromChain, setPayFromChain] = useState("near");
    const [refundTo, setRefundTo] = useState("payer.near");
    const [legs, setLegs] = useState<Leg[] | null>(null);

  // Create form
  const [myCreateName, setMyCreateName] = useState("Acme");
  const [othersText, setOthersText] = useState("Beta");
  const [cutoffMins, setCutoffMins] = useState("");

  // Join form
  const [joinId, setJoinId] = useState("");
  const [joinName, setJoinName] = useState("Beta");

  // Invoice form & result
  const [rows, setRows] = useState<DraftRow[]>([emptyRow()]);
  const [result, setResult] = useState<DecryptedResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Fetch engine public key once on load
  useEffect(() => {
    fetchVerifiedEngine()
      .then(setEngine)
      .catch((e: Error) => setError(`Cannot verify engine: ${e.message}`));
  }, []);

  // Poll cycle state while open so one tab sees when the other joins/submits/closes
  const refreshCycle = useCallback(async (id: string) => {
    try {
      const latest = await getCycle(id);
      setCycle(latest);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!cycle || cycle.state !== "open") return;
    const timer = setInterval(() => {
      refreshCycle(cycle.id);
    }, 3000);
    return () => clearInterval(timer);
  }, [cycle, refreshCycle]);

  // Auto-fetch & decrypt my result once the cycle settles
  useEffect(() => {
    if (!cycle || cycle.state !== "settled" || !company || !keys || !enginePk || result) return;
    fetchDecryptedResult({
      cycleId: cycle.id,
      company,
      mySecretKey: keys.secretKey,
      enginePublicKey: enginePk,
    })
      .then(setResult)
      .catch((e: Error) => setError(e.message));
  }, [cycle, company, keys, enginePk, result]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const mine = myCreateName.trim();
    const others = othersText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!mine || others.length === 0) {
      setError("Enter your company name and at least one counterparty.");
      return;
    }

    setBusy(true);
    try {
      const kp = generateKeyPair();
      const cutoff =
        cutoffMins.trim() && Number(cutoffMins) > 0
          ? new Date(Date.now() + Number(cutoffMins) * 60_000).toISOString()
          : null;

      const created = await createCycle(
        "USD",
        [
          { name: mine, public_key: kp.publicKey },
          ...others.map((name) => ({ name, public_key: null })),
        ],
        cutoff,
      );
      saveKeyPair(created.id, mine, kp);
      setKeys(kp);
      setCompany(mine);
      setCycle(created);
      setRows([emptyRow(others[0])]);
      setResult(null);
      setSeq(1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const id = joinId.trim();
    const name = joinName.trim();
    if (!id || !name) {
      setError("Enter both the Cycle ID and your company name.");
      return;
    }

    setBusy(true);
    try {
      const existingCycle = await getCycle(id);
      const slot = existingCycle.participants.find((p) => p.name === name);
      if (!slot) {
        throw new Error(`"${name}" is not listed in cycle ${id}.`);
      }

      const saved = loadKeyPair(id, name);
      let activeKeys: KeyPairB64;
      let latestCycle = existingCycle;

      if (slot.public_key && saved && saved.publicKey === slot.public_key) {
        // Resuming an already-claimed slot in this browser
        activeKeys = saved;
      } else {
        activeKeys = generateKeyPair();
        latestCycle = await joinCycle(id, name, activeKeys.publicKey);
        saveKeyPair(id, name, activeKeys);
      }

      const firstOther = latestCycle.participants.find((p) => p.name !== name)?.name ?? "";
      setKeys(activeKeys);
      setCompany(name);
      setCycle(latestCycle);
      setRows([emptyRow(firstOther)]);
      setResult(null);
      setSeq(1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!cycle || !keys || !enginePk) return;
    setError(null);
    setNotice(null);

    const invoices: InvoiceInput[] = [];
    for (const r of rows) {
      const cents = Math.round(Number(r.dollars) * 100);
      if (!r.ref.trim() || !r.counterparty || !Number.isFinite(cents) || cents <= 0) {
        setError("Every invoice needs a ref, a counterparty, and a positive amount.");
        return;
      }
      invoices.push({
        ref: r.ref.trim(),
        seller: r.direction === "owed" ? company : r.counterparty,
        buyer: r.direction === "owed" ? r.counterparty : company,
        amount_cents: cents,
        currency: cycle.currency,
      });
    }

    const payout = payoutSymbol && payoutAddress.trim()
    ? { symbol: payoutSymbol, blockchain: payoutChain.trim().toLowerCase(), address: payoutAddress.trim() }
    : null;

    setBusy(true);
    try {
      await submitEncrypted({
        cycleId: cycle.id,
        company,
        seq,
        invoices,
        mySecretKey: keys.secretKey,
        enginePublicKey: enginePk,
        payout,
      });
      setSeq((s) => s + 1);
      setNotice(`Encrypted and submitted ${invoices.length} invoice(s) as ${company}.`);
      await refreshCycle(cycle.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleClose() {
    if (!cycle) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      setCycle(await closeCycle(cycle.id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function resetLocal() {
    setCycle(null);
    setCompany("");
    setKeys(null);
    setResult(null);
    setError(null);
    setNotice(null);
    setLegs(null);
    setOnchain(null);
  }

  // ---------- screen 1: Create or Join ----------
  if (!cycle) {
    return (
      <main className="page">
        <header className="masthead">
            <div className="status-row">
                {engine ? (
                    <span className={`status ${engine.hardwareAttested ? "status--ok" : "status--warn"}`}>
                        <span className="status__dot" />
                        <span className="status__text">
                        {engine.hardwareAttested ? "Engine hardware attested (dstack-tdx)" : "Engine simulated (local dev)"}
                        </span>
                        <code className="status__note">report_data {shortHex(engine.reportData, 8)}</code>
                    </span>
                ) : (
                    <span className="status">
                        <span className="status__dot" />
                        <span className="status__text">Verifying engine attestation…</span>
                    </span>
                )}
            </div>

          <h1 className="masthead__title">Confidential invoice netting</h1>
          <p className="masthead__lede">
            Encrypt invoices in your browser, net offsetting balances, and see only what you need to pay or receive.
          </p>
        </header>

        {error && <div className="notice" role="alert">{error}</div>}

        <div className="card-grid">
          <section className="frame">
            <h2 className="section-title">Create a cycle</h2>
            <p className="section-note">Invite companies by name, then share the Cycle ID with them.</p>
            <form onSubmit={handleCreate} style={{ marginTop: "1rem" }}>
              <div className="field">
                <label className="field__label">Your company name</label>
                <input className="input" value={myCreateName} onChange={(e) => setMyCreateName(e.target.value)} />
              </div>
              <div className="field">
                <label className="field__label">Other participating companies (comma-separated)</label>
                <input className="input" value={othersText} onChange={(e) => setOthersText(e.target.value)} />
              </div>
              <div className="field">
                <label className="field__label">Cutoff in minutes (optional — needed to drop no-shows)</label>
                <input
                  className="input"
                  type="number"
                  min="1"
                  placeholder="Leave blank to require all companies"
                  value={cutoffMins}
                  onChange={(e) => setCutoffMins(e.target.value)}
                />
              </div>
              <button className="btn btn--primary" disabled={busy || !enginePk}>
                Create & generate my key
              </button>
            </form>
          </section>

          <section className="frame">
            <h2 className="section-title">Join a cycle</h2>
            <p className="section-note">Enter the Cycle ID shared with you and claim your company name.</p>
            <form onSubmit={handleJoin} style={{ marginTop: "1rem" }}>
              <div className="field">
                <label className="field__label">Cycle ID</label>
                <input className="input" value={joinId} onChange={(e) => setJoinId(e.target.value)} placeholder="Paste Cycle ID" />
              </div>
              <div className="field">
                <label className="field__label">Your company name</label>
                <input className="input" value={joinName} onChange={(e) => setJoinName(e.target.value)} />
              </div>
              <button className="btn btn--primary" disabled={busy || !enginePk}>
                Join & generate my key
              </button>
            </form>
          </section>
        </div>
      </main>
    );
  }

  // ---------- screen 2: Active Cycle (Submit / Close / Result) ----------
  const counterparties = cycle.participants.map((p) => p.name).filter((n) => n !== company);
  const mySlot = cycle.participants.find((p) => p.name === company);
  const allSubmitted = cycle.submitted.length === cycle.participants.length;
  const cutoffPassed = cycle.cutoff ? Date.now() >= Date.parse(cycle.cutoff) : false;

  return (
    <main className="page">
      <header className="masthead">
            <div className="status-row">
                {engine ? (
                    <span className={`status ${engine.hardwareAttested ? "status--ok" : "status--warn"}`}>
                        <span className="status__dot" />
                        <span className="status__text">
                        {engine.hardwareAttested ? "Engine hardware attested (dstack-tdx)" : "Engine simulated (local dev)"}
                        </span>
                        <code className="status__note">report_data {shortHex(engine.reportData, 8)}</code>
                    </span>
                ) : (
                    <span className="status">
                        <span className="status__dot" />
                        <span className="status__text">Verifying engine attestation…</span>
                    </span>
                )}
            </div>

        <h1 className="masthead__title">{company} &mdash; Cycle {cycle.id}</h1>
        <div className="status-row">
          <span className="status status--ok">
            <span className="status__dot" />
            <span className="status__text">State: {cycle.state}</span>
          </span>
          {mySlot?.public_key && (
            <span className="status">
              <span className="status__text">Your key:</span>
              <code className="status__note">{shortHex(mySlot.public_key, 8)}</code>
            </span>
          )}
        </div>
      </header>

      {error && <div className="notice" role="alert">{error}</div>}
      {notice && <div className="notice notice--info">{notice}</div>}

      <div className="workspace">
        <div className="stage">
          {cycle.state === "open" ? (
            <section className="frame">
              <h2 className="section-title">Your invoices</h2>
              <p className="section-note">
                Encrypted in your browser before leaving this tab. Only you and the sealed engine see them.
              </p>

              <form onSubmit={handleSubmit} style={{ marginTop: "1rem" }}>
                {rows.map((row, idx) => (
                  <div className="invoice-row" key={idx}>
                    <input
                      className="input"
                      placeholder="INV-101"
                      value={row.ref}
                      onChange={(e) => {
                        const next = [...rows];
                        next[idx] = { ...row, ref: e.target.value };
                        setRows(next);
                      }}
                    />
                    <select
                      className="select"
                      value={row.direction}
                      onChange={(e) => {
                        const next = [...rows];
                        next[idx] = { ...row, direction: e.target.value as "owed" | "owe" };
                        setRows(next);
                      }}
                    >
                      <option value="owed">Owed to me by</option>
                      <option value="owe">I owe</option>
                    </select>
                    <select
                      className="select"
                      value={row.counterparty}
                      onChange={(e) => {
                        const next = [...rows];
                        next[idx] = { ...row, counterparty: e.target.value };
                        setRows(next);
                      }}
                    >
                      {counterparties.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    <input
                      className="input"
                      type="number"
                      step="0.01"
                      min="0.01"
                      placeholder="$ Amount"
                      value={row.dollars}
                      onChange={(e) => {
                        const next = [...rows];
                        next[idx] = { ...row, dollars: e.target.value };
                        setRows(next);
                      }}
                    />
                    <button
                      type="button"
                      className="btn"
                      disabled={rows.length === 1}
                      onClick={() => setRows(rows.filter((_, i) => i !== idx))}
                    >
                      Remove
                    </button>
                  </div>
                ))}

                <div style={{ marginTop: "1.25rem", paddingTop: "1rem", borderTop: "1px solid var(--rule)" }}>
                    <p className="field__label">On-chain payout details (optional &mdash; only shown to companies that end up owing you)</p>
                    <div className="invoice-row" style={{ marginTop: "0.5rem", gridTemplateColumns: "8rem 9rem 1fr" }}>
                        <select className="select" value={payoutSymbol} onChange={(e) => setPayoutSymbol(e.target.value)}>
                        <option value="">Bank / manual</option>
                        <option value="USDC">USDC</option>
                        <option value="USDT">USDT</option>
                        </select>
                        <input
                            className="input"
                            placeholder="Chain (e.g. near, eth)"
                            disabled={!payoutSymbol}
                            value={payoutChain}
                            onChange={(e) => setPayoutChain(e.target.value)}
                        />
                        <input
                            className="input"
                            placeholder="Your wallet / account (e.g. acme.near)"
                            disabled={!payoutSymbol}
                            value={payoutAddress}
                            onChange={(e) => setPayoutAddress(e.target.value)}
                        />
                    </div>
                </div>
                <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setRows([...rows, { ...emptyRow(counterparties[0] ?? ""), ref: `INV-${101 + rows.length}` }])}
                  >
                    + Add invoice
                  </button>
                  <button type="submit" className="btn btn--primary" disabled={busy}>
                    {cycle.submitted.includes(company) ? "Re-encrypt & update" : "Encrypt & submit"}
                  </button>
                </div>
              </form>
            </section>
          ) : (
            <section className="frame">
              <h2 className="section-title">Your net settlement</h2>
              {!result ? (
                <p className="empty">Decrypting your result locally…</p>
              ) : (
                <>
                  <p className="position">
                    {result.position_cents > 0
                      ? `You are owed ${money(result.position_cents)} overall`
                      : result.position_cents < 0
                        ? `You owe ${money(-result.position_cents)} overall`
                        : "You are square overall"}
                  </p>
                  <ul className="lines">
                    {result.pays.map((p) => (
                      <li key={`pay-${p.payee}`}>
                        <span>Pay {p.payee}</span>
                        <span className="lines__amount">{money(p.amount_cents)}</span>
                      </li>
                    ))}
                    {result.receives.map((r) => (
                      <li key={`rec-${r.payer}`}>
                        <span>{r.payer} pays you</span>
                        <span className="lines__amount">{money(r.amount_cents)}</span>
                      </li>
                    ))}
                    {result.pays.length + result.receives.length === 0 && (
                      <li>No payments for {company} this cycle.</li>
                    )}
                  </ul>

                  {result.issues.length > 0 && (
                    <>
                      <p className="subhead">Flagged invoices (excluded)</p>
                      <ul className="facts">
                        {result.issues.map((i) => (
                          <li key={i.ref}>
                            <strong>{i.ref}</strong> &ndash; {i.detail}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {result.pays.length > 0 && (
                    <div className="settle">
                        <h3 className="frame__title">Pay via NEAR Intents</h3>
                        <p className="frame__sub">Price your cross-chain stablecoin payments through 1Click.</p>
                        <div className="invoice-row" style={{ marginTop: "0.75rem", gridTemplateColumns: "7rem 8rem 1fr auto" }}>
                        <select className="select" value={payFromSymbol} onChange={(e) => setPayFromSymbol(e.target.value)}>
                            <option value="USDC">USDC</option>
                            <option value="USDT">USDT</option>
                        </select>
                        <input className="input" value={payFromChain} onChange={(e) => setPayFromChain(e.target.value)} placeholder="near" />
                        <input className="input" value={refundTo} onChange={(e) => setRefundTo(e.target.value)} placeholder="Refund address" />
                        <button
                            type="button"
                            className="btn"
                            disabled={busy}
                            onClick={async () => {
                            setBusy(true);
                            setError(null);
                            try {
                                setLegs(
                                await fetchIntentsQuote({
                                    pays: result.pays,
                                    payFrom: { symbol: payFromSymbol, blockchain: payFromChain.trim().toLowerCase(), refund_to: refundTo.trim() },
                                    dry: true,
                                }),
                                );
                            } catch (err) {
                                setError((err as Error).message);
                            } finally {
                                setBusy(false);
                            }
                            }}
                        >
                            Get quotes (preview)
                        </button>
                        </div>

                        {legs && (
                        <ul className="settle__list">
                            {legs.map((leg) => (
                            <li className="leg" key={leg.payee}>
                                <div className="leg__head">
                                <span className="leg__what">
                                    Pay {leg.payee} <span className="leg__amount">{money(leg.amount_cents)}</span>
                                </span>
                                <span className="tag">{leg.status}</span>
                                </div>
                                {leg.send && leg.receive && (
                                <p className="leg__detail">
                                    Send {leg.send.amount} {leg.send.symbol} ({leg.send.blockchain}) &rarr; {leg.payee} receives{" "}
                                    {leg.receive.amount} {leg.receive.symbol} ({leg.receive.blockchain}) at <code>{leg.address}</code>
                                </p>
                                )}
                                {leg.reason && <p className="leg__detail">{leg.reason}</p>}
                            </li>
                            ))}
                        </ul>
                        )}
                    </div>
                    )}
                </>
              )}
            </section>
          )}

          {cycle.receipt && engine && (
            <section className="frame" style={{ marginTop: "1.5rem" }}>
                <h2 className="section-title">Cryptographic Receipt &amp; NEAR Proof</h2>
                <p className="frame__sub">
                Signed Merkle root for cycle {cycle.receipt.cycle_id}. No invoice amounts are included.
                </p>

                {(() => {
                const engineKeyHex = toHex(fromB64(engine.signingPublicKey));
                const sigHex = toHex(fromB64(cycle.receipt.signature));
                const contract = process.env.NEXT_PUBLIC_NEAR_CONTRACT ?? "<YOUR_CONTRACT>";
                const anchorArgs = JSON.stringify({
                    cycle_id: cycle.receipt.cycle_id,
                    root: cycle.receipt.root,
                    participants: cycle.receipt.participants,
                    engine_key: engineKeyHex,
                    signature: sigHex,
                });
                const anchorCmd = `near call ${contract} anchor_receipt '${anchorArgs}' --accountId <YOUR_ACCOUNT>`;

                return (
                    <>
                    <dl className="slip">
                        <dt>Merkle Root</dt>
                        <dd>{cycle.receipt.root}</dd>
                        <dt>Engine Key</dt>
                        <dd>{shortHex(engineKeyHex, 16)}</dd>
                        <dt>Signature</dt>
                        <dd>{shortHex(sigHex, 16)}</dd>
                    </dl>

                    <p className="subhead">Anchor on NEAR</p>
                    <pre className="code" tabIndex={0}>{anchorCmd}</pre>
                    <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.75rem", alignItems: "center" }}>
                        <button
                        type="button"
                        className="btn btn--quiet"
                        onClick={() => navigator.clipboard.writeText(anchorCmd)}
                        >
                        Copy anchor command
                        </button>
                        <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={async () => {
                            setBusy(true);
                            try {
                            setOnchain(
                                await verifyOnNear({
                                cycleId: cycle.receipt!.cycle_id,
                                expectedRoot: cycle.receipt!.root,
                                expectedEngineKeyHex: engineKeyHex,
                                }),
                            );
                            } finally {
                            setBusy(false);
                            }
                        }}
                        >
                        Verify on NEAR
                        </button>
                    </div>

                    {onchain && (
                        <div style={{ marginTop: "0.75rem" }}>
                        {onchain.status === "verified" && (
                            <p>
                            <span className="stamp stamp--ok">Anchored &amp; Verified</span>{" "}
                            Written by {onchain.record?.anchored_by} at block {onchain.record?.block_height}.
                            </p>
                        )}
                        {onchain.status === "not_anchored" && (
                            <p className="frame__sub">Not anchored yet — run the command above, then click Verify again.</p>
                        )}
                        {onchain.status === "not_configured" && (
                            <p className="frame__sub">Set NEAR_RPC and NEAR_CONTRACT in dashboards/.env.local to check live on-chain.</p>
                        )}
                        {onchain.status === "rejected" && (
                            <p><span className="stamp stamp--bad">Rejected</span> {onchain.reason}</p>
                        )}
                        {onchain.status === "unreachable" && (
                            <p><span className="stamp stamp--warn">Could not reach NEAR RPC</span> {onchain.detail}</p>
                        )}
                        </div>
                    )}
                    </>
                );
                })()}
            </section>
            )}
        </div>

        <aside className="rail">
          <section className="run">
            <h2 className="section-title">Cycle status</h2>
            <p className="run__hint">
              Share Cycle ID: <strong>{cycle.id}</strong>{" "}
              <button
                type="button"
                className="btn btn--quiet"
                onClick={() => navigator.clipboard.writeText(cycle.id)}
              >
                Copy
              </button>
            </p>

            <ul className="facts" style={{ marginTop: "1rem" }}>
              {cycle.participants.map((p) => {
                const joined = p.public_key !== null;
                const sent = cycle.submitted.includes(p.name);
                return (
                  <li key={p.name}>
                    <strong>{p.name}</strong>:{" "}
                    {sent ? "Submitted" : joined ? `Joined (${shortHex(p.public_key!, 6)})` : "Waiting to join"}
                  </li>
                );
              })}
            </ul>

            {cycle.state === "open" && (
              <div style={{ marginTop: "1.25rem", display: "grid", gap: "0.5rem" }}>
                <button
                  className="btn btn--primary"
                  disabled={busy || (!allSubmitted && !cutoffPassed)}
                  onClick={handleClose}
                >
                  Close & net cycle
                </button>
                {!allSubmitted && !cutoffPassed && (
                  <p className="run__hint">Waiting for all participants to submit.</p>
                )}
              </div>
            )}

            {cycle.summary && (
              <p className="run__hint" style={{ marginTop: "1rem" }}>
                Netted {cycle.summary.invoice_count} invoice(s): {money(cycle.summary.total_amount_cents)} gross &rarr;{" "}
                {money(cycle.summary.net_cents)} net ({cycle.summary.reduction_pct}% saved).
              </p>
            )}

            <p className="run__footer">
              <button type="button" className="btn btn--quiet" onClick={resetLocal}>
                Switch / start another cycle
              </button>
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}