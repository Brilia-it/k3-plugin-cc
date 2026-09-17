# Security policy

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/linxule/kimi-plugin-cc/security/advisories/new) to report a security issue. Do not disclose vulnerabilities in public issues.

Include the plugin version, CLI version, affected operation, and a minimal reproduction. Use sanitized setup output. Do not include API keys, OAuth files, or raw Kimi configuration.

## Review security changes

The safety boundary spans these components:

- `runtime/hooks/` verifies the installed hook, controls config writes, and checks tool calls
- `runtime/rescue-approval.ts` checks write paths, shell arguments, and the trusted workspace root
- `runtime/kimi-engine.ts` selects certified versions and records engine provenance
- `runtime/native-v2-preflight.ts` blocks plan mode, unsafe experimental features, and unsafe resume state
- `runtime/cli-client.ts` checks the spawned engine and tears down subprocesses

Read the [safety guide](./docs/safety.md) and [runtime contracts](./docs/invariants.md) before changing these components. The hook controls tool use; it is not an operating-system sandbox.
