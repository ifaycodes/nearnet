

from __future__ import annotations

import hashlib
import hmac

Proof = list[tuple[str, bytes]]

def leaf_hash(data: bytes) -> bytes:
    return hashlib.sha256(b"\x00" + data).digest()

def node_hash(left: bytes, right: bytes) -> bytes:
    return hashlib.sha256(b"\x01" + left + right).digest()

def build(leaf_hashes: list[bytes]) -> tuple[bytes, list[Proof]]:
    if not leaf_hashes:
        raise ValueError('cannot build a tree with no leaves')

    proofs: list[Proof] = [[] for _ in leaf_hashes]
    level: list[tuple[bytes, list[int]]] = [
        (hash, [i]) for i, hash in enumerate(leaf_hashes)
    ]

    while len(level) > 1:
        next: list[tuple[bytes, list[int]]] = []
        for key in range(0, len(level), 2):
            if key + 1 == len(level):
                next.append(level[key])
                continue
            (left, left_ids), (right, right_ids) = level[key], level[key + 1]
            for i in left_ids:
                proofs[i].append(("R", right))
            for i in right_ids:
                proofs[i].append(("L", left))
            next.append((node_hash(left, right), left_ids + right_ids))
        level = next
    return level[0][0], proofs

def verify(leaf: bytes, proof: Proof, root: bytes) -> bool:
    hash = leaf
    for side, sibling in proof:
        if side == "R":
            hash = node_hash(hash, sibling)
        elif side == "L":
            hash = node_hash(sibling, hash)
        else:
            return False
    return hmac.compare_digest(hash, root)