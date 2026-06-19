import { ethers } from "ethers";
import { ARC_RPC } from "./arcNetwork";

// ─────────────────────────────────────────────────────────────────────────────
// CodeBounty — winner-take-all micro-bounties for code fixes on ARC.
// The task body is stored INLINE as a compact JSON in taskUri (committed by taskHash);
// the fix is a PR-style URL pointer (fixUri) + a content hash.
// Set after deploy (scripts/deploy bakes it in).
// ─────────────────────────────────────────────────────────────────────────────
export const CONTRACT_ADDRESS = "0xA773A6f6a0C2C7b627a2F19Ed5725cc2CD895E86";

export const CODEBOUNTY_ABI = [
  "function MIN_BOUNTY() view returns (uint256)",
  "function MAX_BOUNTY() view returns (uint256)",
  "function MIN_WINDOW() view returns (uint64)",
  "function MAX_WINDOW() view returns (uint64)",
  "function bountyCount() view returns (uint256)",
  "function openCount() view returns (uint256)",
  "function paidVolume() view returns (uint256)",
  "function paidCount() view returns (uint256)",
  "function refundedCount() view returns (uint256)",
  "function totalFixes() view returns (uint256)",
  "function fixerCount() view returns (uint256)",
  "function hasSubmitted(uint256, address) view returns (bool)",
  "function postBounty(string taskUri, bytes32 taskHash, string lang, uint64 window) payable returns (uint256)",
  "function submitFix(uint256 id, string fixUri, bytes32 fixHash, string note) returns (uint32)",
  "function acceptFix(uint256 id, uint32 fixIndex)",
  "function refundExpired(uint256 id)",
  "function getBounty(uint256) view returns (address author, uint96 amount, uint64 postedAt, uint64 deadline, uint8 status, uint32 fixCount, uint32 acceptedFix, string taskUri, bytes32 taskHash, string lang)",
  "function getFixes(uint256) view returns (tuple(address fixer, uint64 submittedAt, string fixUri, bytes32 fixHash, string note)[])",
  "function fixCountOf(uint256) view returns (uint256)",
  "function bountiesByAuthor(address) view returns (uint256[])",
  "function bountiesByFixer(address) view returns (uint256[])",
  "function latest(uint256) view returns (uint256[])",
  "function escrowOf(uint256) view returns (uint256)",
  "function isRefundable(uint256) view returns (bool)",
  "event BountyPosted(uint256 indexed id, address indexed author, uint256 amount, uint64 deadline, string taskUri, bytes32 taskHash, string lang)",
  "event FixSubmitted(uint256 indexed id, uint32 indexed fixIndex, address indexed fixer, string fixUri, bytes32 fixHash, string note)",
  "event FixAccepted(uint256 indexed id, uint32 indexed fixIndex, address indexed winner, uint256 amount)",
  "event BountyRefunded(uint256 indexed id, address indexed author, uint256 amount)",
];

export const STATUS = { Open: 0, Paid: 1, Refunded: 2 } as const;
export const STATUS_LABEL = ["Open", "Paid", "Refunded"];

// the inline task payload carried (as JSON) in taskUri
export interface Task {
  t: string;   // title
  r?: string;  // repo
  f?: string;  // file
  l?: string;  // language (mirror of bounty.lang)
  c?: string;  // code snippet
  ln?: number; // 1-based line index in the snippet that carries the bug (amber mark)
  d?: string;  // description of the bug / TODO
  exp?: string; // expected behaviour (pale-blue mark)
}

export interface Fix {
  index: number; // 1-based
  fixer: string;
  submittedAt: number;
  fixUri: string;
  fixHash: string;
  note: string;
}

export interface Bounty {
  id: number;
  author: string;
  amount: bigint;
  postedAt: number;
  deadline: number;
  status: number;
  fixCount: number;
  acceptedFix: number; // 1-based, meaningful only when status == Paid
  taskUri: string;
  taskHash: string;
  lang: string;
  task: Task | null; // parsed inline task
  fixes: Fix[];
}

export interface Stats {
  bountyCount: number; openCount: number;
  paidVolume: bigint; paidCount: number; refundedCount: number;
  totalFixes: number; fixerCount: number;
  inEscrow: bigint; // == contract balance == Σ open amounts
}
export const EMPTY_STATS: Stats = {
  bountyCount: 0, openCount: 0, paidVolume: 0n, paidCount: 0, refundedCount: 0,
  totalFixes: 0, fixerCount: 0, inEscrow: 0n,
};

export function readProvider() { return new ethers.JsonRpcProvider(ARC_RPC); }
export function readContract(p?: ethers.Provider) { return new ethers.Contract(CONTRACT_ADDRESS, CODEBOUNTY_ABI, p ?? readProvider()); }
export function hasContract(): boolean { return /^0x[a-fA-F0-9]{40}$/.test(CONTRACT_ADDRESS); }

export function parseTask(taskUri: string): Task | null {
  const t = (taskUri || "").trim();
  if (!t.startsWith("{")) return null;
  try { const o = JSON.parse(t); return typeof o?.t === "string" ? o : null; } catch { return null; }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const s = await Promise.allSettled(items.slice(i, i + limit).map(fn));
    s.forEach((r) => { if (r.status === "fulfilled") out.push(r.value); });
  }
  return out;
}

export async function fetchStats(contract?: ethers.Contract): Promise<Stats> {
  const c = contract ?? readContract();
  const p = c.runner?.provider ?? readProvider();
  const [bountyCount, openCount, paidVolume, paidCount, refundedCount, totalFixes, fixerCount, bal] = await Promise.all([
    c.bountyCount(), c.openCount(), c.paidVolume(), c.paidCount(), c.refundedCount(), c.totalFixes(), c.fixerCount(),
    p.getBalance(CONTRACT_ADDRESS),
  ]);
  return {
    bountyCount: Number(bountyCount), openCount: Number(openCount), paidVolume, paidCount: Number(paidCount),
    refundedCount: Number(refundedCount), totalFixes: Number(totalFixes), fixerCount: Number(fixerCount), inEscrow: bal,
  };
}

export async function fetchBounty(id: number, contract?: ethers.Contract): Promise<Bounty | null> {
  const c = contract ?? readContract();
  try {
    const b = await c.getBounty(id);
    if (b.author === ethers.ZeroAddress) return null;
    let fixes: Fix[] = [];
    if (Number(b.fixCount) > 0) {
      const raw = await c.getFixes(id);
      fixes = raw.map((f: { fixer: string; submittedAt: bigint; fixUri: string; fixHash: string; note: string }, i: number) => ({
        index: i + 1, fixer: f.fixer, submittedAt: Number(f.submittedAt), fixUri: f.fixUri, fixHash: f.fixHash, note: f.note,
      }));
    }
    return {
      id, author: b.author, amount: b.amount, postedAt: Number(b.postedAt), deadline: Number(b.deadline),
      status: Number(b.status), fixCount: Number(b.fixCount), acceptedFix: Number(b.acceptedFix),
      taskUri: b.taskUri, taskHash: b.taskHash, lang: b.lang, task: parseTask(b.taskUri), fixes,
    };
  } catch { return null; }
}

export async function fetchFeed(n = 20, contract?: ethers.Contract): Promise<Bounty[]> {
  const c = contract ?? readContract();
  const total = Number(await c.bountyCount());
  if (total === 0) return [];
  const ids: bigint[] = await c.latest(Math.min(n, total));
  const out = await mapLimit(ids.map(Number), 5, (id) => fetchBounty(id, c));
  return out.filter((x): x is Bounty => !!x);
}

// ── helpers ──────────────────────────────────────────────────────────────────
export function shortAddr(a: string, lead = 6, tail = 4): string { return a ? `${a.slice(0, lead)}…${a.slice(-tail)}` : ""; }

/** native-USDC wei → "$1.50" style */
export function usd(wei: bigint): string {
  const n = parseFloat(ethers.formatEther(wei));
  return "$" + n.toFixed(2);
}
export function usdPlain(wei: bigint): string {
  const n = parseFloat(ethers.formatEther(wei));
  return n.toFixed(2);
}

export function buildTaskJson(task: Task): { uri: string; hash: string } {
  // drop empties, keep compact + deterministic key order
  const o: Task = { t: task.t };
  if (task.r) o.r = task.r;
  if (task.f) o.f = task.f;
  if (task.l) o.l = task.l;
  if (task.c) o.c = task.c;
  if (task.ln) o.ln = task.ln;
  if (task.d) o.d = task.d;
  if (task.exp) o.exp = task.exp;
  const uri = JSON.stringify(o);
  const hash = ethers.keccak256(ethers.toUtf8Bytes(uri));
  return { uri, hash };
}

export function shortTitle(b: Bounty): string {
  return b.task?.t || (b.taskUri.startsWith("{") ? "Untitled task" : b.taskUri).slice(0, 80);
}
export function bountyTag(id: number): string { return `#BTY-${String(id).padStart(4, "0")}`; }

export function timeLeft(deadline: number, now: number): string {
  const d = deadline - now;
  if (d <= 0) return "expired";
  const days = Math.floor(d / 86400), h = Math.floor((d % 86400) / 3600), m = Math.floor((d % 3600) / 60);
  if (days > 0) return `${days}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}
export function timeAgo(unix: number, now: number): string {
  const d = Math.max(0, now - unix);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
export function dateStamp(unix: number): string {
  if (!unix) return "—";
  const d = new Date(unix * 1000);
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
  return `${mon} ${d.getUTCDate()} · ${String(d.getUTCHours()).padStart(2,"0")}:${String(d.getUTCMinutes()).padStart(2,"0")}`;
}
