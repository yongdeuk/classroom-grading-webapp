// 채점 기준(루브릭) 모델과 자동 채점.
//
// 루브릭 = { name, step, baseScore, groups: [...], flags: [...] }
//  - 평가 영역(group)은 "기본 점수(base, 그 영역의 최저 밴드)" + 여러 개의 체크 항목(check)으로 이뤄진다.
//    체크할 때마다 그 배점만큼 더해져서, 예) 기본 20 + 5점 체크 4개 → 20/25/30/35/40 밴드가 된다.
//  - step: 배점 간격(정보과학은 5점). 배점이 간격에 안 맞으면 편집 화면에서 경고한다.
//  - baseScore: 제출한 학생의 합계 최저점(선택). 0이면 사용하지 않음.
//  - flags: 제출물에서 교사가 눈여겨봐야 할 신호(점수에는 영향 없음, 경고만 표시).
//  - group.requires: 이 조건(정규식)이 제출물에 없으면 그 영역 체크를 자동으로 전부 해제.
// 과목에 상관없이 쓸 수 있도록 과목 전용 규칙은 모두 루브릭 데이터 안에 둔다.
const Grading = (() => {
  const AUTO_TYPES = { none: '직접 확인', keyword: '키워드(하나라도)', keywordAll: '키워드(모두)', regex: '정규식' };

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // ---- 기본 제공 기준 ----
  const INFO_SCIENCE_STACK_QUEUE = {
    name: '정보과학 — 함수를 활용한 스택·큐 프로그램 구현 (1차 수행평가)',
    step: 5,
    baseScore: 0,
    groups: [
      {
        id: 'design', name: '자료구조 및 함수 설계의 적절성', base: 20,
        checks: [
          { id: 'design_s_io', label: '스택: 삽입(push)·삭제(pop) 연산 설계', points: 5, auto: { type: 'keywordAll', pattern: 'push, pop' }, reason: '스택의 삽입·삭제 연산 설계가 확인되지 않음' },
          { id: 'design_s_peek', label: '스택: 조회(peek)·상태 확인(isEmpty) 설계', points: 5, auto: { type: 'regex', pattern: '(peek|top|조회)[\\s\\S]*(is_?empty|비어)|(is_?empty|비어)[\\s\\S]*(peek|top|조회)' }, reason: '스택의 조회·상태 확인 연산 설계가 확인되지 않음' },
          { id: 'design_q_io', label: '큐: 삽입(enqueue)·삭제(dequeue) 연산 설계', points: 5, auto: { type: 'keywordAll', pattern: 'enqueue, dequeue' }, reason: '큐의 삽입·삭제 연산 설계가 확인되지 않음' },
          { id: 'design_q_peek', label: '큐: 조회(front/peek)·상태 확인 설계', points: 5, auto: { type: 'regex', pattern: '(front|peek|조회)[\\s\\S]*(is_?empty|비어)|(is_?empty|비어)[\\s\\S]*(front|peek|조회)' }, reason: '큐의 조회·상태 확인 연산 설계가 확인되지 않음' },
        ],
      },
      {
        id: 'impl', name: '함수를 활용한 스택·큐 연산 구현', base: 10,
        requires: { pattern: '\\bclass\\s+\\w+', message: 'class 없이 구현됨 — 교과서의 class Stack/Queue를 변경하라는 요구사항 미준수(AI 작성 의심)' },
        checks: [
          { id: 'impl_s_io', label: '스택 push·pop 함수 구현', points: 5, auto: { type: 'regex', pattern: '(?=[\\s\\S]*def\\s+push)(?=[\\s\\S]*def\\s+pop)' }, reason: 'push 또는 pop 함수 정의(def)가 없음' },
          { id: 'impl_s_peek', label: '스택 peek·isEmpty 함수 구현', points: 5, auto: { type: 'regex', pattern: '(?=[\\s\\S]*def\\s+(peek|top))(?=[\\s\\S]*def\\s+is_?empty)' }, reason: 'peek 또는 isEmpty 함수 정의(def)가 없음' },
          { id: 'impl_q_io', label: '큐 enqueue·dequeue 함수 구현', points: 5, auto: { type: 'regex', pattern: '(?=[\\s\\S]*def\\s+enqueue)(?=[\\s\\S]*def\\s+dequeue)' }, reason: 'enqueue 또는 dequeue 함수 정의(def)가 없음' },
          { id: 'impl_q_peek', label: '큐 peek(front)·isEmpty 함수 구현', points: 5, auto: { type: 'regex', pattern: '(?=[\\s\\S]*def\\s+(peek|front))(?=[\\s\\S]*def\\s+is_?empty)' }, reason: '큐의 peek(front) 또는 isEmpty 함수 정의(def)가 없음' },
        ],
      },
      {
        id: 'exc', name: '예외 상황 처리 및 프로그램 검증', base: 10,
        checks: [
          { id: 'exc_overflow', label: '오버플로우(가득 참) 예외 처리', points: 5, auto: { type: 'keyword', pattern: 'overflow, 오버플로우, 가득' }, reason: '오버플로우 상황 처리가 확인되지 않음' },
          { id: 'exc_underflow', label: '언더플로우(비어 있음) 예외 처리', points: 5, auto: { type: 'keyword', pattern: 'underflow, 언더플로우, 비어, is_empty, isempty' }, reason: '언더플로우 상황 처리가 확인되지 않음' },
          { id: 'exc_test', label: '테스트 코드로 연산 실행 결과 검증', points: 5, auto: { type: 'regex', pattern: 'print\\s*\\(' }, reason: '실행 결과를 확인하는 테스트 코드(print)가 없음' },
          { id: 'exc_msg', label: '예외 상황을 알리는 처리(오류 메시지·raise·반환값 등)', points: 5, auto: { type: 'keyword', pattern: 'raise, except, error, 오류, 에러, 예외, return none' }, reason: '예외 상황을 알리는 처리(메시지·raise 등)가 확인되지 않음' },
        ],
      },
    ],
    flags: [
      { type: 'missing', pattern: '\\bclass\\s+\\w+', message: 'class 없이 구현됨 — 과제 요구사항(교과서의 class Stack/Queue를 변경) 미준수. AI 작성 의심' },
      { type: 'match', pattern: '(import\\s+collections|from\\s+collections|import\\s+queue\\b|from\\s+queue\\b|\\bdeque\\s*\\(|\\bQueue\\s*\\(\\))', message: 'deque/queue 내장 모듈 사용 의심 — 직접 구현 요구사항 위반 가능' },
    ],
  };

  const PRESETS = [{ key: 'info-stack-queue', rubric: INFO_SCIENCE_STACK_QUEUE }];
  // 예전 버전(배열 형식)의 기본 루브릭 체크 id — 그대로 남아 있으면 새 기본 기준으로 바꿔 준다.
  const LEGACY_DEFAULT_IDS = ['design_s_push', 'impl_s_push', 'exc_overflow'];

  const clone = (o) => JSON.parse(JSON.stringify(o));

  function defaultRubric() { return normalize(clone(INFO_SCIENCE_STACK_QUEUE)); }
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
    let r = Array.isArray(raw) ? { name: '이전 채점 기준', step: 1, baseScore: 40, groups: raw } : Object.assign({}, raw);
    r.name = String(r.name || '채점 기준');
    r.step = Math.max(0.5, Number(r.step) || 1);
    r.baseScore = Number(r.baseScore) || 0;
    const groupIds = new Set();
    r.groups = (r.groups || []).map((g, gi) => {
      const name = String(g.name || '평가 영역 ' + (gi + 1));
      let gid = g.id || 'g_' + hash(name);
      while (groupIds.has(gid)) gid += '_';
      groupIds.add(gid);
      let requires = g.requires && g.requires.pattern ? { pattern: String(g.requires.pattern), message: String(g.requires.message || '') } : null;
      if (!requires && g.requiresClass) requires = { pattern: '\\bclass\\s+\\w+', message: 'class 없이 구현됨' };
      const checkIds = new Set();
      const checks = (g.checks || []).map((c) => {
        const label = String(c.label || '체크 항목');
        let cid = c.id || 'c_' + hash(name + '|' + label);
        while (checkIds.has(cid)) cid += '_';
        checkIds.add(cid);
        const type = c.auto && AUTO_TYPES[c.auto.type] ? c.auto.type : 'none';
        return { id: cid, label, points: Number(c.points) || 0, auto: { type, pattern: String((c.auto && c.auto.pattern) || '') }, reason: String(c.reason || '') };
      });
      return { id: gid, name, base: Number(g.base) || 0, requires, checks };
    });
    r.flags = (r.flags || [])
      .filter((f) => f && f.pattern)
      .map((f) => ({ type: f.type === 'match' ? 'match' : 'missing', pattern: String(f.pattern), message: String(f.message || '') }));
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

  // { met, evidence } — evidence: 찾았으면 무엇을 찾았는지, 못 찾았으면 무엇을 못 찾았는지
  function detect(auto, text) {
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
    return { met: false, manual: true, evidence: '' };
  }

  function groupBlocked(g, text) {
    if (!g.requires || !g.requires.pattern || !text) return false;
    const re = safeRegex(g.requires.pattern);
    return re ? !re.test(text) : false;
  }

  // 체크 항목 하나에 대한 자동 판정과 근거 문장.
  function explain(g, c, text) {
    if (!text) return { met: false, reason: '추출된 텍스트가 없어 자동 판정을 하지 못함 — 가운데 파일을 직접 확인하세요.' };
    if (groupBlocked(g, text)) {
      return { met: false, reason: '필수 조건 미충족: ' + (g.requires.message || '/' + g.requires.pattern + '/ 없음') };
    }
    const d = detect(c.auto, text);
    if (d.manual) return { met: false, reason: c.reason || '자동 감지 대상이 아닌 항목 — 파일을 확인하고 근거를 적어 주세요.' };
    if (d.met) return { met: true, reason: d.evidence };
    // 정규식은 식 자체를 보여 줘도 알아보기 어려우니, 적어 둔 근거 문장이 있으면 그것만 쓴다.
    if (c.auto.type === 'regex' && c.reason && !/^정규식 오류/.test(d.evidence)) return { met: false, reason: c.reason };
    return { met: false, reason: (c.reason ? c.reason + ' — ' : '') + d.evidence };
  }

  function suggestChecks(r, text) {
    const out = {};
    for (const g of r.groups) for (const c of g.checks) out[c.id] = explain(g, c, text).met;
    return out;
  }

  // 체크되지 않은 항목의 근거(교사가 고친 문장이 있으면 그것을 우선).
  function reasonFor(g, c, s) {
    if (s.reasonEdits && s.reasonEdits[c.id] != null) return s.reasonEdits[c.id];
    const ex = explain(g, c, s.text);
    if (ex.met) return '자동 감지로는 충족(' + ex.reason + ')으로 판단했으나 선생님이 체크를 해제함 — 근거를 적어 주세요.';
    return ex.reason;
  }

  function detectFlags(r, text) {
    if (!text) return [];
    const out = [];
    for (const f of r.flags || []) {
      const re = safeRegex(f.pattern);
      if (!re) continue;
      const hit = re.test(text);
      if ((f.type === 'match' && hit) || (f.type === 'missing' && !hit)) out.push(f.message || '/' + f.pattern + '/ ' + (f.type === 'match' ? '발견' : '없음'));
    }
    return out;
  }

  function presets() { return PRESETS.map((p) => ({ key: p.key, name: p.rubric.name, rubric: normalize(clone(p.rubric)) })); }

  return {
    AUTO_TYPES, normalize, defaultRubric, blankRubric, presets, hash,
    groupMax, rubricMax, rubricMin, groupScore, total, offStep,
    detect, explain, suggestChecks, reasonFor, detectFlags, groupBlocked,
  };
})();
