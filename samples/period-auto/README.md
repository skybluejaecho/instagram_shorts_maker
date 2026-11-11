# 새 CS 회차 3일치 실제 자동 제작 검증

기존 대본을 재제작하는 `samples/period/`와 별도로, 실제 생성 모델이 새 주제·대본·장면을 만드는 통합 실행이다. 시리즈는 `cs-auto-live`, 기간은 `cs-auto-live-01`이다. 2026-11-23부터 3일간 매일 19:00 Asia/Seoul 슬롯에 연결하며, 생성 묶음은 2편+1편이다. 영상은 각각 30초, 1080×1920, 30fps이고 음성은 기존 Microsoft Heami Desktop 설정을 사용한다.

`history/`의 7개 파일은 `story-demo`의 최신 제작 입력을 그대로 복사한 중복 검사 이력이다. 새 회차나 실제 게시 완료 이력이 아니다. 검증용 시리즈를 따로 등록하므로 기존 시리즈의 내용 검증 정책과 영상은 변경하지 않는다. 새 회차는 `planIds`를 지정하지 않고 실제 `generateBatch` 경로로 생성한다.

내용 검증은 `content-policy.json`의 로컬 자료를 필수로 사용한다. 기존 Python·Qt 노트에 공식 Python deque 문서의 확인 노트를 추가했다. 자료 등록·이력 복사·기간 설정은 실행 전 준비 작업이며, 회차 대본을 사람이 작성했다는 뜻은 아니다.

```powershell
node samples/period-auto/setup.cjs
node pipeline/period/validate-auto.cjs samples/period-auto/run.json run
node pipeline/cli.cjs period status cs-auto-live-01
```

실행 기록과 보고서는 `runs/_periods/auto-validation-cs-auto-live-01/`에 남는다. 자동 기획·의미 중복·내용·실제 TTS 타이밍 검사와 제작 검수를 거치며, 완료 후 전체 `run`과 `resume`를 재실행해 입력·기획·음성·MP4 해시와 호출 수를 비교한다. 같은 기간으로 재개하면 이미 생성한 회차를 다시 기획하지 않는다. 새 모델 호출에는 기존 Codex 로그인 이용량이 사용된다.

실패·보류가 발생하면 해당 실행 기록을 보존한다. 자료·대본·코드 수정이나 추가 재시도가 필요했다면 `interventions.json`에 구분해 기록한다. 자동 검수를 통과한 영상도 최종 상태는 `ready_for_review`이고, 실제 게시와 사람의 최종 승인은 포함하지 않는다.
