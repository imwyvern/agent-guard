# Contributing

agent-guard is an open-source research project. Discuss substantial changes in an issue before implementation, and review the [roadmap](docs/roadmap.md), its [charter and non-goals](docs/roadmap.md#6-明确不做non-goals延续-charter), and the [design](docs/design.md). Report vulnerabilities through the [security policy](SECURITY.md).

## Development setup

Use Node.js **20 or newer** and npm. CI checks Node.js 20 and 22.

```sh
git clone https://github.com/imwyvern/agent-guard.git
cd agent-guard
npm ci
npm run build
npm run lint
npm test
```

Add focused tests for behavior changes and update relevant documentation and `CHANGELOG.md`. Translations live in `docs/i18n/` and should be updated when `README.md` changes. Keep changes small enough to review. Benchmarks and Lighthouse are separate local research tools and are not part of the regular CI checks.

Open a pull request describing the problem, the resulting behavior, and the validation performed. Use concise imperative commit subjects in the existing `type: description` style, for example `fix: reject forged canary checksums`, `test: cover crawler bypass`, or `docs: clarify setup`.

## Project charter and non-goals

- Default to **detect + alert only**. Preserve real application route behavior. Any future blocking or budget trap must be explicitly opt-in and disabled by default.
- Keep canaries **inert**: they never authenticate and never enter real identity providers, user databases, secret stores, cloud key lists, or CI secrets. Use `.invalid` hosts for fake service addresses; never use third-party callback honeytokens.
- Keep decoys isolated from business code, databases, and external services. Return only fake data; use `noindex`, `no-store`, robots exclusions, and no sitemap entries.
- Verified crawlers and verified agents must never enter decoys. Preserve the documented fail-open crawler behavior and normal missing-route response.
- Do not add production reverse prompt injection, whole-site tarpits, or unbounded mazes. Never probe, attack, retaliate against, or exploit third-party systems, or connect back to a requester.
- This middleware does not replace a WAF, DDoS defense, authentication system, or bot blocker. Research validation uses local demos; production deployment is outside this repository's scope.
- Preserve the small dependency surface and bounded request processing. Keep sensitive request bodies and Cookie/Authorization values out of logs and alerts.

## Original work and licensing

The project is licensed under [Apache-2.0](LICENSE). By contributing, you agree to license your contributions under the same terms and confirm you have the right to submit them. A DCO sign-off (`git commit -s`) is welcome but optional.

Write original code. Do not copy, vendor, or fork code from other projects, including GPL projects such as Beelzebub. Prior art may inform concepts; cite it when useful and implement independently. Do not submit code or assets with incompatible licensing or without permission to contribute them.

Follow the [Code of Conduct](CODE_OF_CONDUCT.md) in all project interactions.
