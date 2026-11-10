# Security policy

## Supported versions

During the 0.x research phase, security fixes target the latest code on `main` only. Older 0.x snapshots and tags do not receive separate backports. Update to the latest `main` when validating a fix.

## Report a vulnerability

Please report suspected vulnerabilities privately through GitHub Security Advisories: [Report a vulnerability](https://github.com/imwyvern/agent-guard/security/advisories/new). Do not disclose exploit details in public issues or pull requests before coordination.

Include the affected commit/version, Node.js version and adapter, a minimal reproduction, expected impact, and any suggested fix. Use inert sample data and redact real secrets and personal information.

We aim to acknowledge reports within **3 business days**, provide an initial assessment within **7 business days**, and send progress updates at least every **14 days** while a report is open. These are best-effort targets for a volunteer research project, not service guarantees. Fix and disclosure timing depends on severity and complexity; we will coordinate with the reporter and credit them with their consent.

## Scope

In scope:

- Middleware bypasses that defeat documented detection or isolation guarantees, including verified-crawler bypass failures.
- Regular expression denial of service (ReDoS) and other unbounded resource use caused by untrusted input.
- Header injection and unsafe handling of request data in logs, alerts, or responses.
- Canary forgery or failures of canary authenticity checks.
- Alert signature generation or verification issues, including failures of documented integrity or replay protections.

The inert decoys returning fake data or fake credentials are intentional and are out of scope by themselves. A decoy exposing real data, authenticating to a real service, or violating its isolation guarantees is in scope. agent-guard is not a WAF, authentication system, or guarantee that all scanning will be detected.

## Safe harbor

We welcome good-faith research consistent with this policy and will not pursue legal action for authorized testing of this project's code on systems you own or have explicit permission to test. Minimize disruption and data access, stop if real sensitive data appears, and report it privately. This assurance covers only rights controlled by the maintainers; it does not authorize testing third-party systems or bind their owners. There is no paid bounty program.
