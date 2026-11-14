"""Netting cycle: companies submit invoices while it is OPEN,
then it is closed once, which runs matching + netting and makes it SETTLED."""

from __future__ import annotations
import secrets
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum

from .matching import match_invoices
from .models import Issue, MatchResult, Submission
from .netting import CompanyView, NettingResult, net, view_for
from .settlement import Receipt

Sealer = Callable[[MatchResult, NettingResult], tuple[Receipt, dict[str, bytes]]]

class CycleState(str, Enum):
    OPEN = 'open'
    SETTLED = 'settled'

class CycleError(Exception):
    """Base class for violations; main.py maps each to an HTTP status."""

class CycleNotFound(Exception):
    pass

class NotParticipant(Exception):
    pass

class CycleClosed(Exception):
    pass

class CycleNotSettled(Exception):
    pass

class CycleNotReady(Exception):
    pass

class StaleSubmission(Exception):
    pass

class BadSubmission(Exception):
    pass

class AlreadyClaimed(CycleError):
    pass

class NotJoined(CycleError):
    pass

@dataclass
class Cycle:
    id: str
    currency: str
    participants: dict[str, bytes | None]
    cutoff: datetime | None = None
    state: CycleState = CycleState.OPEN
    submissions: dict[str, Submission] = field(default_factory=dict)
    last_seq: dict[str, int] = field(default_factory=dict)
    match: MatchResult | None = None
    result: NettingResult | None = None
    receipt: Receipt | None = None
    sealed: dict[str, bytes] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False, compare=False)

    def public_key_of(self, company: str) -> bytes:
        try:
            pk = self.participants[company]
        except KeyError:
            raise NotParticipant(f"{company!r} is not in this cycle") from None
        if pk is None:
            raise NotJoined(f"{company!r} has not joined yet")
        return pk

    def join(self, company: str, public_key: bytes) -> None:
        """Claim your spot an invited company with your public key"""
        with self._lock:
            if self.state != CycleState.OPEN:
                raise CycleClosed("cycle is closed; cannot join")
            if company not in self.participants:
                raise NotParticipant(f"{company!r} is not in this cycle")
            if self.participants[company] is not None:
                raise AlreadyClaimed("{company!r} has already joined the cycle")
            if public_key in self.participants.values():
                raise AlreadyClaimed("this public key is already used by another participant")
            self.participants[company] = public_key

    def submit(self, submission: Submission, seq: int) -> None:
        """Record a company's invoices. A new submission (higher seq) replaces its old one; an equal or lower seq is a replay"""
        with self._lock:
            if self.state != CycleState.OPEN:
                raise CycleClosed("Cycle is closed; submissions are no longer accepted")
            
            self.public_key_of(submission.company)
            if seq <= self.last_seq.get(submission.company, 0):
                raise StaleSubmission("a newer submission was already accepted")
            
            if submission.company not in self.participants:
                raise NotParticipant(f"{submission.company!r} is not in this cycle")
            
            self.submissions[submission.company] = submission
            self.last_seq[submission.company] = seq

    def _ready(self, now: datetime) -> bool:
        if len(self.submissions) == len(self.participants):
            return True
        return self.cutoff is not None and now >= self.cutoff

    def close(self, seal: Sealer, now: datetime) -> None:
        with self._lock:
            if self.state != CycleState.OPEN:
                raise CycleClosed("Cycle is already closed")
            if not self._ready(now):
                raise CycleNotReady('cannot close yet: waiting for every participant or the cut-off')

            claimed = {name: pk for name, pk in self.participants.items() if pk is not None}
            if len(claimed) < 2:
                raise CycleNotReady("cannot close: at least 2 participants must join before closing")
            self.participants = claimed
            
            match = match_invoices(self.submissions.values(), self.currency)
            result = net(match.matched_invoices)
            receipt, sealed = seal(match, result)

            self.match, self.result = match, result
            self.receipt, self.sealed = receipt, sealed
            self.state = CycleState.SETTLED

    def sealed_result_for(self, company: str) -> bytes:
        self.public_key_of(company)
        with self._lock:
            if self.state != CycleState.SETTLED:
                raise CycleNotSettled("cycle has not been settled yet")
            return self.sealed[company]

    def result_for(self, company: str) -> tuple[CompanyView, tuple[Issue, ...]]:
        """One company's instructions plus the issues it is a party to. Nothing else is shown"""
        if company not in self.participants:
            raise NotParticipant(f"{company!r} is not in this cycle")
        with self._lock:
            if self.state != CycleState.SETTLED or not (self.match and self.result):
                raise CycleNotSettled("Cycle has not been closed yet")
            issues = tuple(i for i in self.match.issues if company in i.parties)
            return view_for(company, self.result), issues

class CycleStore:
    def __init__(self) -> None:
        self._cycles: dict[str, Cycle] = {}
        self._lock = threading.Lock()

    def create(self, currency: str, participants: dict[str, bytes | None], cutoff: datetime) -> Cycle:
        cycle = Cycle(
            id=secrets.token_urlsafe(8),
            currency=currency,
            participants=dict(participants), 
            cutoff=cutoff,
        )
        with self._lock:
            self._cycles[cycle.id] = cycle
        return cycle

    def get(self, cycle_id: str) -> Cycle:
        with self._lock:
            try:
                return self._cycles[cycle_id]
            except KeyError:
                raise CycleNotFound(f"No cycle {cycle_id!r}") from None