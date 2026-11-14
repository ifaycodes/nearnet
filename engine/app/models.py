from __future__ import annotations
from dataclasses import dataclass
from enum import Enum

@dataclass(frozen=True)
class Invoice:
    """One invoice: `seller` is owed `amount_cents` by `buyer`"""
    ref: str
    seller: str
    buyer: str
    amount_cents: int
    currency: str = "USD"

    def __post_init__(self) -> None:
        if self.amount_cents <= 0:
            raise ValueError("amount_cents must be non-negative")
        if not self.ref:
            raise ValueError("ref must be non-empty")
        if not self.seller:
            raise ValueError("seller must be non-empty")
        if not self.buyer:
            raise ValueError("buyer must be non-empty")
        if self.seller == self.buyer:
            raise ValueError("seller and buyer must be different")

    @property
    def key(self) -> tuple[str, str, str]:
        """Invoice Identity: a unique key for this invoice. Independent of amount or currency."""
        return (self.ref, self.seller, self.buyer)

@dataclass(frozen=True)
class Payout:
    """Optional. Where a company would like to be paid onchain"""
    symbol: str
    blockchain: str
    address: str

    def to_json(self) -> dict:
        return {"symbol": self.symbol, "blockchain": self.blockchain, "address": self.address}


@dataclass(frozen=True)
class Submission:
    """What each company sends in for a cycle: the invoices they are a party to"""
    company: str
    invoices: tuple[Invoice, ...]
    payout: Payout | None = None

class IssueKind(str, Enum):
    MISSING_COUNTERPARTY = "missing_counterparty"
    MISMATCH = "mismatch"
    WRONG_CURRENCY = "wrong_currency"
    DUPLICATE = "duplicate"
    NOT_A_PARTY = "not_a_party"

@dataclass(frozen=True)
class Issue:
    """An issue found in a submission. It is excluded from netting
    `detail` must never contain amounts: issues are shown to involved 
    parties of the invoice, and each side should not learn the other's numbers."""

    kind: IssueKind
    ref: str
    parties: tuple[str, ...]
    detail: str

@dataclass(frozen=True)
class MatchResult:
    """The result of matching submissions for a cycle. It contains the invoices that are
    matched, and the issues found in the submissions."""

    matched_invoices: tuple[Invoice, ...]
    issues: tuple[Issue, ...]