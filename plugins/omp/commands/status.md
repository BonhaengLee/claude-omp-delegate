---
description: Show active jobs and the five most recent results
---
MCP omp_status({workspace:<현재 absolute cwd>})를 한 번 호출한다. 진행 중 작업과 최근 종료 5건을 짧은 카드로 표시한다. 작업 없음은 정상이며 /omp:implement를 안내한다. Plan 모드에서도 조회 가능하다. 실패·중단·취소를 정상 완료처럼 표현하지 않는다. ccmd/ccd를 수동 전환한 뒤에도 같은 작업을 찾을 수 있지만 Claude 대화 전체가 옮겨지는 것은 아니다.

## 공통 경계
- Claude는 설계·대화·결과 검토를 맡고, 구현은 명시적 요청이 있을 때만 OMP에 위임한다. 계획 승인 자체는 위임 트리거가 아니다.
- MCP에 현재 대화의 실제 작업 디렉터리를 absolute workspace로 전달한다. 서버 process.cwd()를 대신 쓰지 않는다.
- OMP 실행 중 같은 writeScope 파일을 Claude가 직접 수정하지 않는다. 다른 작업자의 dirty 변경을 보존하고 자동 commit/reset/stash/rollback을 하지 않는다.
- 상태는 같은 OS 사용자의 두 Claude 프로필이 공유한다. Claude 대화 전체·인증은 공유하지 않으며, 재접속 알림을 보장하지 않는다. 재접속 후 /omp:status로 복구한다.
- writeScope는 검토할 의도 범위이지 OS sandbox가 아니다. 완료는 실행 종료이며 acceptance의 통과 판정은 실제 증거와 diff를 검토한 Claude가 한다.
- OMP를 Bash로 직접 시작하거나 --yolo, 별도 계정 폴백, 자동 로그인, 글로벌 모델 설정 변경으로 우회하지 않는다.
