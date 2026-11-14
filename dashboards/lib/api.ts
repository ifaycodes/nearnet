// Types mirror what the demo server returns; the functions talk to it.

export type Invoice = {
  ref: string;
  seller: string;
  buyer: string;
  amount_cents: number;
  currency: string;
};

export type PayoutDetails = { symbol: string; blockchain: string; address: string };
export type Payment = { payer: string; payee: string; amount_cents: number; payout?: PayoutDetails };
export type Issue = { kind: string; ref: string; parties: string[]; detail: string };
export type Amount = { amount: string; symbol: string; blockchain: string };
export type Leg = {
  payee: string;
  amount_cents: number;
  dry: boolean;
  status: "quoted" | "direct_transfer" | "no_payout_details" | "unsupported" | "error";
  reason: string | null;
  payout: PayoutDetails | null;
  address?: string;
  send?: Amount;
  receive?: Amount;
  deposit_address?: string | null;
  time_estimate?: number | null;
};
export type Result =
  | { verified: true; position_cents: number; pays: Payment[]; receives: Payment[]; issues: Issue[] }
  | { verified: false; error: string };

export type Company = {
  name: string;
  invoices: Invoice[];
  payout: PayoutDetails | null;
  settlement: Leg[] | null;
  submission: {
    status: "delivered" | "queued";
    seq: number;
    invoice_count: number;
    chars: number;
    preview: string;
  } | null;
  sealed_result: { chars: number; preview: string } | null;
  result: Result | null;
};

export type Summary = {
  invoice_count: number;
  gross_cents: number;
  net_cents: number;
  saved_cents: number;
  reduction_pct: number;
  payment_count: number;
  flagged_count: number;
};

export type Receipt = { cycle_id: string; root: string; participants: number; signature: string };

export type Attack = { id: string; title: string; outcome: string; blocked: boolean; detail: string };

export type LogLine = { n: number; actor: string; text: string };

export type DemoState = {
  phase: "idle" | "open" | "closed";
  cycle_id: string | null;
  coordinator_up: boolean;
  engine: {
    platform: string;
    hardware_attested: boolean;
    warning: string | null;
    signing_key: string;
  } | null;
  companies: Company[];
  summary: Summary | null;
  receipt: Receipt | null;
  attacks: Attack[];
  log: LogLine[];
  checks: string[];
  settlement: { available: boolean; pay_from: { symbol: string; blockchain: string } };
  near: {
    configured: boolean;
    contract: string;
    anchor_args: Record<string, unknown> | null;
    anchor_command: string | null;
  };
};

export type OnChain = {
  status: "not_configured" | "waiting" | "not_anchored" | "verified" | "rejected" | "unreachable";
  reason?: string;
  detail?: string;
  engine_revoked?: boolean;
  record?: { anchored_by: string; block_height: string; engine_key: string; root: string };
};

async function request<T>(path: string, method: "GET" | "POST"): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/demo/${path}`, { method, cache: "no-store" });
  } catch {
    throw new Error("The demo server is not running. Start the stack, then reload this page.");
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body && typeof body.detail === "string" ? body.detail : `Request failed (${response.status})`;
    throw new Error(detail);
  }
  return body as T;
}

export const getState = () => request<DemoState>("state", "GET");
export const act = (path: string) => request<DemoState>(path, "POST");
export const getOnChain = () => request<OnChain>("onchain", "GET");

// ---------- formatting ----------

export function money(cents: number): string {
  const dollars = Math.abs(cents) / 100;
  const text = dollars.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${cents < 0 ? "-" : ""}$${text}`;
}

export const shortHex = (hex: string, n = 14) => (hex.length > n * 2 ? `${hex.slice(0, n)}…${hex.slice(-6)}` : hex);