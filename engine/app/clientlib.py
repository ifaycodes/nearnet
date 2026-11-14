"""Con=mpany side connector"""

from __future__ import annotations

import hmac
import json
import struct
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from nacl.public import PrivateKey

from . import merkle
from .attestation import REPORT_DATA_LEN, report_data_for
from .crypto import (
    DecryptionError,
    b64d,
    b64e,
    box_open,
    box_seal,
    canonical,
    verify_signature,
)
from .models import Invoice, Payout
from .settlement import leaf_for, receipt_message

class VerificationError(Exception):
    """A result did not check out. Do not trust or act on it."""

class CompanyClient:
    def __init__(self, name: str, secret_key: PrivateKey | None = None) -> None:
        self.name = name
        self._sk = secret_key or PrivateKey.generate()

    @property
    def public_key(self) -> bytes:
        return bytes(self._sk.public_key)

    @property
    def public_key_b64(self) -> str:
        return b64e(self.public_key)

        # sending
    def seal_raw(self, engine_pk: bytes, payload: dict, envelope_company: str | None = None) -> dict:
            """encrypt payload to the engine"""
            blob = box_seal(self._sk, engine_pk, canonical(payload))
            return {'company': envelope_company or self.name, 'ciphertext': b64e(blob)}

    def seal_submission(self, engine_pk: bytes, cycle_id: str, seq: int, invoices: Iterable[Invoice], payout: Payout | None = None) -> dict:
        payload = {
            "version": 1,
            "cycle_id": cycle_id,
            "company": self.name,
            "seq": seq,
            "invoices": [
                {
                    "ref": i.ref,
                    "seller": i.seller,
                    "buyer": i.buyer,
                    "amount_cents": i.amount_cents,
                    "currency": i.currency,
                }
                for i in invoices
            ],
        }
        if payout is not None:
            payload["payout"] = payout.to_json()
        return self.seal_raw(engine_pk, payload)

    # receiving
    def open_result(self, engine_pk: bytes, sealed: dict) -> dict:
        try:
            blob = b64d(sealed['ciphertext'])
        except(KeyError, ValueError) as exception:
            raise VerificationError('malformed sealed reult') from exception

        try: 
            return json.loads(box_open(self._sk, engine_pk, blob))
        except DecryptionError as exception:
            raise VerificationError('result did not decrypt or aunthenticate') from exception

    def verify_result(self, package: dict, *, engine_verify_key: bytes,
    cycle_id: str,
    public_receipt: dict | None = None,
    ) -> None:
        """Raise verificationerror unless the package is genuinely the company's result for the cycle, covered by the engine signed root."""

        try:
            if package['cycle_id'] != cycle_id or package['company'] != self.name:
                raise VerificationError('package is for differnet cycle or company')

            receipt = package['receipt']
            if receipt['cycle_id'] != cycle_id:
                raise VerificationError('receipt is for a differnet cycle')

            proof = [(side, bytes.fromhex(hash)) for side, hash in package['proof']]
            if not merkle.verify(leaf_for(package), proof, bytes.fromhex(receipt['root'])):
                raise VerificationError('result i not covered by the signed root')

            message = receipt_message(receipt['cycle_id'], receipt['root'], receipt['participants'])
            if not verify_signature(engine_verify_key, message, b64d(receipt['signature'])):
                raise VerificationError('receipt signature is invalid')

            if public_receipt is not None and public_receipt != receipt:
                raise VerificationError('receipt differs from public receipt')

        except (KeyError, TypeError, ValueError) as exception:
            raise VerificationError('malformed result package') from exception


# ---------- checking the engine itself, before trusting it with anything ----------
class AttestationError(Exception):
    """The engine could not prove it is what it claims. Send it nothing."""

@dataclass(frozen=True)
class EngineIdentity:
    box_pk: bytes  # encrypt submissions to this key
    verify_key: bytes  # results and receipts are signed by this key
    platform: str
    hardware_attested: bool


# Layout of an Intel TDX quote, version 4: a 48-byte header, then a 584-byte
# body whose last 64 bytes are the report data the program asked to include.
_TDX_QUOTE_VERSION = 4
_TDX_TEE_TYPE = 0x81
_REPORT_DATA_OFFSET = 48 + 520
_MIN_QUOTE_LEN = _REPORT_DATA_OFFSET + REPORT_DATA_LEN


def tdx_report_data(quote: bytes) -> bytes:
    """The 64 report-data bytes inside a TDX v4 quote. Refuses anything else."""
    if len(quote) < _MIN_QUOTE_LEN:
        raise AttestationError("quote is too short to be a TDX quote")
    version, _key_type, tee_type = struct.unpack_from("<HHI", quote, 0)
    if version != _TDX_QUOTE_VERSION or tee_type != _TDX_TEE_TYPE:
        raise AttestationError("not a TDX version 4 quote")
    return quote[_REPORT_DATA_OFFSET : _REPORT_DATA_OFFSET + REPORT_DATA_LEN]


PHALA_VERIFY_URL = "https://cloud-api.phala.com/api/v1/attestations/verify"


def phala_verify_quote(quote: bytes) -> bool:
    """Ask Phala's public verifier to check Intel's signature on the quote.

    Convenient, but you are trusting Phala's service to answer honestly. For
    trustless checking, run Intel's verification yourself (e.g. dcap-qvl) and
    pass your own function to verify_engine_identity. Fails closed.
    """
    try:
        import httpx

        r = httpx.post(PHALA_VERIFY_URL, json={"hex": quote.hex()}, timeout=20)
        r.raise_for_status()
        return r.json()["quote"]["verified"] is True
    except Exception:
        return False


def verify_engine_identity(
    attestation: dict,
    *,
    verify_quote: Callable[[bytes], bool],
    allow_simulated: bool = False,
) -> EngineIdentity:
    """Decide whether to trust the engine's keys. Call this before sealing
    anything to it. Raises AttestationError unless everything checks out.

    Proves: these exact keys were generated by a program running inside a
    genuine, Intel-signed TDX confidential VM.
    Does NOT yet prove: which program that is. Pinning the compose-hash
    (the measured identity of the deployed code) is the next hardening step;
    until then a malicious operator could run modified code in real hardware.
    """
    try:
        platform = attestation["platform"]
        box_pk = b64d(attestation["keys"]["encryption_public_key"])
        verify_key = b64d(attestation["keys"]["signing_public_key"])
        claimed = bytes.fromhex(attestation["report_data"])
    except (KeyError, TypeError, ValueError) as exc:
        raise AttestationError("malformed attestation") from exc

    # the report data must be exactly the hash of the keys we were handed
    expected = report_data_for(box_pk, verify_key)
    if not hmac.compare_digest(claimed, expected):
        raise AttestationError("the keys are not the ones the attestation covers")

    if platform == "simulated":
        if not allow_simulated:
            raise AttestationError(
                "engine is SIMULATED (no hardware attestation); refusing to trust it"
            )
        return EngineIdentity(box_pk, verify_key, platform, hardware_attested=False)

    if platform != "dstack-tdx":
        raise AttestationError(f"unknown attestation platform {platform!r}")

    try:
        quote = bytes.fromhex(attestation["quote"])
    except (KeyError, TypeError, ValueError) as exc:
        raise AttestationError("missing or malformed quote") from exc

    # the quote itself (not just the JSON around it) must cover these keys
    if not hmac.compare_digest(tdx_report_data(quote), expected):
        raise AttestationError("the quote does not cover these keys")

    try:
        genuine = verify_quote(quote)
    except Exception:
        genuine = False
    if not genuine:
        raise AttestationError("the quote failed hardware verification")

    return EngineIdentity(box_pk, verify_key, platform, hardware_attested=True)