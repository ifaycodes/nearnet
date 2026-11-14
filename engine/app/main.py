from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
from pydantic import ValidationError

import os
from .attestation import (
    Attestor,
    SimulatedAttestor,
    attestor_from_env,
    build_attestation,
)

from .crypto import DecryptionError, EngineKeys, b64d, b64e
from .cycle import (
    BadSubmission, CycleNotFound, CycleNotSettled, 
    CycleState, CycleClosed, CycleStore, 
    CycleError, NotParticipant, Cycle,
    CycleNotReady, StaleSubmission, AlreadyClaimed, NotJoined
    )
from .schemas import (
    CycleCreate, CycleOut, 
    KeysOut, ParticipantOut, ReceiptOut, SealedResult,
    SealedSubmission, SubmissionPayload, ParticipantJoin,
    AttestationOut, SubmissionAck, SummaryOut)

from .settlement import seal_cycle

STATUS_FOR_ERROR: dict[type[CycleError], int] = {
    CycleNotFound: 404,
    NotParticipant: 403,
    BadSubmission: 400,
    CycleClosed: 409,
    CycleNotReady: 409,
    CycleNotSettled: 409,
    StaleSubmission: 409,
    AlreadyClaimed: 409,
    NotJoined: 409,
}

def cycle_out(cycle: Cycle) -> CycleOut:
    summary = None
    if cycle.state == CycleState.SETTLED and cycle.result and cycle.match:
        r = cycle.result
        summary = SummaryOut(
            invoice_count=r.invoice_count,
            total_amount_cents=r.total_amount_cents,
            net_cents=r.net_cents,
            saved_cents=r.saved_cents,
            reduction_pct=round(r.reduction_pct, 1),
            payment_count=len(r.payments),
            flagged_count=len(cycle.match.issues),
        )
    return CycleOut(
        id=cycle.id,
        currency=cycle.currency,
        state=cycle.state.value,
        cutoff=cycle.cutoff,
        participants=[ParticipantOut(name=n, public_key=b64e(pk) if pk is not None else None) 
            for n, pk in sorted(cycle.participants.items())],
        submitted=sorted(cycle.submissions),
        summary=summary,
        receipt=ReceiptOut(**cycle.receipt.to_json()) if cycle.receipt else None
    )

def create_app(
        keys: EngineKeys | None = None,
        clock: Callable[[], datetime] | None = None,
        attestor: Attestor | None = None,
) -> FastAPI:
    keys = keys or EngineKeys.generate()
    clock = clock or (lambda: datetime.now(timezone.utc))
    attestation = build_attestation(keys, attestor or SimulatedAttestor())
    app = FastAPI(title="Netting Engine")
    store = CycleStore()

    @app.exception_handler(CycleError)
    async def handle_cycle_error(_: Request, exception: CycleError) -> JSONResponse:
        status = STATUS_FOR_ERROR.get(type(exception), 400)
        return JSONResponse(status_code=status, content={"detail": str(exception)})

    @app.exception_handler(DecryptionError)
    async def handle_decryption_error(_: Request, exception: DecryptionError) -> JSONResponse:
        return JSONResponse(status_code=401, content={"detail": str(exception)})

    # endpoints
    @app.get("/keys", response_model=KeysOut)
    def get_keys() -> KeysOut:
        return KeysOut(
            encryption_public_key=b64e(keys.box_pk),
            signing_public_key=b64e(keys.verify_key),
        )

    @app.post("/cycles", response_model=CycleOut, status_code=201)
    def create_cycle(body: CycleCreate) -> CycleOut:
        participants = {p.name: b64d(p.public_key) if p.public_key is not None else None
            for p in body.participants}
        return cycle_out(store.create(body.currency, participants, body.cutoff))

    @app.post("/cycles/{cycle_id}/join", response_model=CycleOut)
    def join_cycle(cycle_id: str, body: ParticipantJoin) -> CycleOut:
        cycle = store.get(cycle_id)
        cycle.join(body.company, b64d(body.public_key))
        return cycle_out(cycle)

    @app.get("/cycles/{cycle_id}", response_model=CycleOut)
    def get_cycle(cycle_id: str) -> CycleOut:
        return cycle_out(store.get(cycle_id))

    @app.post("/cycles/{cycle_id}/submissions", response_model=SubmissionAck)
    def submit(cycle_id: str, body: SealedSubmission) -> SubmissionAck:
        cycle = store.get(cycle_id)
        company_key = cycle.public_key_of(body.company)

        plaintext = keys.open_from(company_key, b64d(body.ciphertext))

        try: 
            payload = SubmissionPayload.model_validate_json(plaintext)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail="malformed submission payload" + str(exc)) from exc

        if payload.cycle_id != cycle_id or payload.company != body.company:
            raise BadSubmission("submission is not bound to this cycle and company")

        cycle.submit(payload.to_domain(), payload.seq)
        return SubmissionAck(company=payload.company, seq=payload.seq, invoice_count=len(payload.invoices))

    @app.post("/cycles/{cycle_id}/close", response_model=CycleOut)
    def close(cycle_id: str) -> CycleOut:
        cycle = store.get(cycle_id)
        cycle.close(
            lambda match, result: seal_cycle(
                cycle.id, cycle.participants, match, result, keys,
                {c: s.payout for c, s in cycle.submissions.items() if s.payout}
            ),
            clock(),
        )
        return cycle_out(cycle)

    @app.get("/cycles/{cycle_id}/results/{company}", response_model=SealedResult)
    def result(cycle_id: str, company: str) -> SealedResult:
        blob = store.get(cycle_id).sealed_result_for(company)
        return SealedResult(ciphertext=b64e(blob))

    @app.get("/attestation", response_model=AttestationOut)
    def get_attestation() -> AttestationOut:
        return AttestationOut(**attestation)

    return app


app = create_app(attestor=attestor_from_env(os.environ))