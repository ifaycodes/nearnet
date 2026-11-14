from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import httpx

DEFAULT_URL = "https://1click.chaindefuser.com"
STABLECOINS = frozenset({"USDC", "USDT"})
MAX_DEPEG = 0.03  # a "dollar" token quoted outside $0.97-$1.03 is not treated as one


class IntentsError(Exception):
    """1Click could not be reached, refused the request, or sent nonsense."""


@dataclass(frozen=True)
class PayFrom:
    """What the payer sends from, and where leftovers return if a swap fails."""

    symbol: str  # e.g. "USDC"
    blockchain: str  # as named in 1Click's token list, e.g. "near"
    refund_to: str  # the payer's own address on that chain


# ------------------------------ 1Click
class IntentsClient:
    def __init__(self, http, jwt: str | None = None) -> None:
        self._http, self._jwt = http, jwt

    def _call(self, method: str, path: str, **kwargs):
        headers = {"Authorization": f"Bearer {self._jwt}"} if self._jwt else {}
        try:
            response = getattr(self._http, method)(path, headers=headers, **kwargs)
        except httpx.TransportError as exc:
            raise IntentsError("could not reach NEAR Intents (1Click)") from exc
        if response.status_code >= 400:
            raise IntentsError(
                f"1Click refused the request (HTTP {response.status_code}): {_message(response)}"
            )
        try:
            return response.json()
        except ValueError as exc:
            raise IntentsError("1Click answered with something that is not JSON") from exc

    def tokens(self) -> list[dict]:
        body = self._call("get", "/v0/tokens")
        if not isinstance(body, list):
            raise IntentsError("1Click's token list was not a list")
        return body

    def quote(self, request: dict) -> dict:
        body = self._call("post", "/v0/quote", json=request)
        if not isinstance(body, dict):
            raise IntentsError("1Click's quote was not an object")
        return body

    def status(self, deposit_address: str, deposit_memo: str | None = None) -> dict:
        params = {"depositAddress": deposit_address}
        if deposit_memo:
            params["depositMemo"] = deposit_memo
        body = self._call("get", "/v0/status", params=params)
        if not isinstance(body, dict):
            raise IntentsError("1Click's status was not an object")
        return body


def _message(response) -> str:
    try:
        detail = response.json()
        if isinstance(detail, dict) and detail.get("message"):
            return str(detail["message"])[:300]
    except ValueError:
        pass
    return (getattr(response, "text", "") or "no details")[:300]


def intents_from_env(env=os.environ) -> IntentsClient:
    """INTENTS_URL (default 1Click's), INTENTS_JWT (optional: removes the fee)."""
    http = httpx.Client(base_url=env.get("INTENTS_URL", DEFAULT_URL), timeout=30)
    return IntentsClient(http, env.get("INTENTS_JWT") or None)


# --------------------------------- planning


def cents_to_units(cents: int, decimals: int) -> int:
    """US-dollar cents -> a dollar token's smallest unit. Integers only."""
    if not isinstance(decimals, int) or decimals < 2:
        raise ValueError("a dollar token needs at least 2 decimals")
    return cents * 10 ** (decimals - 2)


def _formatted(units: int, decimals: int) -> str:
    return f"{Decimal(units).scaleb(-decimals):f}"


def _index(tokens: list[dict]) -> dict[tuple[str, str], list[dict]]:
    index: dict[tuple[str, str], list[dict]] = {}
    for token in tokens:
        try:
            key = (str(token["symbol"]).upper(), str(token["blockchain"]).lower())
        except (KeyError, TypeError):
            continue
        index.setdefault(key, []).append(token)
    return index


def _resolve(index, symbol: str, blockchain: str) -> tuple[dict | None, str | None]:
    """Find one usable dollar token, or say plainly why not."""
    sym, chain = symbol.upper(), blockchain.lower()
    if sym not in STABLECOINS:
        return None, f"{sym} is not a supported dollar stablecoin (supported: {', '.join(sorted(STABLECOINS))})"
    found = index.get((sym, chain), [])
    if not found:
        where = sorted({c for (s, c) in index if s == sym})
        hint = f"; {sym} is listed on: {', '.join(where)}" if where else ""
        return None, f"1Click does not list {sym} on '{chain}'{hint}"
    if len({t.get("assetId") for t in found}) > 1:
        return None, f"{sym} on '{chain}' matches more than one token; be more specific"
    token = found[0]
    price = token.get("price")
    if not isinstance(price, (int, float)) or abs(price - 1.0) > MAX_DEPEG:
        return None, f"{sym} on '{chain}' is quoted at {price}, not close to $1; refusing to treat it as a dollar"
    if not isinstance(token.get("decimals"), int) or not token.get("assetId"):
        return None, f"1Click's entry for {sym} on '{chain}' is incomplete"
    return token, None


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def plan_settlement(
    pays: list[dict],
    *,
    intents: IntentsClient,
    pay_from: PayFrom,
    dry: bool = True,
    now: datetime | None = None,
    slippage_bps: int = 50,
    ttl_minutes: int = 30,
) -> list[dict]:
    """One result per payment, in order. Never raises for a single bad payment."""
    now = now or datetime.now(timezone.utc)
    index = _index(intents.tokens())
    origin, origin_problem = _resolve(index, pay_from.symbol, pay_from.blockchain)
    legs = []

    for pay in pays:
        payout = pay.get("payout")
        leg = {
            "payee": pay["payee"],
            "amount_cents": pay["amount_cents"],
            "status": None,
            "reason": None,
            "dry": dry,
            "payout": payout,
        }
        legs.append(leg)

        if not payout:
            leg.update(
                status="no_payout_details",
                reason=f"{pay['payee']} did not share on-chain payout details; pay by your usual means.",
            )
            continue
        if origin is None:
            leg.update(status="unsupported", reason=f"your payment asset: {origin_problem}")
            continue
        dest, problem = _resolve(index, str(payout.get("symbol", "")), str(payout.get("blockchain", "")))
        if dest is None:
            leg.update(status="unsupported", reason=f"{pay['payee']}'s payout asset: {problem}")
            continue

        try:
            units = cents_to_units(pay["amount_cents"], dest["decimals"])
        except ValueError as exc:
            leg.update(status="unsupported", reason=str(exc))
            continue
        receive = {
            "amount": _formatted(units, dest["decimals"]),
            "symbol": dest["symbol"].upper(),
            "blockchain": dest["blockchain"],
        }
        address = payout["address"]

        if dest["assetId"] == origin["assetId"]:
            leg.update(
                status="direct_transfer",
                reason="You already hold the asset they asked for on that chain: send it directly, no swap needed.",
                send=receive,
                receive=receive,
                address=address,
            )
            continue

        request = {
            "dry": dry,
            "swapType": "EXACT_OUTPUT",
            "slippageTolerance": slippage_bps,
            "originAsset": origin["assetId"],
            "depositType": "ORIGIN_CHAIN",
            "destinationAsset": dest["assetId"],
            "amount": str(units),
            "refundTo": pay_from.refund_to,
            "refundType": "ORIGIN_CHAIN",
            "recipient": address,
            "recipientType": "DESTINATION_CHAIN",
            "deadline": _iso(now + timedelta(minutes=ttl_minutes)),
        }
        try:
            answer = intents.quote(request)
            quote = answer.get("quote") if isinstance(answer, dict) else None
            if not isinstance(quote, dict) or "amountIn" not in quote or "amountOut" not in quote:
                raise IntentsError("1Click's quote did not contain the amounts")
            if not dry and not quote.get("depositAddress"):
                raise IntentsError("1Click's live quote did not include a deposit address")
        except IntentsError as exc:
            leg.update(status="error", reason=str(exc))
            continue

        leg.update(
            status="quoted",
            address=address,
            send={
                "amount": quote.get("amountInFormatted") or quote["amountIn"],
                "symbol": origin["symbol"].upper(),
                "blockchain": origin["blockchain"],
            },
            receive={
                "amount": quote.get("amountOutFormatted") or quote["amountOut"],
                "symbol": receive["symbol"],
                "blockchain": receive["blockchain"],
            },
            deposit_address=quote.get("depositAddress"),
            deposit_memo=quote.get("depositMemo"),
            deadline=quote.get("deadline"),
            time_estimate=quote.get("timeEstimate"),
        )
    return legs