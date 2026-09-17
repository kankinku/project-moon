export type MergeAuditDecision = "MERGE_APPROVED" | "CHANGES_REQUIRED" | "BLOCKED";

export type MergeAuditState =
  | "MERGE_REVIEW_CREATED"
  | "INPUT_PINNED"
  | "INDEPENDENT_REVIEW"
  | MergeAuditDecision;

export interface MergeAuditManifest {
  schemaVersion: 1;
  runId: string;
  repoRoot: string;
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;
  mergeBase: string;
  approvalSha?: string;
  request?: string;
  internalAuditSummary?: string;
  createdAt: string;
  updatedAt: string;
  state: MergeAuditState;
  decision?: MergeAuditDecision;
  rationale?: string;
  unresolvedP1?: number;
  changedFiles: string[];
  diffStat: string;
  artifactDir: string;
}
