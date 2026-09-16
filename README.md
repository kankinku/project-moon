# Project Moon

**한국어** | [English](README.en.md)

> ChatGPT·Codex·기타 MCP 클라이언트가 개발용 컴퓨터를 직접 조작할 수 있도록 연결하는 **풀 액세스 원격 개발 MCP 런타임**입니다.

Project Moon은 AI가 단순히 명령어를 제안하는 수준을 넘어, 실제 개발 환경에서 명령을 실행하고 파일을 수정하며 Git 상태를 확인하고 테스트·빌드·코드 리뷰까지 수행할 수 있도록 구성한 MCP 서버입니다.

현재 Project Moon은 **32개의 MCP 도구**를 제공합니다.

| 영역 | 도구 수 | 주요 기능 |
|---|---:|---|
| 명령·프로세스 | 6 | 셸 명령, 스크립트, 장기 실행 프로세스, stdin, 출력 조회, 종료 |
| 파일시스템 | 14 | 읽기, 쓰기, 패치, 업로드·다운로드, 해시, 복사, 이동, 삭제 |
| AI 작업 하니스 | 6 | 구조 파악, 계획, 위험도 분류, 프로그램적 검증, 완료 상태 관리 |
| 코드 리뷰 하니스 | 6 | Git 기준점 고정, 리뷰 상태, Worktree, QA, 검증 증거 관리 |

```text
ChatGPT / Codex / MCP Client
             │
             │ MCP over HTTPS + OAuth 2.1
             ▼
       Tailscale Funnel
             │
             ▼
      127.0.0.1:2999
             │
           Nginx
             │
             ▼
      Project Moon MCP
        127.0.0.1:3000
             │
     ┌───────┬──────────┬──────────┐
     ▼       ▼          ▼          ▼
   명령     파일     작업 하니스   리뷰 하니스
     │       │          │          │
     └───────┴──────────┴──────────┘
             │
             ▼
        개발 환경 / Git
```

> [!CAUTION]
> Project Moon은 **샌드박스가 아닙니다.** 명령 허용 목록, 경로 제한, 명령별 승인 게이트, 권한 축소 계층을 기본 제공하지 않습니다. Project Moon을 높은 권한으로 실행하면 인증된 AI 클라이언트 역시 그 권한으로 시스템을 제어할 수 있습니다. 신뢰할 수 있는 개인 개발 환경에서만 사용하고, 인터넷에 공개할 때는 반드시 HTTPS와 강한 인증을 사용하세요.

---

## Project Moon이 필요한 이유

일반적인 AI 코딩 흐름은 다음과 같습니다.

```text
AI가 명령 제안
→ 사람이 터미널에 입력
→ 결과 복사
→ AI에게 전달
→ 다음 명령 제안
```

Project Moon을 사용하면 다음과 같이 바뀝니다.

```text
AI가 상황 판단
→ Moon으로 직접 명령 실행
→ 결과 확인
→ 파일 수정
→ 테스트·빌드
→ Git 검증
→ 필요하면 코드 리뷰·수정
```

따라서 다음 작업을 하나의 AI 세션 안에서 처리할 수 있습니다.

- 컴퓨터 및 서버 상태 점검
- Git 저장소 clone / pull / diff / commit
- 프로젝트 코드 수정
- npm, Python, Docker 등 개발 명령 실행
- 장시간 실행되는 프로세스 관리
- 로그 조회 및 장애 분석
- 파일 업로드·다운로드 및 패치
- 테스트·타입체크·빌드 수행
- 작업 전 구조 파악과 구현 계획 고정
- 변경 위험도에 맞는 검증 프로필 자동 강제
- Git Worktree 기반 격리 수정
- 코드 리뷰와 QA 증거 저장
- 리뷰 이후 브랜치가 변경되었는지 감지

---

# Windows + Docker 빠른 시작

Project Moon을 개인 Windows 개발 PC에서 사용하는 경우 현재 권장 구성은 다음과 같습니다.

```text
Windows
├─ Docker Desktop
├─ Tailscale
├─ Project Moon 저장소
│  ├─ Start-PublicMcp.ps1
│  ├─ Stop-PublicMcp.ps1
│  └─ shared/
└─ Tailscale Funnel
       ↓
https://project-moon.<tailnet>.ts.net/mcp
```

## 1. 요구 사항

다음 프로그램이 필요합니다.

- Windows 10/11
- PowerShell
- Git
- Docker Desktop
- Tailscale

GPU 기능을 사용할 경우 추가로 다음이 필요합니다.

- NVIDIA GPU
- 정상 동작하는 NVIDIA 드라이버
- Docker의 NVIDIA GPU 런타임 지원

## 2. 저장소 받기

```powershell
git clone https://github.com/kankinku/project-moon.git
cd project-moon
```

이미 clone한 경우:

```powershell
git pull --ff-only origin main
```

## 3. 로컬 설정 준비

```powershell
Copy-Item tunneling\.env.local.example tunneling\.env.local
New-Item -ItemType Directory -Force shared
```

`tunneling/.env.local`은 로컬 전용 파일이며 Git에 포함되지 않습니다.

기본 예시는 다음과 같습니다.

```dotenv
TZ=Asia/Seoul
WORKMACHINE_IMAGE=project-moon-local:0.1.0
```

`shared/` 디렉터리는 컨테이너의 `/shared`로 연결됩니다. AI가 직접 다룰 프로젝트와 파일을 이 영역에 둘 수 있습니다.

## 4. Project Moon 실행

**관리자 권한 PowerShell**에서 실행합니다.

```powershell
.\Start-PublicMcp.ps1
```

스크립트는 자동으로 다음 작업을 수행합니다.

1. Tailscale 연결 상태 확인
2. Tailscale 호스트명을 `project-moon`으로 설정
3. Tailscale Funnel 활성화
4. 공개 `*.ts.net` HTTPS 주소 자동 감지
5. OAuth 공개 URL 자동 구성
6. Docker Compose 설정 검증
7. Project Moon 이미지 빌드 및 컨테이너 시작
8. 로컬 `/health` 검증
9. 공개 `/health` 검증

정상 실행되면 다음과 유사한 결과가 출력됩니다.

```text
PUBLIC_MCP_URL=https://project-moon.<tailnet>.ts.net/mcp
PUBLIC_HEALTH_URL=https://project-moon.<tailnet>.ts.net/health
PUBLIC_TRANSPORT=tailscale-funnel
OAUTH_ENABLED=true
GPU_ENABLED=false
```

> 최초 Tailscale Funnel 사용 시 Tailscale에서 Funnel 활성화를 승인해야 할 수 있습니다.

## 5. OAuth 승인 키 확인

Project Moon의 OAuth 연결 승인에 사용하는 키는 다음 명령으로 확인할 수 있습니다.

```powershell
.\Get-OAuthApprovalKey.ps1
```

이 값은 **비밀번호와 동일하게 취급**하세요. 저장소, 이슈, 로그, 채팅 등에 공개하면 안 됩니다.

## 6. 종료

```powershell
.\Stop-PublicMcp.ps1
```

이 명령은 Project Moon용 Funnel 리스너와 Docker 컨테이너를 중지합니다.

---

# GPU 사용

NVIDIA GPU를 컨테이너에서 사용하려면:

```powershell
.\Start-PublicMcp.ps1 -Gpu
```

Project Moon은 실행 전에 다음을 확인합니다.

- 호스트 `nvidia-smi`
- Docker NVIDIA 런타임
- 컨테이너 GPU Device Request
- 컨테이너 내부 `nvidia-smi`

실행 후 별도로 점검하려면:

```powershell
.\Test-Gpu.ps1
```

정상이면 `status: PASS`와 GPU/드라이버/CUDA 정보가 출력됩니다.

---

# MCP 도구

## 1. 명령 및 프로세스 관리 — 6개

| 도구 | 기능 |
|---|---|
| `exec_command` | 셸 명령, Git, 빌드, 테스트, 패키지 관리자, 시스템 명령 실행 |
| `run_script` | Bash, sh, Node.js, Python 등 전체 스크립트 실행 |
| `write_stdin` | 실행 중인 프로세스에 입력 전달 |
| `read_process` | 장기 실행 프로세스의 새 출력 및 상태 조회 |
| `terminate_process` | 프로세스 그룹에 `SIGINT`, `SIGTERM`, `SIGKILL` 전달 |
| `list_processes` | 실행 중이거나 최근 완료된 Moon 프로세스 목록 조회 |

명령이 즉시 끝나지 않으면 `sessionId`가 반환될 수 있습니다.

```text
exec_command
     │
     ├─ 즉시 완료 → 결과 반환
     │
     └─ 계속 실행 → sessionId
                       │
                       ├─ read_process
                       ├─ write_stdin
                       └─ terminate_process
```

프로세스 상태는 Project Moon 서비스 메모리에 유지되므로 MCP HTTP 요청이 달라져도 이어서 조회할 수 있습니다. 단, Project Moon 서비스가 재시작되면 해당 상태는 사라집니다.

## 2. 파일시스템 — 14개

### 조회

- `list_directory`
- `stat_path`
- `read_file`
- `hash_file`

### 수정

- `write_file`
- `replace_in_file`
- `apply_patch`
- `chmod_path`

### 전송

- `upload_file`
- `download_file`

### 구조 변경

- `make_directory`
- `copy_path`
- `move_path`
- `remove_path`

상대 경로는 `MCP_DEFAULT_CWD`를 기준으로 해석합니다.

> [!WARNING]
> `remove_path`는 휴지통을 거치지 않고 실제 파일을 삭제합니다. `apply_patch`는 호스트의 `git apply --unsafe-paths`를 사용합니다.

텍스트 파일은 UTF-8 경계를 보존하며, 바이너리 데이터는 Base64 방식으로 전송할 수 있습니다.

---

# AI 작업 하니스 — 6개

Project Moon의 작업 하니스는 에이전트가 곧바로 코드를 수정하는 대신 **구조 파악 → 브리핑 → 계획 → 구현 → 프로그램적 검증 → 완료** 순서로 작업하도록 돕습니다. 작업 산출물은 `.moon/` 아래의 로컬 런타임 데이터로 저장되며 Git에는 포함되지 않습니다.

| 도구 | 기능 |
|---|---|
| `task_start` | 현재 Git SHA와 하니스 정책을 고정하고 저장소 구조·위험도를 파악하여 작업 시작 |
| `task_context` | `brief`, `plan`, `execute`, `validate` 단계별 최소 관련 컨텍스트 제공 |
| `task_record` | 구조 브리핑과 구현 계획을 기록하고 상위 산출물 변경 시 기존 검증 무효화 |
| `task_validate` | 실제 변경 경로를 다시 분석하고 위험도에 맞는 프로그램적 검증 실행 |
| `task_complete` | 최신 검증을 통과했고 검증 후 코드가 바뀌지 않았을 때만 작업 완료 |
| `task_status` | 위험도, 변경 파일, 검증 신선도, `STALE`, 실패 반복·성능 회귀 상태 조회 |

일반적인 흐름:

```text
USER INTENT
    ↓
task_start
    ↓
task_context(brief)
    ↓
task_record(context_brief)
    ↓
task_context(plan)
    ↓
task_record(plan)
    ↓
구현
    ↓
task_validate
    ↓
task_complete
```

## 위험도 기반 검증

기본 검증 강도는 다음과 같습니다.

```text
LOW    → fast
MEDIUM → normal
HIGH   → release
```

Moon은 요청 내용뿐 아니라 **실제로 변경된 파일 경로**를 다시 확인하여 위험도를 올릴 수 있습니다. 인증, 보안, 배포, 네트워크, `moon.config.json` 같은 영역은 높은 검증 강도를 요구하도록 구성할 수 있습니다. 에이전트가 더 약한 프로필을 지정해도 현재 위험도보다 낮은 검증은 거부됩니다.

프로젝트별 규칙은 [`moon.config.json`](moon.config.json)에 선언합니다. 현재 Moon 자체의 `fast / normal / release` 프로필에는 Architecture Guard와 문서 감사가 항상 포함되고, 위험도가 높아질수록 타입체크·테스트·빌드가 추가됩니다.

## 정책 고정과 STALE 방지

`task_start`는 시작 시점의 `moon.config.json` 정책을 `.moon`에 복사하고 SHA-256으로 고정합니다. 따라서 작업 도중 에이전트가 현재 설정을 수정해 Architecture Guard나 검증 명령을 약화하더라도 **진행 중인 task run의 기준은 바뀌지 않습니다.** 정책 변경을 적용하려면 새 작업을 시작해야 합니다.

`task_validate`는 검증한 시점의 HEAD, staged/unstaged diff, untracked 파일을 묶어 fingerprint를 생성합니다. 검증 이후 코드가 바뀌면 기존 증거는 더 이상 현재 코드의 증거가 아니므로 `task_status`가 `STALE`로 판단하고 `task_complete`를 차단합니다.

## 컨텍스트 인덱스

작업 시작 시 코드베이스에서 `.moon/.../repository-index.json`을 자동 생성합니다. 이는 영구 문서가 아니라 현재 Git 기준점에서 파생되는 캐시입니다. `task_context(brief)`는 저장소 전체를 덤프하는 대신 다음을 제공합니다.

- 파일 종류별 개수
- 모듈 단위 요약
- 프로젝트 규칙과 ADR
- 사용자 요청과 경로명이 실제로 연관된 파일 우선 목록
- 제한된 크기의 tracked-file 표본

목표는 컨텍스트 양을 늘리는 것이 아니라 **Signal / Noise 비율을 높이는 것**입니다.

## 프로그램적 Architecture / Knowledge Guard

Moon 자체에서는 다음 결정론적 검사기를 사용합니다.

```bash
npm run check:architecture
npm run check:docs
```

`check:architecture`는 tracked 파일뿐 아니라 새로 생성된 untracked 소스도 검사하여 금지된 레이어 의존성과 파일 비대화를 탐지합니다. `check:docs`는 임시 plan/spec 문서의 영구 추적, 깨진 로컬 링크, 문서 예산 초과를 탐지합니다.

## Failure → Harness Improvement

검증 명령의 실행 시간과 실패 시그니처는 `.moon/metrics/`에 구조화된 메트릭으로 축적됩니다. 장기 메트릭에는 원시 stdout/stderr를 저장하지 않고 정규화된 실패 시그니처만 남깁니다.

- 같은 결정론적 실패가 반복되면 regression test / rule / schema / validator로 승격할 후보라고 표시합니다.
- 같은 검증 명령이 충분한 기준선 대비 크게 느려지면 validation runtime regression으로 표시합니다.

즉 반복되는 문제를 “AI가 또 실수했다”로 끝내지 않고 **하니스가 다음 실수를 막을 수 있는지**를 확인하는 구조입니다.

---

# 코드 리뷰 하니스 — 6개

Project Moon에는 특정 AI 모델에 종속되지 않는 코드 리뷰 하니스가 포함되어 있습니다.

AI가 판단과 분석을 담당하고, Moon은 다음과 같은 **검증 가능한 상태와 증거**를 관리합니다.

- 리뷰 시작 시점의 Git SHA
- base / head / merge-base
- 변경 파일과 diff 통계
- 설계 의도
- 리뷰 기준
- 리뷰 결과
- 수정 판단
- Worktree
- QA 명령과 stdout/stderr
- 최종 통과 여부

## 리뷰 상태 흐름

```text
Git working tree clean
        │
        ▼
CONTEXT_READY
        │ 설계 의도
        ▼
INTENT_READY
        │ 리뷰 기준
        ▼
CRITERIA_READY
        │ PR 설명
        ▼
REVIEW_READY
        │ 리뷰
        ▼
REVIEWED
        │ 수정 판단
        ▼
FIXING
        │ QA
        ├──────────────▶ QA_FAILED
        ▼
QA
        │ 최종 보고서
        ▼
PASSED
```

리뷰가 끝난 뒤 대상 브랜치의 SHA가 바뀌면 기존 검증은 자동으로:

```text
STALE
```

상태로 판단됩니다.

## 리뷰 도구

| 도구 | 기능 |
|---|---|
| `review_start` | clean tree 확인 후 base/head/merge-base SHA 고정 |
| `review_context` | intent / criteria / review / fix 단계별 제한된 컨텍스트 제공 |
| `review_record` | 설계 의도, 기준, PR 설명, 리뷰, 판단, 최종 보고서 저장 |
| `review_worktree` | 리뷰 대상 SHA 기반 격리 Worktree 생성·조회·삭제 |
| `review_qa` | QA 명령 순차 실행 및 증거 저장 |
| `review_status` | SHA, STALE, Worktree, P1, QA, `readyToPush` 상태 조회 |

일반적인 흐름은 다음과 같습니다.

```text
review_start
→ review_context(intent)
→ review_record(design_intent)
→ review_context(criteria)
→ review_record(criteria)
→ review_record(pr_body)
→ review_context(review)
→ review_record(review)
→ review_record(decisions)
→ review_worktree          # 필요할 경우
→ review_context(fix)      # 수정할 경우
→ review_qa
→ review_record(final_report)
→ review_status
```

중요한 규칙:

- `review_start`는 dirty working tree를 거부합니다.
- 리뷰 기준이 바뀌면 그 기준에 의존하던 기존 리뷰·QA 증거가 무효화됩니다.
- `final_report` 생성에는 최신 QA 성공과 `unresolvedP1 == 0`이 필요합니다.
- 리뷰 대상 브랜치가 움직이면 `effectiveState="STALE"`이 됩니다.
- `readyToPush`는 현재 **검토 상태를 나타내는 권고 게이트**이며 `exec_command`로 직접 수행하는 `git push` 자체를 차단하지는 않습니다.

프로젝트별 리뷰 규칙은 다음 파일에서 관리할 수 있습니다.

- [`docs/code-convention.yaml`](docs/code-convention.yaml)
- [`docs/adr.yaml`](docs/adr.yaml)
- [`harnesses/code-review/README.md`](harnesses/code-review/README.md)

---

# MCP 전송 구조

Project Moon의 `/mcp`는 **stateless Streamable HTTP JSON** 방식입니다.

```text
HTTP 요청
   │
   ▼
인증 / Host 검증
   │
   ▼
요청별 MCP transport 생성
   │
   ▼
Moon 도구 실행
   │
   ▼
JSON 응답 + X-Request-Id
```

주요 특징:

- 각각의 `POST /mcp` 요청은 독립적입니다.
- `Mcp-Session-Id`를 필수로 사용하지 않습니다.
- 이전 클라이언트가 보내는 오래된 `Mcp-Session-Id`는 무시합니다.
- 인증된 `GET /mcp`, `DELETE /mcp`는 일반적으로 `405`를 반환합니다.
- MCP transport와 Moon 명령의 `sessionId`는 서로 다른 개념입니다.

---

# 인증과 보안

Project Moon은 두 가지 내장 인증 방식을 지원합니다.

1. Static Bearer Token
2. OAuth 2.1 + DCR + PKCE

Windows + Tailscale Funnel 구성에서는 **OAuth 2.1 사용을 권장**합니다.

## OAuth 2.1

Project Moon의 내장 OAuth 서버는 다음 기능을 제공합니다.

- RFC 9728 Protected Resource Metadata
- RFC 8414 Authorization Server Metadata
- Dynamic Client Registration(DCR)
- Authorization Code
- PKCE `S256`
- Resource Audience 검증
- Access Token
- Refresh Token Rotation
- Refresh Token Replay 탐지
- Token Revocation

사용 범위(scope)는 현재 다음 하나입니다.

```text
mcp:tools
```

주요 엔드포인트:

| 경로 | 기능 |
|---|---|
| `/.well-known/oauth-protected-resource` | OAuth 보호 리소스 메타데이터 |
| `/.well-known/oauth-protected-resource/mcp` | `/mcp`용 보호 리소스 메타데이터 |
| `/.well-known/oauth-authorization-server` | Authorization Server 메타데이터 |
| `/register` | Dynamic Client Registration |
| `/authorize` | 연결 승인 및 Authorization Code 발급 |
| `/token` | Access/Refresh Token 교환 |
| `/revoke` | 토큰 폐기 |

OAuth 클라이언트와 토큰 해시는 `MCP_OAUTH_STATE_FILE`에 저장되며 파일 권한은 `600`으로 관리됩니다.

## Static Bearer Token

`MCP_AUTH_TOKEN`을 설정하면 다음 헤더로 인증합니다.

```http
Authorization: Bearer <MCP_AUTH_TOKEN>
```

강한 랜덤값 생성 예시:

```bash
openssl rand -hex 32
```

OAuth 전용으로 운영하려면 `MCP_AUTH_TOKEN`을 비워 두는 것이 좋습니다.

## 인증을 외부에 위임하는 경우

신뢰할 수 있는 상위 OAuth Gateway 또는 사설 네트워크에서 인증을 완전히 담당할 때만 다음 설정을 사용할 수 있습니다.

```dotenv
MCP_AUTH_TOKEN=
MCP_OAUTH_ENABLED=false
MCP_ALLOW_NO_AUTH=true
```

> [!DANGER]
> `MCP_ALLOW_NO_AUTH=true` 상태로 Project Moon을 인터넷에 직접 노출하면 안 됩니다. Moon은 명령 실행·파일 수정·삭제 권한을 제공하므로 사실상 컴퓨터 제어 권한을 공개하는 것과 같습니다.

---

# ChatGPT 연결

Project Moon 실행 후 `Start-PublicMcp.ps1`이 출력한 주소를 사용합니다.

```text
https://project-moon.<tailnet>.ts.net/mcp
```

ChatGPT에서 MCP 연결을 만들 때 Project Moon의 OAuth 흐름을 사용하면:

```text
ChatGPT
  ↓
Project Moon OAuth Metadata
  ↓
Dynamic Client Registration
  ↓
Authorization + PKCE
  ↓
Moon 승인 페이지
  ↓
MCP_OAUTH_APPROVAL_KEY 입력
  ↓
Access Token 발급
  ↓
MCP 연결
```

승인 키는 다음 명령으로 확인할 수 있습니다.

```powershell
.\Get-OAuthApprovalKey.ps1
```

Project Moon은 파일 쓰기, 삭제, 명령 실행 기능을 제공하므로 클라이언트 측 정책에서도 해당 MCP 기능 사용이 허용되어 있어야 합니다.

관련 OpenAI 문서:

- [ChatGPT Plugins Quickstart](https://developers.openai.com/plugins/quickstart)
- [Developer mode and full MCP connectors in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta)
- [MCP server authentication](https://developers.openai.com/plugins/build/auth)
- [MCP and Connectors in the Responses API](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)

---

# 로컬 Node.js 개발

Docker 없이 Node.js 서버 자체를 개발할 수도 있습니다.

## 요구 사항

- Node.js 22 이상
- npm
- Git

```bash
git clone https://github.com/kankinku/project-moon.git
cd project-moon
npm install
npm run build

export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
export MCP_DEFAULT_CWD=/tmp
npm start
```

기본 주소:

```text
MCP    http://127.0.0.1:3000/mcp
Health http://127.0.0.1:3000/health
```

개발 모드:

```bash
export MCP_HOST=127.0.0.1
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
npm run dev
```

---

# Linux VPS / EC2 배포

`deploy/`에는 다음 예제가 포함되어 있습니다.

- systemd 서비스
- 환경변수 예제
- Nginx 설정

Ubuntu 계열 서버 예시:

```bash
sudo mkdir -p /opt/project-moon
sudo cp -a package.json package-lock.json tsconfig.json src deploy /opt/project-moon/
cd /opt/project-moon
sudo npm ci
sudo npm run build
sudo npm prune --omit=dev

sudo install -d -m 0700 /var/lib/project-moon
sudo cp deploy/project-moon.env.example /etc/project-moon.env
sudo chmod 600 /etc/project-moon.env
sudo editor /etc/project-moon.env

sudo cp deploy/project-moon.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now project-moon
```

공개 배포 시 권장 사항:

- Project Moon 자체는 `127.0.0.1`에 바인딩
- TLS는 Nginx 등 신뢰할 수 있는 Reverse Proxy에서 종료
- 외부에는 HTTPS 포트만 공개
- OAuth 상태 파일을 애플리케이션 checkout 밖에 저장
- Secret은 Git에 저장하지 않음
- 실제 Proxy hop 수와 일치할 때만 `MCP_TRUST_PROXY_HOPS` 설정

OAuth 기반 예시:

```dotenv
MCP_HOST=127.0.0.1
MCP_PUBLIC_URL=https://mcp.example.com
MCP_ALLOWED_HOSTS=mcp.example.com,127.0.0.1,localhost
MCP_TRUST_PROXY_HOPS=1
MCP_AUTH_TOKEN=
MCP_OAUTH_ENABLED=true
MCP_OAUTH_APPROVAL_KEY=<strong-random-value>
MCP_OAUTH_ISSUER=https://mcp.example.com
MCP_OAUTH_RESOURCE=https://mcp.example.com/mcp
MCP_OAUTH_STATE_FILE=/var/lib/project-moon/oauth-state.json
```

---

# 상태 확인과 문제 해결

## Health 확인

로컬 Node 서버:

```bash
curl http://127.0.0.1:3000/health
```

Windows Docker/Tailscale 구성의 로컬 Proxy:

```powershell
curl.exe http://127.0.0.1:2999/health
```

공개 주소:

```text
https://project-moon.<tailnet>.ts.net/health
```

정상 응답 예시:

```json
{
  "status": "ok",
  "service": "project-moon",
  "version": "0.1.0",
  "transportMode": "stateless-json",
  "activeMcpSessions": 0,
  "activeMcpRequests": 0,
  "managedProcesses": 0,
  "unrestrictedHostAccess": true,
  "oauthEnabled": true
}
```

## 자주 발생하는 문제

| 증상 | 확인할 항목 |
|---|---|
| Tailscale 명령을 찾지 못함 | Tailscale 설치 및 `tailscale.exe` PATH |
| `Start-PublicMcp.ps1` 권한 오류 | 관리자 PowerShell인지 확인 |
| Docker 연결 실패 | Docker Desktop Engine 실행 여부 |
| Funnel URL을 얻지 못함 | Tailscale 로그인 및 Funnel 승인 여부 |
| OAuth 메타데이터 로드 실패 | `MCP_PUBLIC_URL`, `/.well-known/*` 라우팅 |
| `401 Unauthorized` | OAuth 토큰 또는 Bearer Token |
| `403 Host header is not allowed` | `MCP_ALLOWED_HOSTS` |
| 명령이 `sessionId` 반환 | `read_process`로 후속 조회 |
| `GET /mcp`가 `405` | stateless POST 전송에서는 정상 |
| 재시작 후 프로세스 세션 소실 | 프로세스 상태는 메모리에 저장됨 |
| 리뷰가 `STALE` | 리뷰 시작 이후 대상 브랜치 SHA 변경 |
| `final_report` 거부 | P1 해결 및 최신 QA 통과 여부 |

---

# 테스트와 검증

저장소 기본 검증:

```bash
npm run check:architecture
npm run check:docs
npm run typecheck
npm test
npm run build
```

현재 통합 테스트는 다음 영역을 검증합니다.

- 인증
- OAuth 2.1
- Stateless MCP 요청
- 프로세스 lifecycle
- 파일 읽기·쓰기·패치
- UTF-8 / Base64 경계
- 모든 32개 도구 계약
- AI 작업 하니스 lifecycle과 위험도 상승
- 검증 정책 고정 및 self-bypass 방지
- 검증 후 변경에 대한 `STALE` 감지
- Architecture dependency / 파일 크기 guard
- 임시 문서·깨진 링크 audit
- 요청 관련 파일을 우선하는 repository context index
- 반복 실패 시그니처와 검증 성능 회귀 탐지
- 코드 리뷰 하니스 lifecycle
- Worktree
- QA invalidation

실제 실행 중인 외부 MCP 서버를 대상으로 E2E 테스트할 수도 있습니다.

```bash
MCP_E2E_URL='https://mcp.example.com/mcp' \
MCP_E2E_TOKEN='<bearer-token>' \
MCP_E2E_ROOT='/tmp/project-moon-tools-e2e-manual' \
npx vitest run test/all-tools.integration.test.ts
```

> E2E 테스트는 대상 호스트에서 실제 명령을 실행하고 파일을 생성·수정·삭제합니다. 운영 데이터 디렉터리를 `MCP_E2E_ROOT`로 사용하지 마세요.

---

# 주요 환경변수

| 변수 | 기본값 | 설명 |
|---|---:|---|
| `MCP_HOST` | `0.0.0.0` | HTTP 바인드 주소 |
| `MCP_PORT` | `3000` | MCP 서버 포트 |
| `MCP_ENDPOINT` | `/mcp` | MCP 엔드포인트 |
| `MCP_PUBLIC_URL` | 없음 | 외부 HTTPS 기본 URL |
| `MCP_ALLOWED_HOSTS` | 없음 | 허용할 Host 헤더 목록 |
| `MCP_TRUST_PROXY_HOPS` | `0` | 신뢰하는 Reverse Proxy hop 수 |
| `MCP_AUTH_TOKEN` | 없음 | Static Bearer Token |
| `MCP_ALLOW_NO_AUTH` | `false` | 내장 인증 없이 시작 허용 |
| `MCP_OAUTH_ENABLED` | `false` | 내장 OAuth 2.1 활성화 |
| `MCP_OAUTH_APPROVAL_KEY` | `MCP_AUTH_TOKEN` | OAuth 승인 페이지 키 |
| `MCP_OAUTH_ISSUER` | `MCP_PUBLIC_URL` | OAuth Issuer |
| `MCP_OAUTH_RESOURCE` | Public URL + endpoint | OAuth Resource Audience |
| `MCP_OAUTH_STATE_FILE` | 작업 디렉터리 내부 | OAuth 영구 상태 파일 |
| `MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` | Access Token 수명 |
| `MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh Token 수명 |
| `MCP_OAUTH_AUTHORIZATION_CODE_TTL_SECONDS` | `300` | Authorization Code 수명 |
| `MCP_DEFAULT_CWD` | 서버 시작 위치 | 상대경로 기준 디렉터리 |
| `MCP_DEFAULT_SHELL` | `$SHELL` 또는 `/bin/bash` | 기본 셸 |
| `MCP_MAX_REQUEST_BODY` | `8mb` | HTTP 요청 크기 제한 |
| `MCP_MAX_OUTPUT_BYTES` | `1048576` | 한 응답의 최대 출력 크기 |
| `MCP_MAX_RETAINED_PROCESS_OUTPUT_BYTES` | `4194304` | 프로세스별 보관 출력 크기 |
| `MCP_PROCESS_RETENTION_MS` | `3600000` | 완료 프로세스 기록 유지 시간 |
| `MCP_MAX_PROCESSES` | `128` | 최대 프로세스 기록 수 |
| `MCP_MAX_FILE_CHUNK_BYTES` | `1048576` | 파일 전송 청크 크기 |
| `MCP_MAX_EDIT_FILE_BYTES` | `67108864` | 텍스트 편집 최대 파일 크기 |

자세한 예시는 다음 파일을 참고하세요.

- [`.env.example`](.env.example)
- [`deploy/project-moon.env.example`](deploy/project-moon.env.example)
- [`tunneling/.env.local.example`](tunneling/.env.local.example)

---

# 저장소 구조

| 경로 | 역할 |
|---|---|
| `src/http-server.ts` | HTTP 전송, 인증 라우팅, Health 엔드포인트 |
| `src/mcp-server.ts` | MCP 서버 및 도구 등록 |
| `src/exec-tools.ts` | 명령·스크립트·프로세스 도구 |
| `src/file-service.ts` | 호스트 파일시스템 구현 |
| `src/file-tools.ts` | 파일 MCP 도구 |
| `src/oauth.ts` | DCR, PKCE, 토큰 발급·갱신·폐기 |
| `src/task/` | AI 작업 lifecycle, 위험도, 컨텍스트 인덱스, 검증·메트릭 |
| `src/review/` | Git 코드 리뷰 상태 머신, Worktree, QA |
| `moon.config.json` | 검증 프로필, 위험도, Architecture/Knowledge 정책 |
| `scripts/check-architecture.mjs` | 레이어 의존성·파일 비대화 결정론적 검사 |
| `scripts/audit-docs.mjs` | 임시 문서·문서 예산·로컬 링크 감사 |
| `Start-PublicMcp.ps1` | Windows 공개 MCP 시작 및 Funnel 자동 구성 |
| `Stop-PublicMcp.ps1` | 공개 MCP 중지 |
| `Get-OAuthApprovalKey.ps1` | OAuth 승인 키 조회 |
| `Test-Gpu.ps1` | NVIDIA GPU 연결 검증 |
| `tunneling/` | Docker/Nginx/Tailscale 배포 구성 |
| `deploy/` | Linux systemd/Nginx 배포 예제 |
| `docs/code-convention.yaml` | 프로젝트 코드 리뷰 규칙 |
| `docs/adr.yaml` | Architecture Decision Record |
| `harnesses/code-review/` | 코드 리뷰 하니스 문서와 프롬프트 계약 |
| `test/` | 단위·통합 테스트 |

Windows Docker 설치에 대한 더 자세한 설명은 [`LOCAL_DOCKER_SETUP.md`](LOCAL_DOCKER_SETUP.md)를 참고하세요.

---

# Secret 및 Git 관리

실제 인증 정보는 저장소에 커밋하지 마세요.

루트 `.gitignore`는 다음과 같은 로컬·민감 파일을 기본적으로 제외합니다.

- `.env`, `.env.*`
- `*.pem`, `*.key`, `*.p12`, `*.pfx`
- `.ssh/`
- `credentials*.json`
- `client_secret*.json`
- `service-account*.json`
- `.secrets/`, `secrets/`
- `*.token`, `*.secret`
- `.cloudflare/`, `.tailscale/`
- OAuth runtime state
- Project Moon 백업 아카이브
- `.moon/`
- `.project-moon-worktrees/`

예제 설정 파일만 저장소에 포함하고 실제 값은 로컬 파일 또는 Secret Manager에 보관하는 방식을 권장합니다.

---

# 기반 프로젝트 및 출처

Project Moon은 MIT 라이선스의 [`kstost/cokacremote`](https://github.com/kstost/cokacremote)를 기반으로 발전한 프로젝트입니다. 원 프로젝트의 저작권 및 라이선스 고지는 [`LICENSE`](LICENSE)에 보존되어 있습니다.

코드 리뷰 워크플로는 MIT 라이선스의 [`vibemafiaclub/mafia-codereview-harness`](https://github.com/vibemafiaclub/mafia-codereview-harness)의 핵심 개념을 참고해 Project Moon용 MCP 도구로 재구현했습니다.

상세 출처:

- [`vendor/mafia-codereview-harness/SOURCE.md`](vendor/mafia-codereview-harness/SOURCE.md)

---

# 라이선스

[MIT License](LICENSE)

---

# 면책 고지

이 소프트웨어는 상품성, 특정 목적 적합성 및 비침해성에 대한 보증을 포함하여 명시적 또는 묵시적인 어떠한 보증도 없이 **있는 그대로(AS IS)** 제공됩니다.

저작권자와 기여자는 이 소프트웨어의 사용 또는 기타 거래로 인해 발생하는 데이터 손실·손상, 시스템 장애, 보안 사고, 취약점, 재산상 손실 및 직·간접적 손해에 대해 책임을 지지 않습니다.

Project Moon은 의도적으로 강력한 시스템 접근 권한을 제공하는 도구입니다. 운영 환경과 권한 범위, 인증 방식, 네트워크 공개 범위를 확인하고 사용하는 책임은 사용자에게 있습니다.
