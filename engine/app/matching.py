"""An invoice is netted only if BOTH parties submit it, and the submission terms match. 
Anything ambiguous is treated as an issue, and the invoice is excluded from netting."""

from __future__ import annotations
from collections.abc import Iterable
from .models import Invoice, Submission, MatchResult, Issue, IssueKind

def match_invoices(
        submissions: Iterable[Submission], cycle_currency: str = "USD") -> MatchResult:
    issues: list[Issue] = []
    claims: dict[tuple[str, str, str], dict[str, list[Invoice]]] = {}

    for sub in submissions:
        for inv in sub.invoices:
            if sub.company not in (inv.seller, inv.buyer):
                issues.append(Issue(
                    kind=IssueKind.NOT_A_PARTY,
                    ref=inv.ref,
                    parties=(sub.company,),
                    detail=f"{sub.company} is not a party to invoice {inv.ref}"
                ))
                continue
            claims.setdefault(inv.key, {}).setdefault(sub.company, []).append(inv)

    matched: list[Invoice] = []

    for key in sorted(claims):
        ref, seller, buyer = key
        parties = (seller, buyer)
        by_company = claims[key]

        if any(len(v) > 1 for v in by_company.values()):
            issues.append(Issue(
                kind=IssueKind.DUPLICATE,
                ref=ref,
                parties=parties,
                detail=f"Duplicate invoice {ref} submitted by {', '.join(by_company)}. Excluded as ambiguous"
            ))
            continue

        if len(by_company) < 2:
            issues.append(Issue(
                kind=IssueKind.MISSING_COUNTERPARTY,
                ref=ref,
                parties=parties,
                detail=f"Invoice {ref} submitted by only one party and not confirmed by second party. Excluded from netting"
            ))
            continue

        seller_inv = by_company[seller][0]
        buyer_inv = by_company[buyer][0]

        if seller_inv.currency != cycle_currency or buyer_inv.currency != cycle_currency:
            issues.append(Issue(
                kind=IssueKind.WRONG_CURRENCY,
                ref=ref,
                parties=parties,
                detail=f"Invoice {ref} has wrong currency. Only {cycle_currency} can be netted in this cycle"
            ))
            continue

        elif seller_inv != buyer_inv:
            issues.append(Issue(
                kind=IssueKind.MISMATCH,
                ref=ref,
                parties=parties,
                detail=f"Invoice {ref} submitted by both parties but with different amounts or currencies. Excluded from netting"
            ))
        else:
            matched.append(seller_inv)

    return MatchResult(matched_invoices=tuple(matched), issues=tuple(issues))