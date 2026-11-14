const CYCLE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/; // 32 bytes: a Merkle root or an Ed25519 public key
const HEX128 = /^[0-9a-f]{128}$/; // 64 bytes: a signature or a TDX report data

function fail(message) {
  throw new Error(message);
}

function need(ok, message) {
  if (!ok) fail(message);
}

function requireOwner(ctx) {
  need(ctx.caller() === ctx.owner, "only the owner can do this");
}

export function receiptMessage(cycleId, root, participants) {
  need(CYCLE_ID.test(cycleId), "bad cycle_id");
  need(HEX64.test(root), "root must be 64 lowercase hex characters");
  need(Number.isInteger(participants) && participants >= 2 && participants <= 1000,
    "participants must be an integer from 2 to 1000");
  return (
    `{"cycle_id":"${cycleId}","participants":${participants},` +
    `"root":"${root}","type":"netting-receipt","v":1}`
  );
}

export function registerEngine(ctx, { signing_public_key, report_data }) {
  requireOwner(ctx);
  need(HEX64.test(signing_public_key), "signing_public_key must be 64 lowercase hex characters");
  need(HEX128.test(report_data), "report_data must be 128 lowercase hex characters");
  need(ctx.engines.get(signing_public_key) == null, "this engine key is already registered");
  ctx.engines.set(signing_public_key, {
    report_data,
    registered_at_ns: ctx.timestampNs(),
    revoked_at_ns: null,
  });
  ctx.log(event("engine_registered", { signing_public_key }));
}

export function revokeEngine(ctx, { signing_public_key }) {
  requireOwner(ctx);
  const engine = ctx.engines.get(signing_public_key);
  need(engine != null, "unknown engine key");
  need(engine.revoked_at_ns === null, "already revoked");
  ctx.engines.set(signing_public_key, { ...engine, revoked_at_ns: ctx.timestampNs() });
  ctx.log(event("engine_revoked", { signing_public_key }));
}

export function addAnchor(ctx, { account_id }) {
  requireOwner(ctx);
  need(typeof account_id === "string" && account_id.length > 0, "account_id required");
  ctx.anchors.set(account_id, true);
}

export function removeAnchor(ctx, { account_id }) {
  requireOwner(ctx);
  ctx.anchors.set(account_id, false);
}

export function isAnchor(ctx, { account_id }) {
  return account_id === ctx.owner || ctx.anchors.get(account_id) === true;
}

export function anchorReceipt(ctx, args) {
  const { cycle_id, root, participants, engine_key, signature } = args;
  const caller = ctx.caller();
  need(isAnchor(ctx, { account_id: caller }), "caller is not allowed to anchor receipts");

  receiptMessage(cycle_id, root, participants); // validates all three
  need(HEX128.test(signature), "signature must be 128 lowercase hex characters");

  const engine = ctx.engines.get(engine_key);
  need(engine != null, "engine key is not registered");
  need(engine.revoked_at_ns === null, "engine key has been revoked");

  // first write wins; a receipt can never be replaced
  need(ctx.receipts.get(cycle_id) == null, "this cycle already has an anchored receipt");

  const record = {
    cycle_id,
    root,
    participants,
    engine_key,
    signature,
    anchored_by: caller,
    anchored_at_ns: ctx.timestampNs(),
    block_height: ctx.blockHeight(),
  };
  ctx.receipts.set(cycle_id, record);
  ctx.log(event("receipt_anchored", { cycle_id, root, engine_key }));
}

export function getReceipt(ctx, { cycle_id }) {
  return ctx.receipts.get(cycle_id) ?? null;
}

export function getEngine(ctx, { signing_public_key }) {
  return ctx.engines.get(signing_public_key) ?? null;
}

// The quick check a company runs against its own copy of the result.
export function matches(ctx, { cycle_id, root }) {
  const r = ctx.receipts.get(cycle_id);
  return r != null && r.root === root;
}

function event(name, data) {
  return `EVENT_JSON:${JSON.stringify({
    standard: "netting_receipts",
    version: "1.0.0",
    event: name,
    data,
  })}`;
}