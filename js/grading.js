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
  const AUTO_TYPES = { none: '직접 확인', keyword: '키워드(하나라도)', keywordAll: '키워드(모두)', regex: '정규식', filled: '표/항목 뒤 내용 채움' };

  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // ---- 기본 제공 기준 ----
  const INFO_SCIENCE_STACK_QUEUE = {
    name: '정보과학 — 함수를 활용한 스택·큐 프로그램 구현 (1차 수행평가)',
    step: 5, // 배점은 5점 단위(소수점 없음)
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
          { id: 'exc_s_flow', label: '스택: 오버플로우·언더플로우 예외 처리', points: 5, scope: 'stack', auto: { type: 'filled', pattern: '오버플로우, 언더플로우', stopAt: '오버플로우, 언더플로우, 예외 상황, 발생 조건, 처리 방법' }, reason: '스택의 오버플로우·언더플로우 처리 계획 칸이 비어 있는 것으로 보임' },
          { id: 'exc_q_flow', label: '큐: 오버플로우·언더플로우 예외 처리', points: 5, scope: 'queue', auto: { type: 'filled', pattern: '오버플로우, 언더플로우', stopAt: '오버플로우, 언더플로우, 예외 상황, 발생 조건, 처리 방법' }, reason: '큐의 오버플로우·언더플로우 처리 계획 칸이 비어 있는 것으로 보임' },
          { id: 'exc_test', label: '테스트 코드로 연산 실행 결과 검증', points: 5, auto: { type: 'regex', pattern: 'print\\s*\\(' }, reason: '실행 결과를 확인하는 테스트 코드(print)가 없음' },
          { id: 'exc_msg', label: '예외 상황을 알리는 처리(오류 메시지·raise·반환값 등)', points: 5, auto: { type: 'keyword', pattern: 'raise, except, error, 오류, 에러, 예외, return none' }, reason: '예외 상황을 알리는 처리(메시지·raise 등)가 확인되지 않음' },
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

  const PRESETS = [{ key: 'info-stack-queue', rubric: INFO_SCIENCE_STACK_QUEUE }];
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
  // 학생 체크도 같이 변환: 두 칸 중 하나라도 체크돼 있으면 합친 항목 5점 인정(5점 단위 가산).
  // 한쪽만 체크돼 있던 경우(예전 -2.5점)는 점수가 바뀌므로 changed로 알리고 코멘트를 남긴다.
  const HALF_NAMES = { exc_s_overflow: '스택 오버플로우', exc_s_underflow: '스택 언더플로우', exc_q_overflow: '큐 오버플로우', exc_q_underflow: '큐 언더플로우' };
  function migrateStudentChecks(checks) {
    if (!checks || !HALF_IDS.some((id) => id in checks)) return { checks, changed: false, comments: {} };
    const out = Object.assign({}, checks);
    const comments = {};
    let changed = false;
    for (const [newId, [a, b]] of Object.entries(HALF_PAIRS)) {
      if (!(a in out) && !(b in out)) continue;
      out[newId] = !!out[a] || !!out[b];
      if (!!out[a] !== !!out[b]) {
        changed = true;
        const missing = out[a] ? b : a;
        comments[newId] = HALF_NAMES[missing] + ' 미충족 — 예전 2.5점 기준에서 -2.5점이었던 사항(5점 단위로 바뀌어 5점 인정, 코멘트로 남김)';
      }
      delete out[a]; delete out[b];
    }
    return { checks: out, changed, comments };
  }

  // 체크된 항목에 붙는 코멘트(선생님·변환 코멘트 우선, 없으면 자동 감지의 부분 미충족 코멘트).
  function commentFor(g, c, s) {
    if (s.comments && s.comments[c.id] != null) return s.comments[c.id];
    return explain(g, c, s.text, isSuspect(s)).comment || '';
  }
  const CLASS_RE = '\\bclass\\s+\\w+';

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
    let r = Array.isArray(raw) ? { name: '이전 채점 기준', step: 5, baseScore: 40, groups: raw } : Object.assign({}, raw);
    r.name = String(r.name || '채점 기준');
    // 소수점 간격(예: 0.5, 2.5)은 쓰지 않음 → 기본 5점 간격으로
    r.step = Number.isInteger(Number(r.step)) && Number(r.step) >= 1 ? Number(r.step) : 5;
    r.baseScore = snap(r.baseScore, r.step);
    const groupIds = new Set();
    r.groups = (r.groups || []).map(migrateHalfGroup).map((g, gi) => {
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
        const scope = c.scope === 'stack' || c.scope === 'queue' ? c.scope : '';
        const stopAt = c.auto && c.auto.stopAt ? String(c.auto.stopAt) : '';
        return { id: cid, label, points: snap(c.points, r.step), auto: { type, pattern: String((c.auto && c.auto.pattern) || ''), stopAt }, reason: String(c.reason || ''), scope };
      });
      return { id: gid, name, base: snap(g.base, r.step), requires, aiBlock, checks };
    });
    if (r.groups.some((g) => g.aiBlock) && !(r.flags || []).some((f) => f && f.pattern === CLASS_RE) && Array.isArray(raw)) {
      r.flags = [{ type: 'missing', pattern: CLASS_RE, message: 'class 없이 구현됨' }];
    }
    r.flags = (r.flags || [])
      .filter((f) => f && f.pattern && !/import\\s\+collections/.test(f.pattern)) // 내장 모듈 의심 신호는 뺐음
      .map((f) => ({
        type: f.type === 'match' ? 'match' : 'missing', pattern: String(f.pattern), message: String(f.message || ''),
        requiresPresent: f.requiresPresent ? String(f.requiresPresent) : '',
      }));
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
    if (auto.type === 'filled') {
      // "라벨" 항목 자체(표 헤더 등)는 늘 문서에 인쇄돼 있어 단순 키워드로는 빈칸도 항상
      // 걸리므로, 그 라벨 바로 뒤(다음 표 라벨이 나오기 전까지)에 실제 내용이 채워졌는지 본다.
      // 라벨을 쉼표로 여러 개 주면 모두 채워져야 충족.
      const labels = splitKw(auto.pattern);
      if (!labels.length) return { met: false, manual: true, evidence: '' };
      const stopWords = splitKw(auto.stopAt || auto.pattern);
      const filledText = (label) => {
        const idx = low.indexOf(label.toLowerCase());
        if (idx < 0) return null;
        // 칸 내용은 같은 줄(표 오른쪽 칸)이나 다음 줄(칸 안 문단)에 올 수 있어, 다음 표 항목이
        // 나오기 전까지 최대 3줄을 본다. 원본 학습지를 알면 원본에 원래 있던 줄(인쇄된 안내문)은 뺀다.
        let rest = text.slice(idx + label.length, idx + label.length + 300);
        let cut = rest.length;
        for (const w of stopWords) {
          const wi = rest.toLowerCase().indexOf(w.toLowerCase());
          if (wi >= 0 && wi < cut) cut = wi;
        }
        const lines = rest.slice(0, cut).split('\n').slice(0, 3)
          .filter((l, i) => i === 0 || !templateKeys || !templateKeys.has(lineKey(l)));
        rest = lines.join(' ').replace(/[\t]+/g, ' ').trim();
        return /[가-힣]{2,}|[A-Za-z]{3,}/.test(rest) ? rest : '';
      };
      const found = [], empty = [];
      for (const label of labels) {
        const t = filledText(label);
        if (t) found.push('"' + label + '": "' + t.slice(0, 40) + '"');
        else empty.push('"' + label + '"' + (t === null ? '(항목 없음)' : ''));
      }
      if (!empty.length) return { met: true, evidence: '내용이 채워짐 — ' + found.join(', ') };
      // 일부만 채움: 배점은 5점 단위라 쪼개지 않고 이 항목 점수는 주되, 예전 2.5점 기준이라면
      // 깎였을(-2.5점) 부분을 코멘트로 남긴다.
      if (found.length) {
        return {
          met: true, partial: true,
          evidence: '일부 채워짐 — ' + found.join(', '),
          comment: empty.join(', ') + ' 칸 미기입 — 예전 2.5점 기준이면 -2.5점 사항(5점 단위라 감점하지 않고 코멘트로 남김)',
        };
      }
      return { met: false, evidence: empty.join(', ') + ' 칸이 비어 있는 것으로 보임(표/칸에 내용이 채워지지 않음)' };
    }
    return { met: false, manual: true, evidence: '' };
  }

  // 문서를 "2회차" 표시를 기준으로 앞부분(1회차·스택)/뒷부분(2회차·큐)으로 나눈다.
  // 회차 표시를 찾지 못하면 전체 텍스트를 그대로 두 구간 모두에 쓴다(예전 형식 등 호환).
  function splitRounds(text) {
    if (!text) return { stack: '', queue: '' };
    const m = /2\s*회차/.exec(text);
    if (!m) return { stack: text, queue: text };
    return { stack: text.slice(0, m.index), queue: text.slice(m.index) };
  }
  function sectionText(scope, text) {
    if (!scope) return text;
    const { stack, queue } = splitRounds(text);
    return scope === 'stack' ? stack : scope === 'queue' ? queue : text;
  }
  const SCOPE_LABEL = { stack: '스택(1회차) ', queue: '큐(2회차) ' };

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
    const scoped = sectionText(c.scope, text);
    const prefix = c.scope ? SCOPE_LABEL[c.scope] : '';
    const d = detect(c.auto, scoped);
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
    if (ex.met) return '자동 감지로는 충족(' + ex.reason + ')으로 판단했으나 선생님이 체크를 해제함 — 근거를 적어 주세요.';
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

  // ---- 미기입 판정 ----
  // 과제에 첨부된 원본(빈) 학습지의 텍스트를 알면, 제출물에서 원본에 없는 줄만 "학생이 쓴 내용"으로
  // 본다. 이름·학번 칸만 채운 경우는 쓴 것으로 치지 않는다. 원본을 모르면 코드(def)도 없고
  // 표 칸(오버플로우 등)도 비어 있을 때만 미기입.
  const lineKey = (l) => l.replace(/\s+/g, '');
  let templateKeys = null;
  function setTemplate(text) {
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

  function presets() { return PRESETS.map((p) => ({ key: p.key, name: p.rubric.name, rubric: normalize(clone(p.rubric)) })); }

  return {
    snap, migrateStudentChecks, commentFor,
    AUTO_TYPES, normalize, defaultRubric, blankRubric, presets, hash,
    groupMax, rubricMax, rubricMin, groupScore, total, offStep,
    detect, explain, suggestChecks, reasonFor, detectFlags, isBlank, groupBlocked, isSuspect,
    setTemplate, hasTemplate, writtenText,
  };
})();
