# 화면·가독성 자동 검수

공통 장면 렌더러의 준비된 HTML을 실제 Chrome에서 열고 CSS 애니메이션을 지정된 시각에 멈춰 검사한다. 화면 밖으로 나가는 내용과 글자 잘림은 MP4 제작 전에 차단하며, 겹침·작은 글자·읽기 시간 부족은 사람이 확인할 경고로 남긴다. 모델 호출이나 별도 API 키는 필요하지 않다.

## 제작 흐름

`내용 검증(시리즈 정책에 따라) → speech → prepare → visual → render → verify → 최종 확인`

`pipeline/story/adapter.cjs`의 화면 검수는 기본으로 활성화된다. 기존 다른 전용 어댑터는 적용 대상이 아니다. `generate --plan-only`는 기존처럼 기획·TTS 실측·묶음 등록까지이며, 화면 검수는 실제 회차의 `run`/`batch run`에서 준비된 HTML에 적용한다. 수정 요청으로 재제작할 때도 같은 단계를 거친다.

```powershell
# 정상 제작 중 HTML 준비 뒤 자동 검사
node pipeline/cli.cjs run content-cs-demo-content-cs-01-02
node pipeline/cli.cjs status content-cs-demo-content-cs-01-02
node pipeline/cli.cjs review list content-cs-01

# 현재 입력에 맞는 준비된 HTML만 별도로 재검사
node pipeline/cli.cjs visual audit content-cs-demo-content-cs-01-02
```

`visual audit`은 별도 보고서를 생성한다. 회차 상태·영상·승인 결정을 변경하지 않는다. 현재 준비된 HTML이 없다면 먼저 회차를 실행한다. 화면 검수에서 실패해도 준비된 HTML은 보존되므로 단독 검사에 사용할 수 있다.

## 검사 기준

| 항목 | 결과 |
| --- | --- |
| 화면·안전영역 밖의 글자·카드 | 오류: 제작 및 이전 영상 재사용 중단 |
| 잘림 영역에 가려지는 글자, 가로 넘침, 카드 상자 밖 글자 | 오류 |
| 안정된 장면에서 제목이 없거나 보이지 않음 | 오류 |
| 제목·본문·카드 겹침 | 경고: 의도한 배치인지 최종 확인 |
| 역할별 최소 글자 크기 미달 | 경고 |
| 짧은 장면, 안정된 표시 구간 부족, 문구 대비 읽기 시간 부족 | 경고 |
| 전환 중 카드 겹침 | 별도 전환 경고 |

검수 상태는 `passed`, `warnings`, `failed`이다. 경고는 제작을 계속하며 최종 승인에서 확인한다. 오류가 있으면 회차 실행 상태가 `failed`로 남고 `visual` 보고서에서 원인을 볼 수 있다. 자동으로 문구나 배치를 수정하지는 않는다.

장면마다 전환 구간과 안정 구간을 나눠 각각 대표 시각을 측정한다. 전환 중 등장·퇴장 위치는 화면 이탈 오류로 취급하지 않는다. 안정 구간은 전환 뒤 0.25초 여유부터 장면 끝 0.2초 전까지이며, 시작·중간·끝을 검사한다. 안정 구간이 없으면 그 사실을 경고하고 전환 측정만 남긴다. 모든 시각을 검사하는 기능은 아니다.

글자 상자뿐 아니라 실제 텍스트 Range의 측정 영역과 상위 잘림 영역을 사용한다. Windows 한글 글꼴의 ascent/descent가 자동 높이 글자 상자를 조금 벗어나는 정상 현상은 오류로 처리하지 않는다. 실제 잘림, 가로 넘침, 화면·안전영역 이탈 검사는 유지한다.

읽기 시간은 제목·본문에서 공백과 문장부호를 제외한 문구량을 사용하며, ASCII 영숫자는 한글보다 작은 가중치로 계산한다. 항상 표시되는 브랜드와 반복 카드 이름은 중복 계산하지 않는다. 실제 독자의 이해 속도와 다를 수 있는 추정치이므로 시리즈별로 조정한다.

## 시리즈별 설정

시리즈 JSON의 최상위 `visualReview`에 설정하거나 기존 시리즈의 정책만 교체한다. 생략된 항목에는 기본값을 채운다. 다른 시리즈·기획·입력 파일은 수정하지 않는다.

```powershell
node pipeline/cli.cjs series visual story-demo samples/visual/policy.json
```

```json
{
  "mode": "required",
  "safeArea": { "top": 120, "right": 96, "bottom": 160, "left": 96 },
  "minFontPx": { "headline": 54, "body": 32, "card": 32, "brand": 28 },
  "charsPerSecond": 12,
  "minSceneSeconds": 1.2,
  "overlapTolerancePx": 4
}
```

안전영역은 1080×1920 캔버스의 안쪽 여백이며 특정 플랫폼의 최신 UI 규격이라는 뜻이 아니다. 설정 이름의 오타·유효하지 않은 수치·면적이 없는 안전영역은 거부한다. `{"mode":"off"}`는 화면 검사 단계를 명시적으로 제외한다. 정책을 바꾼 뒤 새 자동 생성 요청에는 새 묶음 ID를 사용한다.

정책만 바꾸면 화면 검사를 다시 하고, 내용·낭독·HTML이 같으면 기존 내용 검증·음성·MP4는 재사용한다. 검사 결과와 정책은 승인 버전에 연결되므로, 새 경고가 생긴 검수 결과가 이전 승인으로 자동 통과하지 않는다. 기존 영상과 승인 기록은 보존된다.

## 보고서와 재개

회차 보고서는 `runs/<회차>/artifacts/visual/<검사>/`, 단독 검사는 `runs/_visual/audit-*/`에 저장한다.

- `report.html`: 장면별 대표 이미지, 문제 시각·요소, 위치 표시, 전체 검사 프레임.
- `report.json`: 판정·측정 근거·임계값·입력 해시·한계.
- `capture.json`: 실제 브라우저와 DOM 측정값.
- `frames/`: 안정·전환 구간의 1080×1920 PNG.
- `frames.json`: 모든 검수 이미지의 경로와 SHA256.
- `failure.json`: 브라우저 실행·측정 과정이 실패했을 때 진단 정보.

같은 입력과 검수 결과를 재사용하면 브라우저를 다시 실행하지 않는다. 보고서나 이미지가 누락·변조되면 재검사하며, 실패한 검사는 이전 MP4의 승인·재사용도 막는다. 검사 중 입력·정책·준비된 HTML/타임라인이 바뀌면 중단한다. 원인을 수정한 뒤 같은 `run` 명령으로 재개한다.

Chrome은 새 임시 프로필로 실행하고 검사가 끝나면 닫는다. 검사 페이지의 JavaScript와 외부 요청은 차단하며 해당 HTML 폴더 안의 제한된 미디어·폰트만 읽는다. 현재 지원하는 CSS 애니메이션 렌더러에 맞춘 검사다. 임의 JavaScript 애니메이션·외부 웹사이트 검사기로 사용하지 않는다.

## 도구와 검증

기존 Chrome과 HyperFrames 설치에 포함된 `puppeteer-core`를 사용한다. 새 패키지를 자동 다운로드하지 않는다. 별도 경로에서는 `HYPERFRAMES_BROWSER_PATH`로 Chrome 실행 파일을, `VISUAL_PUPPETEER_PATH`로 설치된 puppeteer-core 모듈이나 패키지 폴더를 지정한다. Windows에서 Chrome 실행이나 임시 파일 교체가 제한되면 해당 실행 권한이 필요하다.

```powershell
# 기존 CS 예제의 실제 브라우저 검증: 정상 2종 + 오류·경고 6종
node pipeline/visual/validate-samples.cjs

# 실제 Chrome 검증을 포함한 전체 테스트
$env:VISUAL_BROWSER_TEST = '1'
$visualTests = @(rg --files pipeline -g '*.test.cjs')
node --test @visualTests
```

검증 명령은 기존 스택·큐 명세를 복사하고 분리 검증용 고정 음성 큐 시각으로 공통 HTML을 만든다. 실제 TTS 결과라고 표시하지 않으며 원본 명세·영상은 수정하지 않는다. 오류는 복사한 HTML/CSS와 검사 타임라인에만 넣는다. 정상 화면, 긴 제목, 잘린 제목, 겹침, 짧은 장면, 작은 글자, 안전영역 이탈을 실제 Chrome으로 검사하고, 오류가 있는 제작 경로에서 render가 호출되지 않는지도 확인한다. 별도로 기존 실제 제작 회차를 `run`으로 검사하면 실제 음성 타이밍 기준의 검수 결과를 볼 수 있다.

이 검사는 모든 프레임의 완성도·미적 품질·대비·발음·내용 정확성을 보장하지 않는다. 고정 시점의 HTML 측정이므로 MP4 자체의 인코딩·오디오 검사는 기존 `verify` 단계가 담당한다. 최종 영상 확인과 승인은 사람이 진행한다.
