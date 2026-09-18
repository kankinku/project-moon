export type MergeAuditDecision = "MERGE_APPROVED" | "CHANGES_REQUIRED" | "BLOCKED";

export type MergeAuditState =
  | "MERGE_REVIEW_CREATED"
  | "INPUT_PINNED"
  | "INDEPENDENT_REVIEW"
  | MergeAuditDecision;

export type MergeAuditSeverity = "P1" | "P2" | "P3" | "P4";

export type MergeAuditCategory =
  | "requirements"
  | "correctness"
  | "code_quality"
  | "tests"
  | "regression"
  | "architecture"
  | "api_contracts"
  | "security"
  | "performance"
  | "operations"
  | "maintainability";

export type MergeAuditCoverageVerdict = "PASS" | "CONCERN" | "NOT_APPLICABLE";

export interface MergeAuditFinding {
  id: string;
  severity: MergeAuditSeverity;
  category: MergeAuditCategory;
  title: string;
  evidence: string;
  file?: string;
  line?: number;
  recommendation?: string;
  resolved: boolean;
}

export interface MergeAuditCoverage {
  category: MergeAuditCategory;
  verdict: MergeAuditCoverageVerdict;
  evidence: string;
}

export interface MergeAuditValidationEvidence {
  source: "moon_task" | "moon_review" | "github_ci" | "external_ci";
  profile: string;
  headSha: string;
  passed: boolean;
  reference: string;
  summary: string;
}

export interface MergeAuditRisk {
  level: "low" | "medium" | "high";
  reasons: string[];
  requiredValidationProfile: string;
  validationProfileOrder: string[];
}

export interface MergeAuditTarget {
  repository: string;
  pullNumber: number;
}

export interface MergeAuditManifest {
  schemaVersion: 2;
  runId: string;
  repoRoot: string;
  target: MergeAuditTarget;
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
  findings?: MergeAuditFinding[];
  coverage?: MergeAuditCoverage[];
  validationEvidence?: MergeAuditValidationEvidence[];
  risk: MergeAuditRisk;
  changedFiles: string[];
  diffStat: string;
  artifactDir: string;
}
