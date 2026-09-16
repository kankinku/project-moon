export type TaskRiskLevel = "low" | "medium" | "high";

export type TaskState =
  | "CONTEXT_READY"
  | "BRIEF_READY"
  | "PLAN_READY"
  | "VALIDATING"
  | "VALIDATION_FAILED"
  | "VERIFIED"
  | "COMPLETE";

export type TaskArtifactKind = "context_brief" | "plan";

export interface TaskDiscovery {
  topLevelEntries: string[];
  trackedFileCount: number;
  trackedFiles: string[];
  packageScripts: Record<string, string>;
  policyFiles: string[];
  configFile?: string;
}

export interface TaskRiskAssessment {
  level: TaskRiskLevel;
  reasons: string[];
  hint?: TaskRiskLevel;
}

export interface TaskValidationCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface TaskValidationEvidence {
  profile: string;
  requiredProfile: string;
  passed: boolean;
  fingerprint: string;
  completedAt: string;
  results: TaskValidationCommandResult[];
}

export interface TaskManifest {
  schemaVersion: 1;
  runId: string;
  repoRoot: string;
  branch: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  state: TaskState;
  request: string;
  domainContext?: string;
  artifactDir: string;
  artifacts: Partial<Record<TaskArtifactKind, string>>;
  discovery: TaskDiscovery;
  risk: TaskRiskAssessment;
  policySnapshot: {
    file: string;
    sha256: string;
    sourceFile?: string;
  };
  repositoryIndex: {
    file: string;
    sha256: string;
  };
  validation?: TaskValidationEvidence;
  completedAt?: string;
}

export interface ArchitectureLayerRule {
  name: string;
  patterns: string[];
}

export interface ArchitectureDenyRule {
  from: string;
  to: string;
}

export interface ArchitectureMaxFileLinesRule {
  pattern: string;
  max: number;
}

export interface MoonHarnessConfig {
  schemaVersion: 1;
  validation: {
    profileOrder: string[];
    profiles: Record<string, string[]>;
    riskProfiles: Record<TaskRiskLevel, string>;
  };
  risk: {
    highPathPatterns: string[];
    mediumPathPatterns: string[];
    highKeywords: string[];
    mediumKeywords: string[];
  };
  architecture?: {
    layers: ArchitectureLayerRule[];
    deny: ArchitectureDenyRule[];
    maxFileLines: ArchitectureMaxFileLinesRule[];
  };
  knowledge?: {
    maxPermanentDocs: number;
    ephemeralPatterns: string[];
    generatedPatterns: string[];
  };
}
