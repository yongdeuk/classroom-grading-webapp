// 화면 전체를 조립하는 메인 스크립트. 서버 없이 브라우저에서 Classroom/Drive API를
// 직접 호출해 제출물을 불러오고, 텍스트를 뽑아 체크리스트 자동 채점 초안을 채운 뒤
// localStorage에 저장한다.
(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  // 클래스룸 API에는 학번이 없어(학교 내부 학적 번호라 구글 계정에 없음), 학생이 문서
  // 안에 직접 적은 "학번 20801" 같은 칸을 텍스트에서 찾아 보여준다.
  function parseStudentNo(text) {
    if (!text) return '';
    const m = /학번[^0-9]{0,15}([0-9]{3,8})\b/.exec(text);
    return m ? m[1] : '';
  }

  const state = {
    courseId: null, courseWorkId: null, courseName: '', courseWorkTitle: '',
    rubric: Grading.defaultRubric(),
    rubricTouched: false, // 과제를 불러오기 전에 기준을 바꿨으면, 불러올 때 그 기준을 쓴다
    loaded: false,
    students: [],
    hidden: new Set(), // 목록에서 지운(숨긴) 학생의 userId — 제출물을 다시 불러오면 유지됨
    selectedUserId: null,
    checkedIds: new Set(), // 왼쪽 목록에서 체크해 둔(일괄 Claude 채점 대상) 학생의 userId
    viewIdx: {}, // 학생별로 가운데에 보고 있는 파일 번호
    listCollapsed: (() => { try { return localStorage.getItem('grader:listCollapsed') === '1'; } catch (e) { return false; } })(),
    showScores: (() => { try { return localStorage.getItem('grader:showScores') !== '0'; } catch (e) { return true; } })(),
  };

  function toast(msg, ms) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), ms || 3000);
  }

  function setLoadStatus(msg) {
    $('#loadStatus').textContent = msg;
    const s2 = $('#loadStatus2');
    if (s2) s2.textContent = msg;
  }

  async function runWithConcurrency(items, limit, worker) {
    let idx = 0;
    const runners = new Array(Math.min(limit, items.length) || 0).fill(0).map(async () => {
      while (idx < items.length) {
        const i = idx++;
        try { await worker(items[i], i); } catch (e) { console.error(e); }
      }
    });
    await Promise.all(runners);
  }

  function persist() {
    const courseId = state.loaded ? state.courseId : $('#courseSelect').value;
    if (/^\d+$/.test(courseId || '')) Store.setCourseRubric(courseId, state.rubric);
    if (!state.loaded) return;
    const students = {};
    for (const s of state.students) {
      students[s.userId] = {
        sig: s.sig, text: s.text, extractStatus: s.extractStatus,
        checks: s.checks, confirmed: s.confirmed, note: s.note, reasonEdits: s.reasonEdits, comments: s.comments, blank: s.blank, aiSuspect: s.aiSuspect,
        aiEvidence: s.aiEvidence, gradedByAI: s.gradedByAI, gradedBy: s.gradedBy, gradedByAIAt: s.gradedByAIAt, feedbackPosted: s.feedbackPosted,
        teacherChecks: s.teacherChecks, teacherSavedAt: s.teacherSavedAt, aiUndo: s.aiUndo || null,
      };
    }
    Store.save(state.courseId, state.courseWorkId, { rubric: state.rubric, students, hidden: Array.from(state.hidden), updatedAt: Date.now() });
  }

  const selectedStudent = () => state.students.find((x) => x.userId === state.selectedUserId);

  function renderAllGrading() {
    renderStudentList();
    const s = selectedStudent();
    if (s) { renderDocViewer(s); renderGradingPanel(s); }
    renderRubricBadge();
  }

  // ---------------- 탭 ----------------
  // 탭 대신: 평소엔 채점 화면, 오른쪽 위 "⚙ 설정"을 누르면 채점 기준 설정 화면(다시 누르면 채점 화면)
  function showTab(tab) {
    state.tab = tab;
    $('#tabGrade').classList.toggle('hidden', tab !== 'grade');
    $('#tabRubric').classList.toggle('hidden', tab !== 'rubric');
    $('#pickerPanel').classList.toggle('hidden', tab === 'rubric');
    $('#settingsTabBtn').textContent = tab === 'rubric' ? '← 채점 화면' : '⚙ 설정';
    window.scrollTo(0, 0);
  }
  $('#settingsTabBtn').addEventListener('click', () => showTab(state.tab === 'rubric' ? 'grade' : 'rubric'));
  $('#settingsBackBtn').addEventListener('click', () => showTab('grade'));
  // 점수 보이기/숨기기(버튼, 브라우저에 기억)
  // 학생 목록 접기/펴기(브라우저에 기억). 접으면 제출 자료와 평가 항목만 크게 보인다.
  function applyListCollapsed() {
    $('#split3').classList.toggle('list-collapsed', !!state.listCollapsed);
    $('#listToggleBtn').textContent = state.listCollapsed ? '목록 펴기' : '목록 접기';
  }
  $('#listToggleBtn').addEventListener('click', () => {
    state.listCollapsed = !state.listCollapsed;
    try { localStorage.setItem('grader:listCollapsed', state.listCollapsed ? '1' : '0'); } catch (err) {}
    applyListCollapsed();
  });
  // 목록을 접었을 때도 학생을 넘길 수 있게: 화면에 보이는(삭제하지 않은) 학생 순서대로 이전/다음
  function stepStudent(delta) {
    const visible = state.students.filter((s) => !state.hidden.has(s.userId));
    if (!visible.length) return;
    const i = visible.findIndex((s) => s.userId === state.selectedUserId);
    const next = visible[Math.min(visible.length - 1, Math.max(0, (i < 0 ? 0 : i + delta)))];
    if (!next || next.userId === state.selectedUserId) return;
    state.selectedUserId = next.userId;
    renderStudentList();
    renderDocViewer(next);
    renderGradingPanel(next);
    const row = $('#studentList').querySelector('.student-row.selected');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
  function updateScoreToggle() { $('#scoreToggleBtn').textContent = state.showScores ? '점수 숨기기' : '점수 보기'; }
  $('#scoreToggleBtn').addEventListener('click', () => {
    state.showScores = !state.showScores;
    try { localStorage.setItem('grader:showScores', state.showScores ? '1' : '0'); } catch (err) {}
    renderStudentList();
  });
  // 제목 클릭 → 처음 화면(수업·과제 선택). 새로고침하면 로그인이 풀리므로 화면만 초기 상태로 돌린다.
  // 채점한 내용은 이미 저장돼 있어 같은 과제를 다시 불러오면 그대로 이어진다.
  $('#homeLink').addEventListener('click', (e) => {
    e.preventDefault();
    if (state.loaded) persist();
    state.loaded = false;
    state.students = [];
    state.selectedUserId = null;
    state.checkedIds.clear();
    Grading.setTemplate(null);
    state.classroomTemplate = '';
    state.templateSource = '';
    $('#workArea').classList.add('hidden');
    $('#gradeEmpty').classList.remove('hidden');
    $('#docViewer').dataset.key = '';
    $('#pickerSummary').classList.add('hidden');
    $('#pickerForm').classList.remove('hidden');
    setLoadStatus('');
    showTab('grade');
    window.scrollTo(0, 0);
  });
  $('#changeAssignBtn').addEventListener('click', () => {
    $('#pickerSummary').classList.add('hidden');
    $('#pickerForm').classList.remove('hidden');
  });

  function renderRubricBadge() {
    const r = state.rubric;
    $('#rubricBadge').textContent = r.name + ' · ' + Grading.rubricMin(r) + '~' + Grading.rubricMax(r) + '점';
  }

  // ---------------- 인증 ----------------
  function onAuthChange({ token, error }) {
    if (error) { toast('로그인 실패: ' + error); return; }
    if (token) {
      $('#signInBtn').classList.add('hidden');
      $('#signOutBtn').classList.remove('hidden');
      $('#userInfo').classList.remove('hidden');
      $('#userInfo').textContent = '로그인됨';
      $('#app').classList.remove('hidden');
      $('#settingsTabBtn').classList.remove('hidden');
      if (!loadCourses._done) { loadCourses._done = true; loadCourses(); }
    } else {
      loadCourses._done = false;
      $('#signInBtn').classList.remove('hidden');
      $('#signOutBtn').classList.add('hidden');
      $('#userInfo').classList.add('hidden');
      $('#app').classList.add('hidden');
      $('#settingsTabBtn').classList.add('hidden');
    }
  }

  // ---------------- 과제 선택 ----------------
  async function loadCourses() {
    const sel = $('#courseSelect');
    sel.innerHTML = '<option>불러오는 중…</option>';
    try {
      const courses = await Api.listCourses();
      if (!courses.length) { sel.innerHTML = '<option>담당 수업이 없습니다</option>'; return; }
      sel.innerHTML = courses.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
      await onCourseChange(sel.value);
    } catch (e) {
      sel.innerHTML = '<option>불러오기 실패</option>';
      toast('수업 목록을 불러오지 못했습니다: ' + e.message);
    }
  }

  async function onCourseChange(courseId) {
    // 아직 과제를 불러오지 않았고 기준도 손대지 않았으면, 그 수업에서 마지막으로 쓴 기준을 미리 보여 준다.
    if (!state.loaded && !state.rubricTouched) {
      const cr = Store.courseRubric(courseId);
      state.rubric = cr ? Grading.normalize(cr) : Grading.defaultRubric();
      renderRubricTab();
    }
    await loadCourseWorks(courseId);
  }

  async function loadCourseWorks(courseId) {
    const sel = $('#courseWorkSelect');
    sel.disabled = true;
    sel.innerHTML = '<option>불러오는 중…</option>';
    $('#loadBtn').disabled = true;
    try {
      const works = await Api.listCourseWork(courseId);
      if (!works.length) { sel.innerHTML = '<option>과제가 없습니다</option>'; return; }
      sel.innerHTML = works.map((w) => `<option value="${esc(w.id)}">${esc(w.title)}</option>`).join('');
      sel.disabled = false;
      $('#loadBtn').disabled = false;
    } catch (e) {
      sel.innerHTML = '<option>불러오기 실패</option>';
      toast('과제 목록을 불러오지 못했습니다: ' + e.message);
    }
  }

  // ---------------- 제출물 불러오기 + 텍스트 추출 + 자동 채점 ----------------
  async function loadSubmissions() {
    const courseSel = $('#courseSelect'), cwSel = $('#courseWorkSelect');
    state.courseId = courseSel.value;
    state.courseWorkId = cwSel.value;
    state.courseName = courseSel.selectedOptions[0].textContent;
    state.courseWorkTitle = cwSel.selectedOptions[0].textContent;
    $('#workTitle').textContent = state.courseName + ' — ' + state.courseWorkTitle;
    $('#pickerSummaryTitle').textContent = state.courseName + ' — ' + state.courseWorkTitle;

    $('#loadBtn').disabled = true;
    setLoadStatus('제출물 불러오는 중…');
    try {
      const [students, subs] = await Promise.all([
        Api.listStudents(state.courseId),
        Api.listSubmissions(state.courseId, state.courseWorkId),
      ]);

      // 반 전체 명단을 기준으로 삼고, 제출 기록을 매칭한다.
      // (제출물 목록만 기준으로 하면 클래스룸이 아직 제출 레코드를 만들지 않은 학생이
      //  누락될 수 있어, 명단에 있는 학생은 제출물이 없어도 "미제출"로 반드시 나오게 한다.)
      const subByUserId = {};
      subs.forEach((sub) => { subByUserId[sub.userId] = sub; });

      // 과제에 첨부된 원본 학습지 텍스트 — 미기입 판정 기준(없거나 실패하면 코드·표 칸 유무로 판단)
      state.classroomTemplate = await loadTemplateText();

      const cached = Store.load(state.courseId, state.courseWorkId);
      const cachedStudents = (cached && cached.students) || {};

      // 기준 고르기: 방금 직접 올리거나 고친 기준 > 이 과제에 저장된 기준 > 이 수업의 마지막 기준 > 기본 기준
      let regradeAll = false, legacy = false, halfChanged = 0;
      const OLD_IDS = ['exc_test', 'exc_msg'];
      if (state.rubricTouched) {
        regradeAll = true;
      } else if (cached && cached.rubric) {
        legacy = Array.isArray(cached.rubric);
        state.rubric = Grading.normalize(cached.rubric);
        regradeAll = legacy;
      } else {
        const cr = Store.courseRubric(state.courseId);
        state.rubric = cr ? Grading.normalize(cr) : state.rubric;
        regradeAll = true;
      }
      state.rubricTouched = false;
      applyTemplate(); // 올린 빈 양식 > 클래스룸 첨부 학습지
      // 기본 제공 기준이 바뀌어 저장된 기준을 맞춘 항목(예: 테스트 검증을 활동4 표로 판정) → 학생마다 그 항목만 다시 판정
      const syncedIds = Grading.syncedIds(state.rubric);
      let syncChanged = 0;

      const rosterIds = new Set(students.map((s) => s.userId));
      const extraSubs = subs.filter((sub) => !rosterIds.has(sub.userId));
      const roster = students
        .map((s) => ({ userId: s.userId, name: s.profile.name.fullName }))
        .concat(extraSubs.map((sub) => ({ userId: sub.userId, name: '(명단에 없음 ' + sub.userId + ')' })));

      state.hidden = new Set((cached && cached.hidden) || []);

      state.students = roster
        .map(({ userId, name }) => {
          const sub = subByUserId[userId];
          const att = (sub && sub.assignmentSubmission && sub.assignmentSubmission.attachments) || [];
          const files = att.filter((a) => a.driveFile).map((a) => ({ id: a.driveFile.id, name: a.driveFile.title, url: a.driveFile.alternateLink }));
          const links = att.filter((a) => a.link).map((a) => a.link.url);
          const answer = (sub && sub.shortAnswerSubmission && sub.shortAnswerSubmission.answer) || '';
          const turned = sub && (sub.state === 'TURNED_IN' || sub.state === 'RETURNED');
          const status = files.length || answer || links.length ? (sub.late ? '제출(지각)' : '제출') : turned ? '제출(파일없음)' : '미제출';
          const submittedAt = turned && sub.updateTime ? sub.updateTime : null;
          // 클래스룸에 선생님이 입력한 점수(돌려준 점수 우선, 없으면 임시 점수). 댓글은 API로 읽을 수 없음.
          const crGrade = sub && sub.assignedGrade != null ? { value: sub.assignedGrade, kind: '반환' }
            : sub && sub.draftGrade != null ? { value: sub.draftGrade, kind: '임시' } : null;
          const sig = files.map((f) => f.id).join(',') + '|' + answer.length + '|' + links.join(',');
          const prev = cachedStudents[userId] || {};
          // 2.5점 항목(9/28 버전) → 5점 항목으로 변환. 한쪽만 체크돼 점수가 바뀌면 확인 완료를 풀어 다시 보게 한다.
          const mig = Grading.migrateStudentChecks(prev.checks);
          if (mig.changed) halfChanged++;
          const sigMatch = prev.sig === sig;
          const s = {
            userId, name,
            status, files, links, answer, sig, submittedAt, crGrade,
            resubmitted: !!prev.sig && !sigMatch,
            text: sigMatch ? prev.text || '' : '',
            studentNo: sigMatch ? parseStudentNo(prev.text || '') : '',
            extractStatus: sigMatch ? prev.extractStatus || '대기' : (files.length || answer ? '대기' : '없음'),
            checks: mig.checks || {},
            confirmed: sigMatch && !legacy && !mig.changed ? !!prev.confirmed : false,
            note: prev.note || '',
            reasonEdits: prev.reasonEdits || {},
            // 예전 "-2.5점 사항" 오버플로우 코멘트는 지운다
            comments: Object.fromEntries(Object.entries(prev.comments || {}).filter(([, v]) => !/2\.5점/.test(String(v)))),
            aiSuspect: sigMatch && prev.aiSuspect != null ? prev.aiSuspect : null,
            aiEvidence: sigMatch ? prev.aiEvidence || {} : {},
            gradedByAI: sigMatch ? !!prev.gradedByAI : false,
            gradedBy: sigMatch ? prev.gradedBy || 'Claude' : '',
            feedbackPosted: prev.feedbackPosted || null,
            // 선생님 수정은 같은 제출물일 때만 유지(재제출하면 새로 채점)
            teacherChecks: sigMatch ? prev.teacherChecks || {} : {},
            aiUndo: sigMatch ? prev.aiUndo || null : null,
            teacherSavedAt: sigMatch ? prev.teacherSavedAt || null : null,
            gradedByAIAt: sigMatch ? prev.gradedByAIAt || null : null,
          };
          s.flags = Grading.detectFlags(state.rubric, s.text);
          s.blank = Grading.isBlank(state.rubric, s.text);
          // 바뀐 항목(스택/큐 테스트 코드)은 이 학생만 새로 자동 판정, 예전 항목의 선생님 수정·근거는 정리
          for (const id of OLD_IDS) { delete s.teacherChecks[id]; delete s.reasonEdits[id]; delete s.comments[id]; }
          for (const id of (mig.recheck || []).concat(syncedIds)) {
            if (s.teacherChecks[id] != null) continue; // 선생님이 직접 정한 체크는 그대로
            const g = state.rubric.groups.find((x) => x.checks.some((c) => c.id === id));
            const c = g && g.checks.find((x) => x.id === id);
            if (c && s.text) {
              const v = s.blank ? false : Grading.explain(g, c, s.text, Grading.isSuspect(s)).met;
              if (syncedIds.includes(id) && !!s.checks[id] !== v) { if (s.confirmed) { s.confirmed = false; } s.syncTouched = true; }
              s.checks[id] = v;
            }
          }
          if (s.syncTouched) { syncChanged++; delete s.syncTouched; }
          // 미기입인데 저장된 체크가 남아 있으면(예전 버전에서 인쇄 문구에 키워드가 걸림) 확인 완료 전이면 최소점으로 다시 채점
          // 이전 판정으로 미기입(최소점) 처리됐는데 지금 보니 작성한 학생도 다시 채점
          const wasBlankScored = !s.confirmed && !s.blank && (prev.blank || (Object.keys(s.checks).length && Object.values(s.checks).every((v) => !v)));
          if ((regradeAll || (s.blank && !s.confirmed) || wasBlankScored) && s.text) applyAutoChecks(s);
          return s;
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'));

      state.loaded = true;
      state.selectedUserId = null;
      $('#pickerForm').classList.add('hidden');
      $('#pickerSummary').classList.remove('hidden');
      $('#gradeEmpty').classList.add('hidden');
      $('#workArea').classList.remove('hidden');
      renderRubricTab();
      renderAllGrading();
      $('#docViewer').innerHTML = $('#gradingPanel').innerHTML = '<p class="muted">왼쪽 목록에서 학생을 선택하세요.</p>';
      $('#docViewer').dataset.key = '';
      persist();
      if (syncChanged) toast('채점 기준 자동 판정을 9/29 방식으로 되돌려 ' + syncChanged + '명의 점수가 바뀌었습니다. 해당 학생은 확인 완료가 풀렸습니다.', 9000);
      if (halfChanged) toast('예외 처리 채점 항목이 바뀌어(스택/큐 테스트 코드로 나눔) ' + halfChanged + '명을 새로 채점했습니다 — 확인 완료를 풀었으니 다시 확인해 주세요.', 8000);
      if (legacy) toast('예전 형식의 채점 기준을 새 기준(5점 간격)으로 바꿨습니다. 확인 완료 표시는 다시 해 주세요.', 6000);

      const todo = state.students.filter((s) => s.status !== '미제출' && s.extractStatus !== '완료');
      setLoadStatus(state.students.length + '명 · 텍스트 추출 중 (0/' + todo.length + ')…');
      let done = 0;
      await runWithConcurrency(todo, 4, async (s) => {
        await processStudent(s);
        done++;
        setLoadStatus(state.students.length + '명 · 텍스트 추출 중 (' + done + '/' + todo.length + ')…');
      });
      setLoadStatus('완료 (' + new Date().toLocaleTimeString('ko-KR') + ')');
      persist();
    } catch (e) {
      toast('불러오기 실패: ' + e.message);
      setLoadStatus('오류: ' + e.message);
    } finally {
      $('#loadBtn').disabled = false;
    }
  }

  // 과제에 첨부한 원본 학습지(드라이브 파일)의 텍스트. 여러 개면 합친다.
  async function loadTemplateText() {
    try {
      const cw = await Api.getCourseWork(state.courseId, state.courseWorkId);
      const files = (cw.materials || [])
        .filter((m) => m.driveFile && m.driveFile.driveFile)
        .map((m) => ({ id: m.driveFile.driveFile.id, name: m.driveFile.driveFile.title }));
      if (!files.length) return '';
      for (const f of files) await ensureFileMeta(f);
      const { text } = await Extract.extractSubmission(files.filter((f) => f.mimeType), '');
      return text;
    } catch (e) {
      console.warn('원본 학습지를 불러오지 못함:', e);
      return '';
    }
  }

  async function ensureFileMeta(file) {
    if (file.mimeType) return;
    try {
      const meta = await Api.getFileMetaSafe(file.id);
      file.mimeType = meta.mimeType;
      file.name = meta.name || file.name;
      file.webViewLink = meta.webViewLink;
    } catch (e) {
      file.metaError = e.message;
    }
  }

  function applyAutoChecks(s) {
    if (s.status === '미제출') { s.checks = {}; return; }
    if (!s.confirmed) s.checks = Grading.suggestChecks(state.rubric, s.text, Grading.isSuspect(s));
    enforceCheckAiSuspect(s);
    applyTeacherChecks(s);
  }

  // 선생님이 직접 켜고 끈 체크는 따로 저장해 두고, 자동 재채점·Claude 채점 뒤에도 다시 덮어쓴다.
  function applyTeacherChecks(s) {
    if (!s.teacherChecks) return;
    s.checks = s.checks || {};
    for (const [id, v] of Object.entries(s.teacherChecks)) s.checks[id] = !!v;
  }
  const teacherEditCount = (s) => Object.keys(s.teacherChecks || {}).length
    + Object.keys(s.reasonEdits || {}).length + Object.keys(s.comments || {}).length;

  // 항목별로 "AI 의심"이라고 표시해 둔 체크는 자동 채점이 다시 켜지 못하게 0점으로 고정한다.
  function enforceCheckAiSuspect(s) {
    if (!s.checkAiSuspect) return;
    for (const id of Object.keys(s.checkAiSuspect)) {
      if (s.checkAiSuspect[id]) { s.checks = s.checks || {}; s.checks[id] = false; }
    }
  }

  async function processStudent(s) {
    for (const f of s.files) await ensureFileMeta(f);
    const filesOk = s.files.filter((f) => f.mimeType);
    try {
      const { text, status } = await Extract.extractSubmission(filesOk, s.answer);
      s.text = text;
      s.extractStatus = status;
    } catch (e) {
      s.extractStatus = '오류';
      s.text = '[추출 오류] ' + e.message;
    }
    s.studentNo = parseStudentNo(s.text);
    s.flags = Grading.detectFlags(state.rubric, s.text);
    s.blank = Grading.isBlank(state.rubric, s.text);
    applyAutoChecks(s);
    renderStudentList();
    if (state.selectedUserId === s.userId) { renderDocViewer(s); renderGradingPanel(s); }
  }

  // Claude가 제출물을 직접 읽고 체크리스트를 판단한다(키워드/정규식보다 정확).
  const AI = {
    claude: { name: 'Claude', icon: '🤖', api: () => Claude, keyMsg: '먼저 ⚙ 설정에서 Claude API 키를 입력해 주세요.', concurrency: 3 },
    gemini: { name: 'Gemini', icon: '✨', api: () => Gemini, keyMsg: '먼저 ⚙ 설정에서 Gemini API 키를 입력해 주세요.', concurrency: 2 },
  };
  async function gradeStudentWithClaude(s) { return gradeStudentWithAI(s, 'claude'); }
  // AI 채점 되돌리기: 채점 직전의 체크·근거·표시로 복원
  function undoAiGrade(s) {
    if (!s.aiUndo) return false;
    const u = s.aiUndo;
    s.checks = u.checks; s.aiEvidence = u.aiEvidence; s.flags = u.flags;
    s.gradedByAI = u.gradedByAI; s.gradedBy = u.gradedBy; s.gradedByAIAt = u.gradedByAIAt;
    s.aiUndo = null;
    return true;
  }
  async function gradeStudentWithAI(s, provider) {
    const ai = AI[provider];
    if (!s.text) throw new Error('추출된 텍스트가 없습니다. "다시 추출"을 먼저 눌러 주세요.');
    const result = await ai.api().gradeSubmission(state.rubric, s.text);
    // 되돌리기용: AI가 바꾸기 직전 상태를 보관
    s.aiUndo = clone({ checks: s.checks || {}, aiEvidence: s.aiEvidence || {}, flags: s.flags || [], gradedByAI: !!s.gradedByAI, gradedBy: s.gradedBy || '', gradedByAIAt: s.gradedByAIAt || null });
    s.checks = s.checks || {};
    s.aiEvidence = {};
    for (const g of state.rubric.groups) {
      for (const c of g.checks) {
        const r = result.checks && result.checks[c.id];
        if (!r) continue;
        s.checks[c.id] = !!r.met;
        s.aiEvidence[c.id] = String(r.reason || '');
      }
    }
    if (s.aiSuspect == null) {
      s.flags = result.aiSuspect ? [String(result.aiSuspectReason || ai.name + '가 AI 작성 의심 신호를 감지함')] : [];
    }
    enforceCheckAiSuspect(s);
    applyTeacherChecks(s);
    s.gradedByAI = true;
    s.gradedBy = ai.name;
    s.gradedByAIAt = Date.now();
  }

  // 기준이 바뀌었을 때: 확인 완료되지 않은 학생 전원을 새 기준으로 다시 자동 채점.
  function regradeUnconfirmed() {
    let n = 0, kept = 0;
    for (const s of state.students) {
      s.flags = Grading.detectFlags(state.rubric, s.text);
      s.blank = Grading.isBlank(state.rubric, s.text);
      if (s.confirmed) { kept++; continue; }
      applyAutoChecks(s);
      n++;
    }
    return { n, kept };
  }

  // 업로드·보관함 등으로 기준을 통째로 바꾸고 바로 적용한다.
  function applyRubric(r) {
    state.rubric = Grading.normalize(clone(r));
    let msg;
    if (state.loaded) {
      const { n, kept } = regradeUnconfirmed();
      msg = '채점 기준 적용 완료 — ' + n + '명 자동 재채점' + (kept ? ' (확인 완료된 ' + kept + '명은 점수 유지, 다시 확인 필요)' : '');
    } else {
      state.rubricTouched = true;
      msg = '채점 기준 적용 완료 — 제출물을 불러오면 이 기준으로 채점합니다';
    }
    persist();
    renderRubricTab();
    renderAllGrading();
    return msg;
  }

  // 편집기에서 조금씩 고칠 때(재채점은 버튼으로)
  function onRubricEdited(rerenderEditor) {
    if (!state.loaded) state.rubricTouched = true;
    persist();
    if (rerenderEditor) renderRubricEditor();
    renderRubricSummary();
    renderRefDocs();
    renderAllGrading();
  }

  // ---------------- 설정(채점 기준) 화면 ----------------
  function renderRubricTab() {
    renderRefDocs();
    renderLibrary();
    renderRubricEditor();
    renderRubricSummary();
    renderRubricBadge();
    $('#geminiKeyInput').value = Gemini.getKey() ? '••••••••(저장됨)' : '';
    $('#claudeKeyInput').value = Claude.getKey() ? '••••••••(저장됨)' : '';
    if (!$('#claudeModelSelect').options.length) {
      $('#claudeModelSelect').innerHTML = Claude.MODELS.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
    }
    $('#claudeModelSelect').value = Claude.getModel();
  }

  function renderRubricSummary() {
    const r = state.rubric;
    const bad = Grading.offStep(r);
    const src = r.source ? `<span class="muted"> · ${esc(r.source.fileName)}에서 ${r.source.via === 'ai' ? 'AI로 읽음' : '불러옴'}</span>` : '';
    $('#rubricSummary').innerHTML = `
      제출자 점수 범위 <b>${Grading.rubricMin(r)} ~ ${Grading.rubricMax(r)}점</b>
      (평가 영역 ${r.groups.length}개 · 체크 항목 ${r.groups.reduce((s, g) => s + g.checks.length, 0)}개)${src}
      ${bad.length ? `<div class="warn-line">⚠ 배점 간격(${r.step}점)에 맞지 않음: ${bad.map(esc).join(', ')}</div>` : ''}`;
    $('#rubricGroups').querySelectorAll('.rubric-group').forEach((el) => {
      const g = r.groups[Number(el.dataset.gi)];
      if (g) el.querySelector('.group-max').textContent = '기본 ' + g.base + ' + 체크 → 최고 ' + Grading.groupMax(g) + '점';
    });
  }

  function renderLibrary() {
    const sel = $('#librarySelect');
    const presets = Grading.presets();
    const lib = Store.libraryList();
    sel.innerHTML =
      `<optgroup label="기본 제공">${presets.map((p) => `<option value="preset:${esc(p.key)}">${esc(p.name)}</option>`).join('')}
        <option value="blank">빈 기준에서 시작</option></optgroup>` +
      (lib.length ? `<optgroup label="내 보관함">${lib.map((x, i) => `<option value="lib:${i}">${esc(x.name)}</option>`).join('')}</optgroup>` : '');
  }

  function libraryPick() {
    const v = $('#librarySelect').value;
    if (v === 'blank') return { rubric: Grading.blankRubric() };
    if (v.startsWith('preset:')) return Grading.presets().find((p) => 'preset:' + p.key === v);
    if (v.startsWith('lib:')) return Store.libraryList()[Number(v.slice(4))];
    return null;
  }

  const AUTO_OPTS = Object.entries(Grading.AUTO_TYPES);

  function renderRubricEditor() {
    const r = state.rubric;
    $('#rubricName').value = r.name;
    $('#rubricStep').value = r.step;
    $('#rubricBase').value = r.baseScore || 0;
    $('#rubricBase').step = r.step;
    const offStep = (v) => Math.abs(v / r.step - Math.round(v / r.step)) > 1e-9;

    $('#rubricGroups').innerHTML = r.groups
      .map(
        (g, gi) => `
      <div class="rubric-group" data-gi="${gi}">
        <div class="rubric-group-head">
          <input type="text" data-gfield="name" value="${esc(g.name)}" placeholder="평가 영역 이름">
          <label class="inline">기본 점수 <input type="number" min="0" step="${r.step}" data-gfield="base" value="${g.base}" class="${offStep(g.base) ? 'bad' : ''}"></label>
          <span class="group-max"></span>
          <button class="btn ghost small" data-delgroup>영역 삭제</button>
        </div>
        <div class="requires-row">
          <span>필수 조건(선택)</span>
          <input type="text" data-gfield="reqPattern" value="${esc((g.requires && g.requires.pattern) || '')}" placeholder="정규식 — 제출물에 없으면 이 영역 체크를 모두 해제 (예: \\bclass\\s+\\w+)">
          <input type="text" data-gfield="reqMessage" value="${esc((g.requires && g.requires.message) || '')}" placeholder="없을 때 표시할 근거">
        </div>
        <label class="aiblock-opt"><input type="checkbox" data-gfield="aiBlock" ${g.aiBlock ? 'checked' : ''}> AI 작성 의심 학생은 이 영역 체크를 모두 해제(기본 점수만)</label>
        <div class="check-row check-row-head"><span>체크 항목</span><span>배점</span><span>자동 감지</span><span>키워드 / 정규식</span><span>미충족 시 근거</span><span></span></div>
        ${g.checks
          .map(
            (c, ci) => `
          <div class="check-row" data-ci="${ci}">
            <input type="text" data-cfield="label" value="${esc(c.label)}" placeholder="체크 항목 설명">
            <input type="number" min="0" step="${r.step}" data-cfield="points" value="${c.points}" class="${offStep(c.points) ? 'bad' : ''}" title="배점">
            <select data-cfield="autoType">${AUTO_OPTS.map(([k, v]) => `<option value="${k}" ${c.auto.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
            <input type="text" data-cfield="pattern" value="${esc(c.auto.pattern)}" placeholder="${c.auto.type === 'none' ? '(교사가 직접 판단)' : '쉼표로 구분'}" ${c.auto.type === 'none' ? 'disabled' : ''}>
            <input type="text" data-cfield="reason" value="${esc(c.reason)}" placeholder="예: ~가 확인되지 않음">
            <button class="del" data-delcheck title="이 체크 항목 삭제">✕</button>
          </div>`
          )
          .join('')}
        <div class="rubric-group-foot"><button class="btn ghost small" data-addcheck>+ 체크 항목 추가</button></div>
      </div>`
      )
      .join('');

    $('#rubricGroups').querySelectorAll('.rubric-group').forEach((groupEl) => {
      const gi = Number(groupEl.dataset.gi);
      const g = () => state.rubric.groups[gi];
      groupEl.querySelectorAll('[data-gfield]').forEach((input) => {
        input.addEventListener('change', () => {
          const f = input.dataset.gfield;
          if (f === 'aiBlock') g().aiBlock = input.checked;
          else if (f === 'name') g().name = input.value;
          else if (f === 'base') g().base = Grading.snap(input.value, state.rubric.step);
          else {
            const req = g().requires || { pattern: '', message: '' };
            if (f === 'reqPattern') req.pattern = input.value.trim();
            else req.message = input.value;
            g().requires = req.pattern ? req : null;
          }
          onRubricEdited(f === 'base');
        });
      });
      groupEl.querySelector('[data-delgroup]').addEventListener('click', () => {
        if (!confirm('"' + g().name + '" 영역을 삭제할까요?')) return;
        state.rubric.groups.splice(gi, 1);
        onRubricEdited(true);
      });
      groupEl.querySelector('[data-addcheck]').addEventListener('click', () => {
        g().checks.push({ id: 'c_' + Date.now().toString(36), label: '새 체크 항목', points: state.rubric.step, auto: { type: 'none', pattern: '' }, reason: '' });
        onRubricEdited(true);
      });
      groupEl.querySelectorAll('.check-row[data-ci]').forEach((row) => {
        const ci = Number(row.dataset.ci);
        row.querySelectorAll('[data-cfield]').forEach((input) => {
          input.addEventListener('change', () => {
            const c = g().checks[ci];
            const field = input.dataset.cfield;
            if (field === 'points') c.points = Grading.snap(input.value, state.rubric.step);
            else if (field === 'label') c.label = input.value;
            else if (field === 'autoType') c.auto.type = input.value;
            else if (field === 'pattern') c.auto.pattern = input.value;
            else if (field === 'reason') c.reason = input.value;
            onRubricEdited(field === 'points' || field === 'autoType');
          });
        });
        row.querySelector('[data-delcheck]').addEventListener('click', () => {
          g().checks.splice(ci, 1);
          onRubricEdited(true);
        });
      });
    });

    // 주의 신호
    $('#flagRows').innerHTML = (r.flags || [])
      .map(
        (f, fi) => `
      <div class="flag-row" data-fi="${fi}">
        <select data-ffield="type">
          <option value="missing" ${f.type === 'missing' ? 'selected' : ''}>없으면 경고</option>
          <option value="match" ${f.type === 'match' ? 'selected' : ''}>있으면 경고</option>
        </select>
        <input type="text" data-ffield="pattern" value="${esc(f.pattern)}" placeholder="정규식">
        <input type="text" data-ffield="message" value="${esc(f.message)}" placeholder="경고 문구">
        <button class="del" data-delflag title="삭제">✕</button>
      </div>`
      )
      .join('') || '<p class="muted" style="margin:4px 0">없음</p>';
    $('#flagRows').querySelectorAll('.flag-row').forEach((row) => {
      const f = state.rubric.flags[Number(row.dataset.fi)];
      row.querySelectorAll('[data-ffield]').forEach((input) => {
        input.addEventListener('change', () => { f[input.dataset.ffield] = input.value; onRubricEdited(false); });
      });
      row.querySelector('[data-delflag]').addEventListener('click', () => {
        state.rubric.flags.splice(Number(row.dataset.fi), 1);
        onRubricEdited(true);
      });
    });
    renderRubricSummary();
  }

  $('#rubricName').addEventListener('change', (e) => { state.rubric.name = e.target.value || '채점 기준'; onRubricEdited(false); });
  $('#rubricStep').addEventListener('change', (e) => {
    // 간격을 바꾸면 모든 배점을 새 간격의 배수로 맞춘다
    state.rubric.step = Math.max(1, Math.round(Number(e.target.value)) || 5);
    state.rubric = Grading.normalize(state.rubric);
    onRubricEdited(true);
  });
  $('#rubricBase').addEventListener('change', (e) => { state.rubric.baseScore = Grading.snap(e.target.value, state.rubric.step); onRubricEdited(true); });
  $('#addRubricGroupBtn').addEventListener('click', () => {
    state.rubric.groups.push({ id: 'g_' + Date.now().toString(36), name: '새 평가 영역', base: 0, requires: null, checks: [] });
    onRubricEdited(true);
  });
  $('#addFlagBtn').addEventListener('click', () => {
    state.rubric.flags.push({ type: 'match', pattern: '', message: '' });
    renderRubricEditor();
  });

  function regradeClick() {
    if (!state.loaded) { toast('먼저 과제의 제출물을 불러오세요.'); return; }
    const { n, kept } = regradeUnconfirmed();
    persist();
    renderAllGrading();
    toast(n + '명 재채점 완료' + (kept ? ' (확인 완료된 ' + kept + '명은 유지)' : ''));
  }
  $('#regradeBtn').addEventListener('click', regradeClick);
  $('#regradeBtn2').addEventListener('click', regradeClick);
  // targets 학생들을 Claude로 일괄 채점한다. btn이 있으면 진행 상황을 그 버튼 글자에 표시하고,
  // 끝나면 idleLabel로 되돌린다(선택 학생용 버튼은 매번 개수가 바뀌므로 호출부에서 직접 넘겨줌).
  function runClaudeGradeBulk(targets, btn, idleLabel) { return runAiGradeBulk('claude', targets, btn, idleLabel); }
  async function runAiGradeBulk(provider, targets, btn, idleLabel) {
    const ai = AI[provider];
    if (!ai.api().getKey()) { toast(ai.keyMsg, 5000); return; }
    const list = targets.filter((s) => s.status !== '미제출' && s.text);
    if (!list.length) { toast(ai.name + '로 채점할 학생이 없습니다(제출물이 없거나 비어 있음).'); return; }
    if (!confirm(list.length + '명을 ' + ai.name + '(' + ai.api().getModel() + ')로 채점합니다. API 사용량(요금 또는 무료 한도)이 차감됩니다. 계속할까요?')) return;
    if (btn) { btn.disabled = true; btn.textContent = ai.name + ' 채점 중 (0/' + list.length + ')…'; }
    let done = 0, failed = 0, lastError = '', stopped = false, waitNote = '';
    const working = new Set();
    const t0 = Date.now();
    // 진행 상황 막대: 시작하자마자 보이고, 지금 누구를 채점 중인지·몇 명 끝났는지·걸린 시간을 계속 갱신
    const show = () => {
      const pct = Math.round((done / list.length) * 100);
      $('#aiProgress').classList.remove('hidden');
      $('#aiProgressTitle').textContent = ai.icon + ' ' + ai.name + ' 채점 중 ' + done + ' / ' + list.length + '명 (' + pct + '%)';
      $('#aiProgressBar').style.width = Math.max(pct, 3) + '%';
      const sec = Math.round((Date.now() - t0) / 1000);
      $('#aiProgressText').textContent =
        (working.size ? '지금: ' + Array.from(working).join(', ') + ' · ' : '') + sec + '초 경과' +
        (failed ? ' · 실패 ' + failed + '명' : '') + (waitNote ? ' · ' + waitNote : '') + (stopped ? ' · 중지하는 중(진행 중인 학생까지만)' : '');
    };
    const ticker = setInterval(show, 1000);
    $('#aiProgressStop').textContent = '중지';
    $('#aiProgressStop').onclick = () => { stopped = true; show(); };
    if (provider === 'gemini') Gemini.setWaitListener((wait, status, model, nextModel) => {
      const why = status === 429 ? '요청 한도 초과' : status === 404 ? '모델 없음' : '구글 서버 과부하(' + status + ')';
      waitNote = nextModel ? model + ' ' + why + ' → ' + nextModel + ' 모델로 바꿔 시도' : model + ' ' + why + ' — ' + wait + '초 뒤 다시 시도';
      show();
    });
    const gradedNow = [];
    $('#aiProgressUndo').classList.add('hidden');
    show();
    await runWithConcurrency(list, ai.concurrency, async (s) => {
      if (stopped) return;
      working.add(s.name); show();
      try { await gradeStudentWithAI(s, provider); gradedNow.push(s); waitNote = ''; } catch (e) { failed++; lastError = e.message; console.error(s.name, e); }
      working.delete(s.name);
      done++;
      if (btn) btn.textContent = ai.name + ' 채점 중 (' + done + '/' + list.length + ')…';
      show();
      renderStudentList();
      if (state.selectedUserId === s.userId) renderGradingPanel(s);
      persist();
    });
    clearInterval(ticker);
    if (provider === 'gemini') Gemini.setWaitListener(null);
    if (btn) { btn.disabled = false; btn.textContent = idleLabel; }
    persist();
    const summary = ai.name + ' 채점 ' + (stopped ? '중지' : '완료') + ': ' + (done - failed) + '명 성공' + (failed ? ', ' + failed + '명 실패 (' + lastError + ')' : '') + (stopped ? ', ' + (list.length - done) + '명 남음' : '');
    $('#aiProgressTitle').textContent = (failed ? '⚠ ' : '✅ ') + summary;
    $('#aiProgressText').textContent = Math.round((Date.now() - t0) / 1000) + '초 걸림' + (provider === 'gemini' && gradedNow.length ? ' · 사용한 모델: ' + Gemini.getLastModel() : '');
    if (gradedNow.length) {
      $('#aiProgressUndo').classList.remove('hidden');
      $('#aiProgressUndo').onclick = () => {
        if (!confirm('이번에 ' + ai.name + '가 채점한 ' + gradedNow.length + '명을 채점 전 상태로 되돌릴까요?')) return;
        let n = 0;
        for (const s of gradedNow) if (undoAiGrade(s)) n++;
        persist();
        renderAllGrading();
        $('#aiProgress').classList.add('hidden');
        toast(n + '명을 채점 전 상태로 되돌렸습니다');
      };
    }
    $('#aiProgressBar').style.width = '100%';
    $('#aiProgressStop').textContent = '닫기';
    $('#aiProgressStop').onclick = () => { $('#aiProgress').classList.add('hidden'); $('#aiProgressStop').textContent = '중지'; };
    toast(summary, 8000);
  }

  $('#geminiGradeAllBtn').addEventListener('click', () => {
    runAiGradeBulk('gemini', state.students.filter((s) => !s.confirmed), $('#geminiGradeAllBtn'), '✨ 전체 Gemini 채점');
  });
  $('#geminiGradeSelectedBtn').addEventListener('click', () => {
    const n = state.checkedIds.size;
    runAiGradeBulk('gemini', state.students.filter((s) => state.checkedIds.has(s.userId)), $('#geminiGradeSelectedBtn'), '✨ 선택 학생 Gemini 채점 (' + n + ')');
  });

  $('#claudeGradeAllBtn').addEventListener('click', () => {
    const targets = state.students.filter((s) => !s.confirmed);
    runClaudeGradeBulk(targets, $('#claudeGradeAllBtn'), '🤖 전체 Claude 채점');
  });

  function updateSelectionButtons() {
    const n = state.checkedIds.size;
    const gradeBtn = $('#claudeGradeSelectedBtn'), clearBtn = $('#clearSelectionBtn');
    gradeBtn.classList.toggle('hidden', n === 0);
    clearBtn.classList.toggle('hidden', n === 0);
    gradeBtn.textContent = '🤖 선택 학생 Claude 채점 (' + n + ')';
    $('#geminiGradeSelectedBtn').classList.toggle('hidden', n === 0);
    $('#geminiGradeSelectedBtn').textContent = '✨ 선택 학생 Gemini 채점 (' + n + ')';
    $('#commentSelectedBtn').classList.toggle('hidden', n === 0);
    $('#commentSelectedBtn').textContent = '💬 선택 학생 근거 댓글 (' + n + ')';
  }

  $('#commentSelectedBtn').addEventListener('click', () => {
    openCommentModal(state.students.filter((s) => state.checkedIds.has(s.userId)));
  });

  $('#claudeGradeSelectedBtn').addEventListener('click', () => {
    const n = state.checkedIds.size;
    const targets = state.students.filter((s) => state.checkedIds.has(s.userId));
    runClaudeGradeBulk(targets, $('#claudeGradeSelectedBtn'), '🤖 선택 학생 Claude 채점 (' + n + ')');
  });
  $('#clearSelectionBtn').addEventListener('click', () => {
    state.checkedIds.clear();
    updateSelectionButtons();
    renderStudentList();
  });

  $('#similarityBtn').addEventListener('click', () => {
    const panel = $('#similarityPanel');
    if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
    const result = Similarity.analyze(state.students.filter((s) => !state.hidden.has(s.userId)));
    renderSimilarityPanel(result);
    panel.classList.remove('hidden');
  });

  function renderSimilarityPanel(result) {
    const panel = $('#similarityPanel');
    if (!result.groups.length) {
      panel.innerHTML = `<div class="similarity-head"><b>👥 유사 제출물 확인</b><button class="btn ghost small" id="similarityCloseBtn">닫기</button></div>
        <p class="muted" style="margin:6px 0 0">겹치는 내용을 가진 제출물을 찾지 못했습니다 (비교 대상 ${result.comparedCount}명, 과제 공통 문구 ${result.commonLineCount}줄 제외하고 비교함).</p>`;
    } else {
      panel.innerHTML = `<div class="similarity-head"><b>👥 유사 제출물 확인</b><button class="btn ghost small" id="similarityCloseBtn">닫기</button></div>
        <p class="hint" style="margin:4px 0 10px">과제 안내문·표 양식처럼 여러 학생이 똑같이 갖고 있는 문구(${result.commonLineCount}줄)는 제외하고,
          학생이 직접 쓴 부분만 비교했습니다. 참고용이며 최종 판단은 선생님이 해 주세요.</p>
        ${result.groups
          .map(
            (g) => `
          <div class="similarity-group">
            <span class="sim-score">유사도 ${Math.round(g.score * 100)}%</span>
            ${g.members
              .map((m) => `<button class="link-btn sim-name" data-uid="${esc(m.userId)}">${esc(m.name)}</button>`)
              .join(' · ')}
          </div>`
          )
          .join('')}`;
    }
    panel.querySelector('#similarityCloseBtn').addEventListener('click', () => panel.classList.add('hidden'));
    panel.querySelectorAll('.sim-name').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedUserId = btn.dataset.uid;
        renderStudentList();
        const s = selectedStudent();
        renderDocViewer(s);
        renderGradingPanel(s);
      });
    });
  }

  // 보관함
  $('#libraryApplyBtn').addEventListener('click', () => {
    const item = libraryPick();
    if (!item) return;
    toast(applyRubric(item.rubric), 5000);
  });
  $('#librarySaveBtn').addEventListener('click', () => {
    const name = prompt('보관함에 저장할 이름', state.rubric.name);
    if (!name) return;
    if (Store.libraryList().some((x) => x.name === name) && !confirm('같은 이름이 있습니다. 덮어쓸까요?')) return;
    state.rubric.name = name;
    Store.librarySave(clone(state.rubric));
    onRubricEdited(false);
    renderLibrary();
    toast('보관함에 저장했습니다 — 다른 과목·과제에서도 불러와 쓸 수 있습니다');
  });
  $('#libraryDeleteBtn').addEventListener('click', () => {
    const v = $('#librarySelect').value;
    if (!v.startsWith('lib:')) { toast('기본 제공 기준은 삭제할 수 없습니다'); return; }
    const item = Store.libraryList()[Number(v.slice(4))];
    if (!item || !confirm('"' + item.name + '"을(를) 보관함에서 삭제할까요?')) return;
    Store.libraryDelete(item.name);
    renderLibrary();
  });
  $('#exportRubricXlsxBtn').addEventListener('click', () => RubricImport.exportXlsx(state.rubric));
  $('#exportRubricJsonBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.rubric, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '채점기준_' + state.rubric.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });

  // 업로드 → 자동 적용
  async function handleRubricFile(file) {
    const drop = $('#rubricDrop');
    const status = $('#importStatus');
    const notes = $('#importNotes');
    drop.classList.add('busy');
    notes.classList.add('hidden');
    status.textContent = '"' + file.name + '" 읽는 중… (표가 아닌 문서·이미지는 AI가 읽어서 10~40초 걸립니다)';
    try {
      const res = await RubricImport.importFile(file, { stepHint: state.rubric.step });
      const msg = applyRubric(res.rubric);
      status.textContent = '✅ ' + msg;
      const bad = Grading.offStep(state.rubric);
      const lines = [];
      if (res.via === 'ai') lines.push('AI가 읽어 체크리스트로 바꾼 기준입니다. 아래 항목·배점·키워드가 원래 채점기준표와 맞는지 한 번 확인해 주세요.');
      if (res.notes) lines.push('AI 메모: ' + res.notes);
      if (bad.length) lines.push('배점 간격(' + state.rubric.step + '점)에 맞지 않는 항목: ' + bad.join(', '));
      if (lines.length) { notes.innerHTML = lines.map(esc).join('<br>'); notes.classList.remove('hidden'); }
      toast(msg, 5000);
    } catch (e) {
      console.error(e);
      status.textContent = '❌ ' + e.message;
      if (/API 키/.test(e.message)) $('#geminiKeyInput').focus();
    } finally {
      drop.classList.remove('busy');
    }
  }
  $('#rubricFileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) handleRubricFile(f);
  });
  const drop = $('#rubricDrop');
  drop.addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT') $('#rubricFileInput').click(); });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) handleRubricFile(f);
  });
  // 캡처한 채점기준표 이미지를 바로 붙여넣기(Ctrl+V)
  document.addEventListener('paste', (e) => {
    if ($('#tabRubric').classList.contains('hidden')) return;
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    const item = Array.from(e.clipboardData.items).find((it) => it.kind === 'file');
    if (item) { const f = item.getAsFile(); if (f) handleRubricFile(new File([f], f.name || '붙여넣은_이미지.png', { type: f.type })); }
  });

  // Gemini 키
  $('#geminiKeyInput').addEventListener('focus', (e) => { if (e.target.value.startsWith('••')) e.target.value = ''; });
  $('#geminiKeySaveBtn').addEventListener('click', () => {
    const v = $('#geminiKeyInput').value.trim();
    if (v.startsWith('••')) return;
    Gemini.setKey(v);
    $('#geminiKeyInput').value = v ? '••••••••(저장됨)' : '';
    toast(v ? 'API 키를 이 브라우저에 저장했습니다' : 'API 키를 지웠습니다');
  });

  // Claude 키
  $('#claudeKeyInput').addEventListener('focus', (e) => { if (e.target.value.startsWith('••')) e.target.value = ''; });
  $('#claudeKeySaveBtn').addEventListener('click', () => {
    const v = $('#claudeKeyInput').value.trim();
    if (v.startsWith('••')) { Claude.setModel($('#claudeModelSelect').value); return; }
    Claude.setKey(v);
    Claude.setModel($('#claudeModelSelect').value);
    $('#claudeKeyInput').value = v ? '••••••••(저장됨)' : '';
    toast(v ? 'Claude API 키를 이 브라우저에 저장했습니다' : 'Claude API 키를 지웠습니다');
  });

  // ---------------- 학생 목록 ----------------
  function statusClass(status) {
    if (status === '미제출') return 'absent';
    if (status === '제출(지각)') return 'late';
    return '';
  }

  function fmtTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function renderStudentList() {
    const wrap = $('#studentList');
    const visible = state.students.filter((s) => !state.hidden.has(s.userId));
    const visibleIds = new Set(visible.map((s) => s.userId));
    for (const id of [...state.checkedIds]) if (!visibleIds.has(id)) state.checkedIds.delete(id);
    const restoreBar = state.hidden.size
      ? `<div class="hidden-bar">삭제한 학생 ${state.hidden.size}명 <button class="link-btn" id="restoreHiddenBtn">모두 되돌리기</button></div>`
      : '';
    const nSub = visible.filter((s) => s.status !== '미제출').length;
    const submittedIds = visible.filter((s) => s.status !== '미제출').map((s) => s.userId);
    const allChecked = submittedIds.length > 0 && submittedIds.every((id) => state.checkedIds.has(id));
    const scoreBar = `<div class="list-tools"><span class="list-count">제출 <b>${nSub}</b>명 · 미제출 <b>${visible.length - nSub}</b>명</span><button class="btn ghost small" id="selectAllBtn" title="제출한 학생을 모두 선택(선택 학생 채점·근거 댓글용)">${allChecked ? '전체 해제' : '전체 선택'}</button></div>`;
    updateScoreToggle();
    wrap.classList.toggle('hide-scores', !state.showScores);
    wrap.innerHTML = scoreBar + restoreBar + visible
      .map(
        (s) => `
        <div class="student-row ${statusClass(s.status)} ${state.selectedUserId === s.userId ? 'selected' : ''} ${s.status !== '미제출' && Grading.isSuspect(s) ? 'ai-row' : ''}" data-uid="${esc(s.userId)}">
          <input type="checkbox" class="row-check" data-check="${esc(s.userId)}" title="여러 학생 선택해서 한 번에 채점" ${state.checkedIds.has(s.userId) ? 'checked' : ''}>
          <span class="confirm-dot ${s.confirmed ? 'on' : ''}"></span>
          <span class="name">${esc(s.name)}${s.studentNo ? ` <span class="stuno">(${esc(s.studentNo)})</span>` : ''}${s.resubmitted ? ' 🔄' : ''}${s.status !== '미제출' && Grading.isSuspect(s) ? ' <span class="ai-badge">🤖 AI 의심</span>' : ''}</span>
          <span class="status ${statusClass(s.status)}">${esc(s.status)}</span>
          <span class="total">${Grading.total(state.rubric, s.checks, s.status)}${s.crGrade && Number(s.crGrade.value) !== Grading.total(state.rubric, s.checks, s.status) ? `<span class="cr-diff" title="클래스룸 점수 ${esc(s.crGrade.value)}점과 다름">≠${esc(s.crGrade.value)}</span>` : ''}</span>
          <button class="row-del" data-del="${esc(s.userId)}" title="목록에서 삭제(제출물을 다시 불러오면 복구 가능)">✕</button>
        </div>`
      )
      .join('');
    // 가운데 이름 옆 점수도 함께 갱신(점수가 바뀌는 곳은 모두 목록을 다시 그림)
    const sel = selectedStudent();
    const dvScore = document.getElementById('dvScore');
    if (sel && dvScore) dvScore.textContent = Grading.total(state.rubric, sel.checks, sel.status) + '점';
    wrap.querySelectorAll('.student-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-del]') || e.target.closest('[data-check]')) return;
        // 같은 학생을 빠르게 세 번 클릭하면 확인 완료 ↔ 해제 (클릭할 때마다 목록을 다시 그리므로 직접 센다)
        const now = Date.now();
        const tc = state.tripleClick || {};
        const count = tc.uid === row.dataset.uid && now - tc.at < 500 ? tc.count + 1 : 1;
        state.tripleClick = { uid: row.dataset.uid, at: now, count };
        state.selectedUserId = row.dataset.uid;
        if (count === 3) {
          state.tripleClick = null;
          const st = selectedStudent();
          if (st && st.status !== '미제출') {
            st.confirmed = !st.confirmed;
            persist();
            toast(st.name + (st.confirmed ? ' — 확인 완료' : ' — 확인 완료 해제'));
          }
        }
        renderStudentList();
        const s = selectedStudent();
        renderDocViewer(s);
        renderGradingPanel(s);
      });
    });
    wrap.querySelector('#selectAllBtn').addEventListener('click', () => {
      if (allChecked) submittedIds.forEach((id) => state.checkedIds.delete(id));
      else submittedIds.forEach((id) => state.checkedIds.add(id));
      renderStudentList();
      updateSelectionButtons();
    });
    wrap.querySelectorAll('[data-check]').forEach((cb) => {
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        const uid = cb.dataset.check;
        if (cb.checked) state.checkedIds.add(uid); else state.checkedIds.delete(uid);
        updateSelectionButtons();
        const sa = wrap.querySelector('#selectAllBtn');
        if (sa) sa.textContent = submittedIds.length > 0 && submittedIds.every((id) => state.checkedIds.has(id)) ? '전체 해제' : '전체 선택';
      });
    });
    wrap.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const uid = btn.dataset.del;
        const s = state.students.find((x) => x.userId === uid);
        if (!confirm((s ? s.name : '이 학생') + '을(를) 목록에서 삭제할까요?\n(채점 데이터는 남아 있고, "제출물 불러오기"를 다시 누르면 목록에 되돌아옵니다)')) return;
        state.hidden.add(uid);
        if (state.selectedUserId === uid) {
          state.selectedUserId = null;
          renderDocViewer(null);
          renderGradingPanel(null);
        }
        persist();
        renderStudentList();
      });
    });
    const restoreBtn = wrap.querySelector('#restoreHiddenBtn');
    if (restoreBtn) restoreBtn.addEventListener('click', () => {
      state.hidden.clear();
      persist();
      renderStudentList();
    });
  }

  // ---------------- 가운데: 제출한 파일 그대로 보기 ----------------
  // 구글 드라이브의 미리보기 화면을 그대로 띄운다(pdf, docx, pptx, hwp, 이미지, 코드 등).
  function previewUrl(f) {
    const id = encodeURIComponent(f.id);
    const m = f.mimeType || '';
    if (m === 'application/vnd.google-apps.document') return 'https://docs.google.com/document/d/' + id + '/preview';
    if (m === 'application/vnd.google-apps.presentation') return 'https://docs.google.com/presentation/d/' + id + '/preview';
    if (m === 'application/vnd.google-apps.spreadsheet') return 'https://docs.google.com/spreadsheets/d/' + id + '/preview';
    return 'https://drive.google.com/file/d/' + id + '/preview';
  }

  function renderDocViewer(s) {
    const el = $('#docViewer');
    if (!s) { el.innerHTML = '<p class="muted">왼쪽 목록에서 학생을 선택하세요.</p>'; el.dataset.key = ''; return; }
    const absentDoc = s.status === '미제출';

    const idx = Math.min(state.viewIdx[s.userId] || 0, Math.max(0, s.files.length - 1));
    const f = s.files[idx];
    const key = s.userId + ':' + (f ? f.id + ':' + (f.mimeType || '') : '-');

    const head = `
      <div class="detail-head">
        <span class="step-btns">
          <button class="btn ghost small" data-step="-1" title="이전 학생">◀ 이전</button>
          <button class="btn ghost small" data-step="1" title="다음 학생">다음 ▶</button>
        </span>
        <h3>${esc(s.name)}${s.studentNo ? ` <span class="stuno">(${esc(s.studentNo)})</span>` : ''}</h3>
        <span class="head-score" id="dvScore">${Grading.total(state.rubric, s.checks, s.status)}점</span>
        ${s.crGrade ? `<span class="cr-grade" title="구글 클래스룸에 입력된 점수(${s.crGrade.kind})">클래스룸 ${esc(s.crGrade.value)}점${s.crGrade.kind === '임시' ? '(임시)' : ''}</span>` : ''}
        <span class="status ${statusClass(s.status)}">${esc(s.status)}</span>
        ${s.submittedAt ? `<span class="muted">제출: ${esc(fmtTime(s.submittedAt))}</span>` : ''}
        ${s.resubmitted ? '<span class="muted">🔄 재제출됨</span>' : ''}
      </div>
      ${Grading.isSuspect(s) ? `<div class="flag-banner">🤖 AI 작성 의심${s.aiSuspect === true ? ' (선생님이 지정)' : ''}${s.flags && s.flags.length ? '<br>· ' + s.flags.map(esc).join('<br>· ') : ''}</div>`
        : (!absentDoc && Grading.isBlank(state.rubric, s.text) ? '<div class="blank-banner">📝 미기입 — 작성해야 할 영역이 비어 있는 것으로 보입니다. ' + (Grading.hasTemplate() ? '(과제 원본 학습지와 비교해 새로 쓴 내용이 거의 없음)' : '(원본 학습지를 못 찾아 코드·표 칸이 모두 비었는지로 판단)') + '</div>' : '')}
      <div class="file-tabs">
        ${s.files
          .map(
            (x, i) => `
          <span class="file-chip ${i === idx ? 'active' : ''}">
            <button class="file-name" data-view="${i}" title="가운데에서 보기">📎 ${esc(x.name)}</button>
            <a href="${esc(x.webViewLink || x.url || previewUrl(x))}" target="_blank" rel="noopener">새 창에서 열기</a>
            <button data-dl="${esc(x.id)}">다운로드</button>
          </span>`
          )
          .join('')}
        ${s.links.map((u) => `<span class="file-chip">🔗 <a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a></span>`).join('')}
        ${!s.files.length && !s.links.length && !s.answer ? '<span class="muted">제출 파일 없음</span>' : ''}
      </div>
      ${s.answer ? `<div class="answer-box"><b>단답형 답변</b><br>${esc(s.answer)}</div>` : ''}`;

    const extra = `
      <details class="extract-details">
        <summary>자동 채점에 쓴 추출 텍스트 (추출 상태: ${esc(s.extractStatus || '')})</summary>
        <button class="btn ghost small" data-reextract>다시 추출·채점</button>
        <div class="doc-body">${esc(s.text) || '(추출된 내용 없음)'}</div>
      </details>`;

    if (el.dataset.key === key) {
      // 같은 파일을 보고 있으면 iframe은 그대로 두고(다시 로딩 방지) 나머지만 갱신
      const open = el.querySelector('.extract-details') && el.querySelector('.extract-details').open;
      el.querySelector('#dvHead').innerHTML = head;
      el.querySelector('#dvExtra').innerHTML = extra;
      if (open) el.querySelector('.extract-details').open = true;
    } else {
      el.dataset.key = key;
      let frame = '';
      if (f && f.mimeType) {
        frame = `<iframe class="doc-frame" src="${esc(previewUrl(f))}" allow="autoplay" title="${esc(f.name)}"></iframe>
          <p class="muted frame-hint">미리보기가 보이지 않으면 위의 <b>새 창에서 열기</b>를 누르세요. (브라우저에 학교 구글 계정이 로그인되어 있어야 합니다)</p>`;
      } else if (f && f.metaError) {
        frame = `<p class="muted">파일 정보를 불러오지 못했습니다: ${esc(f.metaError)}</p>`;
      } else if (f) {
        frame = '<p class="muted">파일 불러오는 중…</p>';
        ensureFileMeta(f).then(() => { if (state.selectedUserId === s.userId) renderDocViewer(s); });
      }
      el.innerHTML = `<div id="dvHead"></div><div id="dvFrame">${frame}</div><div id="dvExtra"></div>`;
      el.querySelector('#dvHead').innerHTML = head;
      el.querySelector('#dvExtra').innerHTML = extra;
    }

    el.querySelectorAll('[data-step]').forEach((btn) => {
      btn.addEventListener('click', () => stepStudent(Number(btn.dataset.step)));
    });
    el.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => { state.viewIdx[s.userId] = Number(btn.dataset.view); renderDocViewer(s); });
    });
    el.querySelectorAll('[data-dl]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const file = s.files.find((x) => x.id === btn.dataset.dl);
        await ensureFileMeta(file);
        try { await Api.downloadToDisk(file); } catch (e) { toast('다운로드 실패: ' + e.message); }
      });
    });
    const reBtn = el.querySelector('[data-reextract]');
    if (reBtn) reBtn.addEventListener('click', async () => {
      toast('다시 추출 중…');
      await processStudent(s);
      persist();
      toast('추출·자동 채점 완료');
    });
  }

  // ---------------- 오른쪽: 채점 체크리스트 ----------------
  function renderGradingPanel(s) {
    const el = $('#gradingPanel');
    if (!s) { el.innerHTML = '<p class="muted">왼쪽 목록에서 학생을 선택하세요.</p>'; return; }

    s.checks = s.checks || {};
    s.reasonEdits = s.reasonEdits || {};
    s.aiEvidence = s.aiEvidence || {};
    const absent = s.status === '미제출';
    const suspect = Grading.isSuspect(s);
    const groupsHtml = state.rubric.groups
      .map((g) => {
        const blocked = Grading.groupBlocked(g, s.text);
        const aiBlocked = suspect && g.aiBlock;
        const checksHtml = g.checks
          .map((c) => {
            const on = !!s.checks[c.id];
            const aiEv = s.aiEvidence[c.id];
            const itemSuspect = !!(s.checkAiSuspect && s.checkAiSuspect[c.id]);
            let sub = '';
            if (itemSuspect) {
              sub = '<div class="evidence ai-mark-note">🤖 이 항목은 AI 의심으로 표시됨 — 0점 처리(직접 체크로 되돌릴 수 있음)</div>';
            } else if (on) {
              const reason = aiEv != null ? aiEv : (Grading.explain(g, c, s.text, suspect).met ? Grading.explain(g, c, s.text, suspect).reason : '선생님이 직접 체크');
              sub = `<div class="evidence">✓ ${aiEv != null ? (s.gradedBy === 'Gemini' ? '✨ ' : '🤖 ') : ''}${esc(reason)}</div>`;
              // 5점 단위라 점수는 줬지만 부족했던 부분(예전 -2.5점 사항 등)은 코멘트로 — 고칠 수 있음
              const cm = Grading.commentFor(g, c, s);
              if (cm) sub += `
                <div class="reason-box comment-box">
                  <div class="reason-head">💬 코멘트 ${s.comments && s.comments[c.id] != null ? '<button class="link-btn" data-resetcomment="' + esc(c.id) + '">자동 코멘트로 되돌리기</button>' : ''}</div>
                  <textarea data-comment="${esc(c.id)}" rows="2">${esc(cm)}</textarea>
                </div>`;
            } else if (!absent) {
              const edited = s.reasonEdits[c.id] != null;
              const defaultReason = edited ? Grading.reasonFor(g, c, s) : aiEv != null ? aiEv : Grading.reasonFor(g, c, s);
              sub = `
                <div class="reason-box">
                  <div class="reason-head">미충족 근거 ${aiEv != null && !edited ? '<span class="edited">' + (s.gradedBy === 'Gemini' ? '✨ Gemini' : '🤖 Claude') + '</span>' : ''}${edited ? '<span class="edited">수정함</span><button class="link-btn" data-resetreason="' + esc(c.id) + '">자동 근거로 되돌리기</button>' : ''}</div>
                  <textarea data-reason="${esc(c.id)}" rows="2" placeholder="감점 근거를 입력하세요">${esc(defaultReason)}</textarea>
                </div>`;
            }
            return `
          <div class="check-item ${on ? 'on' : 'unmet'} ${itemSuspect ? 'ai-suspect' : ''}">
            <label class="check-line">
              <input type="checkbox" data-check="${esc(c.id)}" ${on ? 'checked' : ''} ${absent ? 'disabled' : ''}>
              <span class="c-label">${esc(c.label)}</span>
              <span class="c-points">+${c.points}</span>
              ${s.teacherChecks && c.id in s.teacherChecks ? `<button class="teacher-mark" data-resetteacher="${esc(c.id)}" title="선생님이 직접 바꾼 체크 — 누르면 자동 판정으로 되돌림">✏️</button>` : ''}
              ${!absent ? `<button class="ai-mark" data-aimark="${esc(c.id)}" title="이 항목만 AI 의심으로 표시(0점 처리)">${itemSuspect ? '🤖✓' : '🤖'}</button>` : ''}
            </label>
            ${sub}
          </div>`;
          })
          .join('');
        return `
        <div class="grade-group">
          <div class="grade-group-head"><span>${esc(g.name)}</span><span class="g-score">${absent ? 0 : Grading.groupScore(g, s.checks)} / ${Grading.groupMax(g)}점</span></div>
          ${g.base ? `<div class="base-note">기본 ${g.base}점 포함</div>` : ''}
          ${aiBlocked ? '<p class="flag-note">🤖 AI 작성 의심 — 자동 채점에서 이 영역은 모두 미체크(기본 점수만). 의심을 해제하면 다시 채점됩니다.</p>' : ''}
          ${!aiBlocked && blocked ? `<p class="flag-note">⚠ 필수 조건 미충족으로 자동 채점에서 모두 미체크 — ${esc(g.requires.message || '')}. 필요하면 직접 체크하세요.</p>` : ''}
          ${checksHtml || '<p class="muted" style="font-size:12px">체크 항목이 없습니다. ⚙ 설정에서 추가하세요.</p>'}
        </div>`;
      })
      .join('');

    el.innerHTML = `
      <div class="grading-head">
        <h3 style="margin:0">${esc(s.name)} 채점</h3>
        ${!absent ? `<span class="ai-grade-btns"><button class="btn ghost small" id="geminiGradeBtn">✨ Gemini로 채점</button><button class="btn ghost small" id="claudeGradeBtn">🤖 Claude로 채점</button></span>` : ''}
      </div>
      ${!absent ? `<div class="teacher-bar">
        <button class="btn primary small" id="teacherSaveBtn">💾 교사 수정 저장</button>
        <button class="btn ghost small" id="sampleBtn" title="이 학생 제출물을 100점 샘플로 지정해, ⚙ 설정에서 규칙이 맞는지 확인합니다">⭐ 100점 샘플로 지정</button>
        <button class="btn ghost small" id="commentOneBtn" title="이 학생 제출 파일에 감점 근거를 댓글로 남깁니다(보내기 전에 미리보기)">💬 근거 댓글${s.feedbackPosted ? ' ✓' : ''}</button>
        <span class="muted">${s.teacherSavedAt ? '저장 ' + esc(new Date(s.teacherSavedAt).toLocaleString('ko-KR')) + ' · ' : ''}선생님이 바꾼 체크는 자동 재채점·Claude 채점을 해도 유지됩니다</span>
      </div>` : ''}
      ${s.gradedByAI ? `<div class="ai-graded-note">${s.gradedBy === 'Gemini' ? '✨ Gemini' : '🤖 Claude'}가 채점함 (${esc(new Date(s.gradedByAIAt).toLocaleString('ko-KR'))}) — 체크와 근거를 확인하고 필요하면 고치세요.${s.aiUndo ? ' <button class="link-btn" id="aiUndoBtn">↩ 채점 전으로 되돌리기</button>' : ''}</div>` : ''}
      ${absent ? '<p class="muted">미제출 — 0점</p>' : `
      <div class="ai-box ${suspect ? 'on' : ''}">
        <label class="check-line"><input type="checkbox" id="aiSuspectChk" ${suspect ? 'checked' : ''}>
          <span class="c-label"><b>🤖 AI 작성 의심</b></span>
          <span class="c-points">${s.aiSuspect == null ? '자동 판정' : '선생님이 지정'}</span></label>
        ${s.flags && s.flags.length ? `<div class="ai-signals">자동 감지 신호: ${s.flags.map(esc).join(' / ')}</div>` : `<div class="ai-signals">자동 감지 신호 없음${!suspect && Grading.isBlank(state.rubric, s.text) ? ' — 📝 미기입으로 보임(작성 영역이 비어 있어 AI 의심 판정에서 제외)' : ''}</div>`}
        ${s.aiSuspect != null ? '<button class="link-btn" id="aiAutoBtn">자동 판정으로 되돌리기</button>' : ''}
      </div>`}
      ${groupsHtml}
      <div class="total-line">
        합계 <span id="totalScore">${Grading.total(state.rubric, s.checks, s.status)}</span>점
        <label class="confirm"><input type="checkbox" id="confirmChk" ${s.confirmed ? 'checked' : ''}> 확인 완료</label>
      </div>
      <textarea class="notes" id="notesInput" placeholder="비고">${esc(s.note || '')}</textarea>
    `;

    el.querySelectorAll('[data-check]').forEach((cb) => {
      cb.addEventListener('change', () => {
        s.checks[cb.dataset.check] = cb.checked;
        s.teacherChecks = s.teacherChecks || {};
        s.teacherChecks[cb.dataset.check] = cb.checked;
        renderGradingPanel(s);
        renderStudentList();
        persist();
        if (!cb.checked) {
          const ta = $('#gradingPanel').querySelector('textarea[data-reason="' + cb.dataset.check + '"]');
          if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
        }
      });
    });
    el.querySelectorAll('[data-resetteacher]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const id = btn.dataset.resetteacher;
        delete s.teacherChecks[id];
        // 자동 판정(또는 Claude 판정) 값으로 되돌림
        const g = state.rubric.groups.find((x) => x.checks.some((c) => c.id === id));
        const c = g && g.checks.find((x) => x.id === id);
        if (c) s.checks[id] = Grading.isBlank(state.rubric, s.text) ? false : Grading.explain(g, c, s.text, Grading.isSuspect(s)).met;
        enforceCheckAiSuspect(s);
        renderGradingPanel(s);
        renderStudentList();
        persist();
      });
    });
    const sBtn = el.querySelector('#sampleBtn');
    if (sBtn) sBtn.addEventListener('click', () => {
      if (!s.text) { toast('추출된 텍스트가 없습니다'); return; }
      setRefDoc('full', { name: s.name + ' 제출물', text: s.text, at: Date.now(), from: 'student' });
      toast(s.name + ' 제출물을 100점 샘플로 지정했습니다 — ⚙ 설정에서 항목별 확인 결과를 보세요', 5000);
    });
    const cOne = el.querySelector('#commentOneBtn');
    if (cOne) cOne.addEventListener('click', () => openCommentModal([s]));
    const tSave = el.querySelector('#teacherSaveBtn');
    if (tSave) tSave.addEventListener('click', () => {
      s.teacherSavedAt = Date.now();
      persist();
      renderGradingPanel(s);
      renderStudentList();
      toast(s.name + ' — 선생님 수정 내용을 저장했습니다');
    });
    el.querySelectorAll('[data-aimark]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const id = btn.dataset.aimark;
        s.checkAiSuspect = s.checkAiSuspect || {};
        const next = !s.checkAiSuspect[id];
        if (next) s.checkAiSuspect[id] = true; else delete s.checkAiSuspect[id];
        if (next) { s.checks = s.checks || {}; s.checks[id] = false; }
        renderGradingPanel(s);
        renderStudentList();
        persist();
      });
    });
    el.querySelectorAll('[data-comment]').forEach((ta) => {
      ta.addEventListener('input', () => {
        s.comments = s.comments || {};
        s.comments[ta.dataset.comment] = ta.value;
        persist();
      });
    });
    el.querySelectorAll('[data-resetcomment]').forEach((btn) => {
      btn.addEventListener('click', () => {
        delete s.comments[btn.dataset.resetcomment];
        renderGradingPanel(s);
        persist();
      });
    });
    el.querySelectorAll('[data-reason]').forEach((ta) => {
      ta.addEventListener('input', () => {
        s.reasonEdits[ta.dataset.reason] = ta.value;
        persist();
      });
      ta.addEventListener('change', () => renderGradingPanel(s)); // "수정함" 표시 갱신
    });
    el.querySelectorAll('[data-resetreason]').forEach((btn) => {
      btn.addEventListener('click', () => {
        delete s.reasonEdits[btn.dataset.resetreason];
        renderGradingPanel(s);
        persist();
      });
    });
    // AI 의심 체크/해제 → AI 의심 시 0점 처리하는 영역(aiBlock)만 다시 자동 채점
    const setSuspect = (v) => {
      s.aiSuspect = v;
      s.checks = Grading.suggestChecks(state.rubric, s.text, Grading.isSuspect(s), s.checks, true);
      enforceCheckAiSuspect(s);
      renderGradingPanel(s);
      renderDocViewer(s);
      renderStudentList();
      persist();
    };
    const aiChk = el.querySelector('#aiSuspectChk');
    if (aiChk) aiChk.addEventListener('change', () => setSuspect(aiChk.checked));
    const aiAuto = el.querySelector('#aiAutoBtn');
    if (aiAuto) aiAuto.addEventListener('click', () => setSuspect(null));
    el.querySelector('#confirmChk').addEventListener('change', (e) => {
      s.confirmed = e.target.checked;
      renderStudentList();
      persist();
    });
    el.querySelector('#notesInput').addEventListener('input', (e) => {
      s.note = e.target.value;
      persist();
    });
    const undoBtn = el.querySelector('#aiUndoBtn');
    if (undoBtn) undoBtn.addEventListener('click', () => {
      if (undoAiGrade(s)) { persist(); renderStudentList(); renderGradingPanel(s); toast(s.name + ' — AI 채점 전 상태로 되돌렸습니다'); }
    });
    const ggBtn = el.querySelector('#geminiGradeBtn');
    if (ggBtn) ggBtn.addEventListener('click', async () => {
      if (!Gemini.getKey()) { toast(AI.gemini.keyMsg, 5000); return; }
      ggBtn.disabled = true;
      const t0 = Date.now();
      const tick = () => { ggBtn.textContent = 'Gemini가 읽는 중… ' + Math.round((Date.now() - t0) / 1000) + '초'; };
      tick();
      const timer = setInterval(tick, 1000);
      toast('Gemini가 제출물을 읽고 있습니다. 보통 10~60초 걸립니다.', 5000);
      try {
        await gradeStudentWithAI(s, 'gemini');
        persist();
        renderStudentList();
        renderGradingPanel(s);
        clearInterval(timer);
        toast('Gemini 채점 완료');
      } catch (e) {
        clearInterval(timer);
        toast('Gemini 채점 실패: ' + e.message, 8000);
        ggBtn.disabled = false;
        ggBtn.textContent = '✨ Gemini로 채점';
      }
    });
    const cgBtn = el.querySelector('#claudeGradeBtn');
    if (cgBtn) cgBtn.addEventListener('click', async () => {
      cgBtn.disabled = true;
      const t0 = Date.now();
      const tick = () => { cgBtn.textContent = 'Claude가 읽는 중… ' + Math.round((Date.now() - t0) / 1000) + '초'; };
      tick();
      const timer = setInterval(tick, 1000);
      toast('Claude가 제출물을 읽고 있습니다. 보통 10~60초 걸립니다.', 5000);
      try {
        await gradeStudentWithClaude(s);
        persist();
        renderStudentList();
        renderGradingPanel(s);
        clearInterval(timer);
        toast('Claude 채점 완료');
      } catch (e) {
        clearInterval(timer);
        toast('Claude 채점 실패: ' + e.message, 8000);
        cgBtn.disabled = false;
        cgBtn.textContent = '🤖 Claude로 채점';
      }
    });
  }

  // ---------------- 기준 검증용 문서(빈 양식 · 100점 샘플) ----------------
  // 빈 양식: 원본에 인쇄된 줄은 "학생이 쓴 내용"에서 빼는 기준(클래스룸 첨부 학습지보다 우선).
  // 100점 샘플: 각 항목 규칙을 미리 돌려 봐서, 빈 양식에서 충족되거나 샘플에서 미충족인 항목을 빨갛게 알려 준다.
  const REF_LABEL = { blank: '빈 양식', full: '100점 샘플' };

  function refDocs() { return state.rubric.refDocs || {}; }

  // 과제를 불러올 때와 빈 양식을 바꿀 때: 쓸 원본 텍스트를 정한다(올린 빈 양식 > 클래스룸 첨부 학습지)
  function applyTemplate() {
    const up = refDocs().blank;
    if (up && up.text) { Grading.setTemplate(up.text); state.templateSource = 'upload'; }
    else { Grading.setTemplate(state.classroomTemplate || ''); state.templateSource = state.classroomTemplate ? 'classroom' : ''; }
  }

  function setRefDoc(kind, doc) {
    state.rubric.refDocs = Object.assign({}, refDocs());
    if (doc) state.rubric.refDocs[kind] = doc; else delete state.rubric.refDocs[kind];
    if (kind === 'blank') {
      applyTemplate();
      if (state.loaded) {
        // 원본이 바뀌면 "학생이 쓴 내용" 판단이 달라지므로 미기입·자동 채점을 다시(확인 완료 학생 제외)
        for (const s of state.students) s.blank = Grading.isBlank(state.rubric, s.text);
        regradeUnconfirmed();
      }
    }
    persist();
    renderRefDocs();
    renderAllGrading();
  }

  async function handleRefFile(kind, file) {
    const st = $('#ref' + (kind === 'blank' ? 'Blank' : 'Full') + 'Status');
    st.textContent = '"' + file.name + '" 읽는 중…';
    try {
      const text = await Extract.extractLocal(file);
      setRefDoc(kind, { name: file.name, text, at: Date.now(), from: 'upload' });
      toast(REF_LABEL[kind] + '을(를) 등록했습니다');
    } catch (e) {
      st.textContent = '❌ ' + e.message;
    }
  }

  function renderRefDocs() {
    const docs = refDocs();
    const fmt = (d) => d ? `<b>${esc(d.name)}</b> <span class="muted">(${d.from === 'student' ? '학생 제출물에서 지정' : '업로드'} · ${esc(new Date(d.at).toLocaleString('ko-KR'))})</span>` : '';
    $('#refBlankStatus').innerHTML = docs.blank ? fmt(docs.blank)
      : state.templateSource === 'classroom' ? '<span class="muted">올린 파일 없음 — 과제에 첨부된 학습지를 빈 양식으로 사용 중</span>'
      : '<span class="muted">없음</span>';
    $('#refFullStatus').innerHTML = docs.full ? fmt(docs.full) : '<span class="muted">없음 — 파일을 올리거나, 채점 화면에서 100점 학생을 골라 "⭐ 100점 샘플로 지정"</span>';
    $('#refBlankClear').classList.toggle('hidden', !docs.blank);
    $('#refFullClear').classList.toggle('hidden', !docs.full);

    const blankText = docs.blank ? docs.blank.text : state.classroomTemplate || '';
    const fullText = docs.full ? docs.full.text : '';
    const out = $('#refResult');
    if (!blankText && !fullText) { out.innerHTML = ''; return; }
    const v = Grading.validate(state.rubric, blankText, fullText);
    const bad = v.rows.filter((x) => x.blankBad || x.fullBad).length;
    out.innerHTML = `
      <div class="ref-summary ${bad ? 'bad' : 'ok'}">
        ${bad ? `⚠ 규칙을 고쳐야 할 항목 ${bad}개` : '✅ 모든 항목이 빈 양식에서는 미충족, 100점 샘플에서는 충족'}
        ${blankText ? ` · 빈 양식 점수 <b>${v.blankTotal}</b>점(기대 ${Grading.rubricMin(state.rubric)}점)` : ''}
        ${fullText ? ` · 100점 샘플 점수 <b>${v.fullTotal}</b>점(기대 ${Grading.rubricMax(state.rubric)}점)` : ''}
      </div>
      <table class="ref-table">
        <thead><tr><th>채점 항목</th>${blankText ? '<th>빈 양식</th>' : ''}${fullText ? '<th>100점 샘플</th>' : ''}</tr></thead>
        <tbody>${v.rows.map((x) => `
          <tr>
            <td>${esc(x.label)} <span class="muted">+${x.points}</span></td>
            ${blankText ? `<td class="${x.blankBad ? 'bad' : ''}" title="${esc(x.blankReason)}">${x.blankMet ? '✓ 충족 — 인쇄 문구에 걸림' : '✗'}</td>` : ''}
            ${fullText ? `<td class="${x.fullBad ? 'bad' : ''}" title="${esc(x.fullReason)}">${x.fullMet ? '✓' : '✗ 미충족 — ' + esc(x.fullReason)}</td>` : ''}
          </tr>`).join('')}</tbody>
      </table>
      <p class="hint">빨간 칸은 그 항목의 자동 감지 규칙(키워드·정규식 등)이 이 과제 양식과 맞지 않는다는 뜻입니다. 위 "현재 채점 기준"에서 규칙을 고치거나 "직접 확인"으로 바꿔 주세요. 칸에 마우스를 올리면 판정 근거가 보입니다.</p>`;
  }

  for (const kind of ['blank', 'full']) {
    const K = kind === 'blank' ? 'Blank' : 'Full';
    const input = $('#ref' + K + 'Input');
    $('#ref' + K + 'Btn').addEventListener('click', () => input.click());
    input.addEventListener('change', () => { const f = input.files[0]; input.value = ''; if (f) handleRefFile(kind, f); });
    $('#ref' + K + 'Clear').addEventListener('click', () => {
      if (confirm(REF_LABEL[kind] + '을(를) 지울까요?')) setRefDoc(kind, null);
    });
    const box = $('#ref' + K + 'Box');
    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('over'); });
    box.addEventListener('dragleave', () => box.classList.remove('over'));
    box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) handleRefFile(kind, f); });
  }

  // ---------------- 감점 근거 댓글(학생 제출 파일에 드라이브 댓글) ----------------
  // 체크되지 않은 항목의 근거(선생님이 고친 근거 우선)와, 점수는 줬지만 부족했던 부분(코멘트)을 모은다.
  function buildFeedback(s) {
    const r = state.rubric;
    const lines = ['[수행평가 채점 근거]'];
    if (s.blank) {
      lines.push('- 작성해야 할 영역이 비어 있어 최소점으로 처리했습니다.');
      return lines.join('\n');
    }
    const minus = [], notes = [];
    for (const g of r.groups) for (const c of g.checks) {
      if (!s.checks[c.id]) {
        const aiEv = s.aiEvidence && s.aiEvidence[c.id];
        // 학생이 읽을 글이라 자동 감지의 기술적 설명(키워드 목록 등) 대신 기준의 "미충족 시 근거" 문장을 쓴다.
        // 선생님이 고친 근거 > Claude 근거 > 기준 문장 > 자동 근거 순.
        const reason = s.reasonEdits && s.reasonEdits[c.id] != null ? s.reasonEdits[c.id]
          : aiEv != null ? aiEv : c.reason || Grading.reasonFor(g, c, s);
        minus.push('- ' + c.label + ' (-' + c.points + '점): ' + reason);
      } else {
        const cm = Grading.commentFor(g, c, s);
        if (cm) notes.push('- ' + c.label + ': ' + cm);
      }
    }
    if (minus.length) lines.push('감점 항목', ...minus);
    else lines.push('모든 채점 항목을 충족했습니다.');
    if (notes.length) lines.push('', '참고', ...notes);
    return lines.join('\n');
  }

  let commentTargets = [];
  function openCommentModal(students) {
    commentTargets = students.map((s) => {
      const f = s.files[Math.min(state.viewIdx[s.userId] || 0, Math.max(0, s.files.length - 1))];
      const skip = s.status === '미제출' ? '미제출' : !f ? '제출 파일이 없음(댓글을 달 파일이 없음)' : '';
      return { s, file: f, text: skip ? '' : buildFeedback(s), skip };
    });
    $('#commentItems').innerHTML = commentTargets
      .map((t, i) => `
        <div class="comment-item">
          <div class="comment-item-head"><b>${esc(t.s.name)}</b>
            ${t.file ? `<span class="muted">→ 📎 ${esc(t.file.name)}</span>` : ''}
            ${t.s.feedbackPosted ? `<span class="warn-inline">이미 보냄(${esc(new Date(t.s.feedbackPosted.at).toLocaleString('ko-KR'))}) — 다시 보내면 댓글이 하나 더 달립니다</span>` : ''}
          </div>
          ${t.skip ? `<p class="muted" style="margin:4px 0">건너뜀: ${esc(t.skip)}</p>` : `<textarea data-ci="${i}" rows="${Math.min(12, t.text.split('\n').length + 1)}">${esc(t.text)}</textarea>`}
        </div>`)
      .join('');
    $('#commentItems').querySelectorAll('textarea[data-ci]').forEach((ta) => {
      ta.addEventListener('input', () => { commentTargets[Number(ta.dataset.ci)].text = ta.value; });
    });
    const n = commentTargets.filter((t) => !t.skip).length;
    $('#commentSendBtn').textContent = n + '명에게 보내기';
    $('#commentSendBtn').disabled = n === 0;
    $('#commentStatus').textContent = '';
    $('#commentModal').classList.remove('hidden');
  }

  $('#commentCancelBtn').addEventListener('click', () => $('#commentModal').classList.add('hidden'));
  $('#commentSendBtn').addEventListener('click', async () => {
    const todo = commentTargets.filter((t) => !t.skip && t.text.trim());
    if (!todo.length) return;
    const btn = $('#commentSendBtn');
    btn.disabled = true;
    $('#commentStatus').textContent = '드라이브 댓글 권한 확인 중… (처음 한 번은 구글 동의 창이 뜹니다)';
    const ok = await Auth.ensureScope(CONFIG.COMMENT_SCOPE);
    if (!ok) {
      $('#commentStatus').textContent = '❌ 댓글 쓰기 권한을 받지 못했습니다(동의 창에서 허용해야 합니다. 학교 관리자가 막았을 수도 있습니다).';
      btn.disabled = false;
      return;
    }
    let done = 0;
    const failed = [];
    for (const t of todo) {
      $('#commentStatus').textContent = '보내는 중… (' + done + '/' + todo.length + ')';
      try {
        const res = await Api.addComment(t.file.id, t.text.trim());
        t.s.feedbackPosted = { at: Date.now(), fileId: t.file.id, fileName: t.file.name, commentId: res.id };
        done++;
      } catch (e) {
        failed.push(t.s.name + ': ' + e.message);
      }
    }
    persist();
    renderStudentList();
    const sel = selectedStudent();
    if (sel) renderGradingPanel(sel);
    btn.disabled = false;
    if (failed.length) {
      $('#commentStatus').textContent = '✅ ' + done + '명 보냄, ❌ ' + failed.length + '명 실패 — ' + failed.join(' / ');
    } else {
      $('#commentModal').classList.add('hidden');
      toast(done + '명의 제출 파일에 감점 근거 댓글을 달았습니다');
    }
  });

  // ---------------- 이벤트 바인딩 ----------------
  $('#signInBtn').addEventListener('click', () => Auth.signIn());
  $('#signOutBtn').addEventListener('click', () => Auth.signOut());
  $('#courseSelect').addEventListener('change', (e) => onCourseChange(e.target.value));
  $('#loadBtn').addEventListener('click', loadSubmissions);
  $('#exportCsvBtn').addEventListener('click', () => Store.exportCsv(state.rubric, state.students, { courseWorkTitle: state.courseWorkTitle }));
  $('#exportJsonBtn').addEventListener('click', () => Store.exportJson(state.courseId, state.courseWorkId, { courseName: state.courseName, courseWorkTitle: state.courseWorkTitle }));
  $('#importJsonBtn').addEventListener('click', () => $('#importJsonInput').click());
  $('#importJsonInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const meta = await Store.importJsonFile(file);
      toast('가져오기 완료. 같은 수업·과제를 다시 "제출물 불러오기" 하면 반영됩니다.');
      if (state.courseId === meta.courseId && state.courseWorkId === meta.courseWorkId) {
        state.rubricTouched = false;
        await loadSubmissions();
      }
    } catch (err) {
      toast('가져오기 실패: ' + err.message);
    } finally {
      e.target.value = '';
    }
  });

  showTab('grade');
  updateScoreToggle();
  applyListCollapsed();
  renderRubricTab();

  window.addEventListener('load', () => {
    Auth.init(onAuthChange);
  });
})();
