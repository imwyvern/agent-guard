---
name: Good first issue
about: Describe a self-contained starter task with clear acceptance criteria.
title: ""
labels: ["good first issue"]
---

Use this template when filing a starter task. Claim an existing `good first issue` by commenting on it rather than opening a duplicate. For security vulnerabilities, use [private vulnerability reporting](https://github.com/imwyvern/agent-guard/security/advisories/new). See the [community guide](https://github.com/imwyvern/agent-guard/blob/main/docs/community.md).

Remove secrets, personal data, and real credentials from all examples.

## Task

What should the contributor implement or document?

## Why this is a good first issue

Why is the work self-contained? Which files or examples should they start from?

## Acceptance criteria

- [ ] Behavior matches the charter: detect and alert only unless a documented, off-by-default option is involved.
- [ ] Canaries stay inert; decoys return only fake data and stay `noindex` / `no-store`.
- [ ] Verified crawlers never enter decoys.
- [ ] No new runtime dependencies. Framework packages, if any, are optional peers.
- [ ] `npm run build`, `npm run typecheck`, `npm run lint`, and `npm test` pass.
- [ ] README, all five translations in `docs/i18n/`, and CHANGELOG are updated when the public surface changes.

Add any task-specific checks below.

## Relevant docs

Link the roadmap item, community guide section, or design note that defines the work.

## Suggested tests

How can this be verified locally?
