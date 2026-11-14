import crypto from "node:crypto";
import { NextResponse } from "next/server";

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

function verifyEd25519(engineKeyHex: string, message: string, signatureHex: string): boolean {
  const key = crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519, Buffer.from(engineKeyHex, "hex")]),
    format: "der",
    type: "spki",
  });
  return crypto.verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureHex, "hex"));
}

async function rpcView(rpcUrl: string, contractId: string, method: string, args: Record<string, unknown>) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
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
    throw new Error(JSON.stringify(body.error ?? body.result.error));
  }
  return JSON.parse(Buffer.from(body.result.result).toString("utf8"));
}

export async function POST(req: Request) {
  const rpcUrl = process.env.NEAR_RPC;
  const contractId = process.env.NEAR_CONTRACT;
  if (!rpcUrl || !contractId) {
    return NextResponse.json({ status: "not_configured" });
  }

  try {
    const { cycleId, expectedRoot, expectedEngineKeyHex } = (await req.json()) as {
      cycleId: string;
      expectedRoot?: string;
      expectedEngineKeyHex?: string;
    };

    const record = await rpcView(rpcUrl, contractId, "get_receipt", { cycle_id: cycleId });
    if (!record) {
      return NextResponse.json({ status: "not_anchored" });
    }

    const engine = await rpcView(rpcUrl, contractId, "get_engine", {
      signing_public_key: record.engine_key,
    });
    if (!engine) {
      return NextResponse.json({ status: "rejected", reason: "Receipt names an unregistered engine key.", record });
    }

    const message =
      `{"cycle_id":"${record.cycle_id}","participants":${record.participants},` +
      `"root":"${record.root}","type":"netting-receipt","v":1}`;

    if (!verifyEd25519(record.engine_key, message, record.signature)) {
      return NextResponse.json({ status: "rejected", reason: "Engine signature on-chain is invalid.", record });
    }
    if (expectedRoot && record.root !== expectedRoot) {
      return NextResponse.json({ status: "rejected", reason: "On-chain root differs from this cycle's receipt.", record });
    }
    if (expectedEngineKeyHex && record.engine_key !== expectedEngineKeyHex) {
      return NextResponse.json({ status: "rejected", reason: "Anchored under a different engine key.", record });
    }

    return NextResponse.json({
      status: "verified",
      record,
      engine_revoked: engine.revoked_at_ns !== null,
    });
  } catch (err) {
    return NextResponse.json({ status: "unreachable", detail: (err as Error).message });
  }
}