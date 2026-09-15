# Optional NVIDIA GPU Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in NVIDIA GPU path that exposes the RTX 5060 Ti to `cokacremote-local`, verifies `nvidia-smi`, and preserves the existing CPU deployment and security boundaries.

**Architecture:** Keep the base Compose file CPU-portable and merge a focused GPU overlay only when `Start-PublicMcp.ps1 -Gpu` is used. Perform host and Docker preflight checks before container mutation, then use a separate structured verifier for live container evidence.

**Tech Stack:** Docker Compose, NVIDIA Container Toolkit, PowerShell 7, Nginx, Node.js MCP service

---

### Task 1: Prove the GPU configuration is absent

**Files:**
- Test target: `tunneling/docker-compose.gpu.yml`

- [ ] **Step 1: Run the missing-overlay acceptance check**

```powershell
docker compose --env-file tunneling/.env.local -f tunneling/docker-compose.local.yml -f tunneling/docker-compose.gpu.yml config --quiet
```

Expected: FAIL because `tunneling/docker-compose.gpu.yml` does not exist.

- [ ] **Step 2: Confirm the running container has no GPU request**

```powershell
docker inspect cokacremote-local --format '{{json .HostConfig.DeviceRequests}}'
```

Expected: `null`.

### Task 2: Add the GPU Compose overlay

**Files:**
- Create: `tunneling/docker-compose.gpu.yml`

- [ ] **Step 1: Add the minimum GPU service override**

```yaml
services:
  workmachine:
    gpus: all
    environment:
      NVIDIA_VISIBLE_DEVICES: all
      NVIDIA_DRIVER_CAPABILITIES: compute,utility
```

- [ ] **Step 2: Verify both Compose modes**

```powershell
docker compose --env-file tunneling/.env.local -f tunneling/docker-compose.local.yml config --quiet
docker compose --env-file tunneling/.env.local -f tunneling/docker-compose.local.yml -f tunneling/docker-compose.gpu.yml config
```

Expected: both exit zero; GPU output contains a device request plus `compute,utility`.

### Task 3: Integrate GPU preflight and activation

**Files:**
- Modify: `Start-PublicMcp.ps1`

- [ ] **Step 1: Add the opt-in parameter and Compose argument list**

```powershell
[CmdletBinding()]
param([switch]$Gpu)

$composeArgs = @('--env-file', $localEnv)
if ($Gpu) {
    $composeArgs += @('-f', $gpuComposeFile)
}
```

All start/recreate calls will use the same constructed Compose arguments, including the existing base file and optional public environment file.

- [ ] **Step 2: Add non-mutating GPU preflight**

Before the first `docker compose up`, run host `nvidia-smi`, confirm `docker info` includes an `nvidia` runtime, and stop with a specific error if either check fails.

- [ ] **Step 3: Add post-start container verification**

After OAuth health succeeds, run:

```powershell
docker exec cokacremote-local nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
```

Expected: exit zero in GPU mode. Emit `GPU_ENABLED=true`; CPU mode emits `GPU_ENABLED=false`.

- [ ] **Step 4: Syntax-check the script**

```powershell
[scriptblock]::Create((Get-Content -Raw .\Start-PublicMcp.ps1)) | Out-Null
```

Expected: exit zero.

### Task 4: Add repeatable GPU diagnostics

**Files:**
- Create: `Test-Gpu.ps1`

- [ ] **Step 1: Implement structured checks**

The script must query host `nvidia-smi`, Docker runtime registration, `HostConfig.DeviceRequests`, and container `nvidia-smi`. It must return JSON fields `status`, `host`, `dockerRuntime`, `containerDeviceRequest`, and `container`, and exit nonzero on any failed requirement.

- [ ] **Step 2: Syntax-check the verifier**

```powershell
[scriptblock]::Create((Get-Content -Raw .\Test-Gpu.ps1)) | Out-Null
```

Expected: exit zero.

### Task 5: Document operation and rollback

**Files:**
- Modify: `LOCAL_DOCKER_SETUP.md`

- [ ] **Step 1: Document GPU start and verification**

Add the commands:

```powershell
.\Start-PublicMcp.ps1 -Gpu
.\Test-Gpu.ps1
```

State that CPU mode remains `.\Start-PublicMcp.ps1`, only `workmachine` receives the GPU, and no CUDA application framework is installed.

- [ ] **Step 2: Document rollback**

Explain that running the start script without `-Gpu` recreates `workmachine` without a GPU request while retaining OAuth state.

### Task 6: Deploy and verify

**Files:**
- Test: `tunneling/docker-compose.local.yml`
- Test: `tunneling/docker-compose.gpu.yml`
- Test: `Start-PublicMcp.ps1`
- Test: `Test-Gpu.ps1`

- [ ] **Step 1: Start the GPU deployment**

```powershell
.\Start-PublicMcp.ps1 -Gpu
```

Expected: public MCP URL, OAuth enabled, and GPU enabled.

- [ ] **Step 2: Verify live GPU access**

```powershell
.\Test-Gpu.ps1
docker exec cokacremote-local nvidia-smi
```

Expected: PASS and RTX 5060 Ti details.

- [ ] **Step 3: Verify public OAuth**

```powershell
node .\scripts\verify-public-oauth.mjs
```

Expected: all OAuth and authenticated MCP checks PASS with `secretsPrinted: false`.

- [ ] **Step 4: Run the Linux regression suite**

```powershell
docker run --rm --entrypoint /bin/bash cokacremote-local:0.1.0 -lc 'cd /opt/cokacremote && npm ci --include=dev && npm test && npm run typecheck && npm run build && npm audit --omit=dev'
```

Expected: 39 tests pass, typecheck/build exit zero, zero production vulnerabilities.

- [ ] **Step 5: Recheck isolation and secrets**

Confirm port host IP is `127.0.0.1`, only `shared/` is host-bound, Docker socket is absent, `cloudflared` has no GPU request, `git diff --check` passes, and changed files contain no credential patterns.

- [ ] **Step 6: Commit the implementation**

```powershell
git add Start-PublicMcp.ps1 Test-Gpu.ps1 LOCAL_DOCKER_SETUP.md tunneling/docker-compose.gpu.yml
git commit -m "feat: add optional NVIDIA GPU support"
```
