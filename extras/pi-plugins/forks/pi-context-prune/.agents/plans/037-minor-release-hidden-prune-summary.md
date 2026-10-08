---
name: 037-minor-release-hidden-prune-summary
description: Commit the hidden prune summary change, perform a minor release, and push main plus the new tag.
steps:
  - phase: discovery
    steps:
      - "- [x] step 1: verify release prerequisites and inspect the release workflow/script"
      - "- [x] step 2: confirm the current version and pending repo changes"
  - phase: implementation
    steps:
      - "- [x] step 1: commit the hidden-summary change on main"
      - "- [x] step 2: run the repository release script for a minor bump"
  - phase: validation
    steps:
      - "- [x] step 1: confirm the new version/tag and that main plus tag were pushed"
      - "- [x] step 2: update the plan checklist to reflect the completed release"
---

# 037-minor-release-hidden-prune-summary

## Phase 1 — Discovery
- [x] step 1: verify release prerequisites and inspect the release workflow/script
- [x] step 2: confirm the current version and pending repo changes

## Phase 2 — Implementation
- [x] step 1: commit the hidden-summary change on main
- [x] step 2: run the repository release script for a minor bump

## Phase 3 — Validation
- [x] step 1: confirm the new version/tag and that main plus tag were pushed
- [x] step 2: update the plan checklist to reflect the completed release
