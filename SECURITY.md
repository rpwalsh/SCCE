# Security Policy

## Supported versions

SCCE v3 is a pre-release source tree. Security fixes are made on the default branch;
there is no separately supported stable release line yet.

## Reporting a vulnerability

Use this repository's GitHub private vulnerability-reporting form under the
**Security** tab. Do not disclose an unpatched vulnerability, credentials, private
corpus material, or machine-specific paths in a public issue.

Include the affected commit, impact, reproduction steps, and any proposed mitigation.
There is currently no bug-bounty program or guaranteed response-time SLA.

The checked-in server configuration is loopback-only. Treat any non-loopback bind,
reverse proxy, tunnel, or execution against an untrusted repository as a separate
security deployment that requires its own authentication and isolation review.

Patch validation defaults to trusted-host execution and therefore carries the server
process's host authority. The optional Docker provider is server-selected,
digest-pinned, resource-bounded, and networkless during source validation, but the
Docker daemon, operator configuration, image supply chain, and host kernel remain in
the deployment trust base. A local passing smoke test is not an attestation or an
independent security review.
