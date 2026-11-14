"""Req an Res shape for the HTTP API"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from pydantic import ( AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field, StrictInt, StringConstraints, model_validator)

from .crypto import b64d
from .models import Invoice, Submission, Payout

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Currency = Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")]

def _check_b64(value: str) -> str:
    b64d(value)
    return value

def _check_public_key(value: str) -> str:
    if len(b64d(value)) != 32:
        raise ValueError('public key must be exactly 32 bytes')
    return value

B64 = Annotated[str, StringConstraints(max_length=8_000_000), AfterValidator(_check_b64)]
PublicKeyB64 = Annotated[str, AfterValidator(_check_public_key)]

class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")

# requests
class ParticipantsIn(Strict):
    name: Name
    public_key: PublicKeyB64 | None = None

class ParticipantJoin(Strict):
    company: Name
    public_key: PublicKeyB64

class CycleCreate(Strict):
    currency: Currency = "USD"
    participants: list[ParticipantsIn] = Field(min_length=2, max_length=100)
    cutoff: AwareDatetime | None = None

    @model_validator(mode="after")
    def participants_unique(self) -> "CycleCreate":
        names = [p.name for p in self.participants]
        keys = [p.public_key for p in self.participants if p.public_key is not None]

        if len(set(names)) != len(names):
            raise ValueError('participant names must be unique')

        if len(set(keys)) != len(keys):
            raise ValueError("participants keys must be unique")
        return self

class SealedSubmission(Strict):
    company: Name
    ciphertext: B64

class InvoiceIn(Strict):
    ref: Name
    seller: Name
    buyer: Name
    amount_cents: StrictInt = Field(gt=0, le=10**15)
    currency: Currency = "USD"

    @model_validator(mode="after")
    def parties_differ(self) -> "InvoiceIn":
        if self.seller == self.buyer:
            raise ValueError("seller and buyer must differ")
        return self

    def to_domain(self) -> Invoice:
        return Invoice(self.ref, self.seller, self.buyer, self.amount_cents, self.currency)

class PayoutIn(Strict):
    """Optional onchain payment details"""

    symbol: Annotated[str, StringConstraints(pattern="^[A-Za-z0-9]{2,12}$")]
    blockchain: Annotated[str, StringConstraints(pattern="^[a-z0-9]{2,32}$")]
    address: Annotated[str, StringConstraints(pattern="^[A-Za-z0-9._:-]{3,128}$")]

    def to_domain(self) -> Payout:
        return Payout(self.symbol.upper(), self.blockchain, self.address)

class SubmissionPayload(Strict):
    """the decrypted comtent of a submission. bound to one cycle, one comapny and numbered so old submission cannot replay"""
    version: Literal[1]
    cycle_id: str
    company: Name
    seq: StrictInt = Field(ge=1)
    invoices: list[InvoiceIn] = Field(max_length=5000)
    payout: PayoutIn | None = None

    def to_domain(self) -> Submission:
        return Submission(self.company, 
            tuple(i.to_domain() for i in self.invoices),
            self.payout.to_domain() if self.payout else None,)

class SubmissionIn(Strict):
    company: Name
    invoices: list[InvoiceIn] = Field(max_length=5000)

    def to_domain(self) -> Submission:
        return Submission(self.company, tuple(i.to_domain() for i in self.invoices))

# Responses

class KeysOut(Strict):
    encryption_public_key: str
    signing_public_key: str

class SubmissionAck(Strict):
    company: str
    seq: int
    invoice_count: int

class SummaryOut(Strict):
    """Aggregate numbers only. No payments, no per-company positions"""
    invoice_count: int
    total_amount_cents: int
    net_cents: int
    saved_cents: int
    reduction_pct: float
    payment_count: int
    flagged_count: int

class ParticipantOut(Strict):
    name: str
    public_key: str | None

class ReceiptOut(Strict):
    """the only thing that can go onchain"""
    cycle_id: str
    root: str 
    participants: int
    signature: str

class CycleOut(Strict):
    id: str
    currency: str
    state: str
    cutoff: datetime | None
    participants: list[ParticipantOut]
    submitted: list[str]
    summary: SummaryOut | None = None
    receipt: ReceiptOut | None = None

class SealedResult(Strict):
    ciphertext: str

class AttestationOut(Strict):
    """The engine's public keys plus the evidence tying them to hardware."""

    platform: str  # "dstack-tdx" (real hardware) or "simulated"
    keys: KeysOut
    report_data: str  # hex of the 64 bytes the quote must contain
    quote: str | None  # hex TDX quote; None when simulated
    event_log: str | None
    warning: str | None  # set when simulated