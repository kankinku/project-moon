import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { startHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";

describe("opt-in provider metadata diagnostic (synthetic MCP clients)", () => {
  it("reads only SDK metadata, compares across stateless calls, and never attests provider identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "moon-metadata-test-"));
    const config = loadConfig({ MCP_AUTH_TOKEN: "synthetic-auth", MCP_HOST: "127.0.0.1",
      MCP_DEFAULT_CWD: root, MCP_PROVIDER_METADATA_PROBE: "true" }, root);
    config.port = 0;
    const running = await startHttpServer(config, createServices(config));
    try {
      const endpoint = new URL(config.endpoint, "http://127.0.0.1:" + (running.httpServer.address() as AddressInfo).port);
      async function rpc(method: string, params: object, authenticated = true) {
        const response = await fetch(endpoint, { method: "POST", headers: {
          "content-type": "application/json", accept: "application/json, text/event-stream",
          ...(authenticated ? { authorization: "Bearer synthetic-auth" } : {}),
        }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        return { status: response.status, body: await response.json() };
      }
      const listed = await rpc("tools/list", {});
      expect(listed.body.result.tools.map((x: {name: string}) => x.name)).toContain("provider_metadata_probe");
      const call = (meta: Record<string, unknown>, args: Record<string, unknown> = {}) =>
        rpc("tools/call", {name: "provider_metadata_probe", arguments: args, _meta: meta});
      expect((await rpc("tools/call", {name: "provider_metadata_probe", arguments: {}}, false)).status).toBe(401);
      const first = await call({"openai/subject":"synthetic-private-subject","openai/session":"synthetic-private-session"});
      expect(first.status).toBe(200);
      const data = first.body.result.structuredContent;
      expect(data).toMatchObject({ providerProof: false, freshContext: "unproven",
        subject: {type:"string",sameAsBaseline:null}, session:{type:"string",sameAsBaseline:null} });
      expect(JSON.stringify(first)).not.toContain("synthetic-private-");
      expect(data.sdkAuthInfoPresent).toBe(false);
      expect(data.uncontractedCandidateTypes["openai/model"]).toBe("missing");
      const same = await call({"openai/subject":"synthetic-private-subject","openai/session":"synthetic-private-session"},{baselineId:data.baselineId});
      expect(same.body.result.structuredContent).toMatchObject({subject:{sameAsBaseline:true},session:{sameAsBaseline:true},providerProof:false});
      const different = await call({"openai/subject":"synthetic-private-subject","openai/session":"synthetic-other-session"},{baselineId:data.baselineId});
      expect(different.body.result.structuredContent).toMatchObject({subject:{sameAsBaseline:true},session:{sameAsBaseline:false},freshContext:"unproven",providerProof:false});
      const missing = await call({}, {baselineId:data.baselineId,"openai/session":"synthetic-private-session"});
      expect(missing.body.result.structuredContent).toMatchObject({session:{type:"missing",sameAsBaseline:null},providerProof:false});
      const unknown = await call({}, {baselineId:"00000000-0000-4000-8000-000000000000"});
      expect(unknown.body.result.isError).toBe(true);
      const candidates = await call({"openai/model":"synthetic-model-value","openai/invocationId":"synthetic-invocation-value"},{baselineId:data.baselineId});
      expect(candidates.body.result.structuredContent).toMatchObject({providerProof:false,uncontractedCandidateTypes:{"openai/model":"string","openai/invocationId":"string"}});
      expect(JSON.stringify(candidates)).not.toContain("synthetic-model-value");
      expect(JSON.stringify(candidates)).not.toContain("synthetic-invocation-value");
      const malformed = await call({"openai/subject":{},"openai/session":12},{baselineId:data.baselineId});
      expect(malformed.body.result.structuredContent).toMatchObject({subject:{type:"object",sameAsBaseline:null},session:{type:"number",sameAsBaseline:null}});
    } finally {
      await running.close();
      await rm(root,{recursive:true,force:true});
    }
  });
});
