# `checksum-ai/test-run-action`

GitHub Action that triggers a Checksum AI test run from CI in one step. Wraps
the public-API `execution/*` endpoints and (optionally) opts the run into
auto-heal-on-failure. Notification of pass/fail and any healed PRs is delivered
via the standard Checksum PR-comment pipeline — this action is fire-and-forget
and exits as soon as the dispatch is accepted.

## Quick start

```yaml
- uses: checksum-ai/test-run-action@v2
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

**No checkout needed.** On a `pull_request` event, omit `changed-files` and
`git-base-ref` — the action reads the PR's changed files from the GitHub API
and runs only the affected tests on the Checksum cloud. Point them at a preview
deployment with `env-overrides`:

```yaml
permissions:
  contents: read
  pull-requests: read   # so the action can read the PR's changed files

steps:
  - uses: checksum-ai/test-run-action@v2
    with:
      api-key: ${{ secrets.CHECKSUM_API_KEY }}
      affected: true
      wait: true
      env-overrides: |
        {"BASE_URL": "https://preview.checksum.ai/pr-${{ github.event.pull_request.number }}/"}
```

(Outside a `pull_request` event — e.g. `workflow_run` — pass `pr-number:` so the
action knows which PR's files to read.)

Or compute the diff locally from a checkout:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0

- uses: checksum-ai/test-run-action@v2
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
- uses: checksum-ai/test-run-action@v2
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    affected: true
    changed-files: |
      packages/webapp/src/routing/index.ts
```

Dual-repo CI (diff the code repo, dispatch from the workflow repo):

```yaml
- uses: checksum-ai/test-run-action@v2
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
- uses: checksum-ai/test-run-action@v2
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    grep: 'checkout'
    env-overrides: '{"BASE_URL":"https://pr-${{ github.event.pull_request.number }}.preview.example.com"}'

# Suite — pass one or more suite UUIDs.
- uses: checksum-ai/test-run-action@v2
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    suite-ids: 'a1b2c3d4-...,e5f6g7h8-...'

# Tests — explicit UUIDs.
- uses: checksum-ai/test-run-action@v2
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    test-ids: 'a1b2c3d4-...,e5f6g7h8-...'

# Collection — single UUID.
- uses: checksum-ai/test-run-action@v2
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    collection-id: 'd9e8f7a6-...'
```

## Sharding

Set `shard-count` (honored in `grep` and `affected` modes) to split the
selected tests across N parallel shards (`2`–`40`) and merge the results into
one Checksum run — useful for large suites where a single run is too slow for
CI feedback. Each shard runs one Playwright worker, so total parallelism
scales with `shard-count`.

```yaml
- uses: checksum-ai/test-run-action@v2
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    grep: '@smoke'
    branch: ${{ github.head_ref }}
    env-overrides: '{"BASE_URL":"https://pr-${{ github.event.pull_request.number }}.preview.example.com"}'
    shard-count: 8
    wait: true                    # gate the PR check on the merged verdict
    wait-timeout-seconds: 1800    # fail fast instead of riding the job timeout
```

With `wait: true` the action polls the run by id and exits green only when the
server's merged `verdict` is `pass`. Omit `shard-count` (or set `1`) for a
non-sharded run. `shard-count` is honored in `grep` and `affected` modes;
a `shard-count` of `2` or more cannot be combined with `auto-heal` (a
`shard-count` of `1` still can).

> **Prerequisite:** sharded runs merge each shard's report with the `checksumai`
> CLI on the checked-out `branch`. That branch must be on `checksumai@4.4.0` or
> later — the first stable release with sharded-report merging — or the shards
> run but never combine, and the run never returns a final `verdict`. Update it
> (e.g. `npm install checksumai@latest`) before enabling sharding, and pair
> `wait: true` with `wait-timeout-seconds` so a stale version fails fast
> instead of hanging the runner until the job timeout.

## Auto-heal

Set `auto-heal: true` to opt the run into the healing pipeline. When the run
terminates with status `failed`, healing sessions spawn automatically, post
progress as a comment on the PR, and (by default) push healed tests as a PR.

```yaml
- uses: checksum-ai/test-run-action@v2
  with:
    api-key: ${{ secrets.CHECKSUM_API_KEY }}
    grep: 'checkout'
    auto-heal: true
```

To dispatch heal sessions without auto-creating a PR (e.g., to inspect them
manually first):

```yaml
- uses: checksum-ai/test-run-action@v2
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
| `shard-count` | no | — | Run in parallel across N shards (`2`–`40`) and merge into one run (`grep` / `affected` modes). Omit or `1` = non-sharded. Each shard runs one Playwright worker. `2`+ can't be combined with `auto-heal`. |
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
| `job-name` | job name of the dispatched run for a non-sharded run; empty for a sharded run. Prefer `test-run-id`. |
| `status` | Raw final run status when `wait: true` (e.g. `passed`, `healed`, `failed`, `process-error`, `cancelled`, `timeout`). Empty when `wait: false`. The exit code gates on `verdict`, not this string. |
| `verdict` | Server-computed CI verdict when `wait: true`: `pass`, `fail`, or `pending` (pending only on timeout). This is what the exit code reflects. Empty when `wait: false`. |
| `test-run-id` | Test run UUID, returned at dispatch (non-sharded and sharded). Poll via `/public-api/v1/execution/status/run/{runId}`. |

## Failure behavior

By default (`wait: false`) the action fails **only** when the dispatch HTTP
call does not return 2xx. Test results — pass, fail, or healed — are reported
asynchronously via PR comments from the Checksum pipeline; they do not affect
this step's exit code.

Set `wait: true` to make the action poll `/public-api/v1/execution/status/run/{runId}`
until the run is terminal, then exit on the server-computed **verdict** (this is
correct for sharded runs, where partial pre-merge counts or an empty selection
would mislead a raw status check):

| Result | Exit |
| --- | --- |
| `verdict: pass` (a genuinely passing run) | 0 (green) |
| `verdict: fail` (test failures, process error, cancelled, empty selection) | 1 (red) |
| timeout reached before terminal | 1 (red) |

```yaml
- uses: checksum-ai/test-run-action@v2
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
