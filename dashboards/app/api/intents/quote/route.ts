import { NextResponse } from "next/server";

const INTENTS_URL = process.env.INTENTS_URL ?? "https://1click.chaindefuser.com";
const INTENTS_JWT = process.env.INTENTS_JWT;
const STABLECOINS = new Set(["USDC", "USDT"]);
const MAX_DEPEG = 0.03;

type Payout = { symbol: string; blockchain: string; address: string };
type PayItem = { payee: string; amount_cents: number; payout?: Payout | null };
type TokenInfo = { symbol: string; blockchain: string; assetId: string; decimals: number; price: number };

function formatUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function resolveToken(tokens: TokenInfo[], symbol: string, blockchain: string): { token?: TokenInfo; problem?: string } {
  const sym = symbol.toUpperCase();
  const chain = blockchain.toLowerCase();
  if (!STABLECOINS.has(sym)) {
    return { problem: `${sym} is not supported (use USDC or USDT)` };
  }
  const matches = tokens.filter(
    (t) => String(t.symbol).toUpperCase() === sym && String(t.blockchain).toLowerCase() === chain,
  );
  if (matches.length === 0) {
    const chains = [...new Set(tokens.filter((t) => String(t.symbol).toUpperCase() === sym).map((t) => t.blockchain))];
    return { problem: `1Click does not list ${sym} on '${chain}'${chains.length ? ` (available: ${chains.join(", ")})` : ""}` };
  }
  const token = matches[0];
  if (typeof token.price !== "number" || Math.abs(token.price - 1.0) > MAX_DEPEG) {
    return { problem: `${sym} on '${chain}' is quoted at ${token.price}, not close to $1` };
  }
  return { token };
}

export async function POST(req: Request) {
  try {
    const { pays, payFrom, dry = true } = (await req.json()) as {
      pays: PayItem[];
      payFrom: { symbol: string; blockchain: string; refund_to: string };
      dry?: boolean;
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (INTENTS_JWT) headers["Authorization"] = `Bearer ${INTENTS_JWT}`;

    const tokRes = await fetch(`${INTENTS_URL}/v0/tokens`, { headers, cache: "no-store" });
    if (!tokRes.ok) {
      return NextResponse.json({ detail: `1Click tokens failed (${tokRes.status})` }, { status: 502 });
    }
    const tokens = (await tokRes.json()) as TokenInfo[];
    const origin = resolveToken(tokens, payFrom.symbol, payFrom.blockchain);

    const legs = [];
    for (const pay of pays) {
      const payout = pay.payout ?? null;
      if (!payout) {
        legs.push({
          payee: pay.payee,
          amount_cents: pay.amount_cents,
          dry,
          status: "no_payout_details",
          reason: `${pay.payee} did not share on-chain payout details; pay by your usual means.`,
          payout: null,
        });
        continue;
      }
      if (!origin.token) {
        legs.push({
          payee: pay.payee,
          amount_cents: pay.amount_cents,
          dry,
          status: "unsupported",
          reason: `Your payment asset: ${origin.problem}`,
          payout,
        });
        continue;
      }
      const dest = resolveToken(tokens, payout.symbol, payout.blockchain);
      if (!dest.token) {
        legs.push({
          payee: pay.payee,
          amount_cents: pay.amount_cents,
          dry,
          status: "unsupported",
          reason: `${pay.payee}'s payout asset: ${dest.problem}`,
          payout,
        });
        continue;
      }

      const units = BigInt(pay.amount_cents) * (10n ** BigInt(dest.token.decimals - 2));
      const receive = {
        amount: formatUnits(units, dest.token.decimals),
        symbol: dest.token.symbol.toUpperCase(),
        blockchain: dest.token.blockchain,
      };

      if (dest.token.assetId === origin.token.assetId) {
        legs.push({
          payee: pay.payee,
          amount_cents: pay.amount_cents,
          dry,
          status: "direct_transfer",
          reason: "Same asset and chain — send directly, no swap needed.",
          payout,
          address: payout.address,
          send: receive,
          receive,
        });
        continue;
      }

      const quoteRes = await fetch(`${INTENTS_URL}/v0/quote`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          dry,
          swapType: "EXACT_OUTPUT",
          slippageTolerance: 50,
          originAsset: origin.token.assetId,
          depositType: "ORIGIN_CHAIN",
          destinationAsset: dest.token.assetId,
          amount: units.toString(),
          refundTo: payFrom.refund_to,
          refundType: "ORIGIN_CHAIN",
          recipient: payout.address,
          recipientType: "DESTINATION_CHAIN",
          deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
        }),
      });
      const body = await quoteRes.json().catch(() => null);
      if (!quoteRes.ok || !body?.quote) {
        legs.push({
          payee: pay.payee,
          amount_cents: pay.amount_cents,
          dry,
          status: "error",
          reason: body?.message ?? `1Click quote failed (${quoteRes.status})`,
          payout,
        });
        continue;
      }

      const q = body.quote;
      legs.push({
        payee: pay.payee,
        amount_cents: pay.amount_cents,
        dry,
        status: "quoted",
        reason: null,
        payout,
        address: payout.address,
        send: {
          amount: q.amountInFormatted ?? q.amountIn,
          symbol: origin.token.symbol.toUpperCase(),
          blockchain: origin.token.blockchain,
        },
        receive: {
          amount: q.amountOutFormatted ?? q.amountOut,
          symbol: receive.symbol,
          blockchain: receive.blockchain,
        },
        deposit_address: q.depositAddress ?? null,
        time_estimate: q.timeEstimate ?? null,
      });
    }

    return NextResponse.json({ legs });
  } catch (err) {
    return NextResponse.json({ detail: (err as Error).message }, { status: 500 });
  }
}