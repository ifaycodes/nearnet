import { money, type Company, type DemoState, type Leg } from "@/lib/api";

/** "80000.000000" -> "80,000.00". Display only; the exact string came from the server. */
function shown(amount: string): string {
  const n = Number(amount);
  return Number.isFinite(n)
    ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })
    : amount;
}

export default function Settle({
  state,
  company,
  busy,
  onAct,
}: {
  state: DemoState;
  company: Company;
  busy: boolean;
  onAct: (path: string) => void;
}) {
  const legs = company.settlement;
  const available = state.settlement.available;

  return (
    <section className="settle" aria-labelledby="settle-title">
      <h3 className="frame__title" id="settle-title">
        Pay on-chain (optional)
      </h3>
      <p className="frame__sub">
        Companies that shared payout details can be paid in stablecoins through NEAR Intents. Everyone else is paid the
        usual way. This only prices the payments: nothing is sent, and no money moves in this demo.
      </p>
      <p className="settle__privacy">
        On a public chain, each payment (who pays whom, and how much) can be seen. The invoices behind it stay private.
      </p>

      <div className="settle__action">
        <button className="btn" disabled={busy || !available} onClick={() => onAct(`quote/${company.name}`)}>
          {legs ? "Get fresh quotes" : "Get quotes (preview only)"}
        </button>
        {!available && (
          <p className="run__hint">On-chain quotes are not configured on this demo server.</p>
        )}
      </div>

      {legs && (
        <ul className="settle__list" aria-live="polite">
          {legs.map((leg) => (
            <LegRow key={leg.payee} leg={leg} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LegRow({ leg }: { leg: Leg }) {
  const tag = TAGS[leg.status];
  return (
    <li className="leg">
      <div className="leg__head">
        <span className="leg__what">
          Pay {leg.payee} <span className="leg__amount">{money(leg.amount_cents)}</span>
        </span>
        <span className={`tag ${tag.className}`}>{tag.label}</span>
      </div>

      {leg.status === "quoted" && leg.send && leg.receive && (
        <p className="leg__detail">
          You send about{" "}
          <strong>
            {shown(leg.send.amount)} {leg.send.symbol}
          </strong>{" "}
          on {leg.send.blockchain}. {leg.payee} receives exactly{" "}
          <strong>
            {shown(leg.receive.amount)} {leg.receive.symbol}
          </strong>{" "}
          on {leg.receive.blockchain}, at <code className="leg__address">{leg.address}</code>.
          {leg.dry && " Preview only: no deposit address has been issued."}
        </p>
      )}
      {leg.status === "direct_transfer" && leg.receive && (
        <p className="leg__detail">
          Send <strong>{shown(leg.receive.amount)} {leg.receive.symbol}</strong> on {leg.receive.blockchain} straight to{" "}
          <code className="leg__address">{leg.address}</code>. You already hold what they asked for, so no swap is needed.
        </p>
      )}
      {(leg.status === "no_payout_details" || leg.status === "unsupported" || leg.status === "error") && (
        <p className="leg__detail">{leg.reason}</p>
      )}
    </li>
  );
}

const TAGS: Record<Leg["status"], { label: string; className: string }> = {
  quoted: { label: "Quote ready", className: "tag--ok" },
  direct_transfer: { label: "Send directly", className: "tag--ok" },
  no_payout_details: { label: "Pay another way", className: "tag--wait" },
  unsupported: { label: "Not supported", className: "tag--warn" },
  error: { label: "Could not quote", className: "tag--bad" },
};