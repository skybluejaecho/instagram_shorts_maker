# 검토 요청 자동 반영과 재제작

## 사용 흐름

`완성 영상 검토 → 버전과 대상 장면을 지정해 요청 기록 → 모델이 텍스트 패치 생성 → 변경 범위·장면 규격 검사 → 음성·타이밍 검사 → 입력 교체 → 필요한 단계 재제작 → 새 영상 최종 검토`

`pipeline/story/adapter.cjs`를 쓰는 회차에서 사용할 수 있다. 입력 JSON을 직접 고치지 않고 자연어 요청을 적용한다. 새 결과는 `ready_for_review`이며 이전 승인·수정 요청은 해당 이전 버전에 남는다.

수정된 HTML도 MP4 출력 전에 `visual` 검수를 거친다. 잘림·영역 이탈이면 제작을 중단하고, 겹침·가독성 경고는 검토 보고서에 남긴다. 정책이나 화면 검수 결과가 바뀌면 같은 MP4를 재사용하더라도 새 검토 버전이므로 다시 확인해야 한다.

```powershell
# 현재 영상 버전과 수정 대상 장면 확인
node pipeline/cli.cjs review list auto-cs-01
node pipeline/cli.cjs review scenes story-demo-auto-cs-01-01

# 요청 기록; 출력에 Request ID가 표시된다
node pipeline/cli.cjs review request-changes story-demo-auto-cs-01-01 --revision "<현재 Revision 전체 값>" --target peek_scene_end --note "마지막 장면의 제목을 짧게 해줘. 낭독과 다른 장면은 그대로 유지해."

# 화면 문구만 변경하고 재제작
node pipeline/cli.cjs review apply story-demo-auto-cs-01-01 --request "<Request ID>" --scope visual

# 진행·변경 전후·이전 영상과 새 영상 조회
node pipeline/cli.cjs review revision "<Request ID>"
node pipeline/cli.cjs status story-demo-auto-cs-01-01
```

낭독 수정은 `--scope narration`을 사용한다. `--scope both`가 기본값이며 요청 대상 안에서 화면과 낭독을 모두 바꿀 수 있다. `--attempts 1..5`는 이번 명령에서 허용할 패치 생성 호출 횟수이며 기본 3이다. 내용 검사 모델 호출은 별도다. `--model`과 `SHORTS_CODEX_MODEL`, `CODEX_CLI`는 [자동 생성 모듈](../generation/README.md)과 동일하게 사용한다. 기존 Codex 로그인과 이용량을 사용한다.

## 이번 MVP의 수정 범위

| 항목 | 동작 |
| --- | --- |
| `--target <장면 ID>` | 그 장면의 제목·본문과 그 장면에서 읽는 낭독 cue만 수정 가능 |
| `--target episode` | 회차 전체에서 허용된 텍스트 필드 수정 가능 |
| `--scope visual` | 장면 `headline`, `body`; 낭독은 코드로 변경 차단 |
| `--scope narration` | 기존 cue의 `text`; 화면 문구 변경 차단 |
| `--scope both` | 대상 범위 안에서 두 종류의 텍스트 수정 가능 |
| 고정 항목 | 회차 제목, 길이, 음성·속도, 색상·폰트, 장면·cue ID와 순서, 카드·레이아웃·전환·강조 행동 |

대상은 `review scenes`가 출력한 정확한 ID 또는 `episode`여야 한다. 기존에 자유 텍스트 대상으로 기록한 요청은 ID를 지정해 새로 기록한다. 현재 애니메이션 속도·카드 위치·음성 변경 요청은 자동 반영 범위 밖이다. 모델이 지원 불가를 반환하면 이유를 기록하고 멈춘다. 지원하지 않는 요청을 텍스트 변경으로 대신 처리하도록 지시하지 않는다.

모델은 파일 전체나 코드를 쓰지 않고 `{summary, edits}`를 반환한다. 로컬 검증기가 허용된 필드·대상·변경 종류·줄 길이·음성 큐를 검사하고 실제 변경 전후를 계산한다. 변경 없는 패치와 범위 밖 변경은 거부한다. 카드 강조에 사용되는 cue는 첫 발음 토큰도 유지하도록 검사하므로 첫 단어에 연결된 강조 시점을 보존한다. 요청 의미와 설명의 사실성이 정확히 반영됐는지는 최종 영상 검토에서 확인한다.

## 재제작과 버전 보존

`contentReview.mode: required` 시리즈는 수정 후보를 근거 자료와 대조한 뒤 음성 검사와 입력 반영으로 진행한다. 명백한 오류에는 기존 수정 범위 안에서 보완을 시도하고, 근거가 부족하면 `needs_review`로 후보를 보존한다. 모델·자료 변경 오류는 `content_failed`로 남긴다. 같은 요청으로 재개하면 현재 자료와 후보를 다시 검사한다. `review revision`에 내용 보고서 경로도 표시한다. [내용 검증 안내](../content/README.md)를 참고한다.

화면 문구만 바뀌면 기존 `speech` 산출물의 해시와 타이밍을 확인하고 같은 WAV를 사용한다. `prepare → render → verify`만 다시 실행한다. 낭독이 바뀌면 고정된 시리즈 음성·속도로 새 TTS를 합성하고 영상 길이와 장면 전환에 맞는지 검사한다. 통과 후 실제 회차의 `speech`부터 다시 제작한다. 현재 실측용 합성과 회차용 합성을 각각 실행하며, 회차용 음성의 타이밍으로 최종 HTML을 만든다.

기록은 `runs/_revisions/<Request ID>/`에 저장된다.

- `before.json`: 요청 처리 시작 시 원본 입력 바이트
- `after-*.json`: 검증을 통과한 수정 입력
- `attempt-*/`: 시도별 프롬프트·모델 응답·패치
- `check-*/`: 실측 결과·HTML 미리보기·타임라인
- `state.json`: 요청, 기준 영상 버전, 파일 해시, 변경 전후, 진행 상태, 이전·신규 MP4 경로

원본 입력을 보존한 뒤 수정 입력을 원래 회차 파일에 원자적으로 교체한다. 이전 MP4와 검수 결과는 기존 `runs/<회차 ID>/artifacts/`에 계속 남는다. 다른 회차의 입력·영상·검토 상태는 변경하지 않는다.

같은 Request ID와 scope로 `review apply`를 반복하면 완료된 수정 결과를 재사용한다. 재제작이 실패했다면 이미 반영된 명세로 필요한 단계부터 재개한다. 음성 미설치 등 환경 오류에서는 후보를 보존해 모델 재호출 없이 검증부터 재개한다. 대본 규격·길이 오류에는 원본과 이전 패치·실측 오류를 전달해 제한된 횟수 안에서 다시 수정한다. 여러 시도에서도 패치는 항상 원본 입력에 적용된다.

요청의 기준 영상이 바뀌었거나 더 최신 검토 결정이 있으면 반영을 거부한다. 처리 중 수동으로 입력을 편집해도 해시 충돌로 멈추며 덮어쓰지 않는다. 같은 회차의 수정·제작·검토 결정은 잠금으로 조정한다. 같은 요청의 동시 실행도 차단한다. 원본·후보 파일이 변경되면 재개를 거부한다.

`review revision`은 생성·검사·입력 반영·재제작 상태와 오류를 표시한다. 프로세스가 사라진 진행 상태는 `interrupted`로 조회된다. `provider_failed`는 모델 연결, `preflight_failed`는 실행 환경, `render_failed`는 재제작 오류를 먼저 해결한다. `unsupported`는 지원 범위에 맞는 새 요청이 필요하고, `conflict`는 현재 입력·영상과 요청 버전을 확인해야 한다. 최종 승인은 기존 `review approve`로 사람이 확인한 새 Revision에 기록한다.
