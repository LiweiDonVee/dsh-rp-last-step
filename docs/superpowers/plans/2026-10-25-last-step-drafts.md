# Last Step Drafts Implementation Plan

> Execute inline with `superpowers:executing-plans`; no delegated agents. Design authority remains Astra's frozen contracts.

**Goal:** Add fact-receipt presentation, effective narrative revisions, expression-only drafts and legitimate native adoption.

**Architecture:** Keep existing receipts and writer assembly. Add focused narrative projection, draft persistence and owner-command adoption modules. Adoption changes only effective result content within a real native turn and preserves the host's blocked reason.

**Tech Stack:** Node 24 ESM, React 18, native DSH 0.2.1-rc.3, Node test, Vitest, existing esbuild packaging.

**Spec:** `E:/WorkSpace/outputs/agent-rp-build-20261025/briefs/last-step-drafts.md` and its three frozen contracts.

## Constraints

- Only this repository; branch `feature/agent-rp-stack-20261025`, BASE `ff7d122`.
- No idle result append, metadata mutation, fake tools, sibling source imports, publishing or nested agents.
- Unadopted drafts stay outside formal history. Frozen drafts invoke writer only.
- Public method and DTO names match contracts-runtime.md and contracts-story-kit.md.

## 1. Effective narrative projection

Files: `src/narratives.mjs`, `tests/narratives.test.mjs`, `tests/fixtures/narrative-events.mjs`.

- [x] Write tests for original canonical result, content replacement, compaction, inactive branch, forged sources and stale/latest/downstream gates.
- [x] Run `node --test tests/narratives.test.mjs`; verify the missing reader fails.
- [x] Implement `readNarratives(sessionId,events)` and internal source/eligibility helpers; read current content and retain root call identity.
- [x] Repeat the focused command and require all cases to pass.

## 2. Terminal receipts and immutable profile content

Files: `agent.mjs`, `host.mjs`, `presenter.mjs`, `receipts.mjs`, `store.mjs`, existing host/agent/store tests.

- [x] Add exclusive factReceiptId tests, exact opening with zero model calls, GM-bound packet refusal, frozen context arguments and outcome callbacks.
- [x] Add builtin identity conflict and content transfer requestId/revision/source/policy tests; run the focused files RED.
- [x] Resolve optional GM presentation, reserve exact opening normally, preserve legacy packet/rewrite, and extend the existing atomic preset store.
- [x] Run the same focused tests GREEN.

## 3. Draft kernel, owner reads and material inspection

Files: `drafts.mjs`, presenter/host/routes/api, `tests/drafts.test.mjs`, host/routes tests.

- [x] Test versioned edits, persisted isolation, authorized material reads, writer-only input and separate draft progress; run RED.
- [x] Implement contracted owner methods and frozen writer path without normal presentation events.
- [x] Run focused GREEN, then `pnpm check` for LS-A checkpoint and report evidence to coordinator.

## 4. Native adoption and retry dispatch

LS-A accepted base: `1f32d8f02980320c4775c5d6f8fb3cd4f252135b`, scoped rereview double PASS. Actual rc.3 scoped monotonic guard probe: `E:/WorkSpace/outputs/agent-rp-build-20261025/probes/last-step-scope/evidence.json`; wrong arguments/facts denied, unrelated Agent unaffected, disposer restores execution. Only the owner maintenance request ID/turn may activate adoption/retry listeners. Retry may make one main dispatch and one writer call; no repeated facts/material/assembly.

Files: `adoption.mjs`, host, `tests/adoption.test.mjs`, native fixture and smoke script.

- [x] Test concurrent/stale/changed-source adoption, downstream fact rejection, scoped-listener disposal, command agentId and real retry workflow; run RED.
- [x] Register owner commands, queue a real followup, replace content in scoped pre-step, reject that model step and return separately confirmed adoption.
- [x] Test focused GREEN. Verify packaged rc.3 native execution, pre/post forks and cold process restart with fixed counters.

## 4b. Branch inheritance and exact plugin-state transfer

Files: `src/transfer.mjs`, preset/receipt/draft stores, host and focused transfer tests.

- [x] Add RED tests for genuine child ancestry, prefix-captured profile/overlay rather than later parent state, existing child preservation and foreign receipt denial.
- [x] Implement `inheritSession` from R4 and authorized canonical Session readers.
- [x] Add RED tests for dependency-limited `exportState`, collision-only preflight without destination Sessions, idempotent exact-ID restore and destination canonical validation before atomic writes.
- [x] Implement `exportState/preflightRestore/restoreState/contentRevision` per contracts-transfer including T1/T2; retain required parent receipts and versioned drafts, not unrelated library data.
- [x] Run focused GREEN; verify source/branch isolation, failed receipts available for audit and restore revision conflict.

## 5. Native panels and delivery

Files: client/API/styles, UI tests, README/usage/architecture, package version/changelog if needed.

- [x] Write UI tests for alternatives/edit/compare/adopt/retry/material and real error handling; run `pnpm test:ui` RED.
- [x] Implement expression-only guidance, stored material inspector and explicit native blocked-maintenance explanation.
- [x] Run focused GREEN, `pnpm check`, `pnpm package`, native smoke and screenshots.
- [x] Review diff and commit with command-level `Codex <codex@local>` identity. Write report with checkpoint, SHA, counts, native scope and remaining integration work.
