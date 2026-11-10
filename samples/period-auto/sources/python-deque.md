# Python deque 참고 노트

자료 유형: 공식 문서를 읽어 정리한 로컬 요약. 원문 전체나 자동 수집 자료가 아니다.
확인일: 2026-11-09
출처: https://docs.python.org/3/library/collections.html#collections.deque
확인 범위: deque 설명, append, appendleft, pop, popleft, extend, extendleft, insert, rotate, maxlen.

Python collections.deque는 양쪽 끝에 값을 넣고 뺄 수 있는 양방향 큐다. append는 오른쪽, appendleft는 왼쪽에 추가한다. pop은 오른쪽, popleft는 왼쪽 값을 제거하며 반환한다. 빈 deque의 pop과 popleft는 IndexError를 발생시킨다.

extend는 입력을 차례로 오른쪽에 추가한다. extendleft는 차례로 왼쪽에 추가하므로 새 값들은 입력과 반대 순서로 놓인다. 빈 deque에 A, B, C를 extendleft하면 왼쪽부터 C, B, A가 된다.

maxlen은 최대 원소 수를 제한한다. 가득 찬 deque에 append 또는 appendleft로 추가하면 반대쪽 끝의 값이 밀려나 길이가 유지된다. 원문 구절: “items are discarded from the opposite end”. 최대 길이 2이고 왼쪽부터 A, B라면 append로 C를 넣은 결과는 B, C다. 이는 Python deque의 규칙이며 모든 고정 크기 큐에 적용되지 않는다.

insert로 maxlen을 넘기면 반대쪽을 버리는 대신 IndexError가 발생한다.

rotate의 양수는 오른쪽, 음수는 왼쪽 회전이다. 비어 있지 않은 deque의 오른쪽 한 칸 회전은 오른쪽 끝 값을 왼쪽에 옮긴다. 왼쪽 한 칸은 반대다.

예시는 위 규칙의 직접 적용이다. 구체적 성능 수치·산업 사용 빈도·다른 구현의 동작은 이 자료의 범위 밖이다.
