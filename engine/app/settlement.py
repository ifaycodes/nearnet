from __future__ import annotations

import os
from dataclasses import dataclass
from . import merkle
from .crypto import EngineKeys, b64e, canonical
from .models import Issue, MatchResult, Payout
from .netting import NettingResult, Payment, view_for

LEAF_FIELDS = ('cycle_id', 'company', 'position_cents', 'pays', 'receives', 'issues', 'salt')

@dataclass(frozen=True)
class Receipt:
    cycle_id: str
    root: str
    participants: int
    signature: bytes

    def to_json(self) -> dict:
        return {
            'cycle_id': self.cycle_id,
            'root': self.root,
            'participants': self.participants,
            'signature': b64e(self.signature),
        }

def receipt_message(cycle_id: str, root_hex: str, participants: int) -> bytes:
    return canonical(
        {
            'type': 'netting-receipt',
            'version': 1,
            'cycle_id': cycle_id,
            'root': root_hex,
            'participants': participants,
        }
    )

def leaf_for(fields: dict) -> bytes:
    """leaf hash of a package. clients can recompute this to check their proof."""
    return merkle.leaf_hash(canonical({key: fields[key] for key in LEAF_FIELDS}))

def _payment(p: Payment, payouts: dict[str, Payout] | None = None) -> dict:
    out = {'payer': p.payer, 'payee': p.payee, 'amount_cents': p.amount_cents}
    if payouts and p.payee in payouts:
        out["payout"] = payouts[p.payee].to_json()
    return out

def _issue(i: Issue) -> dict:
    return{
        'kind': i.kind.value,
        'ref': i.ref,
        'parties': list(i.parties),
        'detail': i.detail,
    }

def seal_cycle(
    cycle_id: str,
    participants: dict[str, bytes],
    match: MatchResult,
    result: NettingResult,
    keys: EngineKeys,
    payouts: dict[str, Payout] | None = None,
) -> tuple[Receipt, dict[str, bytes]]:
    
    names = sorted(participants)
    packages: dict[str, dict] = {}
    for name in names:
        view = view_for(name, result)
        packages[name] = {
            "cycle_id": cycle_id,
            "company": name,
            "position_cents": view.position_cents,
            "pays": [_payment(p, payouts) for p in view.pays],
            "receives": [_payment(p) for p in view.receives],
            "issues": [_issue(i) for i in match.issues if name in i.parties],
            "salt": os.urandom(32).hex(),
        }

    root, proofs = merkle.build([leaf_for(packages[n]) for n in names])
    root_hex = root.hex()
    receipt = Receipt(
        cycle_id=cycle_id,
        root=root_hex,
        participants=len(names),
        signature=keys.sign(receipt_message(cycle_id, root_hex, len(names))),
    )

    sealed: dict[str, bytes] = {}
    for name, proof in zip(names, proofs):
        package = {
            **packages[name],
            'proof':[[side, sibling.hex()] for side, sibling in proof],
            'receipt': receipt.to_json(),
        }
        sealed[name] = keys.seal_to(participants[name], canonical(package))

    return receipt, sealed


    