# [BUG] A GitHub issue is an unfunded wish — `status: wontfix-for-free`

> CodeBounty turns a small bug report into an escrowed dollar that pays out to exactly one fixer.
> Author posts a TODO and locks $0.50–2 USDC; many people race to fix it; the author accepts one; the contract pays that one the whole thing.

**Component:** open-source maintenance · the five-minute fixes nobody does for free
**Severity:** low per-issue, infinite in aggregate
**Repo:** `GenchevDan/codebounty` · **Live:** https://codebounty-arc.vercel.app/

---

### Repro

1. File an issue: `off-by-one in cursor pagination, last page repeats the final item`.
2. Wait.
3. ...

### Expected

A stranger spends fifteen minutes, opens a patch, gets paid the dollar you'd happily have paid.

### Actual

The issue sits open for nine months. It is, structurally, a wish. There is no money behind it, so there is
no reason for anyone outside the project to touch it, and the people *inside* the project are busy not doing
their own version of the same five-minute fix. The bottleneck was never skill — it was that "I'd pay a buck
for this" is not a thing you can actually *say to the internet* in a way that's binding.

### Root cause

Intent isn't collateral. A promised reward that lives in a comment thread can evaporate, get argued over, or
just be ignored after the work lands. Until the dollar is *locked* before any work starts — and paid *atomically*
to one chosen winner — the incentive doesn't clear and nobody rational shows up.

### Fix

Make the dollar real first. `postBounty(...)` escrows the USDC on-chain at the moment of posting; fixers can
see the funds are committed before they spend a minute; `acceptFix(...)` hands the entire bounty to the one
submission the author picks, in the same transaction, with no step in between where the author can back out.
The contract is the settlement layer. The judgement stays human — a chain can't grade a patch, and this one
doesn't pretend to.

---

### How a bounty flows

```
postBounty(taskUri, taskHash, lang, window)   payable, [$0.50 .. $2.00]   →  Status.Open, escrow locked
        the task body rides inline as compact JSON in taskUri; taskHash = keccak256(it) so it can't be edited later

submitFix(id, fixUri, fixHash, note)          anyone but the author, one per address, free*  →  emits FixSubmitted
        fixUri = gist/commit/PR pointer · note ≤ 280 chars · fixHash = keccak256(fixUri + " " + note)
        *free = no protocol fee; you still pay Arc's USDC gas, which is the whole anti-spam story

acceptFix(id, fixIndex)                        AUTHOR ONLY      →  Status.Paid, 100% to that fixer, atomically
        — or, after the deadline —
refundExpired(id)                              AUTHOR ONLY      →  Status.Refunded, 100% back to the author
```

Notes for whoever reads the code:

- **Winner-take-all is the point.** One accepted fix takes the full `b.amount`; everyone else gets nothing.
  That's what makes a $1 bounty worth a stranger's evening instead of splitting into worthless dust.
- **`acceptFix` is the only human money decision** and it's gated to `msg.sender == b.author`. No owner, no
  agent, no third party can move an escrowed wei. The two — and only two — exits are *winner-on-accept* and
  *author-on-refund*.
- **Both payout paths are checks-effects-interactions:** status flips to terminal *before* the transfer, so a
  re-entrant call just hits `NotOpen` and reverts.
- **The contract is never a vault.** `receive()`/`fallback()` revert (`NoLooseFunds`); the only coins it can hold are bounties still `Open`. Nothing accretes; nothing is retained.
- **Bounds are constants, not config:** `MIN_BOUNTY = 5e17`, `MAX_BOUNTY = 2e18`, `MIN_WINDOW = 1 hours`,
  `MAX_WINDOW = 30 days`. No admin can move the band after deploy because there's no admin.

### Why this only adds up on Arc

Trace the fee schedule of one bounty's life: **post, submit, accept, claim-the-payout** — three or four
on-chain events, each one mandatory, around a prize that tops out at two dollars. On a chain where gas is a
separate, fluctuating token you'd have to hold and price-watch, that overhead eats the prize alive: you'd be
spending real money in a second asset just to give away a single dollar in a first one. The unit economics of
"many fixers compete, one wins, cents change hands" simply don't survive that friction.

Arc settles in native USDC via `msg.value` — no ERC-20, no `approve` round-trip — so the escrow, the prize,
and every transaction fee along the path are denominated in the same dollar the bounty is *about*. The amount
posted, the amount paid, the cost of posting and accepting: one unit of account, sub-second finality on accept.
That collapse — fee currency == prize currency == unit of account — is the precondition that lets cent-scale,
race-to-fix bounties exist at all, and it's the same precondition that lets a coding *agent* earn a 90¢ bounty
without the meta-cost dwarfing the reward.

### Agents (what's real, what's a demo)

- `app/api/x402/submit/route.ts` — **a real server route**, genuine HTTP-402 wire format
  (`402` challenge → `X-PAYMENT` → `X-PAYMENT-RESPONSE`). Because submitting carries no protocol fee, the
  honest model is **pay-then-prove**: an agent calls `submitFix` from its own wallet (paying Arc's USDC gas —
  the anti-spam), then presents the tx hash; the route fetches the receipt, confirms `to == CONTRACT_ADDRESS`,
  parses the `FixSubmitted` event, recomputes the `keccak256`, and replays-bounds it with a 600s freshness
  window. No facilitator, no trusted relayer — it verifies against the chain itself.
- `agent/triage.mjs` — **a real autonomous watcher**, read-only, **zero money authority**. Polls open bounties
  every 12s, fetches each fix pointer to check it's reachable, recomputes the on-chain hash to catch a patch
  swapped after submission, flags duplicate hashes (copy-and-resubmit), and ranks the clean candidates
  earliest-first so the author has an advisory. It cannot accept anything — only `b.author` can.
- `agent/submit-demo.mjs`, `agent/demo.mjs` — **demos.** The first drives the x402 loop end-to-end from a
  funded fixer wallet; the second seeds a full post→compete→accept→payout cycle so you can watch it live.

### Known limitations (filed, not hidden)

- The chain guarantees the **money**, not the **merit**. No oracle decides whether a patch is correct; the
  funding author does, the way code review actually works.
- The deadline bounds how long a fixer waits, not whether they get paid. An author can `refundExpired` instead
  of accepting. Stated up front so nobody's surprised.
- Plagiarism is fought off-chain: content hash + first-submit timestamp + the triage agent. The contract
  doesn't adjudicate originality.

---

## Changelog

### [deployed] — Arc testnet
- `CodeBounty.sol` (Solidity 0.8.35, MIT) live at `0xA773A6f6a0C2C7b627a2F19Ed5725cc2CD895E86`.
- Escrow band `[$0.50, $2.00]` and window `[1h, 30d]` baked in as immutable constants.

### [added]
- `postBounty` / `submitFix` / `acceptFix` / `refundExpired` — the full winner-take-all loop.
- Inline task payload: the bug/TODO body is stored as compact JSON in `taskUri`, committed by `taskHash`.
- Per-fix tamper-evidence: `fixHash = keccak256(fixUri + " " + note)`, re-checked by the triage agent and the
  x402 route.
- `latest(n)`, `getBounty`, `getFixes`, plus running tallies (`openCount`, `paidVolume`, `paidCount`,
  `refundedCount`, `totalFixes`, `fixerCount`) — cosmetic, never gating money.
- Real x402 submit route with on-chain self-verification.
- Autonomous read-only triage agent.

### [guarded]
- `acceptFix` / `refundExpired` are CEI with terminal-status guards; re-entry reverts `NotOpen`.
- `receive`/`fallback` revert `NoLooseFunds` — contract balance == Σ open escrows, always.
- One submission per address per bounty (`hasSubmitted`); author can't fix their own (`AuthorCannotFix`).

### [run]
```bash
npm install
npm run dev                 # http://localhost:3000

node agent/triage.mjs       # autonomous read-only triage (polls every 12s)
node agent/demo.mjs         # seed a live post -> compete -> accept -> payout (needs a funded wallet)
```

---

## Environment

```
chain        Arc testnet · eip155:5042002
settlement   native USDC, 18 decimals, via msg.value (no ERC-20, no approvals)
contract     CodeBounty.sol  ·  0xA773A6f6a0C2C7b627a2F19Ed5725cc2CD895E86
explorer     https://testnet.arcscan.app/address/0xA773A6f6a0C2C7b627a2F19Ed5725cc2CD895E86
front end    Next.js · ethers v6
reported-by  Daniel Genchev (@GenchevDan)
```

If you can reproduce the original bug — an open issue with no money behind it going stale — escrow a dollar
on it and assign the fix to whoever closes it first. That's the patch.
