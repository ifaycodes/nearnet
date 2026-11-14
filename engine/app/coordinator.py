from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from dotenv import load_dotenv

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from .schemas import CycleCreate, SealedSubmission, ParticipantJoin
load_dotenv()

class EngineUnreachable(Exception):
    pass


@dataclass
class Tracked:
    id: str
    participants: frozenset[str]
    cutoff: datetime | None
    closed: bool = False
    submitted: set[str] = field(default_factory=set)  # acknowledged by the engine
    pending: list[dict] = field(default_factory=list)  # sealed, not yet delivered
    rejected: list[dict] = field(default_factory=list)  # engine said no (no content)
    results: dict[str, dict] = field(default_factory=dict)  # sealed, cached


def _body(response: httpx.Response) -> dict:
    try:
        return response.json()
    except ValueError as exc:
        return {"detail": "engine returned an unreadable response" + str(exc)}


def _relay(response: httpx.Response) -> JSONResponse:
    return JSONResponse(status_code=response.status_code, content=_body(response))


def create_coordinator(
    engine, clock: Callable[[], datetime] | None = None
) -> FastAPI:
    """`engine` is anything with get/post that behaves like an httpx.Client
    pointed at the engine (a real client in production, a test client or a
    flaky stand-in in tests)."""
    clock = clock or (lambda: datetime.now(timezone.utc))
    app = FastAPI(title="Netting coordinator (untrusted relay)")
    cycles: dict[str, Tracked] = {}
    app.state.cycles = cycles

    def call(method: str, path: str, **kwargs) -> httpx.Response:
        try:
            return getattr(engine, method)(path, **kwargs)
        except httpx.TransportError as exc:
            raise EngineUnreachable from exc

    def tracked(cycle_id: str) -> Tracked:
        if cycle_id not in cycles:
            raise HTTPException(404, "no such cycle")
        return cycles[cycle_id]

    def flush(t: Tracked) -> None:
        """Deliver queued submissions in arrival order. Stops (leaving the
        rest queued) if the engine is unreachable."""
        while t.pending:
            envelope = t.pending[0]
            r = call("post", f"/cycles/{t.id}/submissions", json=envelope)  # may raise
            t.pending.pop(0)
            if r.status_code == 200:
                t.submitted.add(envelope["company"])
            else:  # e.g. a stale resend; keep a note, never the content
                t.rejected.append(
                    {
                        "company": envelope["company"],
                        "status": r.status_code,
                        "detail": _body(r).get("detail"),
                    }
                )

    @app.exception_handler(EngineUnreachable)
    async def handle_unreachable(_, __) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": "engine unreachable"})

    # ---- identity: relayed untouched; clients verify it themselves ----

    @app.get("/attestation")
    def attestation() -> JSONResponse:
        return _relay(call("get", "/attestation"))

    @app.get("/keys")
    def keys() -> JSONResponse:
        return _relay(call("get", "/keys"))

    # ---- cycles ----

    @app.post("/cycles")
    def create_cycle(body: CycleCreate) -> JSONResponse:
        r = call("post", "/cycles", json=body.model_dump(mode="json"))
        if r.status_code == 201:
            data = _body(r)
            cycles[data["id"]] = Tracked(
                id=data["id"],
                participants=frozenset(p.name for p in body.participants),
                cutoff=body.cutoff,
            )
        return _relay(r)

    @app.get("/cycles/{cycle_id}")
    def get_cycle(cycle_id: str) -> JSONResponse:
        tracked(cycle_id)
        return _relay(call("get", f"/cycles/{cycle_id}"))

    @app.post("/cycles/{cycle_id}/join")
    def join(cycle_id: str, body: ParticipantJoin) -> JSONResponse:
        t = tracked(cycle_id)
        if body.company not in t.participants:
            raise HTTPException(403, "not a participant in this cycle")
        if t.closed:
            raise HTTPException(409, "cycle is closed")
        if t.cutoff is not None and clock() >= t.cutoff:
            raise HTTPException(409, "the cutoff has passed")
        return _relay(call("post", f"/cycles/{cycle_id}/join", json=body.model_dump()))

    @app.post("/cycles/{cycle_id}/submissions")
    def submit(cycle_id: str, body: SealedSubmission) -> JSONResponse:
        t = tracked(cycle_id)
        if body.company not in t.participants:
            raise HTTPException(403, "not a participant in this cycle")
        if t.closed:
            raise HTTPException(409, "cycle is closed")
        if t.cutoff is not None and clock() >= t.cutoff:
            raise HTTPException(409, "the cutoff has passed")

        envelope = body.model_dump()
        try:
            flush(t)  # older queued submissions go first, so order is kept
            r = call("post", f"/cycles/{cycle_id}/submissions", json=envelope)
        except EngineUnreachable:
            t.pending.append(envelope)
            return JSONResponse(
                status_code=202, content={"status": "queued", "company": body.company}
            )
        if r.status_code == 200:
            t.submitted.add(body.company)
        return _relay(r)

    @app.post("/cycles/{cycle_id}/flush")
    def flush_endpoint(cycle_id: str) -> dict:
        t = tracked(cycle_id)
        try:
            flush(t)
        except EngineUnreachable:
            pass
        return {"queued": len(t.pending), "delivered_companies": sorted(t.submitted)}

    @app.post("/cycles/{cycle_id}/close")
    def close(cycle_id: str) -> JSONResponse:
        t = tracked(cycle_id)
        try:
            flush(t)
        except EngineUnreachable:
            # closing now would silently drop what is still queued
            raise HTTPException(
                503,
                f"engine unreachable; {len(t.pending)} submission(s) still "
                "queued, so the cycle was not closed",
            )
        r = call("post", f"/cycles/{cycle_id}/close")
        if r.status_code == 200:
            t.closed = True
            data = _body(r)
            if isinstance(data, dict) and "participants" in data:
                t.participants = frozenset(p["name"] for p in data["participants"])
            for name in sorted(t.participants):  # keep sealed results to hand out later
                try:
                    rr = call("get", f"/cycles/{cycle_id}/results/{name}")
                except EngineUnreachable:
                    break
                if rr.status_code == 200:
                    t.results[name] = _body(rr)
        return _relay(r)

    @app.get("/cycles/{cycle_id}/results/{company}")
    def result(cycle_id: str, company: str) -> JSONResponse:
        t = tracked(cycle_id)
        if company not in t.participants:
            raise HTTPException(403, "not a participant in this cycle")
        if company in t.results:
            return JSONResponse(content=t.results[company])
        r = call("get", f"/cycles/{cycle_id}/results/{company}")
        if r.status_code == 200:
            t.results[company] = _body(r)
        return _relay(r)

    return app


def app_from_env() -> FastAPI:
    """uvicorn --factory app.coordinator:app_from_env   (needs ENGINE_URL)"""
    return create_coordinator(httpx.Client(base_url=os.environ.get("ENGINE_URL", "http://127.0.0.1:8000"), timeout=15))