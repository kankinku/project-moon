import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { AppConfig } from "./config.js";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "./tool-metadata.js";
import { runTool } from "./tool-result.js";

const TTL_MS = 15 * 60 * 1000;
const MAX_BASELINES = 32;
type Digest = string | null;
type Baseline = { expiresAt: number; subject: Digest; session: Digest };

function valueType(value: unknown): string {
  return value === undefined ? "missing" : value === null ? "null" :
    Array.isArray(value) ? "array" : typeof value;
}

// Diagnostic correlation only. Never a provider attestation. No raw identifiers,
// hashes, tokens, headers, or payloads are returned, logged, or written to disk.
export class ProviderMetadataProbe {
  private readonly key = randomBytes(32);
  private readonly baselines = new Map<string, Baseline>();

  private digest(field: string, value: unknown): Digest {
    if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
    return createHmac("sha256", this.key).update(JSON.stringify([field, value])).digest("hex");
  }

  observe(meta: Record<string, unknown> | undefined, sdkAuthInfoPresent: boolean, baselineId?: string): Record<string, unknown> {
    const now = Date.now();
    for (const [id, baseline] of this.baselines) {
      if (baseline.expiresAt <= now) this.baselines.delete(id);
    }
    const subject = meta?.["openai/subject"];
    const session = meta?.["openai/session"];
    const subjectDigest = this.digest("subject", subject);
    const sessionDigest = this.digest("session", session);
    const baseline = baselineId ? this.baselines.get(baselineId) : undefined;
    if (baselineId && !baseline) throw new Error("Diagnostic baseline unavailable or expired; start a new baseline");
    const comparison = (value: Digest, prior: Digest | undefined) =>
      value !== null && prior != null ? value === prior : null;

    if (!baselineId) {
      if (this.baselines.size >= MAX_BASELINES) {
        const oldest = this.baselines.keys().next().value;
        if (oldest !== undefined) this.baselines.delete(oldest);
      }
      baselineId = randomUUID();
      this.baselines.set(baselineId, {expiresAt: now + TTL_MS, subject: subjectDigest, session: sessionDigest});
    }

    return {
      baselineId,
      subject: { type: valueType(subject), sameAsBaseline: comparison(subjectDigest, baseline?.subject) },
      session: { type: valueType(session), sameAsBaseline: comparison(sessionDigest, baseline?.session) },
      sdkAuthInfoPresent,
      // These names are exploratory, not a documented OpenAI provider-proof contract.
      uncontractedCandidateTypes: Object.fromEntries(
        ["openai/model", "openai/invocationId", "openai/responseId", "openai/turnId", "openai/requestId"]
          .map(name => [name, valueType(meta?.[name])]),
      ),
      providerProof: false,
      freshContext: "unproven",
    };
  }
}

export function registerProviderMetadataProbe(server: McpServer, config: AppConfig, probe: ProviderMetadataProbe): void {
  server.registerTool("provider_metadata_probe", {
    title: "Observe ChatGPT metadata (diagnostic only)",
    description: "Opt-in diagnostic: reports only types and equality of client-declared SDK metadata. No provider proof. Omit baselineId for a new temporary comparison baseline.",
    inputSchema: { baselineId: z.string().uuid().optional() },
    annotations: TOOL_ANNOTATIONS.additiveNonIdempotentClosed,
    _meta: toolAuthMetadata(config),
  }, ({ baselineId }, extra) => runTool(() => probe.observe(extra._meta, extra.authInfo !== undefined, baselineId)));
}
