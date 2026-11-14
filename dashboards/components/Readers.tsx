import { money, shortHex, type Company, type DemoState } from "@/lib/api";
import Settle from "./Settle";
export type Reader = "company" | "coordinator" | "public";

/** The same cycle, seen by three different readers. */
export default function Readers({
  state,
  company,
  reader,
  onPick,
  busy,
  onAct,
}: {
  state: DemoState;
  company: Company;
  reader: Reader;
  onPick: (r: Reader) => void;
  busy: boolean;
  onAct: (path: string) => void;
}) {
  const tabs: { id: Reader; label: string }[] = [
    { id: "company", label: `As ${company.name}` },
    { id: "coordinator", label: "As the coordinator" },
    { id: "public", label: "As the public" },
  ];

  return (
    <div>
      <div className="readers" role="tablist" aria-label="Who is looking">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={reader === t.id}
            aria-controls="reader-panel"
            className={`reader-tab reader-tab--${t.id}`}
            onClick={() => onPick(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        id="reader-panel"
        role="tabpanel"
        aria-labelledby={`tab-${reader}`}
        // keyed so the sheet re-settles each time the reader changes
        key={`${reader}-${company.name}`}
        className={`frame${reader === "coordinator" ? " frame--sealed" : ""}`}
      >
        {reader === "company" && <CompanyView state={state} company={company} busy={busy} onAct={onAct} />}
        {reader === "coordinator" && <CoordinatorView state={state} company={company} />}
        {reader === "public" && <PublicView state={state} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- company

function CompanyView({ state, company, busy, onAct }: { state: DemoState; company: Company; busy: boolean; onAct: (path: string) => void }) {
  const result = company.result;
  const flagged = new Map(
    result && result.verified ? result.issues.map((i) => [i.ref, i] as const) : [],
  );

  return (
    <>
      <h3 className="frame__title">{company.name}&rsquo;s books</h3>
      <p className="frame__sub">
        Only {company.name} can read this. These are the invoices it sends to the engine.
      </p>
      <p className="frame__sub">
        {company.payout
          ? `On-chain payout details shared: ${company.payout.symbol} on ${company.payout.blockchain}. Only companies that owe it money are told.`
          : `No on-chain payout details shared, so companies that owe ${company.name} money pay it the usual way.`}
      </p>

      <div className="table-wrap">
        <table className="ledger ledger--invoices">
          <thead>
            <tr>
              <th scope="col">Invoice</th>
              <th scope="col">With</th>
              <th scope="col">Direction</th>
              <th scope="col" className="ledger__amount">
                Amount
              </th>
              <th scope="col">After netting</th>
            </tr>
          </thead>
          <tbody>
            {company.invoices.map((inv) => {
              const owed = inv.seller === company.name;
              const issue = flagged.get(inv.ref);
              return (
                <tr key={inv.ref}>
                  <td className="ledger__ref">{inv.ref}</td>
                  <td>{owed ? inv.buyer : inv.seller}</td>
                  <td>{owed ? "Owed to you" : "You owe"}</td>
                  <td className="ledger__amount">{money(inv.amount_cents)}</td>
                  <td>
                    {!result && <span className="tag tag--wait">Waiting</span>}
                    {result && !result.verified && <span className="tag tag--bad">Not verified</span>}
                    {result && result.verified && issue && (
                      <>
                        <span className="tag tag--warn">Flagged</span>
                        <span className="ledger__why">{issue.detail}</span>
                      </>
                    )}
                    {result && result.verified && !issue && <span className="tag tag--ok">Netted</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {result && <Outcome state={state} company={company} busy={busy} onAct={onAct} />}
    </>
  );
}

function Outcome({ state, company, busy, onAct }: { state: DemoState; company: Company; busy: boolean; onAct: (path: string) => void }) {
  const result = company.result!;

  if (!result.verified) {
    return (
      <section className="result" aria-label="Result">
        <div className="verdict">
          <span className="stamp stamp--bad">Rejected</span>
          <p className="verdict__note">
            {company.name} refused this result: {result.error}. Nothing from it is shown as fact.
          </p>
        </div>
      </section>
    );
  }

  const p = result.position_cents;
  const headline =
    p > 0 ? `You are owed ${money(p)} overall` : p < 0 ? `You owe ${money(-p)} overall` : "You are square overall";

  return (
    <section className="result" aria-label="Result">
      <h3 className="frame__title">What the engine sent back to {company.name}</h3>
      <p className="position">
        {headline}
        <span className="position__note">
          Across all of {company.name}&rsquo;s confirmed invoices, before and after netting.
        </span>
      </p>

      <ul className="lines">
        {result.pays.map((x) => (
          <li key={`p-${x.payee}`}>
            <span>Pay {x.payee}</span>
            <span className="lines__amount">{money(x.amount_cents)}</span>
          </li>
        ))}
        {result.receives.map((x) => (
          <li key={`r-${x.payer}`}>
            <span>{x.payer} pays you</span>
            <span className="lines__amount">{money(x.amount_cents)}</span>
          </li>
        ))}
        {result.pays.length + result.receives.length === 0 && <li>No payments for {company.name} this cycle.</li>}
      </ul>

      {result.issues.length > 0 && (
        <>
          <p className="subhead">Needs attention</p>
          <ul className="facts">
            {result.issues.map((i) => (
              <li key={i.ref}>
                <strong>{i.ref}</strong> &ndash; {i.detail}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="verdict">
        {result.pays.length > 0 && <Settle state={state} company={company} busy={busy} onAct={onAct} />}
        <span className="stamp stamp--ok">Verified</span>
        <p className="verdict__note">
          These checks ran in the demo harness, using the same code a real connector would.
        </p>
      </div>
      <ul className="checks">
        {state.checks.map((c) => (
          <li key={c}>
            <span className="checks__tick" aria-hidden="true">
              ✓
            </span>
            <span>{c}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------ coordinator

function CoordinatorView({ state, company }: { state: DemoState; company: Company }) {
  if (state.phase === "idle") {
    return (
      <>
        <h3 className="frame__title">What the coordinator holds</h3>
        <p className="empty">
          No cycle is open yet. Open one and send invoices to see exactly what reaches the coordinator.
        </p>
      </>
    );
  }

  const received = state.companies.filter((c) => c.submission).length;
  const box = company.submission;

  return (
    <>
      <h3 className="frame__title">What the coordinator holds</h3>
      <p className="frame__sub">
        {received} of {state.companies.length} sealed boxes received. The coordinator relays them; it has no key to
        open them.
      </p>

      <div className="table-wrap">
        <table className="ledger ledger--boxes">
          <thead>
            <tr>
              <th scope="col">Company</th>
              <th scope="col">Sealed box</th>
              <th scope="col" className="ledger__amount">
                Size
              </th>
            </tr>
          </thead>
          <tbody>
            {state.companies.map((c) => (
              <tr key={c.name} className={c.name === company.name ? "ledger__row--selected" : undefined}>
                <td className="ledger__ref">{c.name}</td>
                <td>
                  {c.submission ? (
                    <code className="cipher cipher--small">{c.submission.preview.slice(0, 30)}…</code>
                  ) : (
                    <span className="tag tag--wait">Not received</span>
                  )}
                </td>
                <td className="ledger__amount">
                  {c.submission ? `${c.submission.chars.toLocaleString("en-US")} characters` : "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {box && (
        <>
          <p className="subhead">{company.name}&rsquo;s box, as received</p>
          <pre className="cipher">{box.preview}…</pre>
          <p className="frame__sub">
            The first 44 of {box.chars.toLocaleString("en-US")} characters. Only the engine&rsquo;s key opens it.
          </p>
        </>
      )}

      <p className="subhead">What the coordinator can tell</p>
      <ul className="facts">
        <li>Who is in the cycle, and who has sent a box.</li>
        <li>How large each box is, and when it arrived.</li>
        {state.summary && (
          <li>
            After closing, only totals: {state.summary.invoice_count} invoices, {money(state.summary.gross_cents)} gross,{" "}
            {money(state.summary.net_cents)} net.
          </li>
        )}
      </ul>
      <p className="subhead">What it cannot tell</p>
      <ul className="facts facts--cannot">
        <li>Which invoices a box contains, or who owes whom.</li>
        <li>Any amount, or any company&rsquo;s result.</li>
        <li>Where any company wants to be paid.</li>
      </ul>
    </>
  );
}

// ----------------------------------------------------------------- public

function PublicView({ state }: { state: DemoState }) {
  const r = state.receipt;
  return (
    <>
      <h3 className="frame__title">What anyone can see</h3>
      {!r ? (
        <p className="empty">Nothing is published until the cycle closes.</p>
      ) : (
        <>
          <p className="frame__sub">
            One signed receipt per cycle. It proves the results were produced without revealing any of them.
          </p>
          <dl className="slip">
            <dt>Cycle</dt>
            <dd>{r.cycle_id}</dd>
            <dt>Companies</dt>
            <dd className="slip__plain">{r.participants} took part</dd>
            <dt>Root</dt>
            <dd>{r.root}</dd>
            <dt>Engine signature</dt>
            <dd>{shortHex(r.signature, 22)}</dd>
          </dl>
        </>
      )}
      <p className="subhead">Everything else stays blank</p>
      <span className="redact" style={{ width: "92%" }} />
      <span className="redact" style={{ width: "74%" }} />
      <span className="redact" style={{ width: "83%" }} />
      <p className="frame__sub" style={{ marginTop: "0.8rem" }}>
        Company names, invoices, amounts and payments are never published.
      </p>
    </>
  );
}