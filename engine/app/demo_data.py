"""End-to-end demo data: 5 companies, 10 good invoices, 2 problem invoices.

This is the dataset the dashboard and the demo video will use.
"""
from __future__ import annotations
from .models import Invoice, Submission, Payout

G, B, A, C, F = "Glassworks", "BoardCo", "Assembly", "ChipMaker", "Freight"
COMPANIES = (G, B, A, C, F)

GOOD = [
    ("INV-101", G, A, 120_000),
    ("INV-102", B, A, 200_000),
    ("INV-103", C, B, 140_000),
    ("INV-104", A, C, 60_000),
    ("INV-105", F, G, 25_000),
    ("INV-106", F, B, 30_000),
    ("INV-107", F, A, 45_000),
    ("INV-108", G, B, 35_000),
    ("INV-109", B, C, 50_000),
    ("INV-110", C, F, 20_000),
]

DEMO_PAYOUTS = {
    G: Payout("USDC", "near", "glassworks-sample.near"),
    F: Payout("USDT", "near", "freight-sample.near"),
    C: Payout("USDC", "eth", "0x000000000000000000000000000000000000dEaD"),
}

def build_submissions():
    by_company = {c: [] for c in (G, B, A, C, F)}

    def add(inv, *companies):
        for c in companies:
            by_company[c].append(inv)

    for ref, seller, buyer, dollars in GOOD:
        add(Invoice(ref, seller, buyer, dollars * 100), seller, buyer)

    # Freight says ChipMaker owes it 15k; ChipMaker never confirms.
    add(Invoice("INV-111", F, C, 15_000 * 100), F)
    # BoardCo says Assembly owes 80k; Assembly says 75k.
    add(Invoice("INV-112", B, A, 80_000 * 100), B)
    add(Invoice("INV-112", B, A, 75_000 * 100), A)

    return [Submission(c, tuple(v)) for c, v in by_company.items()]
