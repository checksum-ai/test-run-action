import * as core from "@actions/core";
import { execSync } from "node:child_process";

const AFFECTED_TIMEOUT_MS = 300_000;
const MAX_CHANGED_FILES = 1000;
const SAFE_REF = /^[A-Za-z0-9._/~^@-]+$/;
const SAFE_GIT_DIR = /^[A-Za-z0-9._/\-]+$/;

export type AffectedTestsResponse = {
  affectedTestIds: string[];
};

/** Same pattern as `checksumai test --cksm-affected` (runtime tests-runner). */
export function buildGrepPatternFromAffectedIds(testIds: string[]): string {
  const grepIds = [...testIds]
    .sort()
    .map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `(${grepIds.join("|")})`;
}

export async function fetchAffectedTestIds(
  baseUrl: string,
  apiKey: string,
  changedFiles: string[]
): Promise<string[]> {
  if (changedFiles.length === 0) {
    throw new Error(
      "changed-files is empty. Pass `changed-files:` or `git-base-ref:` when `affected: true`."
    );
  }
  if (changedFiles.length > MAX_CHANGED_FILES) {
    throw new Error(
      `changed-files exceeds ${MAX_CHANGED_FILES} entries; use a closer git-base-ref or narrow the diff.`
    );
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/public-api/v1/affected-tests`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AFFECTED_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ChecksumAppCode: apiKey,
      },
      body: JSON.stringify({ changedFiles }),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `Affected-tests request timed out after ${AFFECTED_TIMEOUT_MS / 1000}s. ` +
          "Narrow the diff (closer git-base-ref) or run the full suite with `grep:`."
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Affected-tests request failed (HTTP ${response.status}). Body: ${bodyText}`
    );
  }

  let parsed: Partial<AffectedTestsResponse>;
  try {
    parsed = JSON.parse(bodyText) as Partial<AffectedTestsResponse>;
  } catch {
    throw new Error(
      `Affected-tests returned HTTP ${response.status} but body was not valid JSON: ${bodyText}`
    );
  }

  const ids = parsed.affectedTestIds;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.length > 0)) {
    throw new Error(
      `Affected-tests response missing a valid "affectedTestIds" array: ${bodyText}`
    );
  }
  return ids;
}

/**
 * Resolve changed files from the explicit `changed-files` input, or from a
 * local `git diff` against `git-base-ref`. Returns `null` when neither is
 * provided so the caller can fall back to reading the PR's files from the
 * GitHub API (the no-checkout path).
 */
export function resolveChangedFiles(): string[] | null {
  const explicit = core.getMultilineInput("changed-files", { required: false });
  const fromExplicit = explicit
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (fromExplicit.length > 0) {
    const baseRef = core.getInput("git-base-ref").trim();
    if (baseRef) {
      core.warning(
        "`git-base-ref` is ignored when `changed-files` is provided."
      );
    }
    return fromExplicit;
  }

  const baseRef = core.getInput("git-base-ref").trim();
  if (!baseRef) {
    // Neither input provided — caller falls back to the PR's files via the API.
    return null;
  }

  return getChangedFilesFromGit(baseRef, core.getInput("git-dir").trim() || undefined);
}

function getChangedFilesFromGit(baseRef: string, gitDir?: string): string[] {
  assertSafeRef(baseRef);
  const git = (cmd: string) => {
    const full = gitDir ? wrapGitCommand(cmd, gitDir) : cmd;
    return execSync(full, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  };

  let mergeBase: string;
  try {
    mergeBase = git(`git merge-base HEAD ${baseRef}`);
  } catch {
    throw new Error(
      `Could not resolve merge-base for git-base-ref "${baseRef}". ` +
        "Fetch the base branch (git fetch origin <base>) and ensure fetch-depth: 0."
    );
  }
  if (!mergeBase) {
    throw new Error(`Unexpected empty merge-base for git-base-ref "${baseRef}".`);
  }

  const diff = git(`git diff --name-only ${mergeBase}..HEAD`);
  return diff
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function wrapGitCommand(cmd: string, gitDir: string): string {
  if (!cmd.startsWith("git ")) {
    throw new Error(`Expected git command, got: ${cmd}`);
  }
  if (!SAFE_GIT_DIR.test(gitDir)) {
    throw new Error(
      `Unsafe git-dir: "${gitDir}". Only letters, digits and . _ / - are allowed.`
    );
  }
  return `git -C "${gitDir}" ${cmd.slice(4)}`;
}

function assertSafeRef(ref: string): void {
  if (!SAFE_REF.test(ref)) {
    throw new Error(
      `Unsafe git-base-ref: "${ref}". Only letters, digits and . _ / - ~ ^ @ are allowed.`
    );
  }
}
