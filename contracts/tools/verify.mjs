import crypto from "node:crypto";
import { receiptMessage } from "../src/registry.js";

// DER prefix that wraps a raw 32-byte Ed25519 public key
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

export function verifySignature(engineKeyHex, message, signatureHex) {
  const key = crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519, Buffer.from(engineKeyHex, "hex")]),
    format: "der",
    type: "spki",
  });
  return crypto.verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureHex, "hex"));
}

// `view(method, args)` returns the contract's parsed JSON answer.
export async function checkAnchor(view, cycleId, expectedRoot) {
  const record = await view("get_receipt", { cycle_id: cycleId });
  if (record === null) return { ok: false, reason: "no receipt is anchored for this cycle" };

  const engine = await view("get_engine", { signing_public_key: record.engine_key });
  if (engine === null) return { ok: false, reason: "the receipt names an engine key nobody registered" };

  const message = receiptMessage(record.cycle_id, record.root, record.participants);
  if (!verifySignature(record.engine_key, message, record.signature)) {
    return { ok: false, reason: "the engine's signature does not match the anchored receipt" };
  }
  if (expectedRoot !== undefined && expectedRoot !== record.root) {
    return { ok: false, reason: "the anchored root differs from the root you expected" };
  }
  return {
    ok: true,
    record,
    engineRevoked: engine.revoked_at_ns !== null,
    engineReportData: engine.report_data,
  };
}

export function rpcView(rpcUrl, contractId, fetchImpl = fetch) {
  return async (method, args) => {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "verify",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: contractId,
          method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        },
      }),
    });
    const body = await res.json();
    if (body.error || body.result?.error) {
      throw new Error(`rpc error: ${JSON.stringify(body.error ?? body.result.error)}`);
    }
    return JSON.parse(Buffer.from(body.result.result).toString("utf8"));
  };
}

async function main() {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 ? process.argv[i + 1] : undefined;
  };
  const [rpc, contract, cycle, root] = ["rpc", "contract", "cycle", "root"].map(arg);
  if (!rpc || !contract || !cycle) {
    console.log("usage: node tools/verify.mjs --rpc <url> --contract <account> --cycle <id> [--root <hex>]");
    process.exit(2);
  }
  const result = await checkAnchor(rpcView(rpc, contract), cycle, root);
  if (!result.ok) {
    console.log(`REJECTED: ${result.reason}`);
    process.exit(1);
  }
  const r = result.record;
  console.log(`OK: receipt for cycle ${r.cycle_id} is anchored and correctly signed`);
  console.log(`  root:         ${r.root}`);
  console.log(`  participants: ${r.participants}`);
  console.log(`  anchored by:  ${r.anchored_by} at block ${r.block_height}`);
  console.log(`  engine key:   ${r.engine_key}${result.engineRevoked ? "  (REVOKED since)" : ""}`);
  if (root === undefined) console.log("  (pass --root to also compare with your own copy)");
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}