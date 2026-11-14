

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from nacl.exceptions import CryptoError
from nacl.public import Box, PrivateKey, PublicKey
from nacl.signing import SigningKey, VerifyKey

class DecryptionError(Exception):
    """A box would not open: tampered, wrong keys etc"""

def b64e(data: bytes) -> str:
    return base64.b64encode(data).decode('ascii')

def b64d(text: str) -> str:
    try:
        return base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError) as exception:
        raise ValueError('invalid base64') from exception

def canonical(obj: Any) -> bytes:
    return json.dumps(
        obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")

def box_seal(my_sk: PrivateKey, their_pk: bytes, plaintext: bytes) -> bytes:
    return bytes(Box(my_sk, PublicKey(their_pk)).encrypt(plaintext))

def box_open(my_sk: PrivateKey, their_pk: bytes, blob: bytes) -> bytes:
    try:
        return Box(my_sk, PublicKey(their_pk)).decrypt(blob)
    except (CryptoError, ValueError) as exception:
        raise DecryptionError('could not decrypt or authenticate message') from exception

def verify_signature(verify_key: bytes, message: bytes, signature: bytes) -> bool:
    try:
        VerifyKey(verify_key).verify(message, signature)
        return True
    except (CryptoError, ValueError):
        return False

@dataclass(frozen=True)
class EngineKeys:
    """ the engine's 2 key pairs. in the final design these are generated inside the enclave and their public 
    halves are bound to the attestation."""
    box_sk: PrivateKey
    sign_sk: SigningKey

    @classmethod
    def generate(cls) -> "EngineKeys":
        return cls(PrivateKey.generate(), SigningKey.generate())

    @property
    def box_pk(self) -> bytes:
        return bytes(self.box_sk.public_key)

    @property
    def verify_key(self) -> bytes:
        return bytes(self.sign_sk.verify_key)

    def open_from(self, sender_pk: bytes, blob: bytes) -> bytes:
        return box_open(self.box_sk, sender_pk, blob)

    def seal_to(self, recipient_pk: bytes, plaintext: bytes) -> bytes:
        return box_seal(self.box_sk, recipient_pk, plaintext)

    def sign(self, message: bytes) -> bytes:
        return self.sign_sk.sign(message).signature