import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  buildGrepPatternFromAffectedIds,
  fetchAffectedTestIds,
  resolveChangedFiles,
} from "./affected";

type ExecMode = "grep" | "suite" | "tests" | "collection" | "affected";

type AutoHealBlock = {
  autoCreatePR?: boolean;
  prNumber?: number;
  repoName?: string;
  metadata?: Record<string, unknown>;
};

type DispatchPlan = {
  mode: ExecMode;
  url: string;
  payload: Record<string, unknown>;
};

// Shape of GET /public-api/v1/execution/status/run/:runId. `isTerminal` and
// `verdict` are server-computed and are the ONLY fields CI should gate on:
// they stay correct for sharded runs (partial pre-merge counts, empty
// selections, dead-ends) where the raw `status` string alone would mislead.
type Verdict = "pass" | "fail" | "pending";

type StatusResponse = {
  status: string;
  isTerminal: boolean;
  verdict: Verdict;
  // Infra detail behind a failed/process-error status, e.g. a sharded run that
  // lost a shard ("1/8 shards failed; merged report is missing their tests").
  // A run like that reports `failed` when the surviving shards had real
  // failures, so without this the log cannot tell "tests failed" from "tests
  // failed and part of the suite never ran".
  failureReason: string | null;
};

// fetchStatus outcomes: a parsed status, a transient hiccup worth retrying, or
// a fatal condition (e.g. 404 — wrong `api-base-url`, or a Checksum API without
// the run-status endpoint) that should stop the poll instead of spinning.
type StatusResult =
  | { kind: "ok"; value: StatusResponse }
  | { kind: "retry"; reason: string }
  | { kind: "fatal"; reason: string };

const TERMINAL_OK_STATUSES = new Set([200, 201, 202]);
const MAX_CONSECUTIVE_STATUS_FAILURES = 5;
const SHARD_MIN = 2;
const SHARD_MAX = 40;

async function run(): Promise<void> {
  const apiKey = core.getInput("api-key", { required: true });
  const baseUrl = core
    .getInput("api-base-url")
    .trim()
    .replace(/\/+$/, "");

  const plan = await buildDispatchPlan(baseUrl, apiKey);
  if (plan === null) {
    return;
  }
  await attachAutoHealIfEnabled(plan.payload);

  core.info(`Dispatching ${plan.mode} run → POST ${plan.url}`);
  core.info(`Payload: ${JSON.stringify(redactPayload(plan.payload))}`);

  const response = await fetch(plan.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ChecksumAppCode: apiKey,
    },
    body: JSON.stringify(plan.payload),
  });

  const bodyText = await response.text();
  if (!TERMINAL_OK_STATUSES.has(response.status)) {
    core.setFailed(
      `Execution dispatch failed (HTTP ${response.status}). Body: ${bodyText}`
    );
    return;
  }

  let parsed: { name?: string | null; runId?: string; sharded?: boolean } = {};
  try {
    parsed = JSON.parse(bodyText) as {
      name?: string | null;
      runId?: string;
      sharded?: boolean;
    };
  } catch {
    core.setFailed(
      `Execution dispatch returned HTTP ${response.status} but body was not valid JSON: ${bodyText}`
    );
    return;
  }

  // Poll by `runId`: it is returned for BOTH non-sharded and sharded runs, and
  // its status endpoint is the only one that is correct for sharded runs
  // (`name` is null when sharded, so job-name polling can't work).
  const runId = parsed.runId;
  if (!runId) {
    core.setFailed(
      `Execution dispatch returned HTTP ${response.status} but response had no "runId" field: ${bodyText}`
    );
    return;
  }
  const jobName = parsed.name ?? "";
  const sharded = parsed.sharded === true;

  core.setOutput("job-name", jobName);
  core.setOutput("test-run-id", runId);
  core.info(
    `Dispatched ${sharded ? "sharded" : "non-sharded"} run. runId: ${runId}${jobName ? ` (job: ${jobName})` : ""}`
  );

  if (!core.getBooleanInput("wait")) {
    await core.summary
      .addHeading("Checksum AI test run dispatched", 3)
      .addList([
        `Mode: \`${plan.mode}\``,
        `Run id: \`${runId}\``,
        `Sharded: \`${sharded ? "yes" : "no"}\``,
        `Auto-heal: \`${core.getBooleanInput("auto-heal") ? "enabled" : "disabled"}\``,
      ])
      .write();
    return;
  }

  await waitForCompletion(baseUrl, apiKey, runId, plan.mode, sharded);
}

async function waitForCompletion(
  baseUrl: string,
  apiKey: string,
  runId: string,
  mode: ExecMode,
  sharded: boolean
): Promise<void> {
  const pollIntervalMs = parsePositiveIntInput("poll-interval-seconds") * 1000;
  const timeoutMs = parseOptionalPositiveIntInput("wait-timeout-seconds");
  const deadline =
    timeoutMs === undefined ? undefined : Date.now() + timeoutMs * 1000;
  const statusUrl = `${baseUrl}/public-api/v1/execution/status/run/${encodeURIComponent(runId)}`;

  core.info(
    `Waiting for terminal status (poll every ${pollIntervalMs / 1000}s, timeout ${
      deadline === undefined ? "none" : `${timeoutMs}s`
    })…`
  );

  let lastStatus = "unknown";
  let lastVerdict: Verdict = "pending";
  let lastFailureReason: string | null = null;
  let reachedTerminal = false;
  let consecutiveFailures = 0;

  while (deadline === undefined || Date.now() < deadline) {
    const result = await fetchStatus(statusUrl, apiKey);
    if (result.kind === "fatal") {
      // Not transient (e.g. 404) — retrying can only burn CI minutes.
      core.setFailed(`Cannot poll run status: ${result.reason}`);
      return;
    }
    if (result.kind === "retry") {
      // Transient hiccup — keep polling, but give up after too many in a row
      // rather than spinning until the job timeout.
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_STATUS_FAILURES) {
        core.setFailed(
          `Status endpoint failed ${consecutiveFailures} times in a row: ${result.reason}`
        );
        return;
      }
      core.warning(`${result.reason}; will retry.`);
    } else {
      consecutiveFailures = 0;
      lastStatus = result.value.status;
      lastVerdict = result.value.verdict;
      lastFailureReason = result.value.failureReason;
      core.info(`status=${lastStatus} verdict=${lastVerdict}`);
      // Gate on the server-computed `isTerminal`, never on the raw status
      // string — it stays correct across sharded merge, empty selections,
      // and dead-ends.
      if (result.value.isTerminal) {
        reachedTerminal = true;
        break;
      }
    }
    await sleep(pollIntervalMs);
  }

  const finalStatus = reachedTerminal ? lastStatus : "timeout";
  const finalVerdict: Verdict = reachedTerminal ? lastVerdict : "pending";
  const runUrl = `https://app.checksum.ai/#/test-runs/${runId}`;

  core.setOutput("status", finalStatus);
  core.setOutput("verdict", finalVerdict);
  core.setOutput("test-run-id", runId);

  await core.summary
    .addHeading("Checksum AI test run", 3)
    .addList(
      [
        `Mode: \`${mode}\``,
        `Sharded: \`${sharded ? "yes" : "no"}\``,
        `Final status: \`${finalStatus}\``,
        `Verdict: \`${reachedTerminal ? lastVerdict : "pending"}\``,
        lastFailureReason ? `Failure reason: ${lastFailureReason}` : "",
        `Test run: ${runUrl}`,
      ].filter(Boolean)
    )
    .write();

  if (!reachedTerminal) {
    core.setFailed(
      `Timed out after ${timeoutMs}s waiting for run to terminate (last status: ${lastStatus}). View: ${runUrl}`
    );
    return;
  }
  // The verdict is the CI gate: "pass" only for a genuinely passing run
  // (server already fails-closed on empty selections and pre-merge state).
  if (lastVerdict !== "pass") {
    const reason = lastFailureReason ? ` Reason: ${lastFailureReason}.` : "";
    core.setFailed(
      `Test run did not pass (verdict: ${lastVerdict}, status: ${lastStatus}).${reason} View: ${runUrl}`
    );
    return;
  }
  core.info(`Test run passed (status: ${lastStatus}). View: ${runUrl}`);
}

async function fetchStatus(
  url: string,
  apiKey: string
): Promise<StatusResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { ChecksumAppCode: apiKey },
    });
  } catch (e) {
    return { kind: "retry", reason: `Status request errored (${String(e)})` };
  }
  if (!response.ok) {
    // A 404 means the run id or the status endpoint isn't there (wrong
    // `api-base-url`, or an API without this endpoint) — retrying won't fix it.
    if (response.status === 404) {
      return {
        kind: "fatal",
        reason: `status endpoint returned HTTP 404 (${url}). Check \`api-base-url\`.`,
      };
    }
    return {
      kind: "retry",
      reason: `Status endpoint returned HTTP ${response.status}`,
    };
  }
  try {
    const body = (await response.json()) as Partial<StatusResponse>;
    if (typeof body.status !== "string" || typeof body.isTerminal !== "boolean") {
      return { kind: "retry", reason: "Status response was missing fields" };
    }
    const verdict: Verdict =
      body.verdict === "pass" || body.verdict === "fail" ? body.verdict : "pending";
    return {
      kind: "ok",
      value: {
        status: body.status,
        isTerminal: body.isTerminal,
        verdict,
        failureReason:
          typeof body.failureReason === "string" && body.failureReason
            ? body.failureReason
            : null,
      },
    };
  } catch {
    return { kind: "retry", reason: "Status response was not valid JSON" };
  }
}

function parsePositiveIntInput(name: string): number {
  const raw = core.getInput(name);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`\`${name}\` must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

function parseOptionalPositiveIntInput(name: string): number | undefined {
  const raw = core.getInput(name);
  if (raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`\`${name}\` must be a positive integer, got: ${raw}`);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function buildDispatchPlan(
  baseUrl: string,
  apiKey: string
): Promise<DispatchPlan | null> {
  // GitHub Actions sets INPUT_* env vars for every input declared in
  // action.yml regardless of whether the caller set them, so we cannot
  // distinguish "set to empty string" from "not set". Mode auto-detection
  // therefore requires a non-empty value on exactly one mode input.
  const affected = core.getBooleanInput("affected");
  const grep = core.getInput("grep");
  const suiteIds = core.getInput("suite-ids");
  const testIds = core.getInput("test-ids");
  const collectionId = core.getInput("collection-id");

  const provided: Array<[string, string]> = [
    ["grep", grep],
    ["suite-ids", suiteIds],
    ["test-ids", testIds],
    ["collection-id", collectionId],
  ].filter(([, value]) => value !== "") as Array<[string, string]>;

  if (affected && provided.length > 0) {
    throw new Error(
      "`affected: true` cannot be combined with `grep`, `suite-ids`, `test-ids`, or `collection-id`."
    );
  }
  if (affected) {
    return planAffected(baseUrl, apiKey);
  }

  if (provided.length > 1) {
    throw new Error(
      `Provide exactly one execution mode input. Got: ${provided
        .map(([k]) => k)
        .join(", ")}.`
    );
  }
  if (provided.length === 0) {
    throw new Error(
      "Provide one of: `affected`, `grep`, `suite-ids`, `test-ids`, or `collection-id`."
    );
  }

  const mode = provided[0]![0];
  warnOnIgnoredInputs(mode);

  if (mode === "grep") return planGrep(baseUrl, grep);
  if (mode === "suite-ids") return planSuite(baseUrl, suiteIds);
  if (mode === "test-ids") return planTests(baseUrl, testIds);
  return planCollection(baseUrl, collectionId);
}

async function planAffected(
  baseUrl: string,
  apiKey: string
): Promise<DispatchPlan | null> {
  const changedFiles = await resolveAffectedChangedFiles();
  core.info(
    `Resolving affected tests for ${changedFiles.length} changed file(s)…`
  );

  const affectedTestIds = await fetchAffectedTestIds(
    baseUrl,
    apiKey,
    changedFiles
  );
  core.setOutput("affected-test-ids", JSON.stringify(affectedTestIds));

  if (affectedTestIds.length === 0) {
    core.info("No tests affected by the current changes — nothing to run.");
    await core.summary
      .addHeading("Checksum AI affected tests", 3)
      .addList([
        `Changed files: ${changedFiles.length}`,
        "Affected test ids: 0",
        "Skipped test dispatch.",
      ])
      .write();
    return null;
  }

  const grepPattern = buildGrepPatternFromAffectedIds(affectedTestIds);
  core.setOutput("grep-pattern", grepPattern);
  core.info(
    `Affected test ids (${affectedTestIds.length}): ${affectedTestIds.join(", ")}`
  );
  core.info(`Dispatching grep run with pattern: ${grepPattern}`);

  const plan = planGrep(baseUrl, grepPattern);
  return { ...plan, mode: "affected" };
}

/**
 * Resolve the changed-file list for `affected` mode. Precedence:
 *   1. `changed-files` input (explicit), or a local `git diff` vs
 *      `git-base-ref` — handled by resolveChangedFiles().
 *   2. Otherwise (no checkout): read the open PR's files from the GitHub API.
 */
async function resolveAffectedChangedFiles(): Promise<string[]> {
  const fromInputsOrGit = resolveChangedFiles();
  if (fromInputsOrGit !== null) return fromInputsOrGit;

  const prNumber = await resolvePrNumber();
  if (prNumber === undefined) {
    throw new Error(
      "`affected: true` needs changed files. Provide `changed-files:` or " +
        "`git-base-ref:`, or run on a pull_request event (or pass `pr-number:`) " +
        "so the changed files can be read from the GitHub API."
    );
  }
  return await fetchPrChangedFiles(prNumber);
}

/** List a PR's changed file paths via the GitHub API (no checkout needed). */
async function fetchPrChangedFiles(prNumber: number): Promise<string[]> {
  const token = core.getInput("github-token");
  if (!token) {
    throw new Error(
      "`affected: true` (no checkout) needs `github-token` with " +
        "`pull-requests: read` to read the PR's changed files."
    );
  }
  const repository = process.env.GITHUB_REPOSITORY || "";
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(
      `Cannot derive owner/repo from GITHUB_REPOSITORY ("${repository}").`
    );
  }

  const octokit = github.getOctokit(token);
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const changed = files
    .map((f) => f.filename)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  core.info(
    `Read ${changed.length} changed file(s) from PR #${prNumber} via the GitHub API.`
  );
  return changed;
}

function warnOnIgnoredInputs(mode: string): void {
  if (mode === "grep" || mode === "affected") return;
  const ignored: string[] = [];
  if (core.getInput("branch")) ignored.push("`branch`");
  if (core.getInput("env-overrides")) ignored.push("`env-overrides`");
  if (core.getInput("shard-count")) ignored.push("`shard-count`");
  if (ignored.length === 0) return;
  const verb = ignored.length === 1 ? "is" : "are";
  core.warning(
    `${ignored.join(" and ")} ${verb} only honored in grep mode and will be ignored.`
  );
}

function planGrep(baseUrl: string, grep: string): DispatchPlan {
  const payload: Record<string, unknown> = { grep };

  const branch = core.getInput("branch");
  if (branch) payload.branch = branch;

  const envOverridesRaw = core.getInput("env-overrides");
  if (envOverridesRaw) {
    payload.envOverrides = parseJsonInput("env-overrides", envOverridesRaw);
  }

  const shardCount = parseShardCountInput();
  if (shardCount !== undefined) {
    payload.shardCount = shardCount;
  }

  return {
    mode: "grep",
    url: `${baseUrl}/public-api/v2/execution/grep`,
    payload,
  };
}

// Returns the shard count only when it should fan out (>= 2). Omitted or `1`
// returns undefined (non-sharded — no `shardCount` in the payload). Anything
// else (non-integer, < 1, > 40) is a hard input error.
function parseShardCountInput(): number | undefined {
  const raw = core.getInput("shard-count").trim();
  if (raw === "") return undefined;
  // Plain decimal integers only — reject `0x10`, `1e1`, `8.0`, signs, etc.
  const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > SHARD_MAX) {
    throw new Error(
      `\`shard-count\` must be an integer between 1 and ${SHARD_MAX} (omit or 1 = non-sharded, ${SHARD_MIN}-${SHARD_MAX} = sharded), got: ${raw}`
    );
  }
  return parsed >= SHARD_MIN ? parsed : undefined;
}

function planSuite(baseUrl: string, suiteIdsInput: string): DispatchPlan {
  const suiteIds = parseCsv(suiteIdsInput);
  if (suiteIds.length === 0) {
    throw new Error("`suite-ids` must contain at least one UUID.");
  }
  return {
    mode: "suite",
    url: `${baseUrl}/public-api/v1/execution/suite`,
    payload: { suiteIds },
  };
}

function planTests(baseUrl: string, testIdsInput: string): DispatchPlan {
  const testIds = parseCsv(testIdsInput);
  if (testIds.length === 0) {
    throw new Error("`test-ids` must contain at least one UUID.");
  }
  return {
    mode: "tests",
    url: `${baseUrl}/public-api/v1/execution/tests`,
    payload: { testIds },
  };
}

function planCollection(baseUrl: string, collectionId: string): DispatchPlan {
  return {
    mode: "collection",
    url: `${baseUrl}/public-api/v1/execution/collection/${encodeURIComponent(
      collectionId
    )}`,
    payload: {},
  };
}

async function attachAutoHealIfEnabled(
  payload: Record<string, unknown>
): Promise<void> {
  if (!core.getBooleanInput("auto-heal")) return;

  const autoHeal: AutoHealBlock = {};
  autoHeal.autoCreatePR = core.getBooleanInput("auto-create-pr");

  const repoName = resolveRepoName();
  if (repoName) autoHeal.repoName = repoName;

  const prNumber = await resolvePrNumber();
  if (prNumber !== undefined) autoHeal.prNumber = prNumber;

  const metadataRaw = core.getInput("metadata");
  if (metadataRaw) {
    autoHeal.metadata = parseJsonInput("metadata", metadataRaw) as Record<
      string,
      unknown
    >;
  }

  if (autoHeal.autoCreatePR && !autoHeal.repoName) {
    throw new Error(
      "auto-heal is enabled with auto-create-pr=true but `repo-name` could not be auto-detected and was not provided. Pass `repo-name:` explicitly or run on a workflow event that exposes github.repository."
    );
  }
  if (autoHeal.prNumber !== undefined && !autoHeal.repoName) {
    throw new Error(
      "`pr-number` is set without a resolvable `repo-name`. Pass `repo-name:` explicitly."
    );
  }

  payload.autoHeal = autoHeal;
}

function resolveRepoName(): string | undefined {
  const explicit = core.getInput("repo-name");
  if (explicit) return explicit;
  // GITHUB_REPOSITORY is "owner/repo"; backend matches on the bare repo name.
  // Read the env var directly — `github.context.repo` is a throwing getter
  // when the env var is absent, which would surface as a cryptic library
  // message instead of our own validation guard below.
  const ghRepo = process.env.GITHUB_REPOSITORY;
  if (!ghRepo) return undefined;
  const parts = ghRepo.split("/");
  return parts[parts.length - 1] || undefined;
}

async function resolvePrNumber(): Promise<number | undefined> {
  const explicit = core.getInput("pr-number");
  if (explicit) {
    const parsed = Number(explicit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`\`pr-number\` must be a positive integer, got: ${explicit}`);
    }
    return parsed;
  }

  // pull_request / pull_request_target events carry the PR number in the
  // event payload — no API call needed.
  const fromEvent = github.context.payload?.pull_request?.number;
  if (typeof fromEvent === "number") return fromEvent;

  // push / workflow_dispatch / schedule events don't carry PR data, so look
  // up an open PR with this branch as head via the GH API. Requires
  // `pull-requests: read` permission on the workflow's GITHUB_TOKEN.
  return await lookupPrNumberByBranch();
}

async function lookupPrNumberByBranch(): Promise<number | undefined> {
  const token = core.getInput("github-token");
  if (!token) {
    core.info(
      "pr-number: no github-token provided; cannot look up PR for branch."
    );
    return undefined;
  }

  const ref = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF || "";
  const branch = ref.replace(/^refs\/heads\//, "");
  const repository = process.env.GITHUB_REPOSITORY || "";
  const [owner, repo] = repository.split("/");

  if (!branch || !owner || !repo) {
    core.info(
      `pr-number: cannot derive branch+repo (branch=${branch}, repository=${repository}); skipping lookup.`
    );
    return undefined;
  }

  try {
    const octokit = github.getOctokit(token);
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${branch}`,
      state: "open",
      per_page: 2,
    });
    if (prs.length === 0) {
      core.info(`pr-number: no open PR found with head ${owner}:${branch}.`);
      return undefined;
    }
    if (prs.length > 1) {
      core.warning(
        `pr-number: multiple open PRs found with head ${owner}:${branch}; using #${prs[0]!.number}.`
      );
    }
    core.info(`pr-number: auto-resolved to #${prs[0]!.number} from open PR.`);
    return prs[0]!.number;
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    if (status === 401 || status === 403) {
      core.warning(
        "pr-number: GH API returned 403/401 looking up the PR. Add `permissions: pull-requests: read` to the workflow (or pass `pr-number:` explicitly)."
      );
    } else {
      const message = err instanceof Error ? err.message : String(err);
      core.warning(`pr-number: PR lookup failed: ${message}`);
    }
    return undefined;
  }
}

function parseCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseJsonInput(name: string, raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`\`${name}\` must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`\`${name}\` is not valid JSON: ${err.message}`);
    }
    throw err;
  }
}

function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  // Payload contains no secrets today, but keep this in case envOverrides ever
  // forwards a sensitive value the workflow author classifies as such.
  return payload;
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(message);
});
