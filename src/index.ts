import * as core from "@actions/core";
import * as github from "@actions/github";

type ExecMode = "grep" | "suite" | "tests" | "collection";

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

  const plan = buildDispatchPlan(baseUrl);
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

  let parsed: { name?: string } = {};
  try {
    parsed = JSON.parse(bodyText) as { name?: string };
  } catch {
    core.setFailed(
      `Execution dispatch returned HTTP ${response.status} but body was not valid JSON: ${bodyText}`
    );
    return;
  }

  const jobName = parsed.name;
  if (!jobName) {
    core.setFailed(
      `Execution dispatch returned HTTP ${response.status} but response had no "name" field: ${bodyText}`
    );
    return;
  }

  core.setOutput("job-name", jobName);
  core.info(`Dispatched. Job name: ${jobName}`);

  if (!core.getBooleanInput("wait")) {
    await core.summary
      .addHeading("Checksum AI test run dispatched", 3)
      .addList([
        `Mode: \`${plan.mode}\``,
        `Job name: \`${jobName}\``,
        `Auto-heal: \`${core.getBooleanInput("auto-heal") ? "enabled" : "disabled"}\``,
      ])
      .write();
    return;
  }

  await waitForCompletion(baseUrl, apiKey, jobName, plan.mode);
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

function buildDispatchPlan(baseUrl: string): DispatchPlan {
  // GitHub Actions sets INPUT_* env vars for every input declared in
  // action.yml regardless of whether the caller set them, so we cannot
  // distinguish "set to empty string" from "not set". Mode auto-detection
  // therefore requires a non-empty value on exactly one mode input.
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

  if (provided.length > 1) {
    throw new Error(
      `Provide exactly one execution mode input. Got: ${provided
        .map(([k]) => k)
        .join(", ")}.`
    );
  }
  if (provided.length === 0) {
    throw new Error(
      "Provide one of: `grep`, `suite-ids`, `test-ids`, or `collection-id`."
    );
  }

  const mode = provided[0]![0];
  warnOnIgnoredInputs(mode);

  if (mode === "grep") return planGrep(baseUrl, grep);
  if (mode === "suite-ids") return planSuite(baseUrl, suiteIds);
  if (mode === "test-ids") return planTests(baseUrl, testIds);
  return planCollection(baseUrl, collectionId);
}

function warnOnIgnoredInputs(mode: string): void {
  if (mode === "grep") return;
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
