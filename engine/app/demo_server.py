"""Demo harness: plays the five sample companies against a LIVE coordinator.

In real life each company runs its own connector and only ever sees its own
data. For a demo on one screen, this service stands in for all five: it holds
their keys, seals and sends their (sample) invoices through the real
coordinator to the real engine, opens each company's result and verifies it
exactly as a real connector would. The dashboard drives it and displays the
three viewpoints: each company, the coordinator, and the public.

Nothing here is trusted by the system. It is a stand-in for the companies.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable

import httpx
from fastapi import FastAPI, HTTPException

from .clientlib import (
    AttestationError,
    CompanyClient,
    VerificationError,
    phala_verify_quote,
    verify_engine_identity,
)
from .crypto import b64d, b64e, verify_signature
from .demo_data import COMPANIES, DEMO_PAYOUTS, build_submissions
from .settlement import receipt_message
from .payments import IntentsClient, IntentsError, PayFrom, intents_from_env, plan_settlement
DEMO_PAY_FROM = PayFrom("USDC", 'near', 'assembly-sample.near')

CHECKS = [
    "Decrypted with the company's own key",
    "Merkle proof reaches the root the engine signed",
    "The engine's signature on that root is valid",
    "Same receipt as the public one",
]


def _detail(response: httpx.Response) -> str:
    try:
        detail = response.json().get("detail")
    except Exception:
        detail = None
    return str(detail) if detail is not None else f"HTTP {response.status_code}"


def _preview(ciphertext: str) -> str:
    return ciphertext[:44]


class Session:
    """One run of the demo. Reset throws it away and starts a new one."""

    def __init__(self) -> None:
        self.clients = {n: CompanyClient(n) for n in COMPANIES}
        self.subs = {s.company: s for s in build_submissions()}
        self.identity = None
        self.engine_info: dict | None = None
        self.cycle_id: str | None = None
        self.phase = "idle"  # idle -> open -> closed
        self.sent: dict[str, dict] = {}
        self.envelopes: dict[str, dict] = {}
        self.sealed_results: dict[str, dict] = {}
        self.views: dict[str, dict] = {}
        self.summary: dict | None = None
        self.receipt: dict | None = None
        self.attacks: list[dict] = []
        self.settlements: dict[str, list[dict]] = {}
        self.log: list[dict] = []

    def say(self, actor: str, text: str) -> None:
        self.log.append({"n": len(self.log) + 1, "actor": actor, "text": text})


def near_view(rpc_url: str, contract: str) -> Callable[[str, dict], object]:
    """Read-only calls to the receipt contract over NEAR's JSON-RPC."""

    def view(method: str, args: dict):
        r = httpx.post(
            rpc_url,
            timeout=20,
            json={
                "jsonrpc": "2.0",
                "id": "demo",
                "method": "query",
                "params": {
                    "request_type": "call_function",
                    "finality": "final",
                    "account_id": contract,
                    "method_name": method,
                    "args_base64": b64e(json.dumps(args).encode()),
                },
            },
        )
        body = r.json()
        if "error" in body or "error" in body.get("result", {}):
            raise RuntimeError(f"rpc error: {body.get('error') or body['result']['error']}")
        return json.loads(bytes(body["result"]["result"]).decode())

    return view


def create_demo(
    coordinator,
    rpc_view: Callable[[str, dict], object] | None = None,
    near_contract: str | None = None,
    near_owner: str | None = None,
    intents: IntentsClient | None = None
) -> FastAPI:
    """`coordinator` behaves like an httpx.Client pointed at the coordinator."""
    app = FastAPI(title="Netting demo harness")
    box = {"s": Session()}

    def coord(method: str, path: str, **kwargs) -> httpx.Response:
        try:
            return getattr(coordinator, method)(path, **kwargs)
        except httpx.TransportError as exc:
            raise HTTPException(502, "the coordinator is not reachable") from exc

    def session() -> Session:
        return box["s"]

    def anchor_args(s: Session) -> dict | None:
        if s.receipt is None or s.identity is None:
            return None
        return {
            "cycle_id": s.receipt["cycle_id"],
            "root": s.receipt["root"],
            "participants": s.receipt["participants"],
            "engine_key": s.identity.verify_key.hex(),
            "signature": b64d(s.receipt["signature"]).hex(),
        }

    def state() -> dict:
        s = session()
        try:
            coordinator.get("/attestation")
            up = True
        except httpx.TransportError:
            up = False
        companies = []
        for name in COMPANIES:
            companies.append(
                {
                    "name": name,
                    "invoices": [
                        {
                            "ref": i.ref,
                            "seller": i.seller,
                            "buyer": i.buyer,
                            "amount_cents": i.amount_cents,
                            "currency": i.currency,
                        }
                        for i in s.subs[name].invoices
                    ],
                    "payout": DEMO_PAYOUTS[name].to_json() if name in DEMO_PAYOUTS else None,
                    "submission": s.sent.get(name),
                    "sealed_result": s.sealed_results.get(name),
                    "result": s.views.get(name),
                    "settlement": s.settlements.get(name)
                }
            )
        contract = near_contract or "YOUR-CONTRACT.testnet"
        owner = near_owner or contract
        args = anchor_args(s)
        return {
            "phase": s.phase,
            "cycle_id": s.cycle_id,
            "coordinator_up": up,
            "engine": s.engine_info,
            "companies": companies,
            "summary": s.summary,
            "receipt": s.receipt,
            "attacks": s.attacks,
            "log": s.log,
            "checks": CHECKS,
            "settlement": {
                "available": intents is not None,
                "pay_from": {
                    "symbol": DEMO_PAY_FROM.symbol,
                    "blockchain": DEMO_PAY_FROM.blockchain,
                }
            },
            "near": {
                "configured": rpc_view is not None,
                "contract": contract,
                "anchor_args": args,
                "anchor_command": None
                if args is None
                else (
                    f"near contract call-function as-transaction {contract} anchor_receipt "
                    f"json-args '{json.dumps(args)}' prepaid-gas '30 Tgas' "
                    f"attached-deposit '0 NEAR' sign-as {owner} network-config testnet "
                    "sign-with-keychain send"
                ),
            },
        }

    @app.get("/demo/state")
    def get_state() -> dict:
        return state()

    @app.post("/demo/reset")
    def reset() -> dict:
        box["s"] = Session()
        return state()

    @app.post("/demo/start")
    def start() -> dict:
        s = session()
        if s.phase != "idle":
            raise HTTPException(409, "a cycle is already running; reset to start over")

        attestation = coord("get", "/attestation").json()
        try:
            identity = verify_engine_identity(
                attestation, verify_quote=phala_verify_quote, allow_simulated=True
            )
        except AttestationError as exc:
            raise HTTPException(502, f"engine identity check failed: {exc}") from exc

        r = coord(
            "post",
            "/cycles",
            json={
                "participants": [
                    {"name": n, "public_key": c.public_key_b64} for n, c in s.clients.items()
                ]
            },
        )
        if r.status_code != 201:
            raise HTTPException(502, f"could not open a cycle: {_detail(r)}")

        s.identity = identity
        s.cycle_id = r.json()["id"]
        s.phase = "open"
        s.engine_info = {
            "platform": identity.platform,
            "hardware_attested": identity.hardware_attested,
            "warning": attestation.get("warning"),
            "signing_key": identity.verify_key.hex(),
        }
        how = "hardware attested" if identity.hardware_attested else "SIMULATED, not hardware attested"
        s.say("you", f"Opened cycle {s.cycle_id} for {len(COMPANIES)} companies")
        s.say("engine", f"Identity checked before sending anything: {identity.platform} ({how})")
        return state()

    @app.post("/demo/submit/{company}")
    def submit(company: str) -> dict:
        s = session()
        if company not in s.clients:
            raise HTTPException(404, "unknown company")
        if s.phase != "open":
            raise HTTPException(409, "open a cycle first" if s.phase == "idle" else "the cycle is closed")

        envelope = s.clients[company].seal_submission(
            s.identity.box_pk, s.cycle_id, 1, s.subs[company].invoices, DEMO_PAYOUTS.get(company)
        )
        r = coord("post", f"/cycles/{s.cycle_id}/submissions", json=envelope)
        if r.status_code not in (200, 202):
            raise HTTPException(r.status_code, _detail(r))

        count = len(s.subs[company].invoices)
        s.envelopes[company] = envelope
        s.sent[company] = {
            "status": "delivered" if r.status_code == 200 else "queued",
            "seq": 1,
            "invoice_count": count,
            "chars": len(envelope["ciphertext"]),
            "preview": _preview(envelope["ciphertext"]),
        }
        s.say(
            f"company:{company}",
            f"Sealed {count} invoices"
            + (" and onchain payout details" if company in DEMO_PAYOUTS else "")
            + f"to the engine's key and sent them ({len(envelope['ciphertext'])} characters of ciphertext)",
        )
        s.say("coordinator", f"Relayed {company}'s box to the engine; it cannot open it")
        return state()

    @app.post("/demo/close")
    def close() -> dict:
        s = session()
        if s.phase != "open":
            raise HTTPException(409, "there is no open cycle to close")
        r = coord("post", f"/cycles/{s.cycle_id}/close")
        if r.status_code != 200:
            raise HTTPException(r.status_code, _detail(r))

        data = r.json()
        s.summary, s.receipt = data["summary"], data["receipt"]
        s.say(
            "engine",
            f"Matched {s.summary['invoice_count']} invoices and netted them; "
            f"{s.summary['flagged_count']} flagged for the companies involved",
        )

        for name, client in s.clients.items():
            sealed = coord("get", f"/cycles/{s.cycle_id}/results/{name}").json()
            s.sealed_results[name] = {
                "chars": len(sealed["ciphertext"]),
                "preview": _preview(sealed["ciphertext"]),
            }
            try:
                package = client.open_result(s.identity.box_pk, sealed)
                client.verify_result(
                    package,
                    engine_verify_key=s.identity.verify_key,
                    cycle_id=s.cycle_id,
                    public_receipt=s.receipt,
                )
                s.views[name] = {
                    "verified": True,
                    "position_cents": package["position_cents"],
                    "pays": package["pays"],
                    "receives": package["receives"],
                    "issues": package["issues"],
                }
            except VerificationError as exc:
                s.views[name] = {"verified": False, "error": str(exc)}
            ok = "verified" if s.views[name]["verified"] else "FAILED verification"
            s.say(f"company:{name}", f"Opened its own result with its own key; {ok}")

        s.say("public", f"Receipt published: root {s.receipt['root'][:12]}..., no amounts")
        s.phase = "closed"
        return state()

        # ---- paying on-chain (preview only) ----

    @app.post("/demo/quote/{company}")
    def quote(company: str) -> dict:
        """Price one company's payments through NEAR Intents. Always a dry run:
        nothing is sent and no deposit address is issued."""
        s = session()
        if company not in s.clients:
            raise HTTPException(404, "unknown company")
        if intents is None:
            raise HTTPException(501, "on-chain quotes are not configured on this demo server")
        if s.phase != "closed":
            raise HTTPException(409, "close the cycle first; there are no payments to price yet")
        view = s.views.get(company)
        if not view or not view["verified"]:
            raise HTTPException(409, f"{company}'s result did not verify, so there is nothing safe to pay from")
        try:
            legs = plan_settlement(view["pays"], intents=intents, pay_from=DEMO_PAY_FROM, dry=True)
        except IntentsError as exc:
            raise HTTPException(502, str(exc)) from exc
        s.settlements[company] = legs
        if legs:
            s.say(
                f"company:{company}",
                f"Asked NEAR Intents to price {len(legs)} payment{'s' if len(legs) != 1 else ''} "
                "(dry run: nothing was sent)",
            )
        else:
            s.say(f"company:{company}", "Has no payments to make this cycle")
        return state()
    
    # ---- things that should fail, shown failing ----

    def need_cycle(s: Session) -> None:
        if s.cycle_id is None:
            raise HTTPException(409, "open a cycle first")

    def record(s: Session, attack: dict) -> dict:
        s.attacks.append(attack)
        s.say("attack", f"{attack['title']}: {attack['outcome']}")
        return state()

    @app.post("/demo/attack/tamper")
    def tamper() -> dict:
        s = session()
        if s.phase != "closed":
            raise HTTPException(409, "close the cycle first; there is no result to tamper with")
        name = COMPANIES[0]
        sealed = coord("get", f"/cycles/{s.cycle_id}/results/{name}").json()
        blob = bytearray(b64d(sealed["ciphertext"]))
        blob[len(blob) // 2] ^= 0x01
        try:
            s.clients[name].open_result(s.identity.box_pk, {"ciphertext": b64e(bytes(blob))})
        except VerificationError as exc:
            outcome, blocked, detail = "blocked", True, f"{name} rejected it: {exc}"
        else:
            outcome, blocked, detail = "NOT BLOCKED", False, "the altered result was accepted"
        return record(
            s,
            {
                "id": "tamper",
                "title": f"The coordinator flips one bit of {name}'s result",
                "outcome": outcome,
                "blocked": blocked,
                "detail": detail,
            },
        )

    @app.post("/demo/attack/outsider")
    def outsider() -> dict:
        s = session()
        need_cycle(s)
        mallory = CompanyClient("Mallory")
        envelope = mallory.seal_submission(s.identity.box_pk, s.cycle_id, 1, [])
        r = coord("post", f"/cycles/{s.cycle_id}/submissions", json=envelope)
        blocked = r.status_code == 403
        return record(
            s,
            {
                "id": "outsider",
                "title": "A company that is not in the cycle submits invoices",
                "outcome": "blocked" if blocked else "NOT BLOCKED",
                "blocked": blocked,
                "detail": f"HTTP {r.status_code}: {_detail(r)}",
            },
        )

    @app.post("/demo/attack/replay")
    def replay() -> dict:
        s = session()
        if s.phase != "open" or not s.envelopes:
            raise HTTPException(409, "submit at least one company's invoices first, before closing")
        name = next(iter(s.envelopes))
        r = coord("post", f"/cycles/{s.cycle_id}/submissions", json=s.envelopes[name])
        blocked = r.status_code == 409
        return record(
            s,
            {
                "id": "replay",
                "title": f"{name}'s earlier submission is sent again",
                "outcome": "blocked" if blocked else "NOT BLOCKED",
                "blocked": blocked,
                "detail": f"HTTP {r.status_code}: {_detail(r)}",
            },
        )

    # ---- the public record on NEAR ----

    @app.get("/demo/onchain")
    def onchain() -> dict:
        s = session()
        if rpc_view is None:
            return {"status": "not_configured"}
        if s.phase != "closed":
            return {"status": "waiting"}
        try:
            record_ = rpc_view("get_receipt", {"cycle_id": s.cycle_id})
            if record_ is None:
                return {"status": "not_anchored"}
            engine = rpc_view("get_engine", {"signing_public_key": record_["engine_key"]})
        except Exception as exc:  # network or contract trouble: say so plainly
            return {"status": "unreachable", "detail": str(exc)}

        def rejected(reason: str) -> dict:
            return {"status": "rejected", "reason": reason, "record": record_}

        if engine is None:
            return rejected("the receipt names an engine key nobody registered")
        try:
            message = receipt_message(record_["cycle_id"], record_["root"], record_["participants"])
            signature_ok = verify_signature(
                bytes.fromhex(record_["engine_key"]), message, bytes.fromhex(record_["signature"])
            )
        except Exception:
            signature_ok = False
        if not signature_ok:
            return rejected("the engine's signature does not match the anchored receipt")
        if record_["root"] != s.receipt["root"]:
            return rejected("the anchored root differs from this cycle's receipt")
        if record_["engine_key"] != s.identity.verify_key.hex():
            return rejected("anchored under a different engine key than this cycle's engine")
        return {
            "status": "verified",
            "record": record_,
            "engine_revoked": engine.get("revoked_at_ns") is not None,
        }

    return app


def app_from_env() -> FastAPI:
    """uvicorn --factory app.demo_server:app_from_env

    COORDINATOR_URL  where the coordinator listens (default http://127.0.0.1:8001)
    NEAR_RPC, NEAR_CONTRACT, NEAR_OWNER  optional: enable the on-chain panel
    """
    env = os.environ
    coordinator = httpx.Client(base_url=env.get("COORDINATOR_URL", "http://127.0.0.1:8001"), timeout=30)
    rpc, contract = env.get("NEAR_RPC"), env.get("NEAR_CONTRACT")
    view = near_view(rpc, contract) if rpc and contract else None
    return create_demo(coordinator, view, contract, env.get("NEAR_OWNER"), intents_from_env(env))