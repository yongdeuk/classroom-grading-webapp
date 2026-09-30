// 채점 기준(루브릭) 모델과 자동 채점.
//
// 루브릭 = { name, step, baseScore, groups: [...], flags: [...] }
//  - 평가 영역(group)은 "기본 점수(base, 그 영역의 최저 밴드)" + 여러 개의 체크 항목(check)으로 이뤄진다.
//    체크할 때마다 그 배점만큼 더해져서, 예) 기본 20 + 5점 체크 4개 → 20/25/30/35/40 밴드가 된다.
//  - step: 배점 간격(기본 5점, 정수만). 소수점 배점은 없으므로 모든 배점·기본 점수는 불러올 때
//    step의 배수(정수)로 맞춘다(snap).
//  - baseScore: 제출한 학생의 합계 최저점(선택). 0이면 사용하지 않음.
//  - flags: "AI 작성 의심" 신호. 하나라도 걸리면 그 학생을 AI 의심으로 자동 표시하고,
//    교사는 학생마다 의심을 직접 체크/해제할 수 있다(student.aiSuspect: null=자동, true/false=직접).
//  - group.aiBlock: AI 의심인 학생은 그 영역 체크를 전부 해제(기본 점수만).
//  - group.requires: 이 조건(정규식)이 제출물에 없으면 그 영역 체크를 자동으로 전부 해제.
// 과목에 상관없이 쓸 수 있도록 과목 전용 규칙은 모두 루브릭 데이터 안에 둔다.
const Grading = (() => {
  const AUTO_TYPES = { none: '직접 확인', keyword: '키워드(하나라도)', keywordAll: '키워드(모두)', regex: '정규식', filled: '표/항목 뒤 내용 채움', section: '활동(구역) 작성 여부', defFromTable: '설계표 함수명이 코드에 정의됨', rows: '표에 채운 행 개수', all: '여러 조건 모두 충족' };

  // 기본 제공 기준을 고치면 올리는 번호. 저장돼 있던 기준(과제별 복사본)은 불러올 때 이 번호를 보고
  // 기본 제공 항목의 자동 감지 규칙·근거 문장을 새 것으로 맞춘다(배점·이름은 선생님 것 유지).
  const PRESET_VERSION = 10; // 10: 교육과정 문서의 점수 구간(12항목) 기준 추가, 항목 이름이 같으면 저장된 기준도 새 규칙으로 (9: 설계=활동1 표, 예외=활동2 표·활동4 표로 구역별 판정 (8: 빈 양식 대응 수정(7)을 취소하고 복귀)) (6: 9/30 표 기준 판정을 되돌리고 9/29 방식으로 복귀)

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // ---- 기본 제공 기준 ----
  const INFO_SCIENCE_STACK_QUEUE = {
    name: '정보과학 — 함수를 활용한 스택·큐 프로그램 구현 (1차 수행평가)',
    step: 5, // 배점은 5점 단위(소수점 없음)
    presetVersion: 10,
    baseScore: 0,
    groups: [
      {
        id: 'design', name: '자료구조 및 함수 설계의 적절성', base: 20,
        checks: [
          { id: 'design_s_io', label: '스택: 삽입(push)·삭제(pop) 연산 설계', points: 5, scope: 'stack', auto: { type: 'filled', pattern: '삽입, 삭제', stopAt: '연산 구분, 함수명, 매개변수, 반환값, 비어있는지 확인, 가득 찼는지 확인, 삽입, 삭제, 조회', within: '활동1' }, reason: '스택 활동1 설계표의 삽입·삭제 연산 칸(함수명 등)이 비어 있음' },
          { id: 'design_s_peek', label: '스택: 조회(peek)·상태 확인(isEmpty) 설계', points: 5, scope: 'stack', auto: { type: 'filled', pattern: '비어있는지 확인, 조회', stopAt: '연산 구분, 함수명, 매개변수, 반환값, 비어있는지 확인, 가득 찼는지 확인, 삽입, 삭제, 조회', within: '활동1' }, reason: '스택 활동1 설계표의 조회·상태 확인 연산 칸이 비어 있음' },
          { id: 'design_q_io', label: '큐: 삽입(enqueue)·삭제(dequeue) 연산 설계', points: 5, scope: 'queue', auto: { type: 'filled', pattern: '삽입, 삭제', stopAt: '연산 구분, 함수명, 매개변수, 반환값, 비어있는지 확인, 가득 찼는지 확인, 삽입, 삭제, 조회', within: '활동1' }, reason: '큐 활동1 설계표의 삽입·삭제 연산 칸(함수명 등)이 비어 있음' },
          { id: 'design_q_peek', label: '큐: 조회(front/peek)·상태 확인 설계', points: 5, scope: 'queue', auto: { type: 'filled', pattern: '비어있는지 확인, 조회', stopAt: '연산 구분, 함수명, 매개변수, 반환값, 비어있는지 확인, 가득 찼는지 확인, 삽입, 삭제, 조회', within: '활동1' }, reason: '큐 활동1 설계표의 조회·상태 확인 연산 칸이 비어 있음' },
        ],
      },
      {
        id: 'impl', name: '함수를 활용한 스택·큐 연산 구현', base: 10,
        // class 없이 구현하면(교과서의 class Stack/Queue를 변경하라는 요구사항 위반) AI 작성 의심 →
        // 이 영역은 기본 점수만. 교사가 의심을 해제하면 다시 자동 채점된다.
        aiBlock: true,
        checks: [
          { id: 'impl_s_io', label: '스택 push·pop 함수 구현', points: 5, auto: { type: 'regex', pattern: '(?=[\\s\\S]*def\\s+push)(?=[\\s\\S]*def\\s+pop)' }, reason: 'push 또는 pop 함수 정의(def)가 없음' },
          { id: 'impl_s_peek', label: '스택 peek·isEmpty 함수 구현', points: 5, auto: { type: 'regex', pattern: '(?=[\\s\\S]*def\\s+(peek|top))(?=[\\s\\S]*def\\s+is_?empty)' }, reason: 'peek 또는 isEmpty 함수 정의(def)가 없음' },
          { id: 'impl_q_io', label: '큐 enqueue·dequeue 함수 구현', points: 5, auto: { type: 'regex', pattern: '(?=[\\s\\S]*def\\s+enqueue)(?=[\\s\\S]*def\\s+dequeue)' }, reason: 'enqueue 또는 dequeue 함수 정의(def)가 없음' },
          { id: 'impl_q_peek', label: '큐 peek(front)·isEmpty 함수 구현', points: 5, auto: { type: 'regex', pattern: '(?=[\\s\\S]*def\\s+(peek|front))(?=[\\s\\S]*def\\s+is_?empty)' }, reason: '큐의 peek(front) 또는 isEmpty 함수 정의(def)가 없음' },
        ],
      },
      {
        id: 'exc', name: '예외 상황 처리 및 프로그램 검증', base: 10,
        // 오버플로우·언더플로우는 스택 회차와 큐 회차에 각각 계획을 적어야 하므로, 문서를
        // "2회차" 표시를 기준으로 앞(스택)/뒤(큐)로 나눠 각각 확인한다.
        checks: [
          // 유형 'filled': "오버플로우"라는 표 항목 이름 자체는 늘 인쇄돼 있으니(빈칸이어도 걸림),
          // 그 항목 뒤에 실제 내용이 채워졌는지(다음 표 항목이 나오기 전까지)를 본다.
          // 스택 회차·큐 회차 각각 5점. 오버플로우·언더플로우 중 한 칸만 채웠으면 5점은 주고,
          // 빈 칸은 "예전 기준 -2.5점 사항"으로 코멘트에 남긴다(배점은 5점 단위로만).
          { id: 'exc_s_flow', label: '스택: 오버플로우·언더플로우 예외 처리', points: 5, scope: 'stack', auto: { type: 'filled', pattern: '오버플로우, 언더플로우', stopAt: '오버플로우, 언더플로우, 예외 상황, 발생 조건, 처리 방법', within: '활동2' }, reason: '스택의 오버플로우·언더플로우 처리 계획 칸이 비어 있는 것으로 보임' },
          { id: 'exc_q_flow', label: '큐: 오버플로우·언더플로우 예외 처리', points: 5, scope: 'queue', auto: { type: 'filled', pattern: '오버플로우, 언더플로우', stopAt: '오버플로우, 언더플로우, 예외 상황, 발생 조건, 처리 방법', within: '활동2' }, reason: '큐의 오버플로우·언더플로우 처리 계획 칸이 비어 있는 것으로 보임' },
          // 테스트 코드도 스택 회차·큐 회차를 나눠 각각 확인("2회차" 표시 기준)
          { id: 'exc_s_test', label: '스택: 테스트 코드로 연산 실행 결과 검증', points: 5, scope: 'stack', auto: { type: 'section', pattern: '활동4', stopAt: '번호, 수행 동작, 예상 결과, 실제 결과, 일치 여부' }, reason: '스택 활동4(테스트 케이스 및 실행 결과 검증) 표가 비어 있음' },
          { id: 'exc_q_test', label: '큐: 테스트 코드로 연산 실행 결과 검증', points: 5, scope: 'queue', auto: { type: 'section', pattern: '활동4', stopAt: '번호, 수행 동작, 예상 결과, 실제 결과, 일치 여부' }, reason: '큐 활동4(테스트 케이스 및 실행 결과 검증) 표가 비어 있음' },
        ],
      },
    ],
    flags: [
      // requiresPresent: 이 패턴(실제로 쓴 코드가 있다는 증거)이 없으면 애초에 이 신호를 판단하지
      // 않는다 — 그래야 "작성해야 할 영역을 그냥 비워 둔" 미기입과 "AI가 대신 써 준 코드를 그대로
      // 붙여넣어 class 요구사항만 못 지킨" 경우를 구분할 수 있다.
      { type: 'missing', pattern: '\\bclass\\s+\\w+', requiresPresent: '\\bdef\\s+\\w+', message: 'class 없이 구현됨 — 과제 요구사항(교과서의 class Stack/Queue를 변경) 미준수' },
    ],
  };


  // ---- 새 기본 기준: 교육과정 문서(1차 수행평가)의 점수 구간을 누적 체크로 옮긴 것 ----
  // 영역마다 기본 점수(가장 낮은 구간) + 구간이 올라갈 때마다 +5. 규칙은 활동 구역별로 판정한다.
  //  · 설계: 각 회차 활동1 표(상황 설명, 삽입·삭제·조회 행)에 채운 칸 수. 스택·큐 중 더 많이 채운 회차 기준(scope 'any').
  //  · 구현: 활동3 코드의 함수 정의. 1~2회차 모두(scope 'both') 또는 한쪽(scope 'any')에 있는지, 설계표의 함수명이 정의됐는지.
  //  · 예외/검증: 활동2 표(오버플로우·언더플로우 칸)와 활동4 표(입력값을 적은 행 수).
  // "정확하게 동작", "오류를 스스로 수정"은 글자로 알 수 없으므로 자동 판정은 참고용 — 선생님이 확인한다.
  const ROW_STOP = '연산 구분, 함수명, 매개변수, 반환값, 비어있는지 확인, 가득 찼는지 확인, 삽입, 삭제, 조회, 최대 저장 갯수, 최대 저장 개수';
  const SIT = '(실생활에서의 스택사용)';
  const FLOW = { type: 'filled', pattern: '오버플로우, 언더플로우', stopAt: '오버플로우, 언더플로우, 예외 상황, 발생 조건, 처리 방법', within: '활동2' };
  const ROWS4 = (n) => ({ type: 'rows', pattern: '활동4', min: n });
  const NEW_STACK_QUEUE = {
    name: '정보과학 — 함수를 활용한 스택과 큐 프로그램 구현 (1차 수행평가)',
    step: 5,
    presetVersion: 10,
    baseScore: 40,
    groups: [
      {
        id: 'design', name: '자료구조 및 함수 설계의 적절성', base: 20,
        checks: [
          { id: 'd1', label: '교사의 안내를 받아 자료구조를 선정하고, 연산 중 1가지를 설계함', points: 5, scope: 'any', auto: { type: 'filled', pattern: '삽입, 삭제, 조회', stopAt: ROW_STOP, within: '활동1', min: 1 }, reason: '활동1 설계표에서 설계한 연산이 1가지도 확인되지 않음' },
          { id: 'd2', label: '문제 상황에 맞는 자료구조를 스스로 선정하고, 삽입·삭제·조회 중 1가지 연산을 함수 단위로 설계함', points: 5, scope: 'any', auto: { type: 'filled', pattern: SIT + ', 삽입, 삭제, 조회', stopAt: ROW_STOP, within: '활동1', min: 2 }, reason: '활동1의 상황 설명과 1가지 이상의 연산 설계가 함께 확인되지 않음' },
          { id: 'd3', label: '선정한 자료구조에서 삽입·삭제·조회 중 2가지 연산을 함수 단위로 설계함', points: 5, scope: 'any', auto: { type: 'filled', pattern: SIT + ', 삽입, 삭제, 조회', stopAt: ROW_STOP, within: '활동1', min: 3 }, reason: '활동1 설계표에서 함수 단위로 설계된 연산이 2가지 미만임' },
          { id: 'd4', label: '스택과 큐 중 적합한 자료구조를 선정하고, 삽입·삭제·조회 3가지 연산을 모두 함수 단위로 설계함', points: 5, scope: 'any', auto: { type: 'filled', pattern: SIT + ', 삽입, 삭제, 조회', stopAt: ROW_STOP, within: '활동1', min: 4 }, reason: '활동1 설계표에서 삽입·삭제·조회 3가지 연산을 모두 설계하지 않음' },
        ],
      },
      {
        id: 'impl', name: '함수를 활용한 스택·큐 연산 구현', base: 10,
        // class 없이 구현하면(교과서의 class Stack/Queue를 변경하라는 요구사항 위반) AI 작성 의심 → 이 영역은 기본 점수만.
        aiBlock: true,
        checks: [
          { id: 'i1', label: '스택 또는 큐 중 한 자료구조에 대한 연산을 함수로 구현함', points: 5, scope: 'any', auto: { type: 'regex', pattern: 'def\\s+(?!__)\\w+\\s*\\(' }, reason: '활동3 코드에서 연산을 구현한 함수(def)가 확인되지 않음' },
          { id: 'i2', label: '연산 중 1~2가지를 함수로 구현함 (오류 발생 포함)', points: 5, scope: 'both', auto: { type: 'regex', pattern: 'def\\s+(?!__)\\w+\\s*\\(' }, reason: '스택·큐 두 회차 모두에서 함수로 구현한 연산이 확인되지 않음' },
          { id: 'i3', label: '설계한 연산 중 2가지 이상을 함수로 정확하게 구현하여 오류 없이 동작함', points: 5, scope: 'both', auto: { type: 'regex', pattern: '(def\\s+(?!__)\\w+\\s*\\([\\s\\S]*){2}' }, reason: '스택·큐 두 회차 모두에서 2가지 이상의 연산 함수가 확인되지 않음(동작 여부는 직접 확인)' },
          { id: 'i4', label: '설계한 모든 연산(삽입, 삭제, 조회 등)을 함수로 정확하게 구현하여 오류 없이 동작함', points: 5, scope: 'both', auto: { type: 'defFromTable', pattern: '비어있는지 확인, 비어 있는지 확인, 가득 찼는지 확인, 삽입, 삭제, 조회', stopAt: ROW_STOP, within: '활동1' }, reason: '활동1 설계표에 적은 함수명이 활동3 코드에 모두 정의되지 않음(동작 여부는 직접 확인)' },
        ],
      },
      {
        id: 'exc', name: '예외 상황 처리 및 프로그램 검증', base: 10,
        checks: [
          { id: 'e1', label: '예외 상황을 처리하지 않더라도 프로그램의 정상 동작 여부를 확인함', points: 5, scope: 'any', auto: ROWS4(1), reason: '활동4 표에 프로그램 동작을 확인한 내용이 없음' },
          { id: 'e2', label: '오버플로우 또는 언더플로우 중 1가지 예외 상황을 처리하고 1가지 입력값으로 검증함', points: 5, scope: 'any', auto: { type: 'all', parts: [Object.assign({}, FLOW, { min: 1 }), ROWS4(1)] }, reason: '활동2의 예외 처리 계획과 활동4의 검증 입력값이 함께 확인되지 않음' },
          { id: 'e3', label: '오버플로우 또는 언더플로우 중 1가지 예외 상황을 처리하고 2가지 이상의 입력값으로 검증함', points: 5, scope: 'any', auto: { type: 'all', parts: [Object.assign({}, FLOW, { min: 1 }), ROWS4(2)] }, reason: '활동2의 예외 처리 계획과 활동4의 2가지 이상 검증 입력값이 함께 확인되지 않음' },
          { id: 'e4', label: '오버플로우와 언더플로우 예외 상황을 모두 함수 내에서 처리하고 3가지 이상의 입력값으로 검증하여 오류를 스스로 수정함', points: 5, scope: 'any', auto: { type: 'all', parts: [Object.assign({}, FLOW, { min: 2 }), ROWS4(3)] }, reason: '오버플로우·언더플로우를 모두 처리하고 3가지 이상의 입력값으로 검증한 내용이 확인되지 않음(오류 수정은 직접 확인)' },
        ],
      },
    ],
    flags: [
      { type: 'missing', pattern: '\\bclass\\s+\\w+', requiresPresent: '\\bdef\\s+\\w+', message: 'class 없이 구현됨 — 과제 요구사항(교과서의 class Stack/Queue를 변경) 미준수' },
    ],
  };

  // 예전 버전 기본 항목 이름(저장된 기준을 맞출 때 이 이름이면 새 이름으로 바꾼다)
  const OLD_PRESET_LABELS = [
    '스택: 삽입(push)·삭제(pop) 연산 설계', '스택: 조회(peek)·상태 확인(isEmpty) 설계',
    '큐: 삽입(enqueue)·삭제(dequeue) 연산 설계', '큐: 조회(front/peek)·상태 확인 설계',
    '스택 push·pop 함수 구현', '스택 peek·isEmpty 함수 구현', '큐 enqueue·dequeue 함수 구현', '큐 peek(front)·isEmpty 함수 구현',
    '스택: 삽입·삭제 연산 설계', '스택: 추가 연산(조회·상태 확인 등) 설계', '큐: 삽입·삭제 연산 설계', '큐: 추가 연산(조회·상태 확인 등) 설계',
    '스택: 설계한 삽입·삭제 함수를 코드로 구현(활동3)', '스택: 설계한 추가 연산 함수를 코드로 구현(활동3)',
    '큐: 설계한 삽입·삭제 함수를 코드로 구현(활동3)', '큐: 설계한 추가 연산 함수를 코드로 구현(활동3)',
  ];

  const PRESETS = [{ key: 'info-stack-queue-v2', rubric: NEW_STACK_QUEUE }, { key: 'info-stack-queue', rubric: INFO_SCIENCE_STACK_QUEUE }];
  // 예전 버전(배열 형식)의 기본 루브릭 체크 id — 그대로 남아 있으면 새 기본 기준으로 바꿔 준다.
  const LEGACY_DEFAULT_IDS = ['design_s_push', 'impl_s_push', 'exc_overflow'];

  const clone = (o) => JSON.parse(JSON.stringify(o));
  // 배점은 소수점 없이 step(기본 5)의 배수로만.
  function snap(v, step) {
    const n = Number(v) || 0;
    return Math.max(0, Math.round(n / step) * step);
  }

  // 9/28 버전의 2.5점짜리 예외 처리 4항목 → 5점짜리 2항목(스택/큐)으로 합친다.
  const HALF_PAIRS = { exc_s_flow: ['exc_s_overflow', 'exc_s_underflow'], exc_q_flow: ['exc_q_overflow', 'exc_q_underflow'] };
  const HALF_IDS = Object.values(HALF_PAIRS).flat();
  function migrateHalfGroup(g) {
    if (!(g.checks || []).some((c) => HALF_IDS.includes(c.id))) return g;
    const preset = INFO_SCIENCE_STACK_QUEUE.groups.find((x) => x.id === 'exc');
    const out = [];
    for (const c of g.checks) {
      if (!HALF_IDS.includes(c.id)) { out.push(c); continue; }
      const newId = Object.keys(HALF_PAIRS).find((k) => HALF_PAIRS[k].includes(c.id));
      if (!out.some((x) => x.id === newId)) out.push(clone(preset.checks.find((x) => x.id === newId)));
    }
    return Object.assign({}, g, { checks: out });
  }
  // 예전 "테스트 코드 검증" + "예외 상황을 알리는 처리" → "스택: 테스트 코드…" + "큐: 테스트 코드…"
  const OLD_TEST_IDS = ['exc_test', 'exc_msg'];
  const NEW_TEST_IDS = ['exc_s_test', 'exc_q_test'];
  function migrateTestGroup(g) {
    if (!(g.checks || []).some((c) => OLD_TEST_IDS.includes(c.id))) return g;
    const preset = INFO_SCIENCE_STACK_QUEUE.groups.find((x) => x.id === 'exc');
    const out = [];
    for (const c of g.checks) {
      if (!OLD_TEST_IDS.includes(c.id)) { out.push(c); continue; }
      if (!out.some((x) => NEW_TEST_IDS.includes(x.id))) {
        for (const id of NEW_TEST_IDS) out.push(clone(preset.checks.find((x) => x.id === id)));
      }
    }
    return Object.assign({}, g, { checks: out });
  }
  // 학생 체크도 같이 변환: 두 칸 중 하나라도 체크돼 있으면 합친 항목 5점 인정(5점 단위 가산).
  // 한쪽만 체크돼 있던 경우(예전 -2.5점)는 점수가 바뀌므로 changed로 알리고 코멘트를 남긴다.
  // recheck: 항목이 바뀌어 새로 자동 판정해야 하는 체크 id
  function migrateStudentChecks(checks) {
    const recheck = [];
    if (!checks) return { checks, changed: false, recheck };
    const out = Object.assign({}, checks);
    let changed = false;
    if (OLD_TEST_IDS.some((id) => id in out)) {
      for (const id of OLD_TEST_IDS) delete out[id];
      recheck.push(...NEW_TEST_IDS);
      changed = true;
    }
    for (const [newId, [a, b]] of Object.entries(HALF_PAIRS)) {
      if (!(a in out) && !(b in out)) continue;
      out[newId] = !!out[a] || !!out[b];
      if (!!out[a] !== !!out[b]) changed = true;
      delete out[a]; delete out[b];
    }
    return { checks: out, changed, recheck };
  }

  // 체크된 항목에 붙는 코멘트(선생님·변환 코멘트 우선, 없으면 자동 감지의 부분 미충족 코멘트).
  function commentFor(g, c, s) {
    if (s.comments && s.comments[c.id] != null) return s.comments[c.id];
    return explain(g, c, s.text, isSuspect(s)).comment || '';
  }
  const CLASS_RE = '\\bclass\\s+\\w+';

  function defaultRubric() { return normalize(clone(NEW_STACK_QUEUE)); }
  function blankRubric() { return normalize({ name: '새 채점 기준', step: 5, baseScore: 0, groups: [], flags: [] }); }

  function isLegacyDefault(raw) {
    if (!Array.isArray(raw)) return false;
    const ids = raw.flatMap((g) => (g.checks || []).map((c) => c.id));
    return LEGACY_DEFAULT_IDS.every((id) => ids.includes(id));
  }

  // 어떤 모양으로 들어오든(예전 배열 형식, 업로드한 JSON, AI 결과) 같은 구조로 맞춘다.
  function normalize(raw) {
    if (!raw) return defaultRubric();
    if (isLegacyDefault(raw)) return defaultRubric();
    let r = Array.isArray(raw) ? { name: '이전 채점 기준', step: 5, baseScore: 40, groups: raw } : Object.assign({}, raw);
    r.name = String(r.name || '채점 기준');
    // 소수점 간격(예: 0.5, 2.5)은 쓰지 않음 → 기본 5점 간격으로
    r.step = Number.isInteger(Number(r.step)) && Number(r.step) >= 1 ? Number(r.step) : 5;
    r.baseScore = snap(r.baseScore, r.step);
    // 기본 제공 기준에서 온 항목은 자동 감지 규칙을 최신으로(바뀐 항목 id는 syncedIds로 알려 다시 채점)
    const synced = [];
    if ((Number(r.presetVersion) || 0) < PRESET_VERSION) {
      const presetChecks = {}, presetByLabel = {};
      const normLabel = (t) => String(t || '').replace(/[^0-9A-Za-z가-힣]/g, '');
      for (const pr of PRESETS) for (const pg of pr.rubric.groups) for (const pc of pg.checks) {
        presetChecks[pc.id] = pc;
        if (pr.key === 'info-stack-queue-v2') presetByLabel[normLabel(pc.label)] = pc;
      }
      const same = (a, b) => !!a && JSON.stringify([a.type || 'none', a.pattern || '', a.stopAt || '', a.within || '', a.min || 0, a.parts || null]) === JSON.stringify([b.type || 'none', b.pattern || '', b.stopAt || '', b.within || '', b.min || 0, b.parts || null]);
      r.groups = (r.groups || []).map((g0) => Object.assign({}, g0, {
        checks: (g0.checks || []).map((c0) => {
          const pc = presetChecks[c0.id] || presetByLabel[normLabel(c0.label)];
          if (!pc || (same(c0.auto, pc.auto) && (c0.scope || '') === (pc.scope || '') && (c0.label === pc.label || !OLD_PRESET_LABELS.includes(c0.label)))) return c0;
          synced.push(c0.id);
          const label = OLD_PRESET_LABELS.includes(c0.label) ? pc.label : c0.label;
          return Object.assign({}, c0, { label, auto: clone(pc.auto), scope: pc.scope || '', reason: pc.reason });
        }),
      }));
      r.presetVersion = PRESET_VERSION;
    }
    const groupIds = new Set();
    r.groups = (r.groups || []).map(migrateHalfGroup).map(migrateTestGroup).map((g, gi) => {
      const name = String(g.name || '평가 영역 ' + (gi + 1));
      let gid = g.id || 'g_' + hash(name);
      while (groupIds.has(gid)) gid += '_';
      groupIds.add(gid);
      let requires = g.requires && g.requires.pattern ? { pattern: String(g.requires.pattern), message: String(g.requires.message || '') } : null;
      let aiBlock = !!g.aiBlock || !!g.requiresClass;
      // 이전 버전의 "class 필수 조건"은 AI 의심 처리로 바꾼다(교사가 의심을 해제할 수 있도록).
      if (requires && requires.pattern === CLASS_RE) { requires = null; aiBlock = true; }
      const checkIds = new Set();
      const checks = (g.checks || []).map((c) => {
        const label = String(c.label || '체크 항목');
        let cid = c.id || 'c_' + hash(name + '|' + label);
        while (checkIds.has(cid)) cid += '_';
        checkIds.add(cid);
        const type = c.auto && AUTO_TYPES[c.auto.type] ? c.auto.type : 'none';
        const scope = ['stack', 'queue', 'any', 'both'].includes(c.scope) ? c.scope : '';
        const stopAt = c.auto && c.auto.stopAt ? String(c.auto.stopAt) : '';
        const within = c.auto && c.auto.within ? String(c.auto.within) : '';
        const auto = { type, pattern: String((c.auto && c.auto.pattern) || ''), stopAt };
        if (within) auto.within = within;
        if (c.auto && Number(c.auto.min) > 0) auto.min = Number(c.auto.min);
        if (c.auto && Array.isArray(c.auto.parts)) auto.parts = c.auto.parts.map((pt) => {
          const o = { type: AUTO_TYPES[pt.type] ? pt.type : 'none', pattern: String(pt.pattern || ''), stopAt: String(pt.stopAt || '') };
          if (pt.within) o.within = String(pt.within);
          if (Number(pt.min) > 0) o.min = Number(pt.min);
          return o;
        });
        return { id: cid, label, points: snap(c.points, r.step), auto, reason: String(c.reason || ''), scope };
      });
      return { id: gid, name, base: snap(g.base, r.step), requires, aiBlock, checks };
    });
    if (r.groups.some((g) => g.aiBlock) && !(r.flags || []).some((f) => f && f.pattern === CLASS_RE) && Array.isArray(raw)) {
      r.flags = [{ type: 'missing', pattern: CLASS_RE, message: 'class 없이 구현됨' }];
    }
    // 기준 검증용 문서(빈 양식·100점 샘플) — 텍스트만 보관
    const rd = {};
    for (const k of ['blank', 'full']) {
      const d = r.refDocs && r.refDocs[k];
      if (d && d.text) rd[k] = { name: String(d.name || k), text: String(d.text), at: Number(d.at) || Date.now(), from: d.from === 'student' ? 'student' : 'upload' };
    }
    if (Object.keys(rd).length) r.refDocs = rd; else delete r.refDocs;
    r.flags = (r.flags || [])
      .filter((f) => f && f.pattern && !/import\\s\+collections/.test(f.pattern)) // 내장 모듈 의심 신호는 뺐음
      .map((f) => ({
        type: f.type === 'match' ? 'match' : 'missing', pattern: String(f.pattern), message: String(f.message || ''),
        requiresPresent: f.requiresPresent ? String(f.requiresPresent) : '',
      }));
    Object.defineProperty(r, '_syncedIds', { value: synced, enumerable: false });
    return r;
  }

  // ---- 점수 ----
  function groupMax(g) { return (g.base || 0) + (g.checks || []).reduce((s, c) => s + Number(c.points || 0), 0); }
  function rubricMax(r) { return r.groups.reduce((s, g) => s + groupMax(g), 0); }
  function rubricMin(r) { return Math.max(r.groups.reduce((s, g) => s + (g.base || 0), 0), r.baseScore || 0); }
  function groupScore(g, checks) {
    return (g.base || 0) + (g.checks || []).reduce((s, c) => s + (checks && checks[c.id] ? Number(c.points) : 0), 0);
  }
  // 미제출이면 0점(기본 점수 미적용).
  function total(r, checks, status) {
    if (status === '미제출') return 0;
    const sum = r.groups.reduce((s, g) => s + groupScore(g, checks), 0);
    return Math.max(sum, r.baseScore || 0);
  }

  // 배점 간격에 맞지 않는 항목 목록
  function offStep(r) {
    const bad = [];
    const off = (v) => Math.abs(v / r.step - Math.round(v / r.step)) > 1e-9;
    for (const g of r.groups) {
      if (off(g.base || 0)) bad.push(g.name + ' (기본 ' + g.base + '점)');
      for (const c of g.checks) if (off(c.points)) bad.push(c.label + ' (' + c.points + '점)');
    }
    return bad;
  }

  // ---- 자동 감지 ----
  function safeRegex(p) { try { return new RegExp(p, 'i'); } catch (e) { return null; } }
  function splitKw(p) { return (p || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean); }

  function snippet(text, idx, len) {
    const s = text.slice(Math.max(0, idx - 10), idx + Math.min(len, 40) + 10).replace(/\s+/g, ' ').trim();
    return '"' + s + '"';
  }

  const reEscG = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 표 한 칸을 통째로 차지하는 낱말(앞뒤가 줄바꿈·탭·|). 띄어쓰기 차이는 무시.
  const cellRegex = (w, flags) => new RegExp('(^|[\\r\\n\\t|])[ \\u00a0]*' + w.replace(/\s+/g, '').split('').map(reEscG).join('\\s*') + '[ \\u00a0]*[:：]?(?=[\\t\\r\\n|]|$)', flags || 'i');

  // { met, evidence } — evidence: 찾았으면 무엇을 찾았는지, 못 찾았으면 무엇을 못 찾았는지
  function detect(auto, text, fullText) {
    if (!auto || auto.type === 'none') return { met: false, manual: true, evidence: '' };
    if (!text) return { met: false, evidence: '' };
    const low = text.toLowerCase();
    if (auto.type === 'keyword' || auto.type === 'keywordAll') {
      const kws = splitKw(auto.pattern);
      if (!kws.length) return { met: false, manual: true, evidence: '' };
      const found = kws.filter((k) => low.includes(k.toLowerCase()));
      const missing = kws.filter((k) => !found.includes(k));
      const met = auto.type === 'keyword' ? found.length > 0 : missing.length === 0;
      if (met) return { met, evidence: '키워드 발견: ' + found.join(', ') };
      return {
        met,
        evidence: auto.type === 'keyword'
          ? '제출물에서 키워드(' + kws.join(', ') + ') 중 어느 것도 찾지 못함'
          : '제출물에서 키워드 ' + missing.join(', ') + '을(를) 찾지 못함',
      };
    }
    if (auto.type === 'regex') {
      const re = safeRegex(auto.pattern);
      if (!re) return { met: false, evidence: '정규식 오류: ' + auto.pattern };
      const m = re.exec(text);
      if (m) return { met: true, evidence: m[0] ? '일치: ' + snippet(text, m.index, m[0].length) : '조건 일치' };
      return { met: false, evidence: '제출물에서 패턴 /' + auto.pattern + '/ 과 일치하는 부분을 찾지 못함' };
    }
    if (auto.type === 'filled') {
      // "라벨" 항목 자체(표 헤더 등)는 늘 문서에 인쇄돼 있어 단순 키워드로는 빈칸도 항상
      // 걸리므로, 그 라벨 바로 뒤(다음 표 라벨이 나오기 전까지)에 실제 내용이 채워졌는지 본다.
      // 라벨을 쉼표로 여러 개 주면 모두 채워져야 충족.
      const labels = splitKw(auto.pattern);
      if (!labels.length) return { met: false, manual: true, evidence: '' };
      const stopWords = splitKw(auto.stopAt || auto.pattern);
      // within(예: "활동2")이 있으면 그 활동 구역 안에서만, 표의 "칸 이름"(칸 전체가 그 낱말인 곳)을 찾는다.
      // 문제 설명문·안내문 속의 같은 낱말(예: "(오버플로우 예외 처리 필요)")에는 걸리지 않는다.
      const region = auto.within ? sectionBody(text, auto.within) : text;
      const rlow = region == null ? '' : region.toLowerCase();
      const cellRe = cellRegex;
      const filledText = (label) => {
        if (region == null) return null;
        let idx, endLen = label.length;
        if (auto.within) {
          const m = cellRe(label).exec(region);
          if (!m) return null;
          idx = m.index + m[0].length - label.length;
        } else {
          idx = rlow.indexOf(label.toLowerCase());
          if (idx < 0) return null;
        }
        // 칸 내용은 같은 줄(표 오른쪽 칸)이나 다음 줄(칸 안 문단)에 올 수 있어, 다음 표 항목이
        // 나오기 전까지 최대 3줄을 본다. 원본 학습지를 알면 원본에 원래 있던 줄(인쇄된 안내문)은 뺀다.
        let rest = region.slice(idx + endLen, idx + endLen + 400);
        let cut = rest.length;
        for (const w of stopWords) {
          const wi = auto.within ? (() => { const sm = cellRe(w).exec(rest); return sm ? sm.index : -1; })() : rest.toLowerCase().indexOf(w.toLowerCase());
          if (wi >= 0 && wi < cut) cut = wi;
        }
        const lines = rest.slice(0, cut).split('\n').slice(0, auto.within ? 12 : 3)
          .filter((l, i) => i === 0 || !templateKeys || !templateKeys.has(lineKey(l)));
        rest = lines.join(' ').replace(/[\t\r]+/g, ' ').trim();
        return /[가-힣]{2,}|[A-Za-z]{3,}/.test(rest) ? rest : '';
      };
      const found = [], empty = [];
      for (const label of labels) {
        const t = filledText(label);
        if (t) found.push('"' + label + '": "' + t.slice(0, 40) + '"');
        else empty.push('"' + label + '"' + (t === null ? '(항목 없음)' : ''));
      }
      if (auto.min) {
        // min: 이 칸들 중 min개 이상 채워져야 충족(부분 점수 없음)
        if (found.length >= Number(auto.min)) return { met: true, evidence: '내용이 채워짐(' + found.length + '/' + labels.length + '칸) — ' + found.join(', ') };
        return { met: false, evidence: '채워진 칸이 ' + found.length + '개뿐(필요 ' + auto.min + '개)' + (empty.length ? ' — 비어 있음: ' + empty.join(', ') : '') };
      }
      if (!empty.length) return { met: true, evidence: '내용이 채워짐 — ' + found.join(', ') };
      // 일부만 채움: 배점은 5점 단위라 쪼개지 않고 이 항목 점수는 준다.
      if (found.length) return { met: true, partial: true, evidence: '일부 채워짐 — ' + found.join(', ') };
      return { met: false, evidence: empty.join(', ') + ' 칸이 비어 있는 것으로 보임(표/칸에 내용이 채워지지 않음)' };
    }
    if (auto.type === 'defFromTable') {
      // 활동1 설계표의 행(pattern)에서 학생이 적은 함수명을 읽어, 그 이름이 코드에 "def 이름("으로
      // 정의돼 있는지 본다. 코드는 활동3이나 별도 첨부(.py)에 있을 수 있어 제출물 전체에서 찾는다.
      const rows = splitKw(auto.pattern);
      if (!rows.length) return { met: false, manual: true, evidence: '' };
      const region = auto.within ? sectionBody(text, auto.within) : text;
      if (region == null) return { met: false, evidence: '"' + auto.within + '" 설계표를 문서에서 찾지 못함' };
      const stops = splitKw(auto.stopAt).map((w) => w.toLowerCase());
      const rlines = region.split('\n');
      const names = [];
      for (const row of rows) {
        const ri = rlines.findIndex((l) => l.includes(row));
        if (ri < 0) continue;
        // 함수명 칸: 같은 줄에서 행 이름 뒤(표가 | 로 이어진 경우) 또는 다음 줄
        let cell = rlines[ri].slice(rlines[ri].indexOf(row) + row.length).replace(/^[\s|:]+/, '').split('|')[0].trim();
        if (!cell) {
          for (let j = ri + 1; j < Math.min(rlines.length, ri + 3); j++) {
            const t = rlines[j].trim();
            if (!t) continue;
            if (stops.some((w) => t.toLowerCase().startsWith(w)) || (templateKeys && templateKeys.has(lineKey(t)))) break;
            cell = t.split('|')[0].trim();
            break;
          }
        }
        // 한 칸에 "peek / is_empty"처럼 여러 개를 적을 수 있음. 괄호 앞 이름만.
        for (const part of cell.split(/[\/,·]|\s및\s/)) {
          const m = /[A-Za-z_가-힣][A-Za-z0-9_가-힣]*/.exec(part.replace(/\(.*$/, '').trim());
          if (m && m[0].length >= 2 && !names.includes(m[0])) names.push(m[0]);
        }
      }
      if (!names.length) return { met: false, evidence: '설계표에 함수명이 없어 코드 구현을 확인할 수 없음' };
      const code = fullText || text;
      const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const missing = names.filter((n) => !new RegExp('def\\s+' + esc(n) + '\\s*\\(').test(code));
      if (!missing.length) return { met: true, evidence: '설계표 함수 ' + names.join(', ') + ' 모두 코드에 정의됨' };
      return { met: false, evidence: '설계표 함수명 ' + missing.join(', ') + '이(가) 코드에 def로 정의되지 않음' + (missing.length < names.length ? ' (정의됨: ' + names.filter((n) => !missing.includes(n)).join(', ') + ')' : '') };
    }
    if (auto.type === 'all') {
      const parts = Array.isArray(auto.parts) ? auto.parts : [];
      if (!parts.length) return { met: false, manual: true, evidence: '' };
      const res = parts.map((pt) => detect(pt, text, fullText));
      const bad = res.find((x) => !x.met);
      if (!bad) return { met: true, evidence: res.map((x) => x.evidence).join(' / ') };
      return { met: false, evidence: bad.evidence };
    }
    if (auto.type === 'rows') {
      // pattern(예: "활동4") 구역의 표에서 번호 칸(1, 2, 3…) 뒤에 내용이 적힌 행이 min개 이상인지.
      const head = (auto.pattern || '').trim();
      const need = Number(auto.min) || 1;
      if (!head) return { met: false, manual: true, evidence: '' };
      const body = sectionBody(text, head);
      if (body == null) return { met: false, evidence: '"' + head + '" 구역을 문서에서 찾지 못함' };
      const has = (str) => {
        const lines = str.split('\n').filter((l) => !templateKeys || !templateKeys.has(lineKey(l)));
        return /[가-힣A-Za-z0-9]{2,}/.test(lines.join(' ').replace(/_+/g, ' '));
      };
      const starts = [];
      let pos = 0;
      for (let n = 1; n <= 12; n++) {
        const m = cellRegex(String(n)).exec(body.slice(pos));
        if (!m) break;
        const st = pos + m.index + m[0].length;
        starts.push({ n, st, mi: pos + m.index });
        pos = st;
      }
      let count = 0;
      starts.forEach((x, k) => { if (has(body.slice(x.st, k + 1 < starts.length ? starts[k + 1].mi : body.length))) count++; });
      if (!starts.length) { // 번호 칸이 지워진 문서: 표 머리글·안내문을 뺀 나머지 글 칸 수로 어림
        const ignore = new Set(splitKw(auto.stopAt || '번호, 수행 동작, 예상 결과, 실제 결과, 일치 여부').map(lineKey));
        const cells = body.split(/[\n\t]/).filter((l) => { const k = lineKey(l); return k && !ignore.has(k) && !/하시오\.?$/.test(k) && !(templateKeys && templateKeys.has(k)) && /[가-힣A-Za-z0-9]{2,}/.test(k.replace(/_+/g, '')); });
        count = Math.floor(cells.length / 3);
      }
      if (count >= need) return { met: true, evidence: '"' + head + '" 표에 ' + count + '개 행이 채워짐' };
      return { met: false, evidence: '"' + head + '" 표에 채워진 행이 ' + count + '개뿐(필요 ' + need + '개)' };
    }
    if (auto.type === 'section') {
      // pattern(예: "활동4") 제목 줄 다음부터 다음 "■" 제목 전까지를 그 활동 구역으로 보고,
      // 학습지에 원래 인쇄된 줄(원본과 같은 줄, 표 머리글 stopAt, 번호만 있는 줄, 안내문)을 뺀 뒤
      // 학생이 쓴 글자가 있으면 작성한 것으로 본다.
      const head = (auto.pattern || '').trim();
      if (!head) return { met: false, manual: true, evidence: '' };
      const body = sectionBody(text, head);
      if (body == null) return { met: false, evidence: '"' + head + '" 구역을 문서에서 찾지 못함' };
      const ignore = new Set(splitKw(auto.stopAt).map(lineKey));
      const written = body.split('\n').filter((l) => {
        const k = lineKey(l);
        if (!k || /^\d+[.)]?$/.test(k) || ignore.has(k)) return false;
        if (templateKeys && templateKeys.has(k)) return false;
        if (/하시오\.?$/.test(k)) return false; // 안내문
        return true;
      }).join(' ');
      if ((written.match(/[가-힣A-Za-z0-9]/g) || []).length >= 4) {
        return { met: true, evidence: '"' + head + '" 작성됨: "' + written.replace(/\s+/g, ' ').slice(0, 60) + '"' };
      }
      return { met: false, evidence: '"' + head + '" 구역(표)이 비어 있음' };
    }
    return { met: false, manual: true, evidence: '' };
  }

  // 문서를 "2회차" 표시를 기준으로 앞부분(1회차·스택)/뒷부분(2회차·큐)으로 나눈다.
  // 회차 표시를 찾지 못하면 전체 텍스트를 그대로 두 구간 모두에 쓴다(예전 형식 등 호환).
  function splitRounds(text) {
    if (!text) return { stack: '', queue: '' };
    const m = /\[\s*2\s*회차/.exec(text) || /2\s*회차/.exec(text);
    if (!m) return { stack: text, queue: text };
    return { stack: text.slice(0, m.index), queue: text.slice(m.index) };
  }
  function sectionText(scope, text) {
    if (!scope) return text;
    const { stack, queue } = splitRounds(text);
    return scope === 'stack' ? stack : scope === 'queue' ? queue : text;
  }
  const SCOPE_LABEL = { stack: '스택(1회차) ', queue: '큐(2회차) ', any: '', both: '' };

  function groupBlocked(g, text) {
    if (!g.requires || !g.requires.pattern || !text) return false;
    const re = safeRegex(g.requires.pattern);
    return re ? !re.test(text) : false;
  }

  // AI 작성 의심 여부: 선생님이 직접 정했으면 그 값, 아니면 의심 신호(flags)가 하나라도 있으면 의심.
  function isSuspect(s) {
    if (s.aiSuspect === true || s.aiSuspect === false) return s.aiSuspect;
    return !!(s.flags && s.flags.length);
  }

  // 체크 항목 하나에 대한 자동 판정과 근거 문장.
  function explain(g, c, text, suspect) {
    if (!text) return { met: false, reason: '추출된 텍스트가 없어 자동 판정을 하지 못함 — 가운데 파일을 직접 확인하세요.' };
    if (suspect && g.aiBlock) return { met: false, reason: 'AI 작성 의심으로 이 영역은 기본 점수만 부여' };
    if (groupBlocked(g, text)) {
      return { met: false, reason: '필수 조건 미충족: ' + (g.requires.message || '/' + g.requires.pattern + '/ 없음') };
    }
    const prefix = c.scope ? SCOPE_LABEL[c.scope] : '';
    let d;
    if (c.scope === 'any' || c.scope === 'both') {
      // any: 스택(1회차)·큐(2회차) 중 하나라도 충족하면 충족 / both: 두 회차 모두 충족해야 충족
      const ds = detect(c.auto, sectionText('stack', text), text);
      const dq = detect(c.auto, sectionText('queue', text), text);
      if (ds.manual) d = ds;
      else if (c.scope === 'any') d = ds.met ? Object.assign({}, ds, { evidence: '스택(1회차) ' + ds.evidence }) : dq.met ? Object.assign({}, dq, { evidence: '큐(2회차) ' + dq.evidence }) : { met: false, evidence: '스택: ' + ds.evidence + ' / 큐: ' + dq.evidence };
      else d = ds.met && dq.met ? { met: true, evidence: '스택 ' + ds.evidence + ' / 큐 ' + dq.evidence } : { met: false, evidence: (ds.met ? '' : '스택: ' + ds.evidence) + (!ds.met && !dq.met ? ' / ' : '') + (dq.met ? '' : '큐: ' + dq.evidence) };
      return d.met ? { met: true, reason: d.evidence, comment: '' } : { met: false, reason: (c.reason ? c.reason + ' — ' : '') + d.evidence };
    }
    const scoped = sectionText(c.scope, text);
    d = detect(c.auto, scoped, text);
    if (d.manual) return { met: false, reason: c.reason || '자동 감지 대상이 아닌 항목 — 파일을 확인하고 근거를 적어 주세요.' };
    if (d.met) return { met: true, reason: prefix + d.evidence, comment: d.comment ? prefix + d.comment : '' };
    // 정규식은 식 자체를 보여 줘도 알아보기 어려우니, 적어 둔 근거 문장이 있으면 그것만 쓴다.
    if (c.auto.type === 'regex' && c.reason && !/^정규식 오류/.test(d.evidence)) return { met: false, reason: prefix + c.reason };
    return { met: false, reason: prefix + (c.reason ? c.reason + ' — ' : '') + d.evidence };
  }

  // onlyAiBlock: AI 의심을 바꿨을 때처럼 aiBlock 영역만 다시 계산할 때
  function suggestChecks(r, text, suspect, prev, onlyAiBlock) {
    const out = Object.assign({}, prev || {});
    // 미기입(작성 영역이 비어 있음)이면 학습지에 인쇄된 문구(push, 오버플로우 …)가 키워드에
    // 걸리더라도 아무것도 체크하지 않는다 → 제출자 최소점.
    const blank = isBlank(r, text);
    for (const g of r.groups) {
      if (onlyAiBlock && !g.aiBlock) continue;
      for (const c of g.checks) out[c.id] = blank ? false : explain(g, c, text, suspect).met;
    }
    return out;
  }

  // 체크되지 않은 항목의 근거(교사가 고친 문장이 있으면 그것을 우선).
  function reasonFor(g, c, s) {
    if (s.reasonEdits && s.reasonEdits[c.id] != null) return s.reasonEdits[c.id];
    if (s.blank) return '미기입 — 작성해야 할 영역이 비어 있어 최소점 처리';
    const ex = explain(g, c, s.text, isSuspect(s));
    // 자동 감지로는 충족인데 선생님이 해제한 항목 → 빈칸으로 두어 선생님이 바로 근거를 쓰게 한다
    if (ex.met) return '';
    return ex.reason;
  }

  function detectFlags(r, text) {
    if (!text) return [];
    const out = [];
    for (const f of r.flags || []) {
      if (f.requiresPresent) {
        const rp = safeRegex(f.requiresPresent);
        if (!rp || !rp.test(text)) continue; // 코드를 쓴 흔적 자체가 없으면(미기입) 이 신호는 따지지 않는다
      }
      const re = safeRegex(f.pattern);
      if (!re) continue;
      const hit = re.test(text);
      if ((f.type === 'match' && hit) || (f.type === 'missing' && !hit)) out.push(f.message || '/' + f.pattern + '/ ' + (f.type === 'match' ? '발견' : '없음'));
    }
    return out;
  }

  // 원본 학습지에 원래 있던 줄을 뺀 나머지(= 학생이 쓴 줄). 원본을 모르면 그대로.
  function studentOnly(text) {
    if (!templateKeys || !text) return text || '';
    return text.split('\n').filter((l) => !templateKeys.has(lineKey(l))).join('\n');
  }
  // head(예: "활동4")가 들어간 제목 줄 다음부터 다음 "■" 제목 전까지. 못 찾으면 null.
  function sectionBody(text, head) {
    // 안내문 첫머리에 "활동1, 활동2, …"가 나오므로, "■"로 시작하는 제목 줄을 먼저 찾는다.
    const hm = new RegExp('■[^\\n]*' + String(head).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').exec(text);
    const hi = hm ? hm.index : text.toLowerCase().indexOf(String(head).toLowerCase());
    if (hi < 0) return null;
    const nl = text.indexOf('\n', hi);
    const start = nl < 0 ? text.length : nl + 1;
    const next = text.indexOf('■', start);
    return text.slice(start, next < 0 ? text.length : next);
  }

  // ---- 미기입 판정 ----
  // 과제에 첨부된 원본(빈) 학습지의 텍스트를 알면, 제출물에서 원본에 없는 줄만 "학생이 쓴 내용"으로
  // 본다. 이름·학번 칸만 채운 경우는 쓴 것으로 치지 않는다. 원본을 모르면 코드(def)도 없고
  // 표 칸(오버플로우 등)도 비어 있을 때만 미기입.
  const lineKey = (l) => l.replace(/\s+/g, '');
  let templateKeys = null;
  let templateText = '';
  function setTemplate(text) {
    templateText = text || '';
    templateKeys = text ? new Set(String(text).split('\n').map(lineKey).filter(Boolean)) : null;
  }
  function hasTemplate() { return !!templateKeys; }
  function writtenText(text) {
    if (!templateKeys || !text) return '';
    return text.split('\n').filter((l) => {
      const k = lineKey(l);
      if (!k || templateKeys.has(k)) return false;
      if (/^===.*===$/.test(k) || /^\[추출실패/.test(k)) return false; // 추출기가 붙인 머리글
      if (k.length < 40 && /(학번|이름|성명|학년|번호)/.test(k)) return false; // 신상 칸만 채운 줄
      return true;
    }).join('\n');
  }
  function isBlank(r, text) {
    if (!text) return false;
    if (templateKeys) {
      const letters = (writtenText(text).match(/[가-힣A-Za-z0-9]/g) || []).length;
      return letters < 20;
    }
    const reqs = (r.flags || []).map((f) => f.requiresPresent).filter(Boolean);
    if (!reqs.length) return false;
    const noCode = reqs.every((p) => { const re = safeRegex(p); return !re || !re.test(text); });
    if (!noCode) return false;
    // 코드가 없어도 표 칸을 채웠으면 작성한 것
    for (const g of r.groups) for (const c of g.checks) {
      if (c.auto.type === 'filled' && detect(c.auto, sectionText(c.scope, text)).met) return false;
    }
    return true;
  }

  // 각 항목을 빈 양식·100점 샘플에 돌려 본다. 빈 양식에서 충족(=인쇄 문구에 걸림)이나
  // 샘플에서 미충족(=규칙이 양식과 안 맞음)이면 bad. 빈 양식을 원본으로 두고 판단한다.
  function validate(r, blankText, fullText) {
    const prev = templateText;
    setTemplate(blankText || prev);
    try {
      const rows = [];
      const bChecks = {}, fChecks = {};
      for (const g of r.groups) for (const c of g.checks) {
        const b = blankText ? explain(g, c, blankText, false) : null;
        const f = fullText ? explain(g, c, fullText, false) : null;
        const manual = !c.auto || c.auto.type === 'none';
        if (b) bChecks[c.id] = b.met;
        if (f) fChecks[c.id] = f.met;
        rows.push({
          id: c.id, label: c.label, points: c.points, manual,
          blankMet: !!(b && b.met), blankReason: b ? b.reason : '',
          fullMet: !!(f && f.met), fullReason: f ? f.reason : '',
          blankBad: !!(b && b.met), fullBad: !!(f && !f.met && !manual),
        });
      }
      return { rows, blankTotal: total(r, bChecks, '제출'), fullTotal: total(r, fChecks, '제출') };
    } finally {
      setTemplate(prev);
    }
  }

  function presets() { return PRESETS.map((p) => ({ key: p.key, name: p.rubric.name, rubric: normalize(clone(p.rubric)) })); }

  return {
    snap, migrateStudentChecks, commentFor,
    syncedIds: (r) => (r && r._syncedIds) || [],
    AUTO_TYPES, normalize, defaultRubric, blankRubric, presets, hash,
    groupMax, rubricMax, rubricMin, groupScore, total, offStep,
    detect, explain, suggestChecks, reasonFor, detectFlags, isBlank, groupBlocked, isSuspect,
    setTemplate, hasTemplate, writtenText, validate,
  };
})();
