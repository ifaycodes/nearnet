import { openJson, sealJson, toHex } from "./crypto";
import { Leg, OnChain, PayoutDetails } from "./api";
export type Participant = {
  name: string;
  public_key: string | null;
};

export type CycleOut = {
  id: string;
  currency: string;
  state: "open" | "settled";
  cutoff: string | null;
  participants: Participant[];
  submitted: string[];
  summary: {
    invoice_count: number;
    total_amount_cents: number;
    net_cents: number;
    saved_cents: number;
    reduction_pct: number;
    payment_count: number;
    flagged_count: number;
  } | null;
  receipt: {
    cycle_id: string;
    root: string;
    participants: number;
    signature: string;
  } | null;
};

export type InvoiceInput = {
  ref: string;
  seller: string;
  buyer: string;
  amount_cents: number;
  currency: string;
};

export type PaymentLine = {
  payer: string;
  payee: string;
  amount_cents: number;
  payout?: PayoutDetails;
};

export type AttestationOut = {
  platform: string;
  keys: {
    encryption_public_key: string;
    signing_public_key: string;
  };
  report_data: string;
  quote: string | null;
  event_log: string | null;
  warning: string | null;
};
export type VerifiedEngine = {
  encryptionPublicKey: string;
  signingPublicKey: string;
  platform: string;
  hardwareAttested: boolean;
  reportData: string;
  warning: string | null;
};

export type DecryptedResult = {
  cycle_id: string;
  company: string;
  position_cents: number;
  pays: PaymentLine[];
  receives: PaymentLine[];
  issues: { ref: string; detail: string }[];
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/coord${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body && typeof body.detail === "string" ? body.detail : `Request failed (${res.status})`;
    throw new Error(detail);
  }
  return body as T;
}

export const getEngineKeys = () =>
  api<{ encryption_public_key: string; signing_public_key: string }>("/keys");

export async function fetchVerifiedEngine(): Promise<VerifiedEngine> {
  const att = await api<AttestationOut>("/attestation");
  // Keys must stay in alphabetical order to match Python's canonical()
  const bindingJson = JSON.stringify({
    encryption_public_key: att.keys.encryption_public_key,
    signing_public_key: att.keys.signing_public_key,
    type: "netting-engine-keys",
    version: 1,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bindingJson));
  const expectedReportData = toHex(new Uint8Array(digest)) + "0".repeat(64);
  if (att.report_data.toLowerCase() !== expectedReportData) {
    throw new Error("Attestation check failed: engine keys do not match report_data.");
  }
  if (att.platform === "dstack-tdx") {
    if (!att.quote || att.quote.length < (568 + 64) * 2) {
      throw new Error("Attestation check failed: missing or truncated TDX quote.");
    }
    const quoteReportData = att.quote.slice(568 * 2, (568 + 64) * 2).toLowerCase();
    if (quoteReportData !== expectedReportData) {
      throw new Error("Attestation check failed: TDX quote does not cover these engine keys.");
    }
  } else if (att.platform !== "simulated") {
    throw new Error(`Unknown attestation platform: ${att.platform}`);
  }
  return {
    encryptionPublicKey: att.keys.encryption_public_key,
    signingPublicKey: att.keys.signing_public_key,
    platform: att.platform,
    hardwareAttested: att.platform === "dstack-tdx",
    reportData: att.report_data,
    warning: att.warning,
  };
}

export const createCycle = (
  currency: string,
  participants: { name: string; public_key: string | null }[],
  cutoff: string | null = null,
) =>
  api<CycleOut>("/cycles", {
    method: "POST",
    body: JSON.stringify({ currency, participants, cutoff }),
  });

export const getCycle = (cycleId: string) => api<CycleOut>(`/cycles/${encodeURIComponent(cycleId)}`);

export const joinCycle = (cycleId: string, company: string, publicKey: string) =>
  api<CycleOut>(`/cycles/${encodeURIComponent(cycleId)}/join`, {
    method: "POST",
    body: JSON.stringify({ company, public_key: publicKey }),
  });

export async function submitEncrypted(params: {
  cycleId: string;
  company: string;
  seq: number;
  invoices: InvoiceInput[];
  payout?: PayoutDetails | null;
  mySecretKey: string;
  enginePublicKey: string;
}) {
  const payload: Record<string, unknown> = {
    version: 1,
    cycle_id: params.cycleId,
    company: params.company,
    seq: params.seq,
    invoices: params.invoices,
  };
  if (params.payout) {
    payload.payout = params.payout;
  }
  const ciphertext = sealJson(params.mySecretKey, params.enginePublicKey, payload);
  return api<{ company: string; seq?: number; invoice_count?: number; status?: string }>(
    `/cycles/${encodeURIComponent(params.cycleId)}/submissions`,
    {
      method: "POST",
      body: JSON.stringify({ company: params.company, ciphertext }),
    },
  );
}

export const closeCycle = (cycleId: string) =>
  api<CycleOut>(`/cycles/${encodeURIComponent(cycleId)}/close`, { method: "POST" });

export async function fetchDecryptedResult(params: {
  cycleId: string;
  company: string;
  mySecretKey: string;
  enginePublicKey: string;
}): Promise<DecryptedResult> {
  const sealed = await api<{ ciphertext: string }>(
    `/cycles/${encodeURIComponent(params.cycleId)}/results/${encodeURIComponent(params.company)}`,
  );
  return openJson<DecryptedResult>(params.mySecretKey, params.enginePublicKey, sealed.ciphertext);
}

export async function fetchIntentsQuote(params: {
  pays: PaymentLine[];
  payFrom: { symbol: string; blockchain: string; refund_to: string };
  dry?: boolean;
}): Promise<Leg[]> {
  const res = await fetch("/api/intents/quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(body?.detail ?? `Quote failed (${res.status})`);
  }
  return body.legs as Leg[];
}

export async function verifyOnNear(params: {
  cycleId: string;
  expectedRoot: string;
  expectedEngineKeyHex: string;
}): Promise<OnChain> {
  const res = await fetch("/api/near/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return (await res.json()) as OnChain;
}