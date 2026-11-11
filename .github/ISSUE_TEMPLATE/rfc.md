---
name: RFC
about: Propose a change to core behavior or a safety line.
title: "[RFC] "
labels: ["design"]
---

For security vulnerabilities, use [private vulnerability reporting](https://github.com/imwyvern/agent-guard/security/advisories/new) instead of a public issue. See [SECURITY.md](https://github.com/imwyvern/agent-guard/blob/main/SECURITY.md). Review the [roadmap and charter](https://github.com/imwyvern/agent-guard/blob/main/docs/roadmap.md) and the [community guide](https://github.com/imwyvern/agent-guard/blob/main/docs/community.md) before opening an RFC.

Do not start implementation until a maintainer accepts this RFC. Ordinary bug fixes, documentation, tests, and adapters that preserve the existing contract do not need an RFC.

## Summary

What should change, in one or two sentences?

## Motivation

Who needs this, and what problem does it solve?

## Proposed change

Describe the new behavior. Call out any change to `mode`, decoy isolation, canary inertness, crawler bypass, alerting, or outbound network use.

## Safety lines

Explain how the proposal preserves, or deliberately amends, each of the following:

- Canaries remain inert and cannot authenticate to any real system.
- No outbound probing, third-party callbacks, retaliation, or attacks.
- No reverse prompt injection in production; lure and decoy text stays data, not instructions.
- No real credentials, user data, or business records.
- Verified crawlers never enter decoys; crawler verification remains fail-open.
- Default remains detect + alert only; any delay, maze, or trap is opt-in and off by default.

## Alternatives considered

## Validation

How will the change be verified locally (tests, demos, or simulations)?

## Docs and rollout

Which documents (README and translations, CHANGELOG, design docs) would need to be updated? Is the change off by default?
