import { NearBindgen, near, call, view, initialize, LookupMap } from "near-sdk-js";
import * as rules from "./registry.js";

@NearBindgen({})
export class ReceiptRegistry {
  constructor() {
    this.owner = "";
    this.anchors = new LookupMap("a");
    this.engines = new LookupMap("e");
    this.receipts = new LookupMap("r");
  }

  // the host functions the pure rules need
  ctx() {
    return {
      owner: this.owner,
      anchors: this.anchors,
      engines: this.engines,
      receipts: this.receipts,
      caller: () => near.predecessorAccountId(),
      timestampNs: () => near.blockTimestamp().toString(),
      blockHeight: () => near.blockHeight().toString(),
      log: (text) => near.log(text),
    };
  }

  @initialize({})
  init({ owner }) {
    if (this.owner !== "") throw new Error("already initialised");
    if (typeof owner !== "string" || owner.length === 0) throw new Error("owner required");
    this.owner = owner;
  }

  @call({})
  register_engine(args) { rules.registerEngine(this.ctx(), args); }

  @call({})
  revoke_engine(args) { rules.revokeEngine(this.ctx(), args); }

  @call({})
  add_anchor(args) { rules.addAnchor(this.ctx(), args); }

  @call({})
  remove_anchor(args) { rules.removeAnchor(this.ctx(), args); }

  @call({})
  anchor_receipt(args) { rules.anchorReceipt(this.ctx(), args); }

  @view({})
  get_owner() { return this.owner; }

  @view({})
  is_anchor(args) { return rules.isAnchor(this.ctx(), args); }

  @view({})
  get_engine(args) { return rules.getEngine(this.ctx(), args); }

  @view({})
  get_receipt(args) { return rules.getReceipt(this.ctx(), args); }

  @view({})
  matches(args) { return rules.matches(this.ctx(), args); }

  // the exact text the engine signs for these values (handy for verifiers)
  @view({})
  receipt_message({ cycle_id, root, participants }) {
    return rules.receiptMessage(cycle_id, root, participants);
  }
}