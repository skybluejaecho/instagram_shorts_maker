# 외부 자료와 라이선스 고지

확인일: 2026-11-12

루트 [LICENSE](LICENSE)는 이 프로젝트가 직접 작성한 코드·템플릿·문서에 적용됩니다. 아래 외부 자료와 별도 라이선스 문서에는 각 항목의 조건이 적용됩니다. 원문 발췌·번역·요약을 프로젝트의 MIT 라이선스로 재허가하지 않습니다.

## Python 문서 기반 참고 자료

| 저장소 자료 | 원문과 사용 범위 |
| --- | --- |
| [스택·큐 참고 노트](samples/content/sources/python-structures.md) | [Python Tutorial — Data Structures](https://docs.python.org/3/tutorial/datastructures.html)의 Using Lists as Stacks / Using Lists as Queues. 짧은 영문 발췌, 한국어 요약과 순서 규칙을 적용한 예시 |
| [deque 참고 노트](samples/period-auto/sources/python-deque.md) | [collections.deque](https://docs.python.org/3/library/collections.html#collections.deque)의 메서드와 `maxlen` 설명. 짧은 영문 발췌, 한국어 요약과 규칙을 적용한 예시 |
| [고정 검수 보고서](samples/content-repair/archived-hold-report.json) | 위 deque 노트의 한국어 요약 일부를 검수 근거로 재사용. 보고서 전체가 Python 공식 문서는 아님 |

원문 문서의 저작권 고지:

> Copyright © 2001 Python Software Foundation; All Rights Reserved.

Python 문서 본문에는 **Python Software Foundation License Version 2 (PSF-2.0)**가 적용됩니다. 위 파일에 포함된 원문과 그에 기반한 요약 부분을 사용할 때도 해당 조건을 유지합니다. 라이선스 전문은 [licenses/PSF-2.0.txt](licenses/PSF-2.0.txt)에 있으며, [Python의 공식 라이선스 안내](https://docs.python.org/3/license.html#psf-license)에서 옮겼습니다. 문서의 코드 예제에 적용되는 별도 Zero-Clause BSD 조건을 문서 본문 전체에 적용하지 않습니다.

변경 요약: 2026-11-09에 원문의 일부를 발췌하고 한국어 설명, 작은 입력·출력 예시와 적용 범위의 한계를 추가했습니다. 원문 전체를 복제하거나 Python 구현을 변경한 자료가 아닙니다. 고정 검수 보고서는 이 로컬 요약을 바탕으로 작성한 프로젝트의 검증 자료이며 Python Software Foundation의 검수·보증을 의미하지 않습니다.

## 실행 취소와 스택 검증용 자료 노트 — Qt 문서 기반

이 절은 [참고 노트 본문](samples/content/sources/qt-undo.md)의 동반 표제 정보·저작권 고지·편집 이력입니다. 해당 노트 전체는 **GNU Free Documentation License version 1.3 (GFDL-1.3)**으로 제공합니다. 독립된 프레임워크 코드의 라이선스는 MIT입니다.

- 문서 제목: 실행 취소와 스택 검증용 자료 노트
- 원문: [QUndoStack Class](https://doc.qt.io/qt-6/qundostack.html), Detailed Description / `push()` / `undo()`
- 원문 저작권자: The Qt Company Ltd. 및 원문에 표시된 기여자
- 한국어 편집본 작성·발행: skybluejaecho (AI 보조 작성)

> © (Copyright) 2026 The Qt Company Ltd.
> Documentation contributions included herein are the copyrights of their respective owners.
>
> Copyright (c) 2026 skybluejaecho, for the modifications.
>
> Permission is granted to copy, distribute and/or modify this document
> under the terms of the GNU Free Documentation License, Version 1.3,
> published by the Free Software Foundation;
> with no Invariant Sections, no Front-Cover Texts, and no Back-Cover Texts.
> A copy of the license is included in `licenses/GFDL-1.3.txt`.

Qt의 [문서 라이선스 안내](https://doc.qt.io/qt-6/fdl.html)와 원문 페이지는 GFDL 1.3을 명시합니다. 원문 고지에는 별도의 불변절·앞표지 문구·뒤표지 문구가 지정되어 있지 않습니다. 코드 예제에 관한 별도 BSD 조건을 이 문서 본문에 적용하지 않습니다.

### 변경 이력 (History)

- 원문: **QUndoStack Class**, 2026, The Qt Company Ltd. 및 기여자. 발행자: The Qt Company Ltd. 공개 위치: [Qt 공식 문서](https://doc.qt.io/qt-6/qundostack.html).
- 편집본: **실행 취소와 스택 검증용 자료 노트**, 2026-11-09, 작성·발행: skybluejaecho (AI 보조 작성). 원문의 짧은 설명을 발췌하고 한국어 요약과 주장의 적용 범위를 추가했습니다. 원문 전체의 번역이나 Qt의 공식 해설은 아닙니다.
- 2026-11-12: 이 동반 고지와 [GFDL 1.3 전문](licenses/GFDL-1.3.txt)을 추가했습니다. 기존 노트 본문의 바이트는 고정 검증 자료의 해시를 유지하기 위해 변경하지 않았습니다.

노트 본문, 이 동반 고지와 라이선스 전문을 함께 보관·배포합니다. 노트를 별도 문서로 재배포하거나 수정할 때는 GFDL의 표제·저작권·허가 고지, 변경 이력과 라이선스 전문 제공 조건을 반영해야 합니다. 고정 테스트 자료를 포함해 재배포할 때도 해당 조건을 유지합니다.

## 별도로 설치하는 도구와 제작 자산

Node.js, HyperFrames와 설치 의존성, Chrome, FFmpeg, Windows System.Speech, Azure Speech 실험용 SDK 등은 각자의 라이선스와 서비스 조건을 따릅니다. 이 저장소는 해당 도구의 실행 파일, Windows 음성 데이터나 글꼴 파일을 배포하지 않습니다. SDK 의존성 선언이나 도구 실행 코드는 해당 제품을 MIT로 재허가하지 않습니다.

도구의 라이선스·서비스 이용 조건은 실제 설치한 버전과 이용 방식에 맞게 확인합니다. 특히 프로젝트의 소프트웨어 라이선스만으로 생성 음성·영상의 이용 조건이 정해지지는 않습니다. 사용자가 추가한 이미지·음원·폰트·문서, TTS 및 모델 서비스의 조건을 함께 적용합니다.

## 자료를 추가하거나 가져갈 때

- 외부 원문·이미지·폰트·음원 등을 추가하면 출처, 저작권자, 허가 조건과 수정 내용을 함께 기록합니다. 출처 링크만으로 재배포 권한이 생기지는 않습니다.
- 고정 검증 자료는 기존 해시와 판정을 보존하기 위해 중앙 고지로 연결했습니다. 이 고지는 과거 보고서의 검수 결과나 현재 제작 상태를 변경하지 않습니다.
- 외부 자료를 분리해 사용할 때는 해당 고지와 라이선스를 유지하고, 독립 배포 형태에 필요한 표시도 함께 제공합니다.
