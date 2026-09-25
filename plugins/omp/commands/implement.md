---
description: Delegate a new implementation to your existing OMP Codex harness
argument-hint: [--model openai-codex/<id>] [--thinking <level>] <요구>
---
사용자 인수: $ARGUMENTS
1. 요구 또는 현재 승인된 계획이 있어야 한다. 둘 다 없으면 작업 내용을 한 번만 질문하고 시작하지 않는다. brief는 Claude가 작성한다.
2. Plan 모드에서는 시작하지 않는다. 모드 전환 뒤 사용자가 다시 요청해야 한다. MCP PreToolUse guard가 차단하며 shell fallback은 없다.
3. 사용자가 준 선행 --model/--thinking 옵션을 해석·재작성하지 말고 요구 문장과 함께 brief.goal 앞에 원문 그대로 전달한다. 승인된 계획을 쓸 때도 원문 옵션 접두부 + 계획 목표로 구성한다. 공용 contracts 파서가 시작 전에 옵션을 검증하고 제거하여 semantic goal과 model/thinking을 저장한다. 중복·알 수 없는 옵션·값 충돌은 시작 전 실패한다. 모델 생략은 기존 @default이며 provider를 자동 교체하지 않는다.
4. strict brief {goal,decisions,writeScope,acceptance,constraints,verification,model?,thinking?}를 구성한다. 모든 목록은 실제 항목 1개 이상. 승인 계획의 필요한 결정만 전달하고 전체 transcript·토큰·인증은 복사하지 않는다. 사용자 변경 보존과 실제 실행 검증을 포함한다.
5. MCP omp_start({workspace,brief})를 호출한다. WORKSPACE_BUSY이면 현재 카드와 /omp:status 또는 /omp:cancel을 안내한다. 큐·자동 재시도·다른 workspace 우회는 없다.

## 시작 후 알림
1. 시작 응답의 짧은 진행 카드를 보여 준다. 실제 모델이 아직 관측되지 않았다면 요청 모델로 표시하고 실제 모델이라고 단정하지 않는다. 진행률·예상 완료 시간은 만들지 않는다.
2. 이미 terminal이면 바로 omp_result로 간다. 아니면 응답의 UUID를 검증하고 Bash를 run_in_background로 호출한다:
   node "${CLAUDE_PLUGIN_ROOT}/runtime/cli.js" wait <UUID> --workspace <absolute-workspace>
   사용자 문장이나 모델 옵션을 shell 명령에 삽입하지 않는다. workspace는 한 argv가 되도록 안전하게 shell-quote한다.
3. background 기능이 없는 host만 --timeout-ms 20000으로 한 번 bounded wait하고 진행 카드와 /omp:status를 반환한다. busy polling하지 않는다.
4. background completion notification을 받으면 omp_result를 조회하고 변경·검증·주의·다음 행동 네 묶음으로 검토한다. waiter 종료는 작업 취소가 아니다.

## 공통 경계
- Claude는 설계·대화·결과 검토를 맡고, 구현은 명시적 요청이 있을 때만 OMP에 위임한다. 계획 승인 자체는 위임 트리거가 아니다.
- MCP에 현재 대화의 실제 작업 디렉터리를 absolute workspace로 전달한다. 서버 process.cwd()를 대신 쓰지 않는다.
- OMP 실행 중 같은 writeScope 파일을 Claude가 직접 수정하지 않는다. 다른 작업자의 dirty 변경을 보존하고 자동 commit/reset/stash/rollback을 하지 않는다.
- 상태는 같은 OS 사용자의 두 Claude 프로필이 공유한다. Claude 대화 전체·인증은 공유하지 않으며, 재접속 알림을 보장하지 않는다. 재접속 후 /omp:status로 복구한다.
- writeScope는 검토할 의도 범위이지 OS sandbox가 아니다. 완료는 실행 종료이며 acceptance의 통과 판정은 실제 증거와 diff를 검토한 Claude가 한다.
- OMP를 Bash로 직접 시작하거나 --yolo, 별도 계정 폴백, 자동 로그인, 글로벌 모델 설정 변경으로 우회하지 않는다.
