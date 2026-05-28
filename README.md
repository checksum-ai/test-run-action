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

Set exactly one of `affected`, `grep`, `suite-ids`, `test-ids`, or
`collection-id`. The action picks the matching public-API endpoint:

| Input | Endpoint |
| --- | --- |
| `affected` | `POST /public-api/v1/affected-tests` → `POST /public-api/v2/execution/grep` |
| `grep` | `POST /public-api/v2/execution/grep` |
| `suite-ids` | `POST /public-api/v1/execution/suite` |
| `test-ids` | `POST /public-api/v1/execution/tests` |
| `collection-id` | `POST /public-api/v1/execution/collection/:id` |

### Affected tests (API)

`affected: true` calls `/public-api/v1/affected-tests` with your changed
files, builds a grep pattern from the returned test ids (same as
`npx checksumai test --cksm-affected`), then dispatches
`/public-api/v2/execution/grep`. Supports `branch`, `env-overrides`, and
`auto-heal` like grep mode.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0

- uses: checksum-ai/test-run-action@v1
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    affected: true
    git-base-ref: origin/${{ github.base_ref }}
    auto-heal: true
    env-overrides: |
      {"BASE_URL": "https://preview.checksum.ai/pr-${{ github.event.pull_request.number }}/"}
```

Or pass paths explicitly (no git diff on the runner):

```yaml
- uses: checksum-ai/test-run-action@v1
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    affected: true
    changed-files: |
      packages/webapp/src/routing/index.ts
```

Dual-repo CI (diff the code repo, dispatch from the workflow repo):

```yaml
- uses: checksum-ai/test-run-action@v1
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    affected: true
    git-base-ref: origin/main
    git-dir: ${{ github.workspace }}/code
```

When no tests are affected, the step exits successfully without dispatching a
run (same as the CLI dry-run / empty-affected behavior).

```yaml
# Grep — pattern match on test names. Supports `branch` and `env-overrides`.
- uses: checksum-ai/test-run-action@v1
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    grep: 'checkout'
    env-overrides: '{"BASE_URL":"https://pr-${{ github.event.pull_request.number }}.preview.example.com"}'

# Suite — pass one or more suite UUIDs.
- uses: checksum-ai/test-run-action@v1
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    suite-ids: 'a1b2c3d4-...,e5f6g7h8-...'

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
| `affected` | no* | `false` | Resolve affected tests via API, then grep-dispatch those ids. |
| `changed-files` | no | — | Newline-separated changed paths (`affected` mode). |
| `git-base-ref` | no | — | Ref to diff against (`affected` mode; needs checkout + `fetch-depth: 0`). |
| `git-dir` | no | — | `git -C` directory for the diff (`affected` mode). |
| `grep` | no* | — | Substring/regex matched against test names. |
| `suite-ids` | no* | — | Comma-separated suite UUIDs. |
| `test-ids` | no* | — | Comma-separated test UUIDs. |
| `collection-id` | no* | — | Single collection UUID. |
| `branch` | no | — | Test-repo branch (grep mode only). Defaults to test repo's default branch. |
| `env-overrides` | no | — | JSON object of per-run env vars (grep mode only). |
| `auto-heal` | no | `false` | Opt this run into auto-heal-on-failure. |
| `auto-create-pr` | no | `true` | When auto-heal is enabled, push healed tests as a PR. |
| `pr-number` | no | auto | Source PR number for heal progress comments. Auto-detected on `pull_request` events from the event payload, and on `push` events by looking up an open PR for the branch via the GH API (uses `github-token`, requires `permissions: pull-requests: read`). |
| `repo-name` | no | auto | Bare repo name (no owner). Auto-detected from `github.repository`. |
| `metadata` | no | — | JSON object of free-form metadata attached to heal sessions. |
| `wait` | no | `false` | When `true`, poll until the run reaches a terminal status; exit code reflects the outcome (`passed`/`healed` → 0, others → 1). |
| `poll-interval-seconds` | no | `15` | Status poll interval when `wait: true`. |
| `wait-timeout-seconds` | no | — | Maximum time to wait for terminal status when `wait: true`. When omitted, waits indefinitely; the workflow job's `timeout-minutes` is the upper bound. |
| `api-base-url` | no | `https://api.checksum.ai` | Override the API base URL (e.g., for staging). |
| `github-token` | no | `${{ github.token }}` | Token used to look up the open PR for the current branch on `push` events. Needs `pull-requests: read`. Ignored on `pull_request` events. |

*Provide exactly one of `affected`, `grep`, `suite-ids`, `test-ids`, `collection-id`.

## Outputs

| Name | Description |
| --- | --- |
| `affected-test-ids` | JSON array from `/affected-tests` when `affected: true`. |
| `grep-pattern` | Grep pattern sent to execution (affected mode, when tests were found). |
| `job-name` | Name of the dispatched job. Use it to query `/public-api/v2/execution/status/{jobName}` if you want to poll yourself. |
| `status` | Final terminal status when `wait: true`: `passed`, `healed`, `failed`, `process-error`, `cancelled`, or `timeout`. Empty when `wait: false`. |
| `test-run-id` | Test run UUID, populated when `wait: true` and the run reached a terminal status. |

## Failure behavior

By default (`wait: false`) the action fails **only** when the dispatch HTTP
call does not return 2xx. Test results — pass, fail, or healed — are reported
asynchronously via PR comments from the Checksum pipeline; they do not affect
this step's exit code.

Set `wait: true` to make the action poll the status endpoint and exit based on
the run outcome:

| Final status | Exit |
| --- | --- |
| `passed`, `healed` | 0 (green) |
| `failed`, `process-error`, `cancelled` | 1 (red) |
| timeout reached | 1 (red) |

```yaml
- uses: checksum-ai/test-run-action@v1
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    grep: 'checkout'
    auto-heal: true
    wait: true
```

`wait: true` keeps a runner allocated for the full test-run duration (often
5–25 minutes). Prefer `wait: false` plus the standard PR-comment notification
when runner-minute cost matters. Use the workflow job's `timeout-minutes` to
cap the runner's lifetime; pass `wait-timeout-seconds:` only if you want a
shorter cap than the job timeout.

Note: the action reflects the **test run's** terminal status, not the
auto-heal pipeline's outcome. `auto-heal: true` triggers healing
asynchronously after a `failed` test run; healing progress is reported via
the PR comment posted by the Checksum bot.

## Development

```sh
yarn install
yarn typecheck
yarn build         # bundles src/index.ts → dist/index.js
yarn verify-dist   # rebuild + assert dist/ is up to date
```

Commit `dist/` along with `src/` changes — GitHub Actions resolve the
`runs.main` path at consume time, with no install step.
