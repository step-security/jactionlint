[![StepSecurity Maintained Action](https://raw.githubusercontent.com/step-security/maintained-actions-assets/main/assets/maintained-action-banner.png)](https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions)

# step-security/jactionlint

An action that runs [jdx/jactionlint](https://github.com/jdx/jactionlint) — a static checker for GitHub Actions workflows, composite actions and `dependabot.yml`. It downloads a pinned release of jactionlint and reports correctness, security and policy findings as pull request annotations or code scanning alerts.

## Usage

```yaml
name: jactionlint
on:
  push:
    branches: [main]
  pull_request:

permissions: {}

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  jactionlint:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: step-security/jactionlint@v2
```

### Upload findings to code scanning (SARIF)

```yaml
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: step-security/jactionlint@v2
        with:
          advanced-security: "true"
```

## Inputs

| Input | Description | Default |
|---|---|---|
| `version` | Exact `X.Y.Z` version of jactionlint to download. Pinning the action pins jactionlint too. | Bundled version |
| `executable` | Path of a pre-installed jactionlint binary. When set, `version` is ignored. | |
| `files` | Whitespace-separated list of files to check. Without it, checks all workflows, composite actions, `dependabot.yml` and the Actions lock file. | |
| `profile` | Rule profile: `correctness`, `default` or `pedantic`. | Config file or `default` |
| `config-file` | Path to the config file when it is not `.github/jactionlint.yaml`. | |
| `min-severity` | Hide findings below this level: `info`, `warn` or `error`. | |
| `strict-exit` | Fail the step for `warn` and `info` findings too, not only `error`. | `false` |
| `online` | Run checks that query the GitHub API: `true`, `false`, `cache` or `strict`. | Config file |
| `token` | GitHub API token for online checks. Not passed to jactionlint when `online` is `false`. | `github.token` |
| `annotations` | Annotate pull request files with findings. No effect when `advanced-security` is `true`. | `true` |
| `advanced-security` | Upload findings to code scanning as SARIF. Requires `security-events: write`. Takes precedence over `annotations`. | `false` |
| `color` | Colorize the text output. | `true` |
| `args` | Extra command-line options, split with shell word-splitting rules (e.g. `--ignore=unpinned-images`). | |
| `working-directory` | Directory to run jactionlint in. | `.` |

## Outputs

| Output | Description |
|---|---|
| `executable` | Path of the jactionlint executable the action used. |
| `sarif-file` | Path of the SARIF file, when `advanced-security` is `true`. |

## Issue

Tool documentation, rules reference and configuration guide: [jactionlint.jdx.dev](https://jactionlint.jdx.dev).

Report issues with this action at [step-security/jactionlint](https://github.com/step-security/jactionlint/issues).
