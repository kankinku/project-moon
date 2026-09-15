export type ReviewState =
  | "CONTEXT_READY"
  | "INTENT_READY"
  | "CRITERIA_READY"
  | "REVIEW_READY"
  | "REVIEWED"
  | "FIXING"
  | "QA"
  | "QA_FAILED"
  | "PASSED";

export type ReviewArtifactKind =
  | "design_intent"
  | "criteria"
  | "pr_body"
  | "review"
  | "decisions"
  | "final_report";

export interface ReviewWorktree {
  path: string;
  mode: "detached" | "writable";
  branch?: string;
  createdAt: string;
}

export interface QaCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ReviewManifest {
  schemaVersion: 1;
  runId: string;
  repoRoot: string;
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;
  mergeBase: string;
  createdAt: string;
  updatedAt: string;
  state: ReviewState;
  dirtyAtStart: boolean;
  changedFiles: string[];
  diffStat: string;
  artifactDir: string;
  artifacts: Partial<Record<ReviewArtifactKind, string>>;
  reviewGate?: {
    p1Findings: number;
    unresolvedP1: number | null;
  };
  worktree?: ReviewWorktree;
  qa?: {
    passed: boolean;
    targetPath: string;
    completedAt: string;
    results: QaCommandResult[];
  };
}
