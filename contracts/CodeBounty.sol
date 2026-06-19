// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/*  CodeBounty — winner-take-all micro-bounties for code fixes, settled in native USDC on ARC.

    The personal itch: it's often cheaper to pay $1 for a five-minute fix than to burn an
    evening on a TODO. So an author posts a small task (a bug or TODO, with a pointer to the
    snippet/repo+file and a content hash) and ESCROWS a $0.50–2 USDC bounty in this contract.
    Many fixers then compete PR-style: each submits a POINTER to their fix (a gist/patch/commit
    URL + a short note + a keccak256 hash of the fix body). The author — the human who funded
    it, no one else — ACCEPTS exactly ONE submission. That fixer is paid the WHOLE bounty,
    instantly; everyone else gets nothing. Winner-take-all. If no fix is accepted before the
    deadline, the author reclaims 100%.

    Money moves on a human decision, never on faith and never by an agent:
      - the bounty is provably funded the moment it's posted, so a fixer knows the money is
        real BEFORE spending effort, and the author cannot stiff a winner after accepting;
      - no owner, no admin, no protocol fee, no treasury, no third destination — the only two
        exits for any escrowed wei are (winner on accept) or (author on expiry refund);
      - the contract is never a vault: its balance == sum of the bounties still Open;
      - a review/triage agent may read events and rank/flag submissions off-chain, but it has
        ZERO money authority here — only the author's own key can call acceptFix.

    On-chain native USDC (18 decimals, paid via msg.value — NO ERC-20, NO approvals) is what
    makes cent-scale, winner-take-all bounties pencil out: the fee and the prize are the same
    asset, finality is sub-second. The chain proves who funded what, the immutable task hash,
    every competing fix pointer+hash, which one was accepted, and that the prize went to that
    fixer and nobody else — or came back to the author.
*/

contract CodeBounty {
    // ── bounty bounds (native USDC wei; USDC has 18 decimals on ARC) ──────────
    // The brief's $0.50–2 band, enforced on-chain so a posted bounty is always a real
    // micro-bounty. Immutable: no admin can ever move the band after deploy.
    uint256 public constant MIN_BOUNTY = 5e17;  // $0.50
    uint256 public constant MAX_BOUNTY = 2e18;  // $2.00

    // Deadline bounds: the author picks a window; it must be sane and bounded.
    uint64 public constant MIN_WINDOW = 1 hours;
    uint64 public constant MAX_WINDOW = 30 days;

    enum Status { Open, Paid, Refunded }

    struct Bounty {
        address author;     // who posted AND funded it — the ONLY key that can accept or refund
        uint96  amount;     // USDC escrowed (snapshotted at post; within [MIN,MAX])
        uint64  postedAt;   // block timestamp at post
        uint64  deadline;   // after this, if still Open, author may reclaim 100%
        Status  status;     // Open → Paid (author accepts) | Refunded (author, after deadline)
        uint32  fixCount;   // number of competing fixes submitted
        uint32  acceptedFix;// 1-based index into fixes[id] of the winner (0 while Open)
        string  taskUri;    // pointer to the bug/TODO (repo+file / gist / snippet URL)
        bytes32 taskHash;   // keccak256 of the task body — tamper-evidence for what was asked
        string  lang;       // language tag, e.g. "Solidity" (cosmetic, for the feed)
    }

    struct Fix {
        address fixer;      // who submitted this candidate fix
        uint64  submittedAt;// block timestamp at submit
        string  fixUri;     // pointer to the fix (gist/patch/commit URL)
        bytes32 fixHash;    // keccak256 of the fix body — tamper-evidence for the delivered fix
        string  note;       // short fixer note (≤ 280 chars)
    }

    uint256 public bountyCount;
    mapping(uint256 => Bounty) private bounties;
    // fixes[bountyId] is conceptually 1-based: array index i holds the (i+1)-th fix.
    mapping(uint256 => Fix[]) private fixes;

    // one fix per fixer per bounty: blocks spam-flooding and keeps the contest legible
    mapping(uint256 => mapping(address => bool)) public hasSubmitted;

    mapping(address => uint256[]) private _byAuthor;
    mapping(address => uint256[]) private _byFixer; // bounty ids a fixer has submitted to

    // running tallies (cosmetic; never gate money)
    uint256 public openCount;      // bounties currently Open
    uint256 public paidVolume;     // total USDC paid out to winners
    uint256 public paidCount;      // bounties resolved by an accept
    uint256 public refundedCount;  // bounties reclaimed after expiry
    uint256 public totalFixes;     // total fix submissions across all bounties
    uint256 public fixerCount;     // unique addresses that have ever submitted a fix
    mapping(address => bool) public everFixed;

    // ── events ───────────────────────────────────────────────────────────────
    event BountyPosted(uint256 indexed id, address indexed author, uint256 amount, uint64 deadline, string taskUri, bytes32 taskHash, string lang);
    event FixSubmitted(uint256 indexed id, uint32 indexed fixIndex, address indexed fixer, string fixUri, bytes32 fixHash, string note);
    event FixAccepted(uint256 indexed id, uint32 indexed fixIndex, address indexed winner, uint256 amount);
    event BountyRefunded(uint256 indexed id, address indexed author, uint256 amount);

    // ── errors ───────────────────────────────────────────────────────────────
    error BadAmount();
    error BadWindow();
    error BadUri();
    error NotAuthor();
    error AuthorCannotFix();
    error AlreadyFixed();
    error NotOpen();
    error NoSuchBounty();
    error NoSuchFix();
    error PastDeadline();
    error BeforeDeadline();
    error BadNote();
    error TransferFailed();
    error NoLooseFunds();

    // ── post a bounty (anyone: a person, or an agent paying over x402) ───────
    // Escrows EXACTLY msg.value, which must sit in [MIN_BOUNTY, MAX_BOUNTY]. No external call
    // on this path → no reentrancy surface. The funds are now provably locked to this bounty
    // until the author accepts a fix or reclaims after the deadline.
    function postBounty(string calldata taskUri, bytes32 taskHash, string calldata lang, uint64 window)
        external
        payable
        returns (uint256 id)
    {
        if (msg.value < MIN_BOUNTY || msg.value > MAX_BOUNTY) revert BadAmount();
        if (window < MIN_WINDOW || window > MAX_WINDOW) revert BadWindow();
        uint256 ulen = bytes(taskUri).length;
        if (ulen == 0 || ulen > 2000) revert BadUri(); // holds a compact inline task JSON
        if (bytes(lang).length > 40) revert BadUri();

        id = ++bountyCount;
        Bounty storage b = bounties[id];
        b.author   = msg.sender;
        b.amount   = uint96(msg.value);
        b.postedAt = uint64(block.timestamp);
        b.deadline = uint64(block.timestamp) + window;
        b.status   = Status.Open;
        b.taskUri  = taskUri;
        b.taskHash = taskHash;
        b.lang     = lang;

        _byAuthor[msg.sender].push(id);
        openCount += 1;

        emit BountyPosted(id, msg.sender, msg.value, b.deadline, taskUri, taskHash, lang);
    }

    // ── submit a fix (anyone except the author) ──────────────────────────────
    // PR-style: a pointer + hash + short note. One submission per address per bounty. Costs
    // only USDC gas — submitting is free; you only win if the author accepts you. No money
    // moves here, so there is no reentrancy surface.
    function submitFix(uint256 id, string calldata fixUri, bytes32 fixHash, string calldata note)
        external
        returns (uint32 fixIndex)
    {
        Bounty storage b = bounties[id];
        if (b.author == address(0)) revert NoSuchBounty();
        if (b.status != Status.Open) revert NotOpen();
        if (block.timestamp > b.deadline) revert PastDeadline();
        if (msg.sender == b.author) revert AuthorCannotFix();
        if (hasSubmitted[id][msg.sender]) revert AlreadyFixed();
        uint256 flen = bytes(fixUri).length;
        if (flen == 0 || flen > 400) revert BadUri();
        if (bytes(note).length > 280) revert BadNote();

        hasSubmitted[id][msg.sender] = true;
        fixes[id].push(Fix({ fixer: msg.sender, submittedAt: uint64(block.timestamp), fixUri: fixUri, fixHash: fixHash, note: note }));
        fixIndex = uint32(fixes[id].length); // 1-based
        b.fixCount = fixIndex;
        _byFixer[msg.sender].push(id);
        totalFixes += 1;
        if (!everFixed[msg.sender]) { everFixed[msg.sender] = true; fixerCount += 1; }

        emit FixSubmitted(id, fixIndex, msg.sender, fixUri, fixHash, note);
    }

    // ── accept exactly one fix → pay that fixer the whole bounty (AUTHOR ONLY) ─
    // The single human money decision, allowed any time while the bounty is Open (even past the
    // deadline — the author can still reward good work; "until a decision is made"). Winner-take-
    // all: 100% to the accepted fixer, 0 to everyone else, nothing retained. CEI — status is
    // finalized BEFORE the transfer, and the terminal-status guard makes any re-entry revert.
    function acceptFix(uint256 id, uint32 fixIndex) external {
        Bounty storage b = bounties[id];
        if (b.author == address(0)) revert NoSuchBounty();
        if (msg.sender != b.author) revert NotAuthor();      // agent has NO authority here
        if (b.status != Status.Open) revert NotOpen();
        if (fixIndex == 0 || fixIndex > fixes[id].length) revert NoSuchFix();

        address winner = fixes[id][fixIndex - 1].fixer;
        uint256 amt = b.amount;

        // ── effects ──
        b.status = Status.Paid;
        b.acceptedFix = fixIndex;
        openCount -= 1;
        paidCount += 1;
        paidVolume += amt;

        // ── interaction — the full bounty lands with the winner instantly ──
        (bool ok, ) = payable(winner).call{value: amt}("");
        if (!ok) revert TransferFailed();

        emit FixAccepted(id, fixIndex, winner, amt);
    }

    // ── reclaim the bounty if nothing was accepted by the deadline (AUTHOR ONLY) ─
    // Always solvent: an Open bounty still holds exactly b.amount, so the refund clears.
    function refundExpired(uint256 id) external {
        Bounty storage b = bounties[id];
        if (b.author == address(0)) revert NoSuchBounty();
        if (msg.sender != b.author) revert NotAuthor();
        if (b.status != Status.Open) revert NotOpen();
        if (block.timestamp <= b.deadline) revert BeforeDeadline();

        uint256 amt = b.amount;

        // ── effects ──
        b.status = Status.Refunded;
        openCount -= 1;
        refundedCount += 1;

        // ── interaction ──
        (bool ok, ) = payable(b.author).call{value: amt}("");
        if (!ok) revert TransferFailed();

        emit BountyRefunded(id, b.author, amt);
    }

    // ── views ────────────────────────────────────────────────────────────────
    function getBounty(uint256 id)
        external
        view
        returns (
            address author,
            uint96  amount,
            uint64  postedAt,
            uint64  deadline,
            uint8   status,
            uint32  fixCount,
            uint32  acceptedFix,
            string memory taskUri,
            bytes32 taskHash,
            string memory lang
        )
    {
        Bounty storage b = bounties[id];
        return (b.author, b.amount, b.postedAt, b.deadline, uint8(b.status), b.fixCount, b.acceptedFix, b.taskUri, b.taskHash, b.lang);
    }

    function getFix(uint256 id, uint32 fixIndex)
        external
        view
        returns (address fixer, uint64 submittedAt, string memory fixUri, bytes32 fixHash, string memory note)
    {
        if (fixIndex == 0 || fixIndex > fixes[id].length) revert NoSuchFix();
        Fix storage f = fixes[id][fixIndex - 1];
        return (f.fixer, f.submittedAt, f.fixUri, f.fixHash, f.note);
    }

    /// @notice All competing fixes for a bounty in submission order (1-based on display).
    function getFixes(uint256 id) external view returns (Fix[] memory) {
        return fixes[id];
    }

    function fixCountOf(uint256 id) external view returns (uint256) {
        return fixes[id].length;
    }

    function bountiesByAuthor(address a) external view returns (uint256[] memory) {
        return _byAuthor[a];
    }

    function bountiesByFixer(address a) external view returns (uint256[] memory) {
        return _byFixer[a];
    }

    /// @notice Ids of the latest `n` bounties (newest first). The app filters by status.
    function latest(uint256 n) external view returns (uint256[] memory out) {
        uint256 count = bountyCount;
        if (n > count) n = count;
        out = new uint256[](n);
        for (uint256 i = 0; i < n; i++) out[i] = count - i;
    }

    /// @notice Escrow currently held for a bounty (b.amount while Open, else 0).
    function escrowOf(uint256 id) external view returns (uint256) {
        Bounty storage b = bounties[id];
        return b.status == Status.Open ? b.amount : 0;
    }

    /// @notice True once past the deadline and still Open (author may reclaim).
    function isRefundable(uint256 id) external view returns (bool) {
        Bounty storage b = bounties[id];
        return b.status == Status.Open && block.timestamp > b.deadline;
    }

    // ── no loose money: refuse any plain transfer so balance stays accountable ─
    receive() external payable { revert NoLooseFunds(); }
    fallback() external payable { revert NoLooseFunds(); }
}
