import nacl from "tweetnacl";

export type KeyPairB64 = {
  publicKey: string;
  secretKey: string;
};

export function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

export function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateKeyPair(): KeyPairB64 {
  const kp = nacl.box.keyPair();
  return {
    publicKey: toB64(kp.publicKey),
    secretKey: toB64(kp.secretKey),
  };
}

export function saveKeyPair(cycleId: string, company: string, kp: KeyPairB64) {
  localStorage.setItem(`nearnet:key:${cycleId}:${company}`, JSON.stringify(kp));
}

export function loadKeyPair(cycleId: string, company: string): KeyPairB64 | null {
  const raw = localStorage.getItem(`nearnet:key:${cycleId}:${company}`);
  if (!raw) return null;
  return JSON.parse(raw) as KeyPairB64;
}

export function sealJson(mySecretB64: string, enginePublicB64: string, payload: unknown): string {
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const boxed = nacl.box(plain, nonce, fromB64(enginePublicB64), fromB64(mySecretB64));

  const combined = new Uint8Array(nonce.length + boxed.length);
  combined.set(nonce, 0);
  combined.set(boxed, nonce.length);
  return toB64(combined);
}

export function openJson<T>(mySecretB64: string, enginePublicB64: string, cipherB64: string): T {
  const blob = fromB64(cipherB64);
  const nonce = blob.slice(0, nacl.box.nonceLength);
  const boxed = blob.slice(nacl.box.nonceLength);

  const plain = nacl.box.open(boxed, nonce, fromB64(enginePublicB64), fromB64(mySecretB64));
  if (!plain) {
    throw new Error("Could not decrypt or authenticate result with your local key.");
  }
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}