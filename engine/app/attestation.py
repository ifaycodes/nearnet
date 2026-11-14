from __future__ import annotations

import hashlib
from collections.abc import Mapping
from typing import Protocol

from .crypto import EngineKeys, b64e, canonical

REPORT_DATA_LEN = 64


def keys_binding(box_pk: bytes, verify_key: bytes) -> bytes:
    return hashlib.sha256(
        canonical(
            {
                "type": "netting-engine-keys",
                "version": 1,
                "encryption_public_key": b64e(box_pk),
                "signing_public_key": b64e(verify_key),
            }
        )
    ).digest()


def report_data_for(box_pk: bytes, verify_key: bytes) -> bytes:
    """The 64 bytes placed in the quote: the binding, zero-padded."""
    return keys_binding(box_pk, verify_key).ljust(REPORT_DATA_LEN, b"\x00")


class Attestor(Protocol):
    platform: str

    def attest(self, report_data: bytes) -> dict:
        """Return {"quote": hex string or None, "event_log": str or None}."""


class SimulatedAttestor:
    """No hardware. Clients refuse it unless they explicitly allow it."""

    platform = "simulated"

    def attest(self, report_data: bytes) -> dict:
        return {"quote": None, "event_log": None}


class DstackAttestor:
    """Asks the dstack guest agent (inside the confidential VM) for a quote.

    The agent is reached through /var/run/dstack.sock, or through the
    simulator if DSTACK_SIMULATOR_ENDPOINT is set. If the agent cannot be
    reached this raises, so the engine fails to start instead of quietly
    running without attestation.
    """

    platform = "dstack-tdx"

    def attest(self, report_data: bytes) -> dict:
        # imported here so machines without the SDK can still run simulated
        try:
            from dstack_sdk import DstackClientV0 as Client  # newer SDKs
        except ImportError:
            from dstack_sdk import DstackClient as Client  # SDK 0.5.x

        response = Client().get_quote(report_data)
        return {"quote": response.quote, "event_log": response.event_log}


def attestor_from_env(env: Mapping[str, str]) -> Attestor:
    mode = env.get("ENGINE_ATTESTATION", "simulated")
    if mode == "simulated":
        return SimulatedAttestor()
    if mode == "dstack":
        return DstackAttestor()
    raise ValueError(
        f"ENGINE_ATTESTATION must be 'dstack' or 'simulated', got {mode!r}"
    )


def build_attestation(keys: EngineKeys, attestor: Attestor) -> dict:
    """Everything a company needs to check, in one JSON-ready dict."""
    report_data = report_data_for(keys.box_pk, keys.verify_key)
    evidence = attestor.attest(report_data)  # may raise: that is intended
    attestation = {
        "platform": attestor.platform,
        "keys": {
            "encryption_public_key": b64e(keys.box_pk),
            "signing_public_key": b64e(keys.verify_key),
        },
        "report_data": report_data.hex(),
        "quote": evidence["quote"],
        "event_log": evidence["event_log"],
        "warning": None,
    }
    if attestor.platform == "simulated":
        attestation["warning"] = (
            "SIMULATED: this engine is NOT running in hardware attestation. "
            "Do not send real data."
        )
    return attestation