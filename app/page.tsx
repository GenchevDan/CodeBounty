"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { useWallet } from "@/lib/useWallet";
import { pickProvider } from "@/lib/wallet";
import { switchToArc, ARCSCAN } from "@/lib/arcNetwork";
import {
  CONTRACT_ADDRESS, CODEBOUNTY_ABI, hasContract,
  fetchStats, fetchFeed, fetchBounty,
  type Stats, type Bounty, type Fix, type Task, EMPTY_STATS,
  STATUS, usd, usdPlain, shortAddr, timeLeft, timeAgo, dateStamp, bountyTag, shortTitle, buildTaskJson,
} from "@/lib/codebounty";

const WINDOWS: [string, number][] = [["1 hour", 3600], ["6 hours", 21600], ["24 hours", 86400], ["3 days", 259200], ["7 days", 604800], ["30 days", 2592000]];
const LANGS = ["TypeScript", "JavaScript", "Python", "Solidity", "Rust", "Go", "C++", "Java", "Ruby", "Shell", "CSS", "Other"];

function statusName(s: number) { return s === STATUS.Paid ? "paid" : s === STATUS.Refunded ? "expired" : "open"; }

export default function Page() {
  const { account, balance, chainOk, connecting, connect } = useWallet();
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [feed, setFeed] = useState<Bounty[]>([]);
  const [now, setNow] = useState(0);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "open" | "paid" | "expired">("all");
  const [modal, setModal] = useState<null | "post" | "agents" | { fix: number }>(null);
  const [busyId, setBusyId] = useState<number | "post" | null>(null);
  const [justPaid, setJustPaid] = useState<number | null>(null);
  const [toast, setToast] = useState("");

  const live = hasContract();
  const me = account.toLowerCase();

  const refresh = useCallback(async () => {
    if (!live) return;
    try { const [s, f] = await Promise.all([fetchStats(), fetchFeed(24)]); setStats(s); setFeed(f); } catch { /* rpc */ }
  }, [live]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  async function getSigner() {
    const inj = pickProvider();
    if (!inj) throw new Error("No wallet detected — install Rabby or MetaMask.");
    if (!account) await connect();
    try { await switchToArc(inj); } catch { /* */ }
    return await new ethers.BrowserProvider(inj).getSigner();
  }
  function contractW(signer: ethers.Signer) { return new ethers.Contract(CONTRACT_ADDRESS, CODEBOUNTY_ABI, signer); }
  function flash(m: string) { setToast(m); setTimeout(() => setToast(""), 4000); }

  const reloadOne = useCallback(async (id: number) => {
    const b = await fetchBounty(id); if (b) setFeed((prev) => prev.map((x) => (x.id === id ? b : x)));
    fetchStats().then(setStats).catch(() => {});
  }, []);

  async function accept(id: number, fixIndex: number) {
    try {
      setBusyId(id);
      const c = contractW(await getSigner());
      const tx = await c.acceptFix(id, fixIndex); await tx.wait(1);
      setJustPaid(id); await reloadOne(id); flash("Fix accepted — bounty paid in full.");
    } catch (e) { flash(errMsg(e)); } finally { setBusyId(null); }
  }
  async function reclaim(id: number) {
    try {
      setBusyId(id);
      const c = contractW(await getSigner());
      const tx = await c.refundExpired(id); await tx.wait(1);
      await reloadOne(id); flash("Bounty reclaimed.");
    } catch (e) { flash(errMsg(e)); } finally { setBusyId(null); }
  }

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return feed.filter((b) => {
      if (filter !== "all" && statusName(b.status) !== filter) return false;
      if (!term) return true;
      const hay = `${shortTitle(b)} ${b.lang} ${b.task?.r ?? ""} ${b.task?.f ?? ""} ${usdPlain(b.amount)}`.toLowerCase();
      return hay.includes(term);
    });
  }, [feed, q, filter]);

  return (
    <div className="wrap">
      <div className="vignette" /><div className="grain" />

      {/* ── top bar ─────────────────────────────────────────────── */}
      <header style={{ maxWidth: 940, margin: "0 auto", padding: "26px 22px 10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div className="crumbs">
            <b>CodeBounty</b><span className="sep">/</span><span>Bounties</span>
            <span className="chain-tag" title="ARC testnet">eip155:5042002</span>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {account ? (
              <span className="mono" style={{ fontSize: ".74rem", color: "var(--ink2)", display: "flex", gap: 8, alignItems: "center" }}>
                <span className="seal" style={{ borderColor: chainOk ? "var(--green)" : "var(--amber)", color: chainOk ? "var(--green)" : "#9a6410" }}>{chainOk ? "ARC" : "wrong net"}</span>
                {shortAddr(account)} · ${balance}
              </span>
            ) : <button className="btn btn-sm" onClick={connect}>{connecting ? "connecting…" : "Connect wallet"}</button>}
          </div>
        </div>

        <div style={{ marginTop: 18, marginBottom: 6 }}>
          <h1 className="title" style={{ fontSize: "clamp(1.9rem,4.5vw,2.7rem)", margin: "0 0 6px" }}>
            A résumé of fixes worth paying for.
          </h1>
          <p className="serif" style={{ fontSize: "1.02rem", color: "var(--ink2)", margin: 0, maxWidth: 640, lineHeight: 1.5 }}>
            Post a small bug or TODO, escrow <b style={{ color: "var(--ink)" }}>$0.50–2</b> in USDC, and let fixers compete.
            Accept exactly one — the contract pays them the whole bounty, instantly. A GitHub issue is a wish; this one is funded.
          </p>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap", alignItems: "center" }}>
          <input className="field" style={{ flex: "1 1 280px" }} placeholder="Search bounties — repo, language, $ range, status…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div style={{ display: "flex", gap: 6 }}>
            {(["all", "open", "paid", "expired"] as const).map((f) => (
              <button key={f} className="btn btn-sm" onClick={() => setFilter(f)}
                style={filter === f ? { background: "var(--ink)", color: "var(--paper)", borderColor: "var(--ink)" } : {}}>{f}</button>
            ))}
          </div>
        </div>
      </header>

      {/* ── timeline feed ───────────────────────────────────────── */}
      <main style={{ maxWidth: 940, margin: "0 auto", padding: "14px 22px 130px" }}>
        {filtered.length === 0 ? (
          !live ? <Empty>Contract pending deployment — the interface is live, bounties open once it’s on Arc.</Empty>
            : <Empty>{feed.length === 0 ? "No bounties yet. Post the first one." : "No bounties match your search."}</Empty>
        ) : (
          <div className="timeline">
            <div className="tl-line" />
            {filtered.map((b) => (
              <BountyEntry key={b.id} b={b} now={now} me={me} busy={busyId === b.id}
                onAccept={accept} onReclaim={reclaim} onFix={() => setModal({ fix: b.id })}
                justPaid={justPaid === b.id} />
            ))}
          </div>
        )}
      </main>

      {/* ── floating stats bar ──────────────────────────────────── */}
      <StatsBar stats={stats} now={now} feed={feed} account={account}
        onPost={() => (account ? setModal("post") : connect())} onAgents={() => setModal("agents")} />

      {toast && (
        <div className="mono" style={{ position: "fixed", bottom: 90, left: "50%", transform: "translateX(-50%)", zIndex: 60, background: "var(--ink)", color: "var(--paper)", padding: "9px 16px", borderRadius: 10, fontSize: ".78rem", boxShadow: "0 12px 30px -12px rgba(0,0,0,.6)" }}>{toast}</div>
      )}

      {modal === "post" && <PostModal onClose={() => setModal(null)} getSigner={getSigner} contractW={contractW} setBusy={setBusyId} busy={busyId === "post"} onDone={() => { setModal(null); refresh(); flash("Bounty posted & escrowed."); }} onError={flash} />}
      {modal && typeof modal === "object" && "fix" in modal && (
        <FixModal bounty={feed.find((x) => x.id === modal.fix)!} onClose={() => setModal(null)} getSigner={getSigner} contractW={contractW} setBusy={setBusyId} busy={busyId === modal.fix} onDone={() => { setModal(null); reloadOne(modal.fix); flash("Fix submitted."); }} onError={flash} />
      )}
      {modal === "agents" && <AgentsModal onClose={() => setModal(null)} />}
    </div>
  );
}

function errMsg(e: unknown): string {
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage || (e as Error)?.message || "Something went wrong.";
  if (/user rejected|denied/i.test(m)) return "Transaction rejected.";
  if (/AlreadyFixed/.test(m)) return "You’ve already submitted a fix to this bounty.";
  if (/AuthorCannotFix/.test(m)) return "You can’t fix your own bounty.";
  if (/NotOpen/.test(m)) return "This bounty is no longer open.";
  if (/PastDeadline/.test(m)) return "The deadline has passed.";
  return m.length > 120 ? m.slice(0, 120) + "…" : m;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="serif" style={{ textAlign: "center", color: "var(--ink2)", fontStyle: "italic", padding: "50px 0", fontSize: "1.05rem" }}>{children}</p>;
}

/* ── one bounty = a CV "role" on the timeline ───────────────────────────────── */
function BountyEntry({ b, now, me, busy, onAccept, onReclaim, onFix, justPaid }: {
  b: Bounty; now: number; me: string; busy: boolean;
  onAccept: (id: number, fixIndex: number) => void; onReclaim: (id: number) => void; onFix: () => void; justPaid: boolean;
}) {
  const st = statusName(b.status);
  const isAuthor = me && b.author.toLowerCase() === me;
  const expired = b.status === STATUS.Open && now >= b.deadline;
  const t = b.task;

  return (
    <div className="entry">
      <div className="gutter">
        <div className="when">{dateStamp(b.postedAt)}</div>
        {b.status === STATUS.Open && <div className="left">{expired ? "expired" : timeLeft(b.deadline, now)}</div>}
        {b.status === STATUS.Paid && <div className="left" style={{ color: "var(--green)" }}>paid out</div>}
        {b.status === STATUS.Refunded && <div className="left">reclaimed</div>}
      </div>
      <div className={`node node-${expired ? "expired" : st}`} />

      <div className={`card ${b.status === STATUS.Paid ? "card-paid" : ""} ${b.status === STATUS.Refunded || expired ? "card-expired" : ""}`}>
        {/* header */}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: ".64rem", color: "var(--muted)" }}>{bountyTag(b.id)}</span>
              <span className={`seal seal-${expired ? "expired" : st}`}>{expired ? "expired" : st}</span>
            </div>
            <h3 className="title" style={{ fontSize: "1.18rem", margin: "5px 0 3px" }}>{shortTitle(b)}</h3>
            <div className="sub">
              {t?.r && <span>{t.r}</span>}{t?.f && <span> · {t.f}</span>}<span> · {b.lang || t?.l || "code"}</span>
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <span className="amount-chip">{usd(b.amount)} USDC</span>
            <div className="sub" style={{ marginTop: 5 }}>{b.fixCount} fix{b.fixCount === 1 ? "" : "es"}</div>
          </div>
        </div>

        {/* body: description + code panel */}
        {t?.d && <p className="serif" style={{ fontSize: ".98rem", lineHeight: 1.55, margin: "12px 0 0", color: "var(--ink)" }}>{t.d}</p>}
        {t?.exp && <p className="serif" style={{ fontSize: ".95rem", lineHeight: 1.5, margin: "7px 0 0" }}><span className="mark mark-blue">Expected: {t.exp}</span></p>}
        {t?.c && <CodePanel code={t.c} bugLine={t.ln} />}

        {/* fixes */}
        {b.fixes.length > 0 && (
          <div style={{ marginTop: 14 }}>
            {b.fixes.map((f) => (
              <FixRow key={f.index} f={f} bounty={b} isAuthor={!!isAuthor} now={now} busy={busy}
                onAccept={() => onAccept(b.id, f.index)} justPaid={justPaid} />
            ))}
          </div>
        )}

        {/* actions */}
        <div style={{ display: "flex", gap: 10, marginTop: 15, flexWrap: "wrap", alignItems: "center" }}>
          {b.status === STATUS.Open && !isAuthor && (
            <button className="btn btn-sm btn-ink" onClick={onFix} disabled={busy}>Submit a fix →</button>
          )}
          {b.status === STATUS.Open && isAuthor && expired && (
            <button className="btn btn-sm" onClick={() => onReclaim(b.id)} disabled={busy}>{busy ? "…" : "Reclaim bounty"}</button>
          )}
          {b.status === STATUS.Open && isAuthor && b.fixes.length > 0 && (
            <span className="sub">Accept a fix below to pay the winner.</span>
          )}
          {b.status === STATUS.Open && isAuthor && b.fixes.length === 0 && (
            <span className="sub">{expired ? "Expired — reclaim your escrow." : "Your bounty is live — waiting for fixes."}</span>
          )}
          {b.taskHash && b.taskHash !== ethers.ZeroHash && (
            <span className="sub" style={{ marginLeft: "auto" }} title="keccak256 of the task body">task ✓ committed</span>
          )}
        </div>
      </div>
    </div>
  );
}

function CodePanel({ code, bugLine }: { code: string; bugLine?: number }) {
  const lines = code.replace(/\t/g, "  ").split("\n");
  return (
    <pre className="code" style={{ marginTop: 12 }}>
      {lines.map((ln, i) => (
        <div key={i} className={bugLine === i + 1 ? "bug" : undefined}>
          <span className="ln">{i + 1}</span>{ln || " "}
        </div>
      ))}
    </pre>
  );
}

/* ── a competing fix = an indented sub-entry ────────────────────────────────── */
function FixRow({ f, bounty, isAuthor, now, busy, onAccept, justPaid }: {
  f: Fix; bounty: Bounty; isAuthor: boolean; now: number; busy: boolean; onAccept: () => void; justPaid: boolean;
}) {
  const isWinner = bounty.status === STATUS.Paid && bounty.acceptedFix === f.index;
  const isAgent = false; // (display-only; agents tagged via x402 in a fuller build)
  const dim = bounty.status === STATUS.Paid && !isWinner;
  const triage = triageBadge(f);

  return (
    <div className={`fix ${dim ? "fix-dim" : ""}`}>
      <span className="fix-num">{f.index}.</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="mono" style={{ fontSize: ".74rem", color: "var(--ink)" }}>{shortAddr(f.fixer)}</span>
          <a className="flat-link mono" style={{ fontSize: ".72rem" }} href={normUrl(f.fixUri)} target="_blank" rel="noreferrer">{prettyUrl(f.fixUri)} ↗</a>
          <span className={`triage ${triage.cls}`}>{triage.text}</span>
          {isWinner && <span className="stamp stamp-in" style={{ marginLeft: 4 }}>Accepted · Paid</span>}
        </div>
        {f.note && (
          <p className={`serif ${isWinner ? "sweep sweep-on" : ""}`} style={{ fontSize: ".93rem", lineHeight: 1.45, margin: "5px 0 0", color: dim ? "var(--ink2)" : "var(--ink)", display: "inline-block" }}>{f.note}</p>
        )}
        <div className="sub" style={{ marginTop: 3 }}>
          submitted {timeAgo(f.submittedAt, now)}
          {isWinner && bounty.status === STATUS.Paid && <> · <span style={{ color: "var(--green)" }}>{usd(bounty.amount)} → PAID</span></>}
        </div>
      </div>
      {isAuthor && bounty.status === STATUS.Open && (
        <button className="btn btn-sm btn-amber" style={{ alignSelf: "center", marginLeft: "auto" }} onClick={onAccept} disabled={busy}>
          {busy ? "…" : `Accept · pay ${usd(bounty.amount)}`}
        </button>
      )}
    </div>
  );
}

// lightweight client-side triage hint (the real agent posts richer notes off-chain)
function triageBadge(f: Fix): { text: string; cls: string } {
  const u = f.fixUri.toLowerCase();
  const reachable = /^https?:\/\//.test(u) || u.startsWith("ipfs://");
  if (!f.note) return { text: "⚠ no note", cls: "triage-warn" };
  if (!reachable) return { text: "⚠ check pointer", cls: "triage-warn" };
  return { text: "✓ pointer ok", cls: "triage-ok" };
}
function normUrl(u: string) { return /^https?:\/\//.test(u) ? u : u.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${u.slice(7)}` : `https://${u}`; }
function prettyUrl(u: string) { return u.replace(/^https?:\/\//, "").replace(/^www\./, "").slice(0, 42); }

/* ── floating stats bar ─────────────────────────────────────────────────────── */
function StatsBar({ stats, now, feed, account, onPost, onAgents }: {
  stats: Stats; now: number; feed: Bounty[]; account: string; onPost: () => void; onAgents: () => void;
}) {
  // 30-day activity ruler from posted timestamps
  const ticks = useMemo(() => {
    const span = 30 * 86400; const start = now - span;
    return feed.filter((b) => b.postedAt >= start).map((b) => ({ x: ((b.postedAt - start) / span) * 100, paid: b.status === STATUS.Paid }));
  }, [feed, now]);

  return (
    <div className="statsbar">
      <div style={{ display: "flex", gap: 18 }}>
        <div className="stat"><div className="n">{stats.openCount}</div><div className="k">open</div></div>
        <div className="stat"><div className="n">${usdPlain(stats.inEscrow)}</div><div className="k">in escrow</div></div>
        <div className="stat"><div className="n">${usdPlain(stats.paidVolume)}</div><div className="k">paid out</div></div>
        <div className="stat"><div className="n">{stats.fixerCount}</div><div className="k">fixers</div></div>
      </div>
      <div className="ruler">
        {Array.from({ length: 31 }).map((_, i) => (
          <span key={i} className="tick" style={{ left: `${(i / 30) * 100}%`, height: i === 30 ? 14 : 6, background: i === 30 ? "var(--amber)" : "var(--hair)" }} />
        ))}
        {ticks.map((t, i) => (
          <span key={"b" + i} className="tick" style={{ left: `${t.x}%`, height: 20, width: 2, background: t.paid ? "var(--green)" : "var(--open)" }} />
        ))}
      </div>
      <button className="icon-btn" title="For agents · x402" onClick={onAgents}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>
      </button>
      <button className="btn btn-amber" onClick={onPost}>{account ? "Post a bounty" : "Connect wallet"}</button>
    </div>
  );
}

/* ── post-bounty modal ──────────────────────────────────────────────────────── */
function PostModal({ onClose, getSigner, contractW, setBusy, busy, onDone, onError }: {
  onClose: () => void; getSigner: () => Promise<ethers.Signer>; contractW: (s: ethers.Signer) => ethers.Contract;
  setBusy: (v: "post" | null) => void; busy: boolean; onDone: () => void; onError: (m: string) => void;
}) {
  const [f, setF] = useState({ t: "", r: "", file: "", lang: "TypeScript", c: "", ln: "", d: "", exp: "", amount: "1.00", window: 86400 });
  const set = (k: string, v: string | number) => setF((p) => ({ ...p, [k]: v }));

  async function submit() {
    if (!f.t.trim()) return onError("Give the task a title.");
    const amt = parseFloat(f.amount);
    if (!(amt >= 0.5 && amt <= 2)) return onError("Bounty must be $0.50–2.00.");
    const task: Task = { t: f.t.trim(), r: f.r.trim() || undefined, f: f.file.trim() || undefined, l: f.lang, c: f.c || undefined, ln: f.ln ? Number(f.ln) : undefined, d: f.d.trim() || undefined, exp: f.exp.trim() || undefined };
    const { uri, hash } = buildTaskJson(task);
    if (uri.length > 2000) return onError("Task is too long — trim the snippet (≤ ~2000 chars).");
    try {
      setBusy("post");
      const c = contractW(await getSigner());
      const tx = await c.postBounty(uri, hash, f.lang, BigInt(f.window), { value: ethers.parseEther(amt.toFixed(2)) });
      await tx.wait(1); onDone();
    } catch (e) { onError(errMsg(e)); } finally { setBusy(null); }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="title" style={{ fontSize: "1.5rem", margin: "0 0 4px" }}>Post a bounty</h2>
        <p className="sub" style={{ marginBottom: 16 }}>Escrow $0.50–2 USDC. Fixers compete; you accept one.</p>

        <Row label="Title"><input className="field field-serif" value={f.t} onChange={(e) => set("t", e.target.value)} placeholder="Off-by-one in cursor pagination" /></Row>
        <div style={{ display: "flex", gap: 10 }}>
          <Row label="Repo" flex><input className="field" value={f.r} onChange={(e) => set("r", e.target.value)} placeholder="acme/feed-api" /></Row>
          <Row label="File" flex><input className="field" value={f.file} onChange={(e) => set("file", e.target.value)} placeholder="src/cursor.ts" /></Row>
          <Row label="Language" flex>
            <select className="field" value={f.lang} onChange={(e) => set("lang", e.target.value)}>{LANGS.map((l) => <option key={l}>{l}</option>)}</select>
          </Row>
        </div>
        <Row label="Code snippet (the buggy bit)"><textarea className="field" rows={5} value={f.c} onChange={(e) => set("c", e.target.value)} placeholder={"function next(cur) {\n  return items.slice(cur, cur + size)\n}"} /></Row>
        <div style={{ display: "flex", gap: 10 }}>
          <Row label="Buggy line #" flex><input className="field" value={f.ln} onChange={(e) => set("ln", e.target.value.replace(/\D/g, ""))} placeholder="2" /></Row>
          <Row label="Bounty (USD)" flex><input className="field" value={f.amount} onChange={(e) => set("amount", e.target.value)} placeholder="1.00" /></Row>
          <Row label="Open for" flex>
            <select className="field" value={f.window} onChange={(e) => set("window", Number(e.target.value))}>{WINDOWS.map(([l, s]) => <option key={s} value={s}>{l}</option>)}</select>
          </Row>
        </div>
        <Row label="What’s wrong / the TODO"><textarea className="field field-serif" rows={2} value={f.d} onChange={(e) => set("d", e.target.value)} placeholder="The last page repeats the final item." /></Row>
        <Row label="Expected behaviour (optional)"><input className="field field-serif" value={f.exp} onChange={(e) => set("exp", e.target.value)} placeholder="Each item appears exactly once across pages." /></Row>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-amber" onClick={submit} disabled={busy}>{busy ? "Escrowing…" : `Escrow $${parseFloat(f.amount || "0").toFixed(2)} & post`}</button>
        </div>
      </div>
    </div>
  );
}

/* ── submit-fix modal ───────────────────────────────────────────────────────── */
function FixModal({ bounty, onClose, getSigner, contractW, setBusy, busy, onDone, onError }: {
  bounty: Bounty; onClose: () => void; getSigner: () => Promise<ethers.Signer>; contractW: (s: ethers.Signer) => ethers.Contract;
  setBusy: (v: number | null) => void; busy: boolean; onDone: () => void; onError: (m: string) => void;
}) {
  const [fixUri, setFixUri] = useState("");
  const [note, setNote] = useState("");

  async function submit() {
    if (!fixUri.trim()) return onError("Add a link to your fix (gist / commit / PR).");
    if (note.length > 280) return onError("Note must be ≤ 280 characters.");
    const fixHash = ethers.keccak256(ethers.toUtf8Bytes(fixUri.trim() + " " + note.trim()));
    try {
      setBusy(bounty.id);
      const c = contractW(await getSigner());
      const tx = await c.submitFix(bounty.id, fixUri.trim(), fixHash, note.trim());
      await tx.wait(1); onDone();
    } catch (e) { onError(errMsg(e)); } finally { setBusy(null); }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <span className="mono" style={{ fontSize: ".64rem", color: "var(--muted)" }}>{bountyTag(bounty.id)} · {usd(bounty.amount)} USDC</span>
        <h2 className="title" style={{ fontSize: "1.4rem", margin: "4px 0 4px" }}>Submit a fix</h2>
        <p className="sub" style={{ marginBottom: 16 }}>PR-style: a link to your patch + a one-line note. Free to submit; you win only if accepted.</p>
        <Row label="Fix pointer (gist / commit / PR / patch URL)"><input className="field" value={fixUri} onChange={(e) => setFixUri(e.target.value)} placeholder="https://gist.github.com/…" /></Row>
        <Row label={`Note (${note.length}/280)`}><textarea className="field field-serif" rows={3} value={note} onChange={(e) => setNote(e.target.value.slice(0, 280))} placeholder="Clamp the upper bound to items.length; added a test for the last page." /></Row>
        <p className="sub" style={{ margin: "2px 0 14px" }}>A keccak256 of your pointer + note is committed on-chain (tamper-evident; the triage agent re-checks it).</p>
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-ink" onClick={submit} disabled={busy}>{busy ? "Submitting…" : "Submit fix"}</button>
        </div>
      </div>
    </div>
  );
}

/* ── agents / x402 modal ────────────────────────────────────────────────────── */
function AgentsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 600 }} onClick={(e) => e.stopPropagation()}>
        <h2 className="title" style={{ fontSize: "1.5rem", margin: "0 0 4px" }}>Fixers can be agents — x402</h2>
        <p className="serif" style={{ fontSize: "1rem", color: "var(--ink2)", lineHeight: 1.5, margin: "0 0 14px" }}>
          An AI coding agent can submit a fix (or post a bounty) programmatically over genuine <b style={{ color: "var(--ink)" }}>x402</b> (HTTP-402) — earning micro-USDC at machine scale, no wallet UI.
        </p>
        <pre className="code" style={{ fontSize: ".72rem" }}>{`POST /api/x402/submit            → 402  { accepts:[{ network:"eip155:5042002",
                                          maxAmountRequired:"0", asset:native }] }
submitFix(id, uri, hash, note)   → tx        (native USDC gas = anti-spam)
POST /api/x402/submit  X-PAYMENT: base64({ txHash })
                                 → 200  { fixIndex, triage }  + X-PAYMENT-RESPONSE`}</pre>
        <p className="sub" style={{ marginTop: 12, lineHeight: 1.6 }}>
          Honest scope: Arc’s USDC is native (no ERC-20, no EIP-3009 gasless) and submitting carries no protocol fee, so this is
          <b style={{ color: "var(--ink)" }}> pay-then-prove</b> — the agent calls submitFix from its own wallet (paying only Arc’s USDC gas, which
          is the anti-spam) and proves it with the tx; the route self-verifies the FixSubmitted event against Arc, no facilitator. The triage
          agent then re-hashes the pointer against the on-chain commitment and ranks it for the author.
        </p>
        <div style={{ textAlign: "right", marginTop: 14 }}><button className="btn" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

function Row({ label, children, flex }: { label: string; children: React.ReactNode; flex?: boolean }) {
  return (
    <label style={{ display: "block", marginBottom: 11, flex: flex ? "1 1 0" : undefined, minWidth: 0 }}>
      <span className="sub" style={{ display: "block", marginBottom: 4 }}>{label}</span>
      {children}
    </label>
  );
}
