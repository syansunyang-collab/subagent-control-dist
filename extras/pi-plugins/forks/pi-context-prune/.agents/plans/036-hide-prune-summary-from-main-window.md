---
name: 036-hide-prune-summary-from-main-window
description: Keep prune summaries in LLM context and session metadata without rendering them in Pi's main message window.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: confirm where prune summaries are emitted and how display visibility is controlled"
      - "- [x] step 2: identify any docs that describe the current visible-summary behavior"
  - phase: implementation
    steps:
      - "- [x] step 1: change prune summary emission to persist as hidden custom messages while preserving context participation"
      - "- [x] step 2: update docs/comments to match the new hidden-summary behavior"
  - phase: validation
    steps:
      - "- [x] step 1: run a build or equivalent verification command"
      - "- [x] step 2: sync the checklist with the completed work"
---

# 036-hide-prune-summary-from-main-window

## Phase 1 — Discovery
- [x] step 1: confirm where prune summaries are emitted and how display visibility is controlled
- [x] step 2: identify any docs that describe the current visible-summary behavior

## Phase 2 — Implementation
- [x] step 1: change prune summary emission to persist as hidden custom messages while preserving context participation
- [x] step 2: update docs/comments to match the new hidden-summary behavior

## Phase 3 — Validation
- [x] step 1: run a build or equivalent verification command
- [x] step 2: sync the checklist with the completed work
