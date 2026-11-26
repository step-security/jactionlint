[![StepSecurity Maintained Action](https://raw.githubusercontent.com/step-security/maintained-actions-assets/main/assets/maintained-action-banner.png)](https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions)

# Review and port upstream features

The updater tracks sparse, pinned reference snapshots. Use every upstream's patterns, scans, and tests to find behavior
jactionlint should cover. A pin identifies the source snapshot; it does not promise API compatibility or runtime
interoperability. Review upstream diffs and tests before accepting a pin or claiming that jactionlint covers a behavior.

## Review a candidate

1. For one source, run `mise exec node@lts -- node ./scripts/upstream/main.mjs <source> setup`, then
   `mise exec node@lts -- node ./scripts/upstream/main.mjs <source> update`. This materializes only that source's sparse
   checkout. Use `mise run upstream:setup` when you explicitly need all four references. Review each report's candidate
   tag, SHA, changed paths, verification status and skipped coverage. Read the upstream repository for context outside the
   sparse checkout.
2. For Actionlint, use `detection_audit` to inspect changed detection source, tests and pattern fixtures. Check
   `unmatched_detection_symbols` for likely missing detections and review `likely_local_rules` for changed behavior in
   existing rules. These are source-based leads. The historical diagnostics test checks existing behavior only; it does not
   verify candidate changes or claim coverage.
3. For Zizmor, compare changed audit scans, patterns, tests, and audit IDs with `scripts/zizmor-diff/mapping.json`. Review
   findings, personas, confidence, fixes, exclusions and relevant tests. Add a mapping entry when jactionlint covers the
   behavior, and update `docs/zizmor-parity.md` with measured coverage or a clear reason to defer it.
4. For ShellCheck and Pyflakes, inspect changed scans, patterns, messages and tests. Use local integration code and fixtures as
   evidence of current coverage, then identify applicable behavior jactionlint should add or intentionally defer. The goal is
   to cover useful detection behavior, not to mirror upstream APIs or guarantee runtime interoperability.
5. Classify each behavior change as covered, a feature to consider, an intentional difference or out of scope. Record the
   source and test that establish its behavior; do not infer behavior from filenames or release notes.

`feature_review_leads` links likely upstream symbols to local detections where a useful mapping exists, lists local review
files for the ShellCheck and Pyflakes integrations, and flags relevant files with no detected symbols. These leads do not
prove coverage: inspect upstream diffs and tests. `passed: true` means only that configured checks passed.
`mise run upstream:test` enforces the manager's coverage thresholds.

## Implement a feature

Before coding, check CONTRIBUTING.md's acceptance and false-positive requirements. Reuse a rule ID for the same check; add a
rule only for a distinct workflow property. Keep intentional differences when jactionlint has better context, safer fixes,
fewer false positives or a different scope.

For a security-sensitive or broad feature, ask a strong-reasoning model to review the implementation, threat model, false
positives and test plan. Then use a lower-cost model for a bounded implementation. A maintainer decides the rule ID, profile,
severity and fix safety. Review model-written code and test it like any contribution.

An implementation PR should include:

- the upstream project, accepted release or candidate SHA, source path and upstream test that demonstrate the behavior;
- the user-visible behavior and its rule ID, profile, severity, configuration and fix policy;
- positive, negative and boundary fixtures, including cases that distinguish safe from unsafe behavior;
- corpus results and manual false-positive review for real repositories; say what was not measured;
- updates to `docs/checks.md`, generated `docs/rules.md`, and `docs/zizmor-parity.md` and its mapping where relevant;
- focused tests, `mise run test`, and any generation or lint checks required by the touched files.

When asked to implement a feature, finish the work and prepare a PR unless the request is for a plan or local patch. Lead with the user benefit; put source details, tests and limitations in short `<details>` sections. Link the upstream issue or PR when available. Claim support only when tests demonstrate it.

Do not combine accepting a new upstream SHA with a claim that the corresponding feature has been implemented. Keep source-pin
maintenance and behavior-porting reviewable, even when they are proposed in the same PR.

## Claude Code, Codex and OpenCode

Claude Code, Codex and OpenCode should read this guide and `AGENTS.md`; Claude Code should also read `CLAUDE.md`. Model names
change, so choose by reasoning ability and cost instead of pinning a model name. If an agent cannot select separate models, use
separate review and implementation prompts.

Ask for a plan before broad or security-sensitive work. Keep each change to one behavior, check rule overlap and intentional
differences, and update tests and docs. Reviewers should challenge threat assumptions and boundary cases.
