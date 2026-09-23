// 채점 기준(루브릭). 각 채점 항목(item)은 여러 개의 "체크리스트 항목(check)"으로 이뤄지고,
// 체크할 때마다 그 체크의 배점만큼 점수가 더해진다. 체크는 자동으로 미리 감지해 두지만
// 언제든 교사가 직접 켜고 끌 수 있다.
const Grading = (() => {
  const BASE_SCORE = 40; // 기본점수(제출한 학생의 합계 최저점 — 미제출자에게는 적용하지 않음)

  const DEFAULT_RUBRIC = [
    {
      id: 'design', name: '자료구조 및 함수 설계의 적절성',
      checks: [
        { id: 'design_s_push', label: '스택: 삽입(push) 연산 설계', points: 7, auto: { type: 'keyword', pattern: 'push, 삽입, 등록' } },
        { id: 'design_s_pop', label: '스택: 삭제(pop) 연산 설계', points: 7, auto: { type: 'keyword', pattern: 'pop, 삭제, 취소, 복구' } },
        { id: 'design_s_peek', label: '스택: 조회(peek) 연산 설계', points: 6, auto: { type: 'keyword', pattern: 'peek, top, 조회, 최상단' } },
        { id: 'design_q_enq', label: '큐: 삽입(enqueue) 연산 설계', points: 7, auto: { type: 'keyword', pattern: 'enqueue, 삽입, 접수' } },
        { id: 'design_q_deq', label: '큐: 삭제(dequeue) 연산 설계', points: 7, auto: { type: 'keyword', pattern: 'dequeue, 삭제, 처리' } },
        { id: 'design_q_peek', label: '큐: 조회(front) 연산 설계', points: 6, auto: { type: 'keyword', pattern: 'front, peek, 조회, 맨앞' } },
      ],
    },
    {
      id: 'impl', name: '함수를 활용한 스택·큐 연산 구현',
      // class 없이 구현하면(교과서의 class Stack/Queue를 변경하라는 요구사항 위반, AI 작성 의심)
      // 이 영역 체크를 자동으로 전부 해제한다 — 아래 suggestChecks 참고.
      requiresClass: true,
      checks: [
        { id: 'impl_s_push', label: '스택 push 함수 구현', points: 6, auto: { type: 'regex', pattern: 'def\\s+push' } },
        { id: 'impl_s_pop', label: '스택 pop 함수 구현', points: 6, auto: { type: 'regex', pattern: 'def\\s+pop' } },
        { id: 'impl_s_peek', label: '스택 peek/top 함수 구현', points: 3, auto: { type: 'regex', pattern: 'def\\s+(peek|top)' } },
        { id: 'impl_q_enq', label: '큐 enqueue 함수 구현', points: 6, auto: { type: 'regex', pattern: 'def\\s+enqueue' } },
        { id: 'impl_q_deq', label: '큐 dequeue 함수 구현', points: 6, auto: { type: 'regex', pattern: 'def\\s+dequeue' } },
        { id: 'impl_q_peek', label: '큐 peek/front 함수 구현', points: 3, auto: { type: 'regex', pattern: 'def\\s+(peek|front)' } },
      ],
    },
    {
      id: 'exc', name: '예외 상황 처리 및 프로그램 검증',
      checks: [
        { id: 'exc_overflow', label: '오버플로우 예외 처리', points: 10, auto: { type: 'keyword', pattern: 'overflow, 오버플로우, 가득' } },
        { id: 'exc_underflow', label: '언더플로우 예외 처리', points: 10, auto: { type: 'keyword', pattern: 'underflow, 언더플로우, 비어' } },
        { id: 'exc_test', label: '실행 결과(출력) 검증 확인', points: 10, auto: { type: 'regex', pattern: 'print\\s*\\(' } },
      ],
    },
  ];

  function itemMax(item) {
    return (item.checks || []).reduce((s, c) => s + Number(c.points || 0), 0);
  }
  function rubricMax(rubric) {
    return rubric.reduce((s, it) => s + itemMax(it), 0);
  }

  function evalAuto(auto, text) {
    if (!auto || !auto.type || auto.type === 'none' || !text) return false;
    if (auto.type === 'keyword') {
      const kws = (auto.pattern || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      if (!kws.length) return false;
      const low = text.toLowerCase();
      return kws.some((k) => low.includes(k.toLowerCase()));
    }
    if (auto.type === 'regex') {
      if (!auto.pattern) return false;
      try { return new RegExp(auto.pattern, 'i').test(text); } catch (e) { return false; }
    }
    return false;
  }

  // 제출물 텍스트를 보고 체크리스트 상태를 추천한다 (자동 채점 초안).
  // requiresClass가 걸린 영역은 class 없이 구현됐으면(AI 작성 의심) 체크를 전부 해제해
  // 점수에도 반영한다.
  function suggestChecks(rubric, text) {
    const hasClass = /\bclass\s+\w+/.test(text || '');
    const out = {};
    for (const item of rubric) {
      const blocked = item.requiresClass && !hasClass;
      for (const c of item.checks || []) out[c.id] = blocked ? false : evalAuto(c.auto, text);
    }
    return out;
  }

  function itemScore(item, checks) {
    return (item.checks || []).reduce((s, c) => s + (checks && checks[c.id] ? Number(c.points) : 0), 0);
  }

  // status가 '미제출'이면 0점 (기본점수 미적용). 그 외에는 기본점수를 최저점으로 보장.
  function total(rubric, checks, status) {
    const sum = rubric.reduce((s, it) => s + itemScore(it, checks), 0);
    if (status === '미제출') return 0;
    return Math.max(sum, BASE_SCORE);
  }

  // 제출물에서 "AI가 대신 작성했을 가능성" 등 교사가 눈여겨봐야 할 신호를 찾는다.
  // 점수에는 영향을 주지 않고 화면에 경고로만 표시한다 — 최종 판단은 교사가 한다.
  function detectFlags(text) {
    const flags = [];
    if (!text) return flags;
    const hasClass = /\bclass\s+\w+/.test(text);
    const hasStackQueueOps = /def\s+(push|pop|enqueue|dequeue)\b/i.test(text);
    if (hasStackQueueOps && !hasClass) {
      flags.push('class 없이 구현됨 — 과제 요구사항(교과서의 class Stack/Queue를 변경) 미준수. AI 작성 의심');
    }
    if (/(import\s+collections|from\s+collections|import\s+queue\b|from\s+queue\b|\bdeque\s*\(|\bQueue\s*\(\))/i.test(text)) {
      flags.push('deque/queue 내장 모듈 사용 의심 — 직접 구현 요구사항 위반 가능');
    }
    return flags;
  }

  return { DEFAULT_RUBRIC, BASE_SCORE, itemMax, rubricMax, evalAuto, suggestChecks, itemScore, total, detectFlags };
})();
