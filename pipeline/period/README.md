# 기간 단위 제작 계획과 실행

기간 계획은 한 시리즈의 게시 예정 시각을 만들고, 각 시각에 회차 하나를 연결한다. 회차들을 작은 제작 묶음으로 나눠 기존 기획 생성·내용 검증·TTS·화면 검수·MP4 제작을 실행한다. 게시 예정일이 미래여도 제작은 명령을 실행한 시점에 시작한다. 이 기능은 Instagram 게시나 예약 실행을 수행하지 않는다.

## 5일, 하루 한 편

다음 JSON을 저장한다. `seriesId`는 먼저 등록한 시리즈 ID로 지정한다.

```json
{
  "id": "cs-five-days",
  "seriesId": "story-demo",
  "startDate": "2026-11-16",
  "days": 5,
  "timezone": "Asia/Seoul",
  "times": ["19:00"],
  "weekdays": [1, 2, 3, 4, 5, 6, 7],
  "batchSize": 5
}
```

```powershell
node pipeline/cli.cjs period create planning/cs-five-days.json
node pipeline/cli.cjs period list
node pipeline/cli.cjs period run cs-five-days --jobs 2
node pipeline/cli.cjs period status cs-five-days
node pipeline/cli.cjs period retry-failed cs-five-days --jobs 2
```

`create`는 게시 슬롯과 제작 묶음만 저장한다. 같은 ID와 같은 명세를 다시 전달하면 기존 계획을 사용한다. 같은 ID로 기간·시각·대상 회차 등을 바꾸면 오류를 반환한다. 다른 기간 계획이라도 같은 시리즈의 같은 게시 시각을 중복 예약할 수 없다.

| 설정 | 의미 |
| --- | --- |
| `startDate` | 시간대 기준 첫 달력 날짜, `YYYY-MM-DD` |
| `days` | 첫날을 포함한 달력 날짜 수, 1–366일 |
| `timezone` | IANA 시간대. 기본값 `Asia/Seoul` |
| `times` | 하루 게시 시각 목록. 기본값 `["19:00"]`, 최대 8개 |
| `weekdays` | ISO 요일: 월요일 1, 일요일 7. 기본값은 매일 |
| `batchSize` | 한 번에 기획할 회차 수, 1–10. 기본값 5 |
| `planIds` | 선택 사항. 이미 작성한 미제작 기획 ID를 슬롯 순서대로 지정 |

예를 들어 30일간 월·수·금에만 게시하려면 `days: 30`, `weekdays: [1, 3, 5]`로 지정한다. `days`는 회차 수가 아니며 해당 날짜 범위와 요일·시각에 맞춰 회차 수가 정해진다. 한 기간에 최대 366개 슬롯을 지원한다. 시각과 요일은 정렬해 적용하며 중복은 허용하지 않는다. 일광 절약 시간 전환으로 존재하지 않거나 두 번 나타나는 현지 시각은 임의 해석하지 않고 거부한다.

## 대본을 자동 생성하거나 기존 기획을 사용하기

`planIds`가 없으면 `run`에서 각 묶음의 기획·대본을 자동 생성한다. 공통 장면 어댑터와 Codex CLI 로그인이 필요하다. 기존 자동 생성과 같이 의미 중복 검사, 설정된 근거 자료 검사, 실제 한국어 TTS 타이밍 검증을 통과해야 회차가 등록된다. 30편을 요청해도 `batchSize` 단위로 나눠 기존 묶음별 10편 제한을 지킨다.

기존 CS 예제처럼 대본이 준비됐다면 `plan add`로 등록한 기획을 명시한다.

```json
{
  "id": "cs-ready-five",
  "seriesId": "my-cs-series",
  "startDate": "2026-11-16",
  "days": 5,
  "times": ["19:00"],
  "planIds": ["stack", "queue", "peek", "front-rear", "empty-stack"]
}
```

슬롯 수와 기획 수가 같아야 하고, 각 기획에는 `input`이 있어야 한다. 이미 회차로 만들어졌거나 게시된 기획, 다른 기간에 배정한 기획은 사용할 수 없다. 이 경로는 준비된 기획을 묶음으로 등록하므로 새 대본 생성·의미 중복 모델 검사를 호출하지 않는다. 기존 `topicKey` 중복 검사와 제작 시 내용·화면 검수 정책은 계속 적용된다. 같은 시리즈의 원본 대본이나 기존 영상을 복제하는 기능은 아니다.

기획 생성은 순차적으로 진행한다. 앞 묶음이 등록된 뒤 다음 묶음이 최신 이력을 읽으므로 생성 도중 같은 내용을 다시 선택하는 위험을 줄인다. 한 묶음의 기획 생성이 실패하거나 검토 대기로 남아도 다른 묶음은 계속 시도한다. 생성 묶음은 기존 원자적 등록 규칙을 유지하므로 묶음 안 한 후보가 보류되면 해당 묶음 전체가 아직 등록되지 않을 수 있다. 더 작은 단위로 분리하려면 `batchSize`를 줄인다.

준비된 회차의 제작은 `--jobs 1..8`로 병렬 실행한다. HyperFrames 렌더링은 기존 사용자 계정 잠금으로 순차 처리될 수 있다. 한 회차가 실패해도 나머지 회차는 끝까지 진행한다.

## 재개와 상태 확인

| 명령 | 처리 범위 |
| --- | --- |
| `run` | 전체 기간을 확인하고 실행한다. 변경 없는 단계의 산출물을 재사용한다. |
| `resume` | 미시작·실패·중단·보류·입력 변경 회차를 이어간다. 현재 유효한 완료 회차는 실행 대상에서 제외한다. |
| `retry-failed` | 실패·검토 대기인 제작 회차와 실패·보류된 기획 묶음을 다시 시도한다. |
| `status` | 게시 예정, 기획·회차·묶음, 현재 제작 단계, 실패 이유, 검토 상태를 조회한다. 모델을 호출하지 않는다. |

`--plan-only`를 주면 회차 등록까지만 수행한다. 자동 생성 모드에서는 이 과정에 실제 TTS 사전 검증이 포함되며, MP4 제작은 하지 않는다. `--jobs`와 함께 사용할 수 없다. `--attempts 1..5`는 이번 명령에서 **각 생성 묶음**의 최대 생성·수정 횟수이고 기본값은 3이다. `--model`은 생성과 필요한 내용 검증에 사용할 모델을 선택한다.

완료된 영상은 단계별 입력·산출물 해시로 확인한다. 실패 회차는 마지막 유효한 단계부터 이어간다. 입력이 바뀌거나 산출물이 유실된 완료 회차는 `resume` 또는 `run`으로 다시 제작한다. `retry-failed`는 완료 회차의 변경 사항을 일괄 제작하는 명령이 아니다. 기획·회차·게시 슬롯의 연결은 유지되므로 재시도로 새 회차나 슬롯이 추가되지 않는다.

기간 계획과 게시 연결은 `planning/catalog.json`, 실행 기록과 통합 보고서는 `runs/_periods/<기간 ID>/`에 저장한다. 기간 전체의 제작 시도 기록은 그 아래 `production/state.json`에 모으며, 개별 `batch run` 명령의 실행 기록과 구분한다. 같은 회차를 개별 명령으로 완성해도 기간 상태는 실제 산출물과 최신 검토 상태를 조회한다. MP4·검수 보고서·사람의 승인 이력은 기존 `runs/<회차 ID>/`에 남는다.

CLI 출력에 통합 보고서, MP4, 기술 검수, 화면 검수, 영상 Revision 경로가 표시된다. `status`의 표는 현재 상태이며 저장된 HTML 보고서는 마지막 기간 실행 시점의 스냅샷이다. HTML에도 확인 시각을 표시한다. 실패·검토 보류·중단 회차가 남으면 종료 코드 1을 반환한다.

제작 중 제목·화면 문구의 조건 누락은 [문구 자동 수정](../content/repair-README.md)을 최대 두 번 시도한다. 근거 부족이나 수정 한도 소진은 회차의 `needs_review`로 표시되며 다른 회차는 계속 진행한다. 같은 입력·자료로 보류 회차를 재시도해도 모델 호출과 수정 한도를 새로 시작하지 않는다.

영상이 완성되면 `ready_for_review`이며 자동 승인하지 않는다. 표의 회차 ID와 Revision으로 기존 `review approve`, `review request-changes`, `review apply`를 사용한다. 수정 요청은 기존 회차 단위로 처리하며 기간의 게시 슬롯을 옮기지 않는다. 기간 상태 조회는 최신 영상과 승인 상태를 다시 확인한다.

## 검증

기존 CS 대본 다섯 편을 사용하는 명세가 `samples/period/`에 있다. 아래 명령은 입력 등록과 기간 계획 생성을 수행하며, 제작은 이후 `period run cs-five-days`로 시작한다.

```powershell
node pipeline/cli.cjs series register samples/period/series.json
node pipeline/cli.cjs plan add period-cs-demo samples/period/plans.json
node pipeline/cli.cjs period create samples/period/five-days.json
```

실제 실패·재개 검증은 별도의 실행마다 새 검증 시리즈와 기간을 만들어 원본 회차를 보존한다.

```powershell
node pipeline/period/validate-workflow.cjs
```

다섯 편에 실제 TTS·화면 검수·MP4·기술 검수를 실행한다. 세 번째 회차의 렌더 단계에 검증용 오류를 한 번 넣어 다른 네 편이 완료되는지 확인한 뒤 실패 회차만 재개한다. 완료 영상의 경로와 SHA-256, 기존 음성·HTML 단계, 슬롯과 회차 수가 보존되는지 검사하고 `runs/_periods/validation-<실행 ID>/index.html`에 결과를 기록한다. 이 검증에는 새 대본 생성 모델 호출이 필요하지 않다.

`planning.test.cjs`는 날짜·요일·시간대, 일정 충돌, 동일 명세 재등록, 묶음 연결을 검사한다. `engine.test.cjs`는 실패 격리와 재개 선택을 검사한다. `cli.test.cjs`는 별도 임시 저장소에서 5회차 실행·실패 회차 재개·완료 산출물 보존과 CLI 인자 검증을 확인한다.
