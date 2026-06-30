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

type StatusResponse = {
  status: string;
  testRunId?: string;
};

type DispatchResponse = {
  runId?: string;
  // `name` is the K8s job name for a single-pod run; null for a sharded run
  // (the sharded parent owns no job of its own).
  name?: string | null;
  sharded?: boolean;
};

type RunStatusResponse = {
  isTerminal: boolean;
  verdict: "pass" | "fail" | "pending";
  phase: string;
  executedCount: number;
};

const SHARD_COUNT_MIN = 1;
const SHARD_COUNT_MAX = 20;
const WORKERS_MIN = 1;
const WORKERS_MAX = 8;

const TERMINAL_OK_STATUSES = new Set([200, 201, 202]);
const TERMINAL_RUN_STATUSES = new Set([
  "passed",
  "healed",
  "failed",
  "process-error",
  "cancelled",
]);
const SUCCESS_RUN_STATUSES = new Set(["passed", "healed"]);

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
  const shardCount = attachShardingIfEnabled(plan.payload);

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

  let parsed: DispatchResponse = {};
  try {
    parsed = JSON.parse(bodyText) as DispatchResponse;
  } catch {
    core.setFailed(
      `Execution dispatch returned HTTP ${response.status} but body was not valid JSON: ${bodyText}`
    );
    return;
  }

  // A sharded run (shard-count >= 2) returns a null `name` and is identified
  // solely by `runId`. A single-pod run returns a `name` (K8s job name);
  // older API versions return only `{ name }` with no `runId`.
  const runId = typeof parsed.runId === "string" ? parsed.runId : undefined;
  const jobName =
    typeof parsed.name === "string" && parsed.name.length > 0
      ? parsed.name
      : undefined;
  const sharded = parsed.sharded === true || (shardCount >= 2 && !jobName);

  if (sharded && !runId) {
    core.setFailed(
      `Sharded dispatch returned HTTP ${response.status} but response had no "runId" field: ${bodyText}`
    );
    return;
  }
  if (!sharded && !jobName) {
    core.setFailed(
      `Execution dispatch returned HTTP ${response.status} but response had no "name" field: ${bodyText}`
    );
    return;
  }

  if (jobName) {
    core.setOutput("job-name", jobName);
  }
  if (runId) {
    core.setOutput("run-id", runId);
  }
  core.info(
    sharded
      ? `Dispatched sharded run (${shardCount} shards). Run id: ${runId}`
      : `Dispatched. Job name: ${jobName}`
  );

  if (!core.getBooleanInput("wait")) {
    await core.summary
      .addHeading("Checksum AI test run dispatched", 3)
      .addList(
        [
          `Mode: \`${plan.mode}\``,
          sharded
            ? `Run id: \`${runId}\` (sharded ×${shardCount})`
            : `Job name: \`${jobName}\``,
          `Auto-heal: \`${core.getBooleanInput("auto-heal") ? "enabled" : "disabled"}\``,
        ].filter(Boolean)
      )
      .write();
    return;
  }

  if (sharded) {
    await waitForShardedCompletion(baseUrl, apiKey, runId!, plan.mode);
  } else {
    await waitForCompletion(baseUrl, apiKey, jobName!, plan.mode);
  }
}

async function waitForCompletion(
  baseUrl: string,
  apiKey: string,
  jobName: string,
  mode: ExecMode
): Promise<void> {
  const pollIntervalMs = parsePositiveIntInput("poll-interval-seconds") * 1000;
  const timeoutMs = parseOptionalPositiveIntInput("wait-timeout-seconds");
  const deadline =
    timeoutMs === undefined ? undefined : Date.now() + timeoutMs * 1000;
  const statusUrl = `${baseUrl}/public-api/v2/execution/status/${encodeURIComponent(jobName)}`;

  core.info(
    `Waiting for terminal status (poll every ${pollIntervalMs / 1000}s, timeout ${
      deadline === undefined ? "none" : `${timeoutMs}s`
    })…`
  );

  let lastStatus = "unknown";
  let testRunId = "";

  while (deadline === undefined || Date.now() < deadline) {
    const result = await fetchStatus(statusUrl, apiKey);
    if (result === null) {
      // Transient fetch failure — log and keep polling. Don't fail the
      // action on a single status hiccup; the test run is still progressing.
      core.warning("Status request failed; will retry.");
    } else {
      lastStatus = result.status;
      if (result.testRunId) testRunId = result.testRunId;
      core.info(`status=${lastStatus}`);
      if (TERMINAL_RUN_STATUSES.has(lastStatus)) break;
    }
    await sleep(pollIntervalMs);
  }

  const reachedTerminal = TERMINAL_RUN_STATUSES.has(lastStatus);
  const finalStatus = reachedTerminal ? lastStatus : "timeout";
  const runUrl = testRunId
    ? `https://app.checksum.ai/#/test-runs/${testRunId}`
    : "";

  core.setOutput("status", finalStatus);
  if (testRunId) core.setOutput("test-run-id", testRunId);

  await core.summary
    .addHeading("Checksum AI test run", 3)
    .addList(
      [
        `Mode: \`${mode}\``,
        `Job name: \`${jobName}\``,
        `Final status: \`${finalStatus}\``,
        runUrl ? `Test run: ${runUrl}` : "",
      ].filter(Boolean)
    )
    .write();

  if (!reachedTerminal) {
    core.setFailed(
      `Timed out after ${timeoutMs}s waiting for run to terminate (last status: ${lastStatus}).${
        runUrl ? ` View: ${runUrl}` : ""
      }`
    );
    return;
  }
  if (!SUCCESS_RUN_STATUSES.has(lastStatus)) {
    core.setFailed(
      `Test run terminated with status: ${lastStatus}.${
        runUrl ? ` View: ${runUrl}` : ""
      }`
    );
    return;
  }
  core.info(
    `Test run terminated with status: ${lastStatus}.${runUrl ? ` View: ${runUrl}` : ""}`
  );
}

async function fetchStatus(
  url: string,
  apiKey: string
): Promise<StatusResponse | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { ChecksumAppCode: apiKey },
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    core.warning(`Status endpoint returned HTTP ${response.status}; will retry.`);
    return null;
  }
  try {
    const body = (await response.json()) as Partial<StatusResponse>;
    if (typeof body.status !== "string") return null;
    return {
      status: body.status,
      testRunId:
        typeof body.testRunId === "string" ? body.testRunId : undefined,
    };
  } catch {
    return null;
  }
}

async function waitForShardedCompletion(
  baseUrl: string,
  apiKey: string,
  runId: string,
  mode: ExecMode
): Promise<void> {
  const pollIntervalMs = parsePositiveIntInput("poll-interval-seconds") * 1000;
  const timeoutMs = parseOptionalPositiveIntInput("wait-timeout-seconds");
  const deadline =
    timeoutMs === undefined ? undefined : Date.now() + timeoutMs * 1000;
  const statusUrl = `${baseUrl}/public-api/v1/execution/status/run/${encodeURIComponent(runId)}`;

  core.info(
    `Waiting for sharded run to terminate (poll every ${pollIntervalMs / 1000}s, timeout ${
      deadline === undefined ? "none" : `${timeoutMs}s`
    })…`
  );

  let terminal = false;
  let verdict: RunStatusResponse["verdict"] = "pending";
  let phase = "unknown";
  let executedCount = 0;

  while (deadline === undefined || Date.now() < deadline) {
    const result = await fetchRunStatus(statusUrl, apiKey);
    if (result === null) {
      // Transient fetch failure — keep polling; the run is still progressing.
      core.warning("Status request failed; will retry.");
    } else {
      verdict = result.verdict;
      phase = result.phase;
      executedCount = result.executedCount;
      core.info(
        `phase=${phase} verdict=${verdict} executed=${executedCount}`
      );
      // The server is the sole authority on completion: gate the loop on
      // `isTerminal`, never on raw counts.
      if (result.isTerminal) {
        terminal = true;
        break;
      }
    }
    await sleep(pollIntervalMs);
  }

  const finalStatus = terminal ? phase : "timeout";
  const finalVerdict = terminal ? verdict : "timeout";
  const runUrl = `https://app.checksum.ai/#/test-runs/${runId}`;

  core.setOutput("status", finalStatus);
  core.setOutput("verdict", finalVerdict);
  core.setOutput("test-run-id", runId);

  await core.summary
    .addHeading("Checksum AI sharded test run", 3)
    .addList([
      `Mode: \`${mode}\``,
      `Run id: \`${runId}\``,
      `Phase: \`${finalStatus}\``,
      `Verdict: \`${finalVerdict}\``,
      `Tests executed: \`${executedCount}\``,
      `Test run: ${runUrl}`,
    ])
    .write();

  if (!terminal) {
    core.setFailed(
      `Timed out after ${timeoutMs}s waiting for the sharded run to terminate (last phase: ${phase}). View: ${runUrl}`
    );
    return;
  }
  // Pass the CI check iff the server says `verdict === "pass"`. `verdict` is
  // "fail" for an infra error AND for an empty selection (executedCount === 0).
  if (verdict !== "pass") {
    core.setFailed(
      `Sharded run terminated with verdict: ${verdict} (phase: ${phase}, executed: ${executedCount}). View: ${runUrl}`
    );
    return;
  }
  core.info(
    `Sharded run passed (executed: ${executedCount}). View: ${runUrl}`
  );
}

async function fetchRunStatus(
  url: string,
  apiKey: string
): Promise<RunStatusResponse | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { ChecksumAppCode: apiKey },
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    core.warning(`Status endpoint returned HTTP ${response.status}; will retry.`);
    return null;
  }
  try {
    const body = (await response.json()) as Partial<RunStatusResponse>;
    if (typeof body.isTerminal !== "boolean") return null;
    return {
      isTerminal: body.isTerminal,
      verdict:
        body.verdict === "pass" || body.verdict === "fail"
          ? body.verdict
          : "pending",
      phase: typeof body.phase === "string" ? body.phase : "unknown",
      executedCount:
        typeof body.executedCount === "number" ? body.executedCount : 0,
    };
  } catch {
    return null;
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

  return {
    mode: "grep",
    url: `${baseUrl}/public-api/v2/execution/grep`,
    payload,
  };
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

/**
 * Attach `shardCount` / `workers` to the payload when sharding is requested.
 * Returns the effective shard count (1 = single-pod). Sharding (>= 2) is
 * incompatible with auto-heal — the server rejects the pair with 400, so we
 * fail early here with a clearer message.
 */
function attachShardingIfEnabled(payload: Record<string, unknown>): number {
  const shardCount = parseBoundedIntInput(
    "shard-count",
    SHARD_COUNT_MIN,
    SHARD_COUNT_MAX
  );
  const workers = parseBoundedIntInput("workers", WORKERS_MIN, WORKERS_MAX);

  if (workers !== undefined && (shardCount === undefined || shardCount < 2)) {
    core.warning(
      "`workers` is only honored when `shard-count` >= 2; ignoring it."
    );
  }

  if (shardCount === undefined || shardCount < 2) {
    // Single-pod: omit the fields entirely for byte-for-byte legacy behavior.
    return shardCount ?? 1;
  }

  if (core.getBooleanInput("auto-heal")) {
    throw new Error(
      "`shard-count` >= 2 is incompatible with `auto-heal`. Sharding fans an immutable selection across pods, which auto-heal (which mutates the suite mid-run) cannot honor. Omit one of them."
    );
  }

  payload.shardCount = shardCount;
  if (workers !== undefined) payload.workers = workers;
  return shardCount;
}

function parseBoundedIntInput(
  name: string,
  min: number,
  max: number
): number | undefined {
  const raw = core.getInput(name);
  if (raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `\`${name}\` must be an integer in [${min}, ${max}], got: ${raw}`
    );
  }
  return parsed;
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
