---
description: Continue an existing OMP conversation with a new request
argument-hint: [job UUID] [--model openai-codex/<id>] [--thinking <level>] <추가 요구>
---
사용자 인수: $ARGUMENTS
1. 추가 요구가 없으면 한 번만 질문한다. 첫 인수가 UUID일 때만 jobId로 읽는다. 선행 모델·thinking 옵션은 implement처럼 brief.goal의 접두부에 원문 그대로 전달하고 공용 파서가 처리하게 한다. jobId만 별도 필드로 전달한다.
2. omp_status/omp_result의 data.brief 또는 brief artifact에서 이전 결정을 읽고 추가 goal·acceptance를 반영한 strict brief를 Claude가 작성한다. 사용자에게 모든 필드를 다시 입력시키지 않는다.
3. Plan에서는 시작하지 않는다. MCP omp_followup({workspace,jobId?,brief})를 호출한다. 생략은 workspace 전체의 유일한 resumable session만 허용한다.
4. AMBIGUOUS_SESSION이면 응답 후보를 목표·짧은 ID·모델로 구분해 선택 UI로 한 번 질문한다. 임의 latest를 고르지 않는다. WORKSPACE_BUSY이면 현재 카드를 안내한다.
5. 새 job UUID/parentJobId가 생기며 같은 OMP session을 재개한다. RESUME_FAILED는 실패 근거를 알리고 새 세션으로 몰래 시작하지 않는다.

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
