# 회차 제작 실행기

저장소 루트에서 Node.js로 실행한다. 예제 회차는 Windows의 Microsoft Heami Desktop, FFmpeg·ffprobe, HyperFrames, Chrome을 사용한다. 검증한 환경은 Node.js 24와 HyperFrames 0.9.17이다.

코드·고정 예제와 실제 제작 데이터를 구분하는 규칙은 [Git 저장 범위와 백업](#git-저장-범위와-백업)을 따른다. 운영 데이터는 Git에서 제외하므로 작업을 이어가려면 별도 백업이 필요하다.

다른 PC로 이동할 때는 [PC 이동·인수인계 안내](handoff/README.md)에 따라 `handoff export <ID>`로 Markdown·파일 해시 목록을 만들고, 실제 파일을 복사한 뒤 새 PC에서 `handoff check <ID>`로 확인한다. 이 명령은 모델·미디어 제작을 호출하지 않으며 실제 백업 복사는 별도다.

## 기간 단위 제작

시작일·일수·시간대·게시 요일과 시각으로 5일 또는 30일치 제작 계획을 만들 수 있다. 계획은 기획 묶음으로 나뉘고, 등록된 회차는 독립적으로 제작된다. 한 회차가 실패해도 나머지는 계속 진행하며, 재개할 때 완료된 영상을 확인해 재사용한다. 게시 예정일과 실제 제작 시점은 별개다.

```powershell
node pipeline/cli.cjs period create planning/my-period.json
node pipeline/cli.cjs period run my-period --jobs 2
node pipeline/cli.cjs period status my-period
node pipeline/cli.cjs period retry-failed my-period --jobs 2
```

`resume`은 미시작·실패·중단·입력 변경 회차를 이어가고, `retry-failed`는 실패한 제작 회차와 실패·보류된 기획 묶음을 선택한다. 기획을 자동 생성하거나 `planIds`로 준비된 미제작 기획을 연결할 수 있다. 설정 예시·재개 범위·보고서는 [기간 제작 안내](period/README.md)를 참고한다. 완성 영상의 최종 승인은 기존 검토 절차를 따르며 Instagram 게시·예약 실행은 포함하지 않는다.

## 기획·대본 자동 생성에서 영상까지

공통 장면 렌더러를 쓰는 시리즈는 기존 기획 이력을 읽어 다음 회차들을 자동 생성할 수 있다. Codex CLI의 기존 로그인으로 기획·대본·장면 JSON을 받고, 규격과 중복을 검사한 뒤 실제 한국어 TTS를 합성해 타이밍을 확인한다. 검증 오류는 모델에 전달해 정해진 횟수 안에서 수정한다. 통과한 회차들을 제작 묶음에 등록하고 MP4 제작·기술 검수까지 진행한다.

새 자동 생성 묶음은 TTS 전에 의미 중복 검사를 거친다. 기존 초안·제작·게시 이력과 새 회차끼리 핵심 지식을 비교한다. 중복 회차만 다시 기획하고 다른 회차는 보존하며, 판단이 애매하거나 재기획 횟수를 소진하면 `needs_review`로 멈춘다. 통과한 회차에는 핵심 지식과 예시 요약을 기록한다. 기존 기획을 별도로 검사하려면 `plan audit <시리즈 ID> --plans <기획 ID 목록>`을 사용한다. 판정 기준과 비용·재개 범위는 [의미 중복 검사 안내](novelty/README.md)에 있다.

```powershell
node pipeline/cli.cjs generate story-demo auto-cs-02 --count 3 --jobs 2
node pipeline/cli.cjs generate status auto-cs-02
node pipeline/cli.cjs batch status auto-cs-02
node pipeline/cli.cjs review list auto-cs-02
```

처음에는 `codex login status`로 로그인을 확인한다. 생성에는 Codex 이용량이 소모되며, 이 경로에서는 별도 API 키를 요구하지 않는다. 새 시리즈는 `series register`로 먼저 등록하고 어댑터를 `pipeline/story/adapter.cjs`로 지정한다. `story-demo`와 `auto-cs-01`은 자동화 검증용 예제이다.

기본값은 최대 3회 생성·수정, 회차 순차 제작이다. `--jobs`는 회차 작업 동시 실행 수(1–8), `--attempts`는 이번 명령의 최대 생성 시도 수(1–5), `--count`는 회차 수(1–10)이다. 현재 HyperFrames는 사용자 계정당 렌더링 잠금을 사용하므로 MP4 렌더링은 대기열에서 순차 처리될 수 있다. `--plan-only`는 생성과 실제 TTS 검증·묶음 등록까지 진행하고 MP4 제작 전에 멈춘다. 같은 묶음 ID로 재실행하면 등록된 대본을 다시 생성하지 않고 기존 회차 제작을 재개한다. 새 회차가 필요하면 새 묶음 ID를 사용한다.

시리즈에 `contentReview`를 설정하면 실제 근거 자료를 대본 생성에 제공하고, TTS 전에 화면·낭독의 내용 검증을 실행한다. 오류 회차만 수정하며 근거 부족은 검토 대기로 남긴다. 직접 제작과 수정 요청도 같은 조건을 적용한다. 설정·출처 기록·검증 범위는 [내용 검증 안내](content/README.md)를 참고한다.

일반 제작 단계에서 제목·화면 문구의 적용 조건 누락이나 모호함이 발견되면 최대 두 번 자동 보완·재검수한다. 근거 부족은 검토 대기로 남기고, 같은 입력을 재실행해도 수정 한도를 초기화하지 않는다. 낭독과 기존 음성은 보존하며 [제작 문구 자동 수정 기록](content/repair-README.md)을 상태 조회에서 확인할 수 있다.

완성 영상은 `ready_for_review`로 남는다. 근거 자료에 대한 모델 판정과 사람의 최종 승인·게시는 별도다. 자세한 생성 기록, 재개 기준, 설정과 현재 검증 범위는 [자동 생성 모듈 안내](generation/README.md)를 참고한다.

## 시리즈 기획에서 제작 묶음 만들기

`planning/examples/series.json`과 `planning/examples/plans.json`은 기획 연결을 검증하는 예제이다. `cs-demo` 시리즈에 기존 이진 탐색 회차와 두 개의 초안을 등록한다. 시리즈 설정에는 대상 시청자, 주제 범위, 기본 길이, 말투, 제작 어댑터를 지정한다.

```powershell
node pipeline/cli.cjs series check planning/examples/series.json
node pipeline/cli.cjs series register planning/examples/series.json
node pipeline/cli.cjs series list
node pipeline/cli.cjs plan add cs-demo planning/examples/plans.json
node pipeline/cli.cjs plan list cs-demo
node pipeline/cli.cjs plan check cs-demo
node pipeline/cli.cjs plan batch cs-demo cs-demo-first --plans sorted-required
node pipeline/cli.cjs batch run cs-demo-first
node pipeline/cli.cjs review list cs-demo-first
```

`series check <series.json>`은 **등록 없이 로컬 사전 점검만** 실행한다. `--json`을 붙이면 오류 코드·필드, 경고, 설치 음성 목록, 실제 적용 기본값과 근거 파일 해시를 JSON으로 받는다. 오류가 있으면 종료 코드 1, 등록 가능하면 0이다. `series register`도 같은 검사를 자동 실행하므로 점검 명령을 생략해도 오류 설정은 저장하지 않는다. 같은 ID의 다른 설정은 거부하고 동일 설정 재등록은 기존 데이터를 유지한다.

공통 장면 어댑터에서는 지원하지 않는 최상위·디자인·음성 설정, 4~90초/30fps 프레임 단위 길이, 색상·글꼴·전환 시간·음성 속도, 화면 검수 정책을 확인한다. 예를 들어 `aspectRatio`, `bgm`, 임의 글꼴·지원하지 않는 음성 제공자 설정은 현재 지원 항목으로 간주하지 않는다. 실제 출력은 1080×1920·30fps다. 설치 음성은 제작과 같은 Windows PowerShell/System.Speech 환경에서 **이름·활성화 여부·ko-KR 언어만 조회**하며 합성하지 않는다. 음성이 없는 경우와 목록 조회 자체가 실패한 경우를 구별한다.

필수 근거 자료는 로컬 파일의 존재·읽기 권한·저장소 내 실제 경로·UTF-8·빈 본문·크기 제한을 점검한다. 출처 URL을 내려받거나 자료의 사실성을 모델로 판정하지 않는다. 등록 직전 근거 해시도 다시 확인한다. 내용 검증이 미설정/off이면 경고를 표시하며 자동으로 켜거나 끄지 않는다. 표시된 공통 기본값은 입력·카탈로그에 추가 저장하지 않아 기존 설정과 캐시 기준을 유지한다.

점검은 카탈로그·회차·실행 기록을 생성하거나 수정하지 않고, 외부 모델·TTS 합성·영상 제작을 호출하지 않는다. Windows 음성 조회 권한 문제는 `VOICE_DISCOVERY_FAILED`로 표시하므로 실행 환경을 해결한 뒤 다시 점검한다. 맞춤 어댑터는 경로·기본 등록 항목만 점검하고 상세 제작 설정·음성 검사는 생략했다고 명시한다. 점검 중에는 어댑터 코드를 실행하지 않으며, 실제 등록 시 기존의 `createStages` 내보내기 검사는 유지한다. 이 점검 통과는 FFmpeg·Chrome·렌더링 성공이나 내용 검수 통과를 의미하지 않는다.

기획 파일은 배열이며 각 항목에 `id`, `title`, `topicKey`, `objective`, `angle`, `references`를 넣는다. 기획 ID는 시리즈 안에서 구분하므로 여러 시리즈가 각각 `ep01`을 쓸 수 있다. `input`을 추가하면 해당 어댑터가 사용하는 완성된 대본·장면 JSON을 연결한다. 예제에서는 `sorted-required`에만 기존 제작 입력이 있다. 다른 초안은 대본과 장면을 작성한 뒤 연결한다.

초안을 보완할 때는 수정할 항목의 전체 명세를 배열로 작성해 `plan update <시리즈 ID> <기획 파일>`로 저장한다. 제작 묶음을 만들기 전까지 제목·핵심 지식·참고 자료·입력 경로를 수정할 수 있다. 이미 생성된 회차의 영상 수정은 카탈로그의 `episodes[회차 ID].episode`가 가리키는 입력 JSON 또는 제작 템플릿을 수정하고 기존 `run` 명령을 사용한다.

- `plan batch`에 `--plans ep01,ep03`을 주면 해당 순서로 선택한다. `--count 5`는 등록 순서대로 아직 회차로 생성되지 않은 입력 준비 완료 기획 다섯 개를 선택한다. 요청한 개수를 채우지 못하면 오류를 반환한다.
- `topicKey`는 같은 시리즈에서 동일 내용을 식별하는 기준이다. 대소문자, 앞뒤 공백, 연속 공백, 유니코드 표기 차이를 정규화해 비교한다. 초안과 제작된 기획, 게시 이력 모두 검사하며, 중복되는 기획을 선택하면 묶음 생성을 중단한다. 중복이 발견되면 미제작 기획을 `plan update`로 정리할 수 있다.
- `scheduledFor`에 `2026-11-20T19:00:00+09:00`처럼 시간대가 있는 게시 예정일을 저장할 수 있다. 게시를 마친 외부 이력을 가져올 때는 `publishedAt`을 함께 기록한다. 이 날짜들은 기획·이력 데이터로 보존된다. 예정일이 미래여도 제작 명령은 즉시 실행된다.
- 새 회차 ID는 `<시리즈 ID>-<기획 ID>`이다. 생성 시 입력 파일을 복사하고, 입력에 빠진 제목·대상 시청자·말투·영상 길이에 기획과 시리즈 기본값을 채운다. 이 값의 실제 사용 범위는 제작 어댑터가 정한다. 현재 예제 어댑터는 이진 탐색 영상의 구조에 맞춰져 있다.
- 등록 데이터는 `planning/catalog.json`, 생성된 제작 입력은 `planning/inputs/`에 저장된다. 입력들을 준비한 뒤 회차 목록과 묶음을 한 번에 공개한다. 같은 묶음 이름과 선택으로 재시도하면 이미 생성한 결과를 사용한다. 원본 기획 입력 파일을 나중에 바꿔도 생성된 회차의 입력 복사본은 별도로 관리된다.

제작 묶음과 회차는 기존 `run`, `status`, `retry-failed`, `review` 명령에서 바로 사용할 수 있다. `plan list`에서도 생성 후 제작·검토 상태를 확인할 수 있다.

## 공통 장면 렌더러

공통 장면 회차는 HTML 준비 뒤 `visual` 단계에서 화면·가독성을 자동 검사한다. 화면 이탈·글자 잘림은 MP4 제작 전에 막고, 겹침·작은 글자·짧은 읽기 시간은 경고와 대표 이미지로 남긴다. 기본으로 활성화되며 시리즈별 기준을 설정할 수 있다. [화면 검수 안내](visual/README.md)를 참고한다.

`pipeline/story/adapter.cjs`는 질문·설명·카드·결론 장면을 회차 JSON에서 읽는다. 시리즈의 `renderProfile`에서 글꼴·색상·전환 속도를 설정하고, 회차의 음성 큐와 카드 ID로 강조·연속 이동을 지정한다. 명세와 시리즈 설정 예제는 `pipeline/story/README.md`, `samples/story/`에 있다.

```powershell
node pipeline/cli.cjs batch status story-demo-pair
node pipeline/cli.cjs review list story-demo-pair
```

스택과 큐 예제 두 편은 같은 렌더러를 사용한다. 새 회차는 이 명세에 맞는 대본·장면 입력을 기획의 `input`에 연결하면 된다.

## 제작 묶음 실행

`batches.json`에 묶음 이름과 제작할 회차 ID 목록을 순서대로 적는다. 예제 `prototype-demo`에는 기존 이진 탐색 30초(`binary-search-30`)와 퍼센트 회복 15초(`recovery-15`)가 들어 있다. 회차별 제작 명세와 어댑터는 `episodes.json`에서 연결한다.

```powershell
node pipeline/cli.cjs batch run prototype-demo
node pipeline/cli.cjs batch status prototype-demo
node pipeline/cli.cjs batch retry-failed prototype-demo
```

- 기본값은 한 번에 한 편이다. 서로 다른 회차를 동시에 실행하려면 `batch run prototype-demo --jobs 2`처럼 지정한다. 1~8을 지정할 수 있고 재시도에도 적용된다.
- `batch status`는 다른 터미널에서도 조회할 수 있다. 표에서 회차마다 묶음 상태, 누적 실행 시도 수, 현재 제작 단계를 확인한다. 실행 차례를 기다리는 동안에는 `queued`, 차례가 오면 `running`으로 표시된다. 실패 시 원인도 표시된다. `node pipeline/cli.cjs status <회차 ID>`는 단계별 상세 상태와 완성된 MP4 경로를 보여준다.
- 한 편이 실패하거나 내용 검토 대기(`needs_review`)여도 다른 회차는 끝까지 진행한다. `run`과 `retry-failed`는 종료 시 실패·보류 회차가 남으면 종료 코드 1을 반환한다. 원인을 보완한 뒤 `retry-failed`를 실행하면 실패·보류 회차만 다시 시도한다. 같은 입력·자료로 보류된 회차는 모델을 다시 호출하거나 자동 수정 한도를 초기화하지 않는다. 이미 성공한 회차를 수정했거나 새 회차를 추가했다면 `run`을 쓴다. 유효한 기존 산출물은 재사용한다.
- 프로세스가 중간에 종료된 회차는 `interrupted`로 조회된다. 차례가 오기 전에 종료됐다면 이전 결과를 유지하며, 첫 실행 전이면 `pending`이다. 전체 `run`으로 재개할 수 있다. 상태 기록은 `runs/_batches/<묶음 ID>/state.json`에, 실제 제작물은 `runs/<회차 ID>/`에 저장된다. 같은 묶음의 동시 실행은 차단된다.

## 회차 하나 실행

```powershell
node pipeline/cli.cjs status binary-search-30
node pipeline/cli.cjs run binary-search-30
```

`status`는 입력과 산출물의 현재 상태를 조회한다. 공통 장면의 `run`은 음성(`speech`), HTML(`prepare`), 화면 검수(`visual`), MP4(`render`), 기술 검수(`verify`) 순으로 필요한 단계만 실행한다. 전용 어댑터는 해당 어댑터가 정한 단계를 사용한다. `ready_for_review`가 되면 최종 MP4와 검수 보고서의 경로가 출력된다. 사람이 영상을 보고 수정하거나 승인할 시점이다.

내용 검증이 필수인 공통 장면 시리즈는 `content` 검사를 음성 앞에서 실행한다. 근거와 대본이 같으면 검사 결과를 재사용하며, 자료가 바뀌면 다시 검사한 뒤 기존 음성을 재사용할 수 있다. 상태 조회 자체는 모델을 호출하지 않는다.

- 장면 문구·전환 시간을 수정하고 같은 명령을 실행하면 기존 음성과 타이밍을 사용한다. 낭독문이나 음성 설정이 바뀌면 음성부터 다시 만든다.
- `runs/<회차 ID>/state.json`에 단계별 상태와 산출물 해시가 저장된다. 실패나 중단 후 같은 명령을 실행하면 완료된 결과를 확인한 뒤 이어간다. 한 회차를 두 프로세스에서 동시에 시작하면 두 번째 실행을 거부한다.
- 기술 검수는 H.264 영상의 크기·길이·프레임 수·프레임률과 AAC 오디오 트랙을 확인한다. 공통 장면의 화면 검수는 주요 시점의 배치·가독성을 추가로 확인하며 전체 영상의 최종 확인은 유지한다.

`episodes.json`에서 회차 ID에 입력 JSON과 제작 어댑터를 연결한다. 이진 탐색 어댑터는 해당 영상의 배열과 내레이션 큐를 전제로 한다. 새 시리즈는 자체 어댑터에서 단계별 입력, 산출물, 실행 함수를 제공하고 같은 실행기를 사용한다.

도구를 별도 위치에 설치했다면 `HYPERFRAMES_CLI`(Node 진입 파일 또는 실행 파일), `HYPERFRAMES_BROWSER_PATH`, `HYPERFRAMES_FFMPEG_PATH`, `HYPERFRAMES_FFPROBE_PATH`로 경로를 지정할 수 있다.

## 최종 검토와 수정 요청

묶음의 검토 상태와 MP4·기술 검수 보고서 경로를 조회한 뒤 영상을 확인한다. 승인과 수정 요청에는 해당 목록에 표시된 `Revision` 전체 값을 사용한다.

```powershell
node pipeline/cli.cjs review list prototype-demo
node pipeline/cli.cjs review approve recovery-15 --revision "<확인한 Revision 값>"
node pipeline/cli.cjs review request-changes binary-search-30 --revision "<확인한 Revision 값>" --target "counterexample" --note "마지막 장면의 전환 시간을 0.80초로 늘려 주세요."
```

`request-changes`는 회차·영상 버전·수정 대상·요청 내용을 기록한다. 요청에 맞춰 회차 명세나 템플릿을 수정한 다음 해당 회차를 실행한다. 예를 들어 이진 탐색 회차의 `episode.json`에서 마지막 장면의 `transitionSeconds`를 바꾼 뒤 아래 명령을 사용한다. 기존 단계별 입력 비교에 따라 화면 변경은 음성을 재사용하고, 낭독문 변경은 음성부터 제작한다.

```powershell
node pipeline/cli.cjs run binary-search-30
node pipeline/cli.cjs review list prototype-demo
node pipeline/cli.cjs batch status prototype-demo
```

| 검토 상태 | 의미 |
| --- | --- |
| `ready_for_review` | 현재 영상이 완성돼 최종 확인을 기다린다. |
| `approved` | 현재 영상 버전에 승인이 기록돼 있다. |
| `changes_requested` | 현재 영상에 수정 요청이 남아 있다. |
| `needs_rebuild` | 제작 입력이나 산출물이 변경돼 다시 제작해야 한다. |
| `unavailable` | 제작을 완료하고 기술 검수를 통과해야 검토할 수 있다. |

검토 이력은 `runs/<회차 ID>/review.json`에 저장된다. 같은 영상을 그대로 재사용하면 검토 결과가 유지된다. 새 영상 버전은 다시 `ready_for_review`로 표시되고 이전 수정 요청은 참고용으로 함께 보인다. 다른 회차의 승인은 각 회차에 남아 있다. 오래된 Revision으로 승인하거나 제작 중 검토 결과를 저장하려 하면 오류를 반환한다. `batch status`의 검토 열은 현재 영상 기준이며, 묶음 실행 열은 마지막 제작 시도의 결과이다.

## 수정 요청 자동 반영

공통 장면 렌더러를 사용하는 회차는 기록된 요청을 모델이 텍스트 패치로 바꾸고, 검사 후 필요한 제작 단계부터 다시 실행할 수 있다. 현재 지원 범위는 장면의 제목·본문과 기존 낭독문이다. 대상 장면과 수정 종류를 코드로 제한하며, 음성·영상 길이·디자인·카드와 장면 구조는 유지한다.

```powershell
node pipeline/cli.cjs review scenes story-demo-auto-cs-01-01
node pipeline/cli.cjs review list auto-cs-01
node pipeline/cli.cjs review request-changes story-demo-auto-cs-01-01 --revision "<현재 Revision>" --target peek_scene_end --note "마지막 제목을 짧게 해줘. 낭독은 그대로 유지해."
node pipeline/cli.cjs review apply story-demo-auto-cs-01-01 --request "<출력된 Request ID>" --scope visual
node pipeline/cli.cjs review revision "<Request ID>"
```

`--scope visual`은 화면 문구만, `narration`은 대상 장면의 낭독문만, 기본값인 `both`는 둘 다 허용한다. 화면 수정은 기존 음성을 검사 후 재사용하고, 낭독 수정은 새 음성 길이와 장면 타이밍을 실측한다. 새 영상은 자동 승인되지 않고 검토 대기로 돌아간다. 원본 입력과 이전 영상·수정 전후 문구·모델 시도 기록을 보존한다. 실패 후 같은 `review apply` 명령을 실행하면 저장된 후보 또는 반영된 명세에서 재개한다.

상세 지원 범위와 복구 방법은 [자동 수정 안내](revision/README.md)를 참고한다.

## Git 저장 범위와 백업

현재는 파일 기반 운영을 유지한다. DB·서버·원격 저장소 연동은 추가하지 않는다. 아래 Git 포함 항목은 커밋할 대상이며, 이 안내나 `.gitignore` 변경 자체가 GitHub 업로드를 수행하지는 않는다.

### GitHub에 올릴 파일과 로컬에 둘 파일

| 위치 | Git 포함 | 역할과 보존 방식 |
| --- | --- | --- |
| `pipeline/` | 포함 | 실행기·제작 단계·검사 코드·테스트·문서. `episodes.json`, `batches.json`은 고정 예제 등록부다. |
| `planning/examples/` | 포함 | 재사용할 시리즈·기획 설정 예시. |
| `samples/`의 작성된 원본 | 포함 | HTML·CSS 템플릿, 회차·시리즈 명세, 스크립트, 근거 노트, 고정 검증 입력. `package.json`과 `package-lock.json`도 포함한다. |
| `planning/catalog.json`, `planning/inputs/` | 제외 | 실제 시리즈·기획·회차·일정·게시 이력과 생성된 회차 입력. `runs/`와 함께 백업한다. |
| `runs/` | 제외 | 실행·검수·승인·수정 이력, 모델 응답, TTS·타이밍·HTML·MP4·검수 이미지 등. 재개와 결과 재사용에 필요하므로 전체를 보존한다. |
| `renders/`, 샘플의 `generated/`, `generated-final/`, `.speech-output-*/` | 제외 | 완성 영상·비교 이미지·프로토타입 생성 결과. 기존 파일을 보존하고 백업한다. |
| `node_modules/`, `.hyperframes/` | 제외 | 다시 설치하거나 만들 수 있는 의존성·렌더러 캐시. 일반 백업에서 제외할 수 있다. |
| `local/` | 제외 | 앞으로 비공개 시리즈 설정·근거 자료·운영 요청을 둘 예약 위치. 사용하면 백업에 포함한다. |
| `backups/` | 제외 | 필요할 때 백업을 임시로 모으는 예약 위치. 같은 디스크의 복사본만으로는 장치 고장에 대비할 수 없다. |
| `.env`, `.env.*`, `secrets/`, `.secrets/` | 제외 | 인증 정보. 일반 작업 백업과 분리하여 암호화 보관하거나 복구 후 다시 설정한다. 실제 비밀값이 없는 `.env.example`, `.env.*.example`은 포함 가능하다. |

위 경로는 저장소 루트를 기준으로 한다. `node_modules/`, `.hyperframes/`, 환경 파일 규칙은 하위 폴더에도 적용된다. 생성 결과 제외 규칙은 현재 `samples/<예제>/` 구조를 기준으로 한다. 새로운 폴더 구조나 출력 경로를 도입하면 Git 제외 범위도 함께 점검한다.

파일의 확장자만으로 구분하지 않는다. 예를 들어 `samples/first-render/index.html`은 작성된 원본이며, `samples/content-repair/archived-hold-report.json`과 `samples/period-auto/history/`는 테스트에 필요한 고정 자료다. 이들을 실행 중 생성되는 보고서·이력과 혼동하여 제외하거나 삭제하지 않는다. 직접 제작한 이미지·음원도 필요하면 라이선스와 공개 범위를 확인해 원본 자산으로 관리할 수 있다.

`samples/content-repair/archived-hold-report.json`은 공개 전 두 보고서 위치 필드를 저장소 상대경로로 정리했다. 내용 판정·근거·입력 해시는 유지했으며, `provenance.json`에 현재 파일 해시와 정리 전 원본 해시·변경 필드를 기록했다. 원본 바이트는 Git에서 제외되는 `runs/_git-publication/`의 로컬 감사 기록에 보존했다. 앞으로 고정 자료를 변경할 때도 관련 provenance와 검증 해시를 함께 점검한다. 상대경로로 남은 과거 운영 기록의 위치가 Git 복제본에 실제 존재한다는 뜻은 아니다.

`.gitignore`는 파일을 지우거나 백업하지 않으며 이미 커밋된 파일을 과거 이력에서 제거하지도 않는다. 이번 정리 시점에는 Git 추적 파일이 없어 추적 해제 작업이 필요하지 않았다. 기존 파일은 이동·삭제하지 않고 제외 규칙만 적용한다.

### 새 시리즈를 추가할 때

- 공유할 시리즈 명세·디자인·템플릿·근거 예제는 작성된 원본으로 버전 관리한다. 현재는 `samples/<시리즈>/` 구조를 활용할 수 있다.
- 비공개 운영 입력은 `local/<시리즈>/`에 둘 수 있다. 예를 들어 `series.json`, `period.json`, `sources/`를 두고 CLI에 해당 파일 경로를 명시한다. 이 경로는 정리 규칙이며 자동 탐색·등록 기능은 아니다.
- 등록·기획·제작으로 생긴 데이터는 기존대로 `planning/catalog.json`, `planning/inputs/`, `runs/`에 저장된다. 시리즈별로 저장소를 나누거나 DB로 옮기는 변경은 하지 않는다.
- 근거 자료와 설정을 다른 위치에서 참조한다면 그 실제 파일도 백업 대상에 포함한다. 근거의 내용·경로가 바뀌면 검수나 재사용 판정에 영향을 줄 수 있다.

### 백업 묶음 구조

운영 재개용 백업은 **같은 시점의 코드·설정·카탈로그·회차 입력·실행 기록·산출물**을 묶는다. MP4만 복사하면 승인 이력·자동 수정 횟수·음성 타이밍·완료 단계의 재사용 정보를 복원할 수 없다. GitHub에서 코드만 내려받아도 현재 운영 상태는 복원되지 않는다.

아래는 앞으로 만들 백업의 권장 구조다. 백업 생성기나 정기 실행 기능은 아직 구현하지 않았으며, 이 문서를 작성하면서 실제 백업을 생성한 것도 아니다. `<백업 위치>`는 저장소 밖의 별도 디스크 등으로 지정한다.

```text
<백업 위치>/instagram_shorts_maker/<YYYYMMDD-HHMMSS>/
  manifest.json
  workspace/
    .gitignore
    pipeline/
    planning/              # examples + catalog.json + inputs 전체
    samples/               # 원본 + 기존 generated 결과 포함
    runs/                  # 회차별 폴더와 _로 시작하는 폴더 전체
    renders/
    local/                 # 사용하는 경우
```

`runs/_generation`, `_batches`, `_periods`, `_revisions`, `_content-repairs`도 다른 `runs/` 내용과 함께 복사한다. 폴더 이름이 내부 기록처럼 보인다는 이유로 제외하지 않는다. 고정된 목록만 복사하지 않고 이후 추가되는 운영 기록도 포함한다.

백업의 제외 기준은 Git 제외 기준과 다르다. `planning/catalog.json`, `planning/inputs/`, `runs/`, `renders/`, 기존 샘플 생성물은 Git에서 제외하지만 운영 백업에는 포함한다. `node_modules/`, `.hyperframes/`, 백업 목적지와 임시 `backups/` 자체는 제외한다. 인증 파일·키는 별도 보안 보관 대상으로 분리한다. 소스 스냅샷에 `.git/`은 포함하지 않으며 Git 커밋 이력 보존은 원격 저장소나 별도 Git 백업이 담당한다. 아직 커밋하지 않은 코드·설정도 `workspace/`에 실제 파일로 복사해야 한다.

`manifest.json`에는 다음 항목을 기록하도록 한다.

- 백업 형식 버전, 생성 시각과 시간대, 원래 저장소 절대 경로.
- Git 커밋 ID가 있으면 그 값과 미커밋 변경 여부. 커밋이 없으면 없음을 명시.
- Node.js·HyperFrames·FFmpeg·ffprobe와 TTS 음성 등 재현에 필요한 도구·설정 정보.
- 포함 파일별 상대 경로·크기·SHA-256과 실제 제외 목록, 누락·읽기 실패 여부.
- 모든 복사본의 해시를 확인한 뒤 완료 상태. 읽기·복사·해시 확인 실패가 있으면 불완전 백업으로 표시.

처음에는 날짜별 새 폴더를 만들고 이전 백업을 덮어쓰거나 자동 삭제하지 않는다. 시리즈 등록·대량 제작·수정 반영 후 백업하는 방식부터 시작할 수 있다. 정기 실행이나 보관 기간에 따른 삭제는 별도 운영 정책을 정한 뒤 추가한다.

### 백업과 복구 절차

1. **쓰기 작업을 멈춘다.** 기획·제작·수정·승인 명령과 수동 편집이 끝난 시점에 복사한다. 현재 잠금은 작업별 잠금이며 저장소 전체의 백업 시점을 보장하지 않는다. 제작 도중 파일만 복사한 묶음을 일관된 백업이라고 간주하지 않는다.
2. **새 백업 폴더에 복사하고 검증한다.** 위 범위를 함께 복사하고 원본·복사본의 파일 수와 SHA-256을 비교한다. 인증 정보는 별도로 처리한다. 원본을 이동하거나 정리하지 않는다.
3. **빈 별도 폴더에서 복구를 시험한다.** manifest와 복사본 해시를 먼저 확인한다. 현재 작업 폴더 위에 덮어쓰지 않는다. 이 단계의 파일 일치 확인은 제작 재개 검증과 구분한다.
4. **경로와 실행 환경을 맞춘다.** 실제 운영 복구에는 가능한 한 원래 절대 경로를 사용한다. Node.js·렌더링 도구·한국어 음성을 준비하고 필요한 의존성을 설치한다. 인증 정보는 별도 보관본이나 재로그인으로 복구한다.
5. **상태를 읽어서 확인한다.** `series check <시리즈 설정 파일>`, `period status <기간 ID>`, `review list <제작 묶음 ID>`로 설정·진행·최종 검토 상태를 확인한다. 이 명령들은 외부 모델을 호출하지 않는다. 백업 확인을 이유로 자동으로 `run`, `resume`, `review apply`를 실행하지 않는다.

현재 일부 생성·수정 기록에는 보고서·영상의 절대 경로가 저장된다. [인수인계 기능](handoff/README.md)은 다른 루트의 파일 일치를 점검하며, 문구 보완의 중단 기록도 현재 루트의 회차 입력으로 재개하도록 호환한다. 과거 보고서 링크와 모든 전용 어댑터의 자동 이전까지 보장하지는 않는다. 단순 문자열 치환은 입력·해시 검증을 바꿀 수 있으므로 기존 기록은 그대로 보존한다.

깨끗한 Git 복제본은 코드와 고정 예제로 새 작업을 시작하는 용도다. 기존 운영 카탈로그·산출물을 전제하는 실영상 검증 명령까지 모두 바로 실행되는 환경은 아니다. 기존 작업을 이어가려면 운영 백업과 그 백업 시점의 코드·근거를 함께 복원한다.
