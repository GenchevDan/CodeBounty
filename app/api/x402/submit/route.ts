import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { ARC_RPC, ARC_CHAIN_ID } from "@/lib/arcNetwork";
import { CONTRACT_ADDRESS, CODEBOUNTY_ABI } from "@/lib/codebounty";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── CodeBounty x402 — fixers can be agents ──
// An AI coding agent submits a fix programmatically over the real x402 (HTTP-402) standard,
// then earns the bounty if the author accepts it. Honest scope: Arc's USDC is the NATIVE coin
// (no ERC-20, no EIP-3009 gasless), and submitting a fix carries no protocol fee — so this is
// PAY-THEN-PROVE where the "payment" is the agent's own on-chain submitFix tx (it pays Arc gas
// in USDC, which IS the built-in anti-spam). The agent calls submitFix from its wallet (so the
// fix is recorded under the agent's address and is eligible to win), then proves it with the tx
// hash in X-PAYMENT; we self-verify the FixSubmitted event on-chain — no facilitator. Genuine
// 402 / X-PAYMENT / X-PAYMENT-RESPONSE wire format. Replay-bounded by a freshness window.

const FRESH = 600;
const seen = new Set<string>();

function challenge(req: NextRequest, error: string) {
  return NextResponse.json({
    x402Version: 1,
    error,
    accepts: [{
      scheme: "exact",
      network: `eip155:${ARC_CHAIN_ID}`,
      maxAmountRequired: "0", // submitting is free; Arc USDC-as-gas is the anti-spam
      resource: `${req.nextUrl.origin}/api/x402/submit`,
      description: "CodeBounty fix submission — call submitFix(bountyId, fixUri, fixHash, note) on the CodeBounty contract from your own wallet (native USDC gas), then prove it with the tx hash. Pay-then-prove, self-verified, no facilitator. Returns your fix index + triage.",
      mimeType: "application/json",
      payTo: CONTRACT_ADDRESS,
      asset: "0x0000000000000000000000000000000000000000",
      extra: { name: "USDC", decimals: 18, native: true, method: "submitFix(uint256,string,bytes32,string)" },
    }],
  }, { status: 402 });
}

export async function GET(req: NextRequest) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(CONTRACT_ADDRESS)) return NextResponse.json({ error: "contract not configured" }, { status: 503 });
  return challenge(req, "X-PAYMENT header required");
}

export async function POST(req: NextRequest) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(CONTRACT_ADDRESS)) return NextResponse.json({ error: "contract not configured" }, { status: 503 });

  const hdr = req.headers.get("x-payment");
  if (!hdr) return challenge(req, "X-PAYMENT header required");

  let txHash: string;
  try {
    const p = JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
    txHash = p?.txHash || p?.payload?.txHash;
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("bad txHash");
  } catch {
    return challenge(req, "malformed X-PAYMENT");
  }
  if (seen.has(txHash)) return challenge(req, "submission already proven");

  try {
    const provider = new ethers.JsonRpcProvider(ARC_RPC);
    const rc = await provider.getTransactionReceipt(txHash);
    if (!rc || rc.status !== 1 || rc.to?.toLowerCase() !== CONTRACT_ADDRESS.toLowerCase()) {
      return challenge(req, "invalid or unconfirmed submitFix tx");
    }
    const blk = await provider.getBlock(rc.blockNumber);
    if (!blk || Math.floor(Date.now() / 1000) - Number(blk.timestamp) > FRESH) {
      return challenge(req, "proof too old — submit again");
    }

    // find the FixSubmitted event in that tx
    const iface = new ethers.Interface(CODEBOUNTY_ABI);
    let fix: { id: number; fixIndex: number; fixer: string; fixUri: string; fixHash: string; note: string } | null = null;
    for (const log of rc.logs) {
      try {
        const ev = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (ev?.name === "FixSubmitted") {
          fix = { id: Number(ev.args.id), fixIndex: Number(ev.args.fixIndex), fixer: ev.args.fixer, fixUri: ev.args.fixUri, fixHash: ev.args.fixHash, note: ev.args.note };
          break;
        }
      } catch { /* not ours */ }
    }
    if (!fix) return challenge(req, "no fix submitted in that tx");
    seen.add(txHash);

    // lightweight triage (the standalone agent posts richer advisories off-chain)
    const reachable = /^(https?:\/\/|ipfs:\/\/)/i.test(fix.fixUri);
    const recomputed = ethers.keccak256(ethers.toUtf8Bytes(fix.fixUri + " " + fix.note));
    const triage = {
      pointerReachable: reachable,
      hashMatches: recomputed.toLowerCase() === fix.fixHash.toLowerCase(),
      hasNote: fix.note.trim().length > 0,
    };

    const settlement = { success: true, transaction: txHash, network: `eip155:${ARC_CHAIN_ID}`, payer: fix.fixer };
    return NextResponse.json({
      bountyId: fix.id,
      fixIndex: fix.fixIndex,
      fixer: fix.fixer,
      fixUri: fix.fixUri,
      note: fix.note,
      triage,
      message: "fix recorded on-chain — the author decides; if accepted you receive the full bounty.",
    }, {
      status: 200,
      headers: { "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify(settlement)).toString("base64") },
    });
  } catch (e) {
    return NextResponse.json({ error: "verification error: " + String((e as Error).message || e) }, { status: 502 });
  }
}
