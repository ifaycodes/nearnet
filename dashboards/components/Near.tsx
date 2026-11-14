"use client";

import { useState } from "react";
import { getOnChain, shortHex, type DemoState, type OnChain } from "@/lib/api";

export default function Near({
  state,
  onchain,
  setOnchain,
}: {
  state: DemoState;
  onchain: OnChain | null;
  setOnchain: (o: OnChain | null) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const closed = state.phase === "closed";

  async function check() {
    setChecking(true);
    try {
      setOnchain(await getOnChain());
    } catch (e) {
      setOnchain({ status: "unreachable", detail: (e as Error).message });
    } finally {
      setChecking(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(state.near.anchor_command ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false); // clipboard blocked: the text is selectable instead
    }
  }

  return (
    <section aria-labelledby="near-title">
      <h2 className="section-title" id="near-title">
        Anchor it on NEAR
      </h2>
      <p className="section-note">
        The signed receipt can be written to a public contract. Anyone can then check, years later, that a cycle
        happened and wasn&rsquo;t altered. Only the root and signature go on-chain.
      </p>

      {!closed ? (
        <p className="empty">Close a cycle to get its receipt.</p>
      ) : (
        <>
          <pre className="code" tabIndex={0}>
            {state.near.anchor_command}
          </pre>
          <button className="btn btn--quiet code__copy" onClick={copy}>
            {copied ? "Copied" : "Copy the command"}
          </button>

          <div className="near__result">
            <div>
              <button className="btn" disabled={checking} onClick={check}>
                {checking ? "Checking…" : "Check the chain"}
              </button>
            </div>
            {onchain && <Verdict result={onchain} />}
          </div>
        </>
      )}
    </section>
  );
}

function Verdict({ result }: { result: OnChain }) {
  switch (result.status) {
    case "verified":
      return (
        <div>
          <span className="stamp stamp--ok">Anchored and verified</span>
          <p className="frame__sub" style={{ marginTop: "0.6rem" }}>
            Written by {result.record?.anchored_by} at block {result.record?.block_height}. The engine&rsquo;s signature
            checks out against key {shortHex(result.record?.engine_key ?? "", 10)}.
            {result.engine_revoked && " That key has since been revoked."}
          </p>
        </div>
      );
    case "rejected":
      return (
        <div>
          <span className="stamp stamp--bad">Rejected</span>
          <p className="frame__sub" style={{ marginTop: "0.6rem" }}>
            {result.reason}
          </p>
        </div>
      );
    case "not_anchored":
      return <p className="frame__sub">No receipt is anchored yet. Run the command above, then check again.</p>;
    case "waiting":
      return <p className="frame__sub">Close the cycle first.</p>;
    case "not_configured":
      return (
        <p className="frame__sub">
          The chain check is off. Start the demo with NEAR_RPC and NEAR_CONTRACT set to turn it on.
        </p>
      );
    default:
      return (
        <div>
          <span className="stamp stamp--warn">Could not check</span>
          <p className="frame__sub" style={{ marginTop: "0.6rem" }}>
            {result.detail}
          </p>
        </div>
      );
  }
}