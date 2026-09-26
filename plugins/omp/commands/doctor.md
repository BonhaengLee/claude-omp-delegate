---
description: Diagnose the OMP executable, shared state, and permission guard
---
MCP omp_doctor({workspace})를 호출하고 실행 파일 경로·OMP 버전 정책(18.3.0 이상 19.0.0 미만, 검증 여부)·공용 설정/상태 권한·hook 상태·고아 작업 진단을 표시한다. 첫 실행에는 공용 상태 디렉터리와 config.json에 확인한 실행 파일 경로를 등록할 수 있다. 기존 OMP/Claude 설정·인증은 바꾸지 않는다. auth token/전체 환경은 출력하지 않는다. macOS/Linux만 지원한다.
기존 skills/rules/MCP/extension 발견은 유지하지만 cxd가 명시적으로 추가하는 TUI statusline·Telegram extension을 이 플러그인이 추가 로드하지는 않는다. cxd alias와 완전히 같은 launcher라고 설명하지 않는다. Figma/Toss 인증 경고는 그대로 보고하며 임의 로그인·계정전환·업데이트를 하지 않는다.
명시적 고아 복구 요청이 있을 때만 node "${CLAUDE_PLUGIN_ROOT}/runtime/cli.js" doctor --workspace <안전하게 quote한 absolute cwd> --recover <검증된 UUID>를 실행한다. PID 없음·heartbeat stale·child group ESRCH·nonce 일치를 모두 확인해야 하며 자동 재실행/불확실한 kill은 없다. 기본 모델 변경은 기존 OMP /models·config를 안내하고 여기서 글로벌 설정을 덮지 않는다.

## 공통 경계
- Claude는 설계·대화·결과 검토를 맡고, 구현은 명시적 요청이 있을 때만 OMP에 위임한다. 계획 승인 자체는 위임 트리거가 아니다.
- MCP에 현재 대화의 실제 작업 디렉터리를 absolute workspace로 전달한다. 서버 process.cwd()를 대신 쓰지 않는다.
- OMP 실행 중 같은 writeScope 파일을 Claude가 직접 수정하지 않는다. 다른 작업자의 dirty 변경을 보존하고 자동 commit/reset/stash/rollback을 하지 않는다.
- 상태는 같은 OS 사용자의 두 Claude 프로필이 공유한다. Claude 대화 전체·인증은 공유하지 않으며, 재접속 알림을 보장하지 않는다. 재접속 후 /omp:status로 복구한다.
- writeScope는 검토할 의도 범위이지 OS sandbox가 아니다. 완료는 실행 종료이며 acceptance의 통과 판정은 실제 증거와 diff를 검토한 Claude가 한다.
- OMP를 Bash로 직접 시작하거나 --yolo, 별도 계정 폴백, 자동 로그인, 글로벌 모델 설정 변경으로 우회하지 않는다.
