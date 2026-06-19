// CodeBounty — self-contained DEMO loop: post → compete → accept → instant payout, on-chain.
// From its own funded wallet the agent posts a demo bounty, spins up two throwaway fixer keys
// (funded with a sliver of USDC for gas), submits a fix from each, then — as the demo bounty's
// own author — accepts one. A visitor watches the whole winner-take-all loop happen live on the
// timeline. The agent has power over THIS bounty only because it funded it as an ordinary author.
//   AGENT_PK=0x.. node agent/demo.mjs      (needs ~0.6 USDC in the agent wallet)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JsonRpcProvider, Wallet, Contract, parseEther, keccak256, toUtf8Bytes } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
function loadEnv() { try { for (const l of readFileSync(join(root, ".env.local"), "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {} }
loadEnv();

const RPC = process.env.ARC_RPC || "https://rpc.testnet.arc.network";
const pk = process.env.AGENT_PK;
if (!/^0x[0-9a-fA-F]{64}$/.test(pk || "")) { console.error("AGENT_PK not set (.env.local)"); process.exit(1); }
const lib = readFileSync(join(root, "lib/codebounty.ts"), "utf8");
const CONTRACT = process.env.CONTRACT || (lib.match(/CONTRACT_ADDRESS = "(0x[0-9a-fA-F]{40})"/) || [])[1];
if (!/^0x[0-9a-fA-F]{40}$/.test(CONTRACT || "")) { console.error("contract not baked yet — deploy first"); process.exit(1); }

const ABI = [
  "function postBounty(string taskUri, bytes32 taskHash, string lang, uint64 window) payable returns (uint256)",
  "function submitFix(uint256 id, string fixUri, bytes32 fixHash, string note) returns (uint32)",
  "function acceptFix(uint256 id, uint32 fixIndex)",
  "function bountyCount() view returns (uint256)",
  "event FixAccepted(uint256 indexed id, uint32 indexed fixIndex, address indexed winner, uint256 amount)",
];
const provider = new JsonRpcProvider(RPC, 5042002);
const agent = new Wallet(pk, provider);
const c = new Contract(CONTRACT, ABI, agent);

const task = {
  t: "TODO: debounce the search box", r: "demo/notes-app", f: "src/Search.tsx", l: "TypeScript",
  c: "onChange={(e) => fetchResults(e.target.value)}", ln: 1,
  d: "Every keystroke fires a request — debounce it ~250ms.", exp: "At most one request per 250ms idle.",
};
const uri = JSON.stringify(task);
const hash = keccak256(toUtf8Bytes(uri));

console.log("demo agent:", agent.address);
console.log("posting demo bounty (0.5 USDC, 1h window)…");
let tx = await c.postBounty(uri, hash, "TypeScript", 3600n, { value: parseEther("0.5") });
let rc = await tx.wait(1);
const total = Number(await c.bountyCount());
const id = total; // freshly posted is the latest
console.log(`  posted #BTY-${String(id).padStart(4, "0")} (${rc.hash})`);

// two throwaway fixer wallets, funded with a sliver of USDC for gas
const fixers = [Wallet.createRandom().connect(provider), Wallet.createRandom().connect(provider)];
for (const f of fixers) {
  const ft = await agent.sendTransaction({ to: f.address, value: parseEther("0.03") });
  await ft.wait(1);
}
console.log("funded 2 throwaway fixers; submitting competing fixes…");

const subs = [
  { uri: "https://gist.github.com/demo/debounce-hook", note: "Wrap fetchResults in a 250ms useDebouncedCallback; added a test." },
  { uri: "https://gist.github.com/demo/lodash-debounce", note: "Use lodash.debounce(250) around the handler." },
];
for (let i = 0; i < fixers.length; i++) {
  const fc = new Contract(CONTRACT, ABI, fixers[i]);
  const fh = keccak256(toUtf8Bytes(subs[i].uri + " " + subs[i].note));
  const t2 = await fc.submitFix(id, subs[i].uri, fh, subs[i].note);
  await t2.wait(1);
  console.log(`  fix #${i + 1} from ${fixers[i].address.slice(0, 10)}…`);
}

console.log("author accepts fix #1 → winner-take-all payout…");
tx = await c.acceptFix(id, 1);
rc = await tx.wait(1);
console.log(`  accepted ✓ — 0.5 USDC paid to ${fixers[0].address.slice(0, 10)}… (${rc.hash})`);
console.log(`\nwatch it on the timeline: #BTY-${String(id).padStart(4, "0")} is now PAID.`);
