# `checksum-ai/test-run-action`

GitHub Action that triggers a Checksum AI test run from CI in one step. Wraps
the public-API `execution/*` endpoints and (optionally) opts the run into
auto-heal-on-failure. Notification of pass/fail and any healed PRs is delivered
via the standard Checksum PR-comment pipeline — this action is fire-and-forget
and exits as soon as the dispatch is accepted.

## Quick start

```yaml
- uses: checksum-ai/test-run-action@v1
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    grep: 'Home Page Title'
    auto-heal: true
```

The action auto-resolves `repo-name` from `github.repository` and `pr-number`
from the `pull_request` event payload, so on a PR workflow no further wiring
is needed for auto-heal.

## Execution modes

Set exactly one of `grep`, `suite-ids`, `test-ids`, or `collection-id`. The
action picks the matching public-API endpoint:

| Input | Endpoint |
| --- | --- |
| `grep` | `POST /public-api/v2/execution/grep` |
| `suite-ids` (or empty) | `POST /public-api/v1/execution/suite` |
| `test-ids` | `POST /public-api/v1/execution/tests` |
| `collection-id` | `POST /public-api/v1/execution/collection/:id` |

```yaml
# Grep — pattern match on test names. Supports `branch` and `env-overrides`.
- uses: checksum-ai/test-run-action@v1
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    grep: 'checkout'
    env-overrides: '{"BASE_URL":"https://pr-${{ github.event.pull_request.number }}.preview.example.com"}'

# Suite — leave `suite-ids` blank to run all suites with code, or pass UUIDs.
- uses: checksum-ai/test-run-action@v1
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    suite-ids: ''

# Tests — explicit UUIDs.
- uses: checksum-ai/test-run-action@v1
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    test-ids: 'a1b2c3d4-...,e5f6g7h8-...'

# Collection — single UUID.
- uses: checksum-ai/test-run-action@v1
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    collection-id: 'd9e8f7a6-...'
```

## Auto-heal

Set `auto-heal: true` to opt the run into the healing pipeline. When the run
terminates with status `failed`, healing sessions spawn automatically, post
progress as a comment on the PR, and (by default) push healed tests as a PR.

```yaml
- uses: checksum-ai/test-run-action@v1
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    grep: 'checkout'
    auto-heal: true
```

To dispatch heal sessions without auto-creating a PR (e.g., to inspect them
manually first):

```yaml
- uses: checksum-ai/test-run-action@v1
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    grep: 'checkout'
    auto-heal: true
    auto-create-pr: false
```

When running on a non-PR event (e.g., `push`, `workflow_dispatch`) and you
still want auto-heal to comment on a specific PR, supply `pr-number:`
explicitly. `repo-name` is always auto-detected from `github.repository`
unless overridden.

## Inputs

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | yes | — | Checksum AI API key. |
| `grep` | no* | — | Substring/regex matched against test names. |
| `suite-ids` | no* | — | Comma-separated suite UUIDs. Empty = all suites with code. |
| `test-ids` | no* | — | Comma-separated test UUIDs. |
| `collection-id` | no* | — | Single collection UUID. |
| `branch` | no | — | Test-repo branch (grep mode only). Defaults to test repo's default branch. |
| `env-overrides` | no | — | JSON object of per-run env vars (grep mode only). |
| `auto-heal` | no | `false` | Opt this run into auto-heal-on-failure. |
| `auto-create-pr` | no | `true` | When auto-heal is enabled, push healed tests as a PR. |
| `pr-number` | no | auto | Source PR number for heal progress comments. Auto-detected on `pull_request` events. |
| `repo-name` | no | auto | Bare repo name (no owner). Auto-detected from `github.repository`. |
| `metadata` | no | — | JSON object of free-form metadata attached to heal sessions. |
| `api-base-url` | no | `https://api.checksum.ai` | Override the API base URL (e.g., for staging). |

*Provide exactly one of `grep`, `suite-ids`, `test-ids`, `collection-id`.

## Outputs

| Name | Description |
| --- | --- |
| `job-name` | Name of the dispatched job. Use it to query `/public-api/v2/execution/status/{jobName}` if you want to poll. |

## Failure behavior

The action fails **only** when the dispatch HTTP call does not return 2xx. Test
results — pass, fail, or healed — are reported asynchronously via PR comments
from the Checksum pipeline; they do not affect this step's exit code. If you
need a step that blocks the workflow on terminal status, poll the status
endpoint with the `job-name` output.

## Development

```sh
yarn install
yarn typecheck
yarn build         # bundles src/index.ts → dist/index.js
yarn verify-dist   # rebuild + assert dist/ is up to date
```

Commit `dist/` along with `src/` changes — GitHub Actions resolve the
`runs.main` path at consume time, with no install step.
