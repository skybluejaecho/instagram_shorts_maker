# 공통 회차 제작 명세 v1

`adapter.cjs`는 회차 JSON을 읽어 한국어 음성, HTML 미리보기, MP4와 검수 보고서를 만든다. 질문·설명·카드·결론 화면을 제공하며 1080×1920, 30fps로 출력한다. 스택과 큐 예제는 동일한 어댑터에 서로 다른 JSON을 전달한다.

```powershell
node pipeline/cli.cjs series register samples/story/series.json
node pipeline/cli.cjs plan add story-demo samples/story/plans.json
node pipeline/cli.cjs plan batch story-demo story-demo-pair --plans stack,queue
node pipeline/cli.cjs batch run story-demo-pair --jobs 2
node pipeline/cli.cjs review list story-demo-pair
```

## 입력 구성

`samples/story/stack.json`과 `queue.json`을 전체 명세 예제로 사용한다. 필수 최상위 필드는 `version: 1`, `title`, `durationSeconds`, `narration`, `scenes`이다. 영상 길이는 4~90초이며 프레임 단위로 설정한다.

- `narration`은 `{ "id": "pop", "text": "비가 먼저 나옵니다." }` 형태의 음성 구간 목록이다. 각 ID의 기준 시각은 합성기의 실제 첫 단어 시작 이벤트다. 강조할 단어부터 구간을 시작하면 해당 단어에 동작을 맞출 수 있다.
- `scenes`는 `id`, `type`, `from`, `headline`을 가진다. `from`에는 음성 구간 ID를 넣으며 기재 순서대로 장면이 이어진다. 첫 장면은 0초에 시작하고 이후 장면은 지정된 음성 큐에서 시작한다.
- `type`은 `question`, `explanation`, `cards`, `conclusion` 중 하나다. `body`는 선택 사항이다. 제목은 명시적인 줄바꿈 두 줄, 본문은 세 줄까지 지원한다. 시각적 폭 제한에 맞춰 글자 크기를 조정한다.
- `cards`에는 `{ "id": "b", "label": "B" }`처럼 최대 네 카드를 지정한다. 카드 배치 `layout`은 `row` 또는 `stack`이다. 배열 순서대로 가로줄은 왼쪽→오른쪽, 스택은 아래→위에 놓인다. 같은 ID의 카드는 같은 문구를 사용한다.
- `carry`는 직전 장면에서 다음 장면으로 이어갈 카드 ID 목록이다. 이전 위치에서 새 위치로 이동한다. 지정한 카드는 두 장면에 모두 있어야 한다.
- `actions`에는 `{ "type": "highlight", "target": "b", "at": "pop" }`처럼 해당 장면의 카드와 음성 큐를 연결한다. 강조는 지정한 큐에서 시작하며 그 장면 동안 유지된다.

같은 배치 안에서 이어지는 카드들은 순서를 유지한다. `stack`↔`row`로 바뀔 때는 가로·세로 이동을 나눠 카드를 펼치거나 쌓는다. 이전 카드를 이어받는 장면에 새 카드도 추가하면, 이동이 끝난 뒤 새 카드가 등장한다. 새 카드의 강조 큐 역시 그 등장 이후에 두어야 한다.

## 시리즈 설정

등록 전에 `node pipeline/cli.cjs series check <series.json>`으로 설정·설치된 한국어 음성·근거 자료를 로컬에서 확인할 수 있다. `series register`에도 같은 사전 점검이 적용된다. 오류 항목을 보완하면 되고, 검사 과정에서 모델 호출이나 음성 합성은 하지 않는다. [등록 사전 점검 안내](../README.md#시리즈-기획에서-제작-묶음-만들기)를 참고한다.

시리즈 JSON의 `renderProfile`에서 `brand`, `fontFamily`, `colors`, `transitionSeconds`, `speech`를 설정한다. 묶음을 만들 때 회차 입력의 `profile`로 복사된다. 회차 자체에 `profile`이 있으면 그 객체가 우선하고 생략된 값은 공통 기본값으로 채운다.

지원 색상 항목은 `background`, `text`, `accent`, `muted`이며 `#RRGGBB`로 지정한다. 글꼴은 Windows의 `Malgun Gothic` 또는 `Arial`이다. 전환 시간은 0.15~1.5초다. 기본 음성은 `Microsoft Heami Desktop`, 속도는 2이며 설치된 한국어 음성과 -10~10 속도를 사용할 수 있다. 한국어 렌더링에는 해당 PC의 설치 글꼴을 사용한다.

이미 만들어진 회차를 수정할 때는 `planning/catalog.json`의 해당 회차 `episode` 경로를 편집한다. 색상·장면·동작 변경 후 재실행하면 기존 음성을 재사용한다. 낭독문·음성·속도가 바뀌면 음성부터 다시 만든다.

## 제작 전 확인

등록된 공통 장면 시리즈가 `contentReview.mode: required`이면 `content` 단계를 음성 앞에서 실행한다. 실제 근거 자료의 구절과 화면·낭독 설명을 대조하고 통과한 입력만 제작한다. 자료나 화면 내용 변경은 검사를 갱신하지만 낭독이 같으면 음성을 재사용한다. 설정과 보고서는 [내용 검증 안내](../content/README.md)를 참고한다.

어댑터를 불러오는 단계에서 필수 값, 지원하는 장면과 동작, 텍스트 길이, 중복 ID, 음성 큐와 카드 참조를 확인한다. 잘못된 입력은 기획에서 묶음을 만드는 단계에서도 거절된다.

음성을 합성한 뒤에는 WAV 해시와 낭독문, 음성 설정, 큐 순서, 실제 영상 길이를 검사한다. 내레이션 뒤에 최소 1초가 남아야 하고 각 장면은 전환 시간보다 최소 0.2초 길어야 한다. 이를 통과하면 HTML을 만들고 MP4 렌더링으로 진행한다.

`prepare` 단계에는 `index.html`, `narration.wav`, `timeline.json`이 생성된다. 타임라인 파일에서 장면 시작·끝, 강조 시각, 카드의 시작·도착 위치를 확인할 수 있다. 제작 내용과 최종 시각적 품질은 기존 검토·승인 흐름에서 확인한다.

`prepare` 다음의 `visual` 단계는 실제 Chrome에서 안정·전환 구간을 구분해 화면 이탈·글자 잘림·겹침·읽기 시간을 확인한다. 기본 활성화되며 시리즈의 최상위 `visualReview`에서 안전영역과 최소 글자 크기 등을 설정한다. 오류는 렌더링을 막고, 경고는 보고서와 함께 최종 확인으로 넘긴다. 명령과 보고서·캐시 기준은 [화면 검수 안내](../visual/README.md)에 있다.
