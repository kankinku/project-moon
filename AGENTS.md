# Project Moon Agent Contract

이 저장소에서 작업하는 AI 에이전트는 코드 생성 속도보다 **최신 코드와 결정론적 검증을 기준으로 한 정확성**을 우선한다.

## 작업 원칙

- 사용자의 목표와 현실 제약을 구현 세부사항과 분리해서 이해한다.
- 실질적인 저장소 변경 전에는 관련 코드, 테스트, `moon.config.json`, `docs/adr.yaml`, `docs/code-convention.yaml`을 먼저 확인한다.
- Project Moon은 `AUTO`, `DIRECT`, `HARNESS` 작업 모드를 구분한다. 사용자가 현재 요청에서 모드를 명시하면 그 요청에 우선 적용한다.
- `DIRECT`는 원본 Moon과 같은 저오버헤드 방식이다. 조회, 상태 확인, 단발 명령, 파일 전송, 범위가 명확한 작은 수정은 `exec_command`와 파일 도구를 바로 사용하고 불필요한 `task_*` 상태를 만들지 않는다.
- `HARNESS`는 다중 파일·다단계 변경, 아키텍처/리팩터링, 의존성/스키마, 인증·보안, 배포·네트워크·마이그레이션·파괴적 변경에 사용하며 `task_start → brief → plan → implement → task_validate → task_complete` 흐름을 따른다.
- `AUTO`에서는 DIRECT로 시작할 수 있지만 작업의 범위나 위험도가 커지면 구현을 계속하기 전에 HARNESS로 승격한다.
- `task_*`를 사용할 수 없는 로컬 개발 환경에서도 실질적인 변경은 구조와 영향 범위를 파악하고, 변경 후 `moon.config.json`의 검증 프로필과 동등한 프로그램적 검증을 수행한다.
- 기존 계획이 새 증거와 충돌하면 조용히 계획을 무시하지 말고 계획을 갱신한 뒤 구현한다.

## 구조 규칙

- 전송/MCP 스키마, application orchestration, 정책 판단, Git·파일·검증 infrastructure 책임을 섞지 않는다.
- 금지된 dependency 방향과 파일 크기 제한은 `npm run check:architecture`가 Source of Truth다.
- 단순 셸 실행으로 충분한 기능은 새 MCP 도구로 승격하지 않는다. 반복성, 상태성, 위험성 또는 도메인 의미가 명확할 때만 전용 도구를 추가한다.

## 검증 우선순위

LLM의 자기평가보다 다음 결정론적 검증을 먼저 신뢰한다.

```bash
npm run check:architecture
npm run check:docs
npm run typecheck
npm test
npm run build
```

변경 위험도에 따라 `moon.config.json`의 `fast`, `normal`, `release` 프로필을 따른다. 검증 이후 코드가 변경되었다면 이전 검증 결과를 재사용하지 않는다.

## 실패 처리

버그를 고치는 것으로 끝내지 않는다. 같은 실패가 다시 발생할 가능성이 있으면 원인을 다음 중 하나로 승격할 수 있는지 검토한다.

- regression test
- architecture rule
- schema/type constraint
- deterministic validator
- 더 명확한 durable invariant

반복 실패와 검증 시간 회귀는 `.moon/metrics/`의 런타임 메트릭으로 관찰하며, 이 파일들은 Git에 커밋하지 않는다.

## 지식 관리

- 코드, 테스트, 타입/스키마, 검증 규칙을 최신 스펙의 우선 근거로 본다.
- 영구 문서는 README, AGENTS, ADR, 코드 규칙처럼 지속적으로 유지할 가치가 있는 정보만 남긴다.
- 구현용 plan/spec/debug note는 작업 완료 뒤 영구 문서로 남기지 않는다. 지속되어야 할 결정만 코드·테스트·규칙·ADR에 흡수한다.
- `npm run check:docs` 실패를 문서 감사 예외로 우회하지 말고 실제 stale/broken knowledge를 먼저 수정한다.

## Git 및 안전

- 사용자 승인 없이 기존 main 이력, 원격 브랜치, 배포 환경을 파괴적으로 변경하지 않는다.
- 비밀키, OAuth 승인 키, 토큰, 실제 인증 파일은 Git에 기록하지 않는다.
- 대규모/병렬/리뷰 수정처럼 격리가 유리할 때만 Worktree를 사용한다. 작은 단일 작업에 Worktree를 기계적으로 강제하지 않는다.
