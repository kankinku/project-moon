# Optional NVIDIA GPU Support Design

## Goal

Allow the existing `project-moon-local` Docker service to use the host NVIDIA GPU and run `nvidia-smi` without making GPU hardware a requirement for the normal CPU deployment. Preserve the current Nginx, OAuth, Tailscale Funnel, storage, and host-isolation behavior.

## Current Evidence

- The host exposes an NVIDIA GeForce RTX 5060 Ti with 16 GB VRAM through driver 576.88.
- Docker Desktop runs a Linux daemon and reports the `nvidia` container runtime.
- The running `project-moon-local` container has no Docker GPU device request, so it cannot currently use the GPU.
- Driver 576.88 satisfies NVIDIA's Windows driver requirement for CUDA 12.9 Update 1.

## Chosen Approach

GPU support is an explicit Compose overlay selected by a `-Gpu` switch on the existing public-start script.

The base `tunneling/docker-compose.local.yml` remains the portable CPU definition. A new `tunneling/docker-compose.gpu.yml` augments only the `workmachine` service with access to all NVIDIA GPUs and the `compute,utility` driver capabilities. `compute` permits CUDA/OpenCL workloads and `utility` provides NVML and `nvidia-smi`.

The base Ubuntu application image remains unchanged. NVIDIA Container Toolkit injects the driver utilities and libraries requested by the GPU device allocation. This avoids coupling the MCP server to a large CUDA development image; workloads that require a particular CUDA userspace framework remain responsible for installing or providing that framework.

## Components

### GPU Compose overlay

- Requests all GPUs for `workmachine` using the Docker Compose GPU device contract.
- Sets `NVIDIA_VISIBLE_DEVICES=all`.
- Sets `NVIDIA_DRIVER_CAPABILITIES=compute,utility`.
- Does not involve the host-level Tailscale process in Docker GPU access.
- Does not add privileged mode, Docker socket access, or new host mounts.

### Startup integration

`Start-PublicMcp.ps1 -Gpu` will:

1. Verify that host `nvidia-smi` succeeds.
2. Verify that Docker advertises the NVIDIA runtime.
3. include the GPU Compose overlay in every Compose invocation used during the start/recreate flow.
4. Recreate `workmachine` with its GPU device request while preserving the OAuth state volume and host-level Tailscale Funnel configuration.
5. Verify `nvidia-smi` inside `project-moon-local` before reporting success.

Calling `Start-PublicMcp.ps1` without `-Gpu` retains the current CPU behavior.

### GPU verifier

A separate `Test-Gpu.ps1` command will provide a repeatable diagnostic. It will check the host GPU, Docker runtime registration, container device request, and container `nvidia-smi`. Its normal output will be structured JSON containing status, GPU model, driver version, reported CUDA version, and memory size. It will not print OAuth keys, tokens, environment contents, or unrelated device data.

## Failure Handling

- Missing host `nvidia-smi`: stop before changing containers and report that the NVIDIA Windows driver is unavailable.
- Missing Docker NVIDIA runtime: stop before changing containers and identify Docker Desktop GPU support as unavailable.
- Container GPU allocation or `nvidia-smi` failure: report a failed GPU deployment; do not claim GPU readiness.
- CPU mode remains available independently after any GPU preflight failure.
- Existing OAuth state and approval key remain in the named volume; GPU activation must not delete volumes.

## Security and Isolation

- Preserve loopback-only host port `127.0.0.1:2999`.
- Preserve the single host bind mount to `shared/`.
- Preserve the absence of `/var/run/docker.sock` inside the container.
- Request only `compute,utility`, not graphics, display, video, or every NVIDIA capability.
- Keep OAuth mandatory for the public MCP endpoint.

## Verification

Implementation is complete only when all of the following pass:

1. The GPU overlay fails Compose rendering before it exists, proving the acceptance check detects the missing feature.
2. CPU-only Compose configuration still renders successfully.
3. GPU Compose configuration renders with a GPU device request and `compute,utility`.
4. `Start-PublicMcp.ps1 -Gpu` completes on this host.
5. `docker inspect project-moon-local` shows an NVIDIA GPU device request.
6. `docker exec project-moon-local nvidia-smi` identifies the RTX 5060 Ti.
7. `Test-Gpu.ps1` reports PASS without secrets.
8. Public OAuth end-to-end verification still passes at the active MCP URL.
9. The existing Linux test suite, typecheck, build, and production dependency audit still pass.
10. Port, bind-mount, Docker-socket, and secret-scan checks remain clean.

## Non-Goals

- Installing PyTorch, TensorFlow, Ollama, CUDA compiler tools, or a model runtime.
- Changing host-level Tailscale/Funnel settings as part of GPU enablement.
- Selecting or partitioning individual GPUs; this host currently has one NVIDIA GPU.
- Changing the public hostname, OAuth protocol, MCP tool inventory, or shared-directory policy.
