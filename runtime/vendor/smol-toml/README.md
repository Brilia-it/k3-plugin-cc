# Vendored TOML parser

This directory contains the parser subset of `smol-toml@1.6.1`, under the
included BSD-3-Clause license. The plugin uses its internal `parseKey`,
`extractValue`, and `skipVoid` interfaces when preserving existing config text.
Newer upstream releases changed those internal interfaces, so replacing this
copy requires a separate integration review.

Security patch: `util.js` includes the EOF-comment guard from upstream commit
[30f5c36](https://github.com/squirrelchat/smol-toml/commit/30f5c36), released in
1.7.1 for [GHSA-7w5x-hrqm-74c2](https://github.com/advisories/GHSA-7w5x-hrqm-74c2).
When an unfinished array or inline table ends with a comment without a newline,
`skipUntil` now throws instead of resetting its cursor and looping forever.
This is the only local change to the vendored JavaScript.

The development dependency uses patched upstream 1.9.1 for round-trip tests;
it does not supply the shipped parser. `bun audit` scans that dependency but
cannot discover issues in this source copy. Review future parser advisories
against both. `tests/runtime/toml-eof-comment.test.ts` checks prompt rejection
in this copy and both shipped mirrors, in a child process with a hard timeout.

Known advisory, not ported: [GHSA-r4xh-jqrq-34v2](https://github.com/advisories/GHSA-r4xh-jqrq-34v2)
(quadratic-time `parse()` from `parseKey` rescanning to the end of the document on
each key line, affects <= 1.8.0, fixed in 1.9.x). This vendored 1.6.1 subset is
inside the affected range. The upstream fix is not a contained change: 1.9.1 rewrote
`parseKey` as a state machine over a new `ctx` object (`{ s, p }`), which changes
the internal interface this plugin relies on (`parseKey`, `extractValue`,
`skipVoid`), so it was NOT ported here. Impact is limited: the runtime parses only
the user's own `~/.kimi-code/config.toml`, a local file the user controls, so the
worst case is slow parsing of a pathologically large config. Re-vendoring against
the new interfaces is tracked as a follow-up.
