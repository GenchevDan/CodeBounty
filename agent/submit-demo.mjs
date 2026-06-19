// CodeBounty x402 demo — an agent submits a fix to a bounty programmatically.
// Speaks the real x402 wire format (402 challenge → X-PAYMENT → X-PAYMENT-RESPONSE). Pay-then-
// prove: the agent calls submitFix on-chain from its OWN wallet (native-USDC gas; the fix is
// recorded under the agent, eligible to win), then proves it with the tx hash; the route
// self-verifies the FixSubmitted event and returns the fix index + triage.
//   FIXER_PK=0x.. CONTRACT=0x.. API_BASE=https://codebounty-arc.vercel.app \
//     node agent/submit-demo.mjs <bountyId> "<fixUrl>" "<note>"
import { JsonRpcProvider, Wallet, Contract, keccak256, toUtf8Bytes, Interface } from "ethers";

const RPC = process.env.ARC_RPC || "https://rpc.testnet.arc.network";
const CONTRACT = process.env.CONTRACT;
const API = process.env.API_BASE || "http://localhost:3000";
const id = process.argv[2] || "1";
const fixUri = process.argv[3] || "https://gist.github.com/agent/fix";
const note = process.argv[4] || "Automated fix: clamp the index and add a regression test.";
if (!/^0x[0-9a-fA-F]{40}$/.test(CONTRACT || "")) { console.error("set CONTRACT=0x…"); process.exit(1); }

const wallet = new Wallet(process.env.FIXER_PK, new JsonRpcProvider(RPC, 5042002));
const abi = [
  "function submitFix(uint256 id, string fixUri, bytes32 fixHash, string note) returns (uint32)",
  "event FixSubmitted(uint256 indexed id, uint32 indexed fixIndex, address indexed fixer, string fixUri, bytes32 fixHash, string note)",
];
const c = new Contract(CONTRACT, abi, wallet);

// 1) ask the x402 endpoint — get the 402 challenge
const ch = await fetch(`${API}/api/x402/submit`, { method: "POST" });
if (ch.status !== 402) { console.error("expected 402, got", ch.status, await ch.text()); process.exit(1); }
const req = (await ch.json()).accepts[0];
console.log(`402 → ${req.extra.method} on ${req.payTo} (${req.network}); submitting is free (USDC gas = anti-spam)`);

// 2) submit the fix on-chain from our own wallet (the "payment" is the on-chain work)
const fixHash = keccak256(toUtf8Bytes(fixUri + " " + note));
const tx = await c.submitFix(id, fixUri, fixHash, note);
const rc = await tx.wait(1);
const iface = new Interface(abi);
let fixIndex = 0;
for (const log of rc.logs) { try { const ev = iface.parseLog(log); if (ev?.name === "FixSubmitted") { fixIndex = Number(ev.args.fixIndex); break; } } catch {} }
console.log(`submitted fix #${fixIndex} on-chain (${rc.hash})`);

// 3) prove it — present the tx hash in X-PAYMENT
const xpay = Buffer.from(JSON.stringify({ txHash: rc.hash })).toString("base64");
const res = await fetch(`${API}/api/x402/submit`, { method: "POST", headers: { "X-PAYMENT": xpay } });
if (!res.ok) { console.error("denied:", res.status, await res.text()); process.exit(1); }
const settle = res.headers.get("X-PAYMENT-RESPONSE");
console.log("X-PAYMENT-RESPONSE:", JSON.parse(Buffer.from(settle, "base64").toString()));
console.log("RESULT:", JSON.stringify(await res.json(), null, 2));
console.log("\n→ the fix is on-chain under the agent; if the author accepts it, the full bounty lands in the agent's wallet.");
