"""Multilateral netting.
Each company's net position = what it is owed - what it owes. The least
value that must move is the sum of the positive positions; we match the
largest debtor to the largest creditor until everyone is flat. Ties are
broken by company name, so the result never depends on input order.
"""

from __future__ import annotations
import heapq
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass

from .models import Invoice

@dataclass(frozen=True)
class Payment:
    payer: str
    payee: str
    amount_cents: int

@dataclass(frozen=True)
class NettingResult:
    net_positions: dict[str, int]
    payments: tuple[Payment, ...]
    total_amount_cents: int
    invoice_count: int

    @property
    def net_cents(self) -> int:
        """The total amount that must move to settle all invoices"""
        return sum(p.amount_cents for p in self.payments)

    @property
    def saved_cents(self) -> int:
        """The total amount that is saved by netting instead of paying all invoices"""
        return self.total_amount_cents - self.net_cents

    @property
    def reduction_pct(self) -> float:
        """The percentage reduction in total amount that is achieved by netting"""
        if self.total_amount_cents == 0:
            return 0.0
        return self.saved_cents / self.total_amount_cents * 100

@dataclass(frozen=True)
class CompanyView:
    """The ONLY slice of netting results a company is allowed to see: its own net position and the payments it must make or receive"""
    company: str
    position_cents: int
    pays: tuple[Payment, ...]
    receives: tuple[Payment, ...]

def net(invoices: Iterable[Invoice]) -> NettingResult:
    positions: dict[str, int] = defaultdict(int)
    gross = 0
    count = 0

    for inv in invoices:
        positions[inv.seller] += inv.amount_cents
        positions[inv.buyer] -= inv.amount_cents
        gross += inv.amount_cents
        count += 1

    debtors = [(v, c) for c, v in positions.items() if v < 0]
    creditors = [(-v, c) for c, v in positions.items() if v > 0]
    heapq.heapify(debtors)
    heapq.heapify(creditors)

    payments: list[Payment] = []
    while debtors and creditors:
        d_neg, debtor = heapq.heappop(debtors)
        c_neg, creditor = heapq.heappop(creditors)
        owed, due = -d_neg, -c_neg
        pay = min(owed, due)
        payments.append(Payment(debtor, creditor, pay))
        if owed > pay:
            heapq.heappush(debtors, (-(owed - pay), debtor))
        if due > pay:
            heapq.heappush(creditors, (-(due - pay), creditor))

    return NettingResult(
        net_positions=dict(sorted(positions.items())),
        payments=tuple(payments),
        total_amount_cents=gross,
        invoice_count=count
    )

def view_for(company: str, result: NettingResult) -> CompanyView:
    return CompanyView(
        company=company,
        position_cents=result.net_positions.get(company, 0),
        pays=tuple(p for p in result.payments if p.payer == company),
        receives=tuple(p for p in result.payments if p.payee == company),
    )