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

- [ ] Write tests for original canonical result, content replacement, compaction, inactive branch, forged sources and stale/latest/downstream gates.
- [ ] Run `node --test tests/narratives.test.mjs`; verify the missing reader fails.
- [ ] Implement `readNarratives(sessionId,events)` and internal source/eligibility helpers; read current content and retain root call identity.
- [ ] Repeat the focused command and require all cases to pass.

## 2. Terminal receipts and immutable profile content

Files: `agent.mjs`, `host.mjs`, `presenter.mjs`, `receipts.mjs`, `store.mjs`, existing host/agent/store tests.

- [ ] Add exclusive factReceiptId tests, exact opening with zero model calls, GM-bound packet refusal, frozen context arguments and outcome callbacks.
- [ ] Add builtin identity conflict and content transfer requestId/revision/source/policy tests; run the focused files RED.
- [ ] Resolve optional GM presentation, reserve exact opening normally, preserve legacy packet/rewrite, and extend the existing atomic preset store.
- [ ] Run the same focused tests GREEN.

## 3. Draft kernel, owner reads and material inspection

Files: `drafts.mjs`, presenter/host/routes/api, `tests/drafts.test.mjs`, host/routes tests.

- [ ] Test versioned edits, persisted isolation, authorized material reads, writer-only input and separate draft progress; run RED.
- [ ] Implement contracted owner methods and frozen writer path without normal presentation events.
- [ ] Run focused GREEN, then `pnpm check` for LS-A checkpoint and report evidence to coordinator.

## 4. Native adoption and retry dispatch

Files: `adoption.mjs`, host, `tests/adoption.test.mjs`, native fixture and smoke script.

- [ ] Test concurrent/stale/changed-source adoption, downstream fact rejection, scoped-listener disposal, command agentId and real retry workflow; run RED.
- [ ] Register owner commands, queue a real followup, replace content in scoped pre-step, reject that model step and return separately confirmed adoption.
- [ ] Test focused GREEN. Verify packaged rc.3 native execution, pre/post forks and cold process restart with fixed counters.

## 5. Native panels and delivery

Files: client/API/styles, UI tests, README/usage/architecture, package version/changelog if needed.

- [ ] Write UI tests for alternatives/edit/compare/adopt/retry/material and real error handling; run `pnpm test:ui` RED.
- [ ] Implement expression-only guidance, stored material inspector and explicit native blocked-maintenance explanation.
- [ ] Run focused GREEN, `pnpm check`, `pnpm package`, native smoke and screenshots.
- [ ] Review diff and commit with command-level `Codex <codex@local>` identity. Write report with checkpoint, SHA, counts, native scope and remaining integration work.
