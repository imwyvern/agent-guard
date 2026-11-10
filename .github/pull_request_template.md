## Change

Describe the problem, resulting behavior, and any relevant issue.

## Validation

List the checks run and their results.

- [ ] Relevant tests pass (`npm test`); behavior changes have appropriate coverage.
- [ ] Build and lint pass (`npm run build` and `npm run lint`).
- [ ] Documentation and CHANGELOG are updated where relevant.

## Charter checks

- [ ] Canaries remain inert and cannot authenticate to any real system.
- [ ] Decoys remain isolated, return only fake data, and use `noindex`.
- [ ] Verified crawlers and verified agents never enter decoys.
- [ ] The default remains detect + alert only; any blocking or budget trap is opt-in and disabled by default.
- [ ] No code is copied from other projects, including GPL projects; contributions are original and compatible with Apache-2.0.
- [ ] No third-party attack, probe, retaliation, or exploit behavior is introduced; no production reverse prompt injection or whole-site tarpit is added.
