# 스택·큐 검증용 자료 노트

자료 유형: 공식 문서를 읽고 정리한 로컬 참고 노트. 원문 전체나 자동 수집 결과가 아니다.
확인일: 2026-11-09
출처: https://docs.python.org/3/tutorial/datastructures.html
범위: 5.1.1 Using Lists as Stacks, 5.1.2 Using Lists as Queues.

원문의 짧은 근거 구절:
- 스택: “the last element added is the first element retrieved”
- 큐: “the first element added is the first element retrieved”

확인한 내용의 요약:
스택은 후입선출(LIFO)이다. 같은 끝인 맨 위에 값을 추가하고 맨 위에서 꺼낸다.
Python 리스트로 스택을 구현할 때 append로 끝에 추가하고, 인자 없는 pop으로 마지막 값을 제거하며 반환한다.
큐는 선입선출(FIFO)이다. 뒤에 추가하고 앞에서 꺼내면 도착한 순서대로 처리된다.
문서는 큐를 구현할 때 collections.deque를 사용하고 append와 popleft를 사용하는 예를 제시한다.
이 자료는 모든 작업 스케줄러가 FIFO라는 주장이나 처리 성능의 정량적 수치를 뒷받침하지 않는다.

위 규칙으로 직접 확인할 수 있는 작은 예시:
빈 스택에 A, B 순서로 넣으면 B, A 순서로 나온다. B를 꺼낸 뒤에는 A만 남는다.
빈 큐에 A, B 순서로 넣으면 A, B 순서로 나온다. A를 꺼낸 뒤에는 B만 남는다.
두 예시는 추상 자료구조의 순서 규칙을 적용한 예시이며 실행 속도나 산업 사용 빈도에 대한 조사 결과가 아니다.
