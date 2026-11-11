# 실행 취소와 스택 검증용 자료 노트

자료 유형: Qt 공식 문서를 읽고 정리한 로컬 참고 노트. 원문 전체나 자동 수집 결과가 아니다.
확인일: 2026-11-09
출처: https://doc.qt.io/qt-6/qundostack.html
범위: Detailed Description, push(), undo().

원문의 짧은 근거 구절:
“An undo stack maintains a stack of commands that have been applied to a document.”

확인한 내용의 요약:
QUndoStack은 문서에 적용한 명령을 스택으로 관리하고 새 명령을 push로 추가한다.
실행한 최신 명령부터 undo로 취소하고 redo로 다시 실행할 수 있다.
따라서 최근 작업부터 취소하는 기능에 스택을 활용할 수 있다는 예시를 뒷받침한다.
모든 실행 취소 기능의 내부 구현이 동일하다는 주장을 뜻하지 않는다.
