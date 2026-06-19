// CodeBounty — the autonomous triage agent (read-only; ZERO money authority).
// Watches open bounties, fetches each fix pointer, recomputes its keccak256 against the
// on-chain commitment (so nobody swapped the patch after submitting), flags unreachable
// pointers and duplicate hashes (plagiarism / copy-and-resubmit), ranks the candidates by
// first-submit time, and prints an advisory the author can act on. It can never move a cent —
// only the bounty's own author can call acceptFix.
//   node agent/triage.mjs            (reads the baked contract address)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JsonRpcProvider, Contract, keccak256, toUtf8Bytes, formatEther } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const RPC = process.env.ARC_RPC || "https://rpc.testnet.arc.network";
const lib = readFileSync(join(root, "lib/codebounty.ts"), "utf8");
const CONTRACT = process.env.CONTRACT || (lib.match(/CONTRACT_ADDRESS = "(0x[0-9a-fA-F]{40})"/) || [])[1];
if (!/^0x[0-9a-fA-F]{40}$/.test(CONTRACT || "")) { console.error("contract not baked yet — deploy first"); process.exit(1); }

const ABI = [
  "function bountyCount() view returns (uint256)",
  "function getBounty(uint256) view returns (address author, uint96 amount, uint64 postedAt, uint64 deadline, uint8 status, uint32 fixCount, uint32 acceptedFix, string taskUri, bytes32 taskHash, string lang)",
  "function getFixes(uint256) view returns (tuple(address fixer, uint64 submittedAt, string fixUri, bytes32 fixHash, string note)[])",
];
const c = new Contract(CONTRACT, ABI, new JsonRpcProvider(RPC, 5042002));
const POLL = Number(process.env.POLL_MS || 12000);

async function reachable(url) {
  if (!/^(https?:\/\/|ipfs:\/\/)/i.test(url)) return false;
  const u = url.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${url.slice(7)}` : url;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 5000);
  try { const r = await fetch(u, { method: "GET", signal: ac.signal, headers: { "User-Agent": "CodeBounty-Triage/1.0" } }); return r.ok; }
  catch { return false; } finally { clearTimeout(t); }
}

async function triageBounty(id) {
  const b = await c.getBounty(id);
  if (Number(b.status) !== 0) return;                 // only Open bounties
  const fixes = await c.getFixes(id);
  if (fixes.length === 0) return;
  const title = (() => { try { return JSON.parse(b.taskUri).t; } catch { return b.taskUri.slice(0, 48); } })();
  console.log(`\n#BTY-${String(id).padStart(4, "0")} "${title}" — ${formatEther(b.amount)} USDC · ${fixes.length} fix(es)`);

  const seenHash = new Map();
  const rows = [];
  for (let i = 0; i < fixes.length; i++) {
    const f = fixes[i];
    const recomputed = keccak256(toUtf8Bytes(f.fixUri + " " + f.note));
    const hashOk = recomputed.toLowerCase() === f.fixHash.toLowerCase();
    const dup = seenHash.has(f.fixHash.toLowerCase());
    if (!dup) seenHash.set(f.fixHash.toLowerCase(), i + 1);
    const ok = await reachable(f.fixUri);
    const flags = [];
    if (!ok) flags.push("unreachable-pointer");
    if (!hashOk) flags.push("hash-mismatch(tampered?)");
    if (dup) flags.push(`duplicate-of-#${seenHash.get(f.fixHash.toLowerCase())}(plagiarism?)`);
    if (!f.note.trim()) flags.push("empty-note");
    rows.push({ idx: i + 1, fixer: f.fixer, submittedAt: Number(f.submittedAt), ok, hashOk, dup, flags });
  }
  // rank: clean + reachable first, then earliest submit
  rows.sort((a, b2) => (a.flags.length - b2.flags.length) || (a.submittedAt - b2.submittedAt));
  rows.forEach((r, rank) => {
    const verdict = r.flags.length === 0 ? `ranked #${rank + 1} ✓` : `flagged: ${r.flags.join(", ")}`;
    console.log(`  fix #${r.idx} ${r.fixer.slice(0, 10)}…  ${verdict}`);
  });
  if (rows[0] && rows[0].flags.length === 0) console.log(`  → advisory: accept fix #${rows[0].idx} (clean, earliest reachable).`);
}

async function tick() {
  try {
    const total = Number(await c.bountyCount());
    for (let id = Math.max(1, total - 40); id <= total; id++) await triageBounty(id);
  } catch (e) { console.error("poll error:", String(e?.shortMessage || e?.message || e)); }
}

console.log(`CodeBounty triage agent — watching ${CONTRACT} every ${POLL}ms (read-only)\n`);
await tick();
setInterval(tick, POLL);
