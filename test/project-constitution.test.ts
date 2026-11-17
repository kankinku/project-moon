import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, it, expect } from "vitest";
import { loadProjectConstitution } from "../src/task/project-constitution.js";

describe("project constitution gate", () => {
  it("requires real policy files and returns their contents at task start", async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),"moon-project-constitution-"));
    const registry=path.join(root,"registry.json");
    const repo=path.join(root,"repo");
    await mkdir(path.join(repo,".agent"),{recursive:true});
    const origin="https://github.com/example/demo.git";
    await writeFile(registry,JSON.stringify({schemaVersion:1,projects:{Demo:{root:repo,origin,required:["AGENTS.md",".agent/CONSTITUTION.md"]}}}));
    await writeFile(path.join(repo,"AGENTS.md"),"# Agent rules");
    await expect(loadProjectConstitution(repo,origin,registry)).rejects.toThrow("PROJECT_CONSTITUTION_REQUIRED");
    await writeFile(path.join(repo,".agent/CONSTITUTION.md"),"# Project law");
    const result=await loadProjectConstitution(repo,origin,registry);
    expect(result?.project).toBe("Demo");
    expect(result?.policies[".agent/CONSTITUTION.md"]).toBe("# Project law");
    expect(result?.policyDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(loadProjectConstitution(root,origin,registry)).rejects.toThrow("PROJECT_ROOT_MISMATCH");
    await rm(root,{recursive:true,force:true});
  });
  it("leaves unregistered independent repos unaffected", async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),"moon-unregistered-"));
    const reg=path.join(root,"registry.json");
    await writeFile(reg,JSON.stringify({schemaVersion:1,projects:{}}));
    expect(await loadProjectConstitution(root,"https://github.com/x/y.git",reg)).toBeUndefined();
    await rm(root,{recursive:true,force:true});
  });
});
