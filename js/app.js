// 화면 전체를 조립하는 메인 스크립트. 서버 없이 브라우저에서 Classroom/Drive API를
// 직접 호출해 제출물을 불러오고, 텍스트를 뽑아 체크리스트 자동 채점 초안을 채운 뒤
// localStorage에 저장한다.
(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));

  const state = {
    courseId: null, courseWorkId: null, courseName: '', courseWorkTitle: '',
    rubric: Grading.defaultRubric(),
    rubricTouched: false, // 과제를 불러오기 전에 기준을 바꿨으면, 불러올 때 그 기준을 쓴다
    loaded: false,
    students: [],
    selectedUserId: null,
    viewIdx: {}, // 학생별로 가운데에 보고 있는 파일 번호
  };

  function toast(msg, ms) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), ms || 3000);
  }

  function setLoadStatus(msg) { $('#loadStatus').textContent = msg; }

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
        checks: s.checks, confirmed: s.confirmed, note: s.note, reasonEdits: s.reasonEdits, aiSuspect: s.aiSuspect,
      };
    }
    Store.save(state.courseId, state.courseWorkId, { rubric: state.rubric, students, updatedAt: Date.now() });
  }

  const selectedStudent = () => state.students.find((x) => x.userId === state.selectedUserId);

  function renderAllGrading() {
    renderStudentList();
    const s = selectedStudent();
    if (s) { renderDocViewer(s); renderGradingPanel(s); }
    renderRubricBadge();
  }

  // ---------------- 탭 ----------------
  function showTab(tab) {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('#tabGrade').classList.toggle('hidden', tab !== 'grade');
    $('#tabRubric').classList.toggle('hidden', tab !== 'rubric');
    try { localStorage.setItem('grader:tab', tab); } catch (e) {}
  }
  document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

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
      if (!loadCourses._done) { loadCourses._done = true; loadCourses(); }
    } else {
      loadCourses._done = false;
      $('#signInBtn').classList.remove('hidden');
      $('#signOutBtn').classList.add('hidden');
      $('#userInfo').classList.add('hidden');
      $('#app').classList.add('hidden');
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

      const cached = Store.load(state.courseId, state.courseWorkId);
      const cachedStudents = (cached && cached.students) || {};

      // 기준 고르기: 방금 직접 올리거나 고친 기준 > 이 과제에 저장된 기준 > 이 수업의 마지막 기준 > 기본 기준
      let regradeAll = false, legacy = false;
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

      const rosterIds = new Set(students.map((s) => s.userId));
      const extraSubs = subs.filter((sub) => !rosterIds.has(sub.userId));
      const roster = students
        .map((s) => ({ userId: s.userId, name: s.profile.name.fullName }))
        .concat(extraSubs.map((sub) => ({ userId: sub.userId, name: '(명단에 없음 ' + sub.userId + ')' })));

      state.students = roster
        .map(({ userId, name }) => {
          const sub = subByUserId[userId];
          const att = (sub && sub.assignmentSubmission && sub.assignmentSubmission.attachments) || [];
          const files = att.filter((a) => a.driveFile).map((a) => ({ id: a.driveFile.id, name: a.driveFile.title, url: a.driveFile.alternateLink }));
          const links = att.filter((a) => a.link).map((a) => a.link.url);
          const answer = (sub && sub.shortAnswerSubmission && sub.shortAnswerSubmission.answer) || '';
          const turned = sub && (sub.state === 'TURNED_IN' || sub.state === 'RETURNED');
          const status = files.length || answer || links.length ? (sub.late ? '제출(지각)' : '제출') : turned ? '제출(파일없음)' : '미제출';
          const sig = files.map((f) => f.id).join(',') + '|' + answer.length + '|' + links.join(',');
          const prev = cachedStudents[userId] || {};
          const sigMatch = prev.sig === sig;
          const s = {
            userId, name,
            status, files, links, answer, sig,
            resubmitted: !!prev.sig && !sigMatch,
            text: sigMatch ? prev.text || '' : '',
            extractStatus: sigMatch ? prev.extractStatus || '대기' : (files.length || answer ? '대기' : '없음'),
            checks: prev.checks || {},
            confirmed: sigMatch && !legacy ? !!prev.confirmed : false,
            note: prev.note || '',
            reasonEdits: prev.reasonEdits || {},
            aiSuspect: sigMatch && prev.aiSuspect != null ? prev.aiSuspect : null,
          };
          s.flags = Grading.detectFlags(state.rubric, s.text);
          if (regradeAll && s.text) applyAutoChecks(s);
          return s;
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'));

      state.loaded = true;
      state.selectedUserId = null;
      $('#gradeEmpty').classList.add('hidden');
      $('#workArea').classList.remove('hidden');
      renderRubricTab();
      renderAllGrading();
      $('#docViewer').innerHTML = $('#gradingPanel').innerHTML = '<p class="muted">왼쪽 목록에서 학생을 선택하세요.</p>';
      $('#docViewer').dataset.key = '';
      persist();
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
    s.flags = Grading.detectFlags(state.rubric, s.text);
    applyAutoChecks(s);
    renderStudentList();
    if (state.selectedUserId === s.userId) { renderDocViewer(s); renderGradingPanel(s); }
  }

  // 기준이 바뀌었을 때: 확인 완료되지 않은 학생 전원을 새 기준으로 다시 자동 채점.
  function regradeUnconfirmed() {
    let n = 0, kept = 0;
    for (const s of state.students) {
      s.flags = Grading.detectFlags(state.rubric, s.text);
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
    renderAllGrading();
  }

  // ---------------- 채점 기준 탭 ----------------
  function renderRubricTab() {
    renderLibrary();
    renderRubricEditor();
    renderRubricSummary();
    renderRubricBadge();
    $('#geminiKeyInput').value = Gemini.getKey() ? '••••••••(저장됨)' : '';
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
          else if (f === 'base') g().base = Number(input.value) || 0;
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
            if (field === 'points') c.points = Number(input.value) || 0;
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
  $('#rubricStep').addEventListener('change', (e) => { state.rubric.step = Math.max(0.5, Number(e.target.value) || 1); onRubricEdited(true); });
  $('#rubricBase').addEventListener('change', (e) => { state.rubric.baseScore = Number(e.target.value) || 0; onRubricEdited(false); });
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

  // ---------------- 학생 목록 ----------------
  function statusClass(status) {
    if (status === '미제출') return 'absent';
    if (status === '제출(지각)') return 'late';
    return '';
  }

  function renderStudentList() {
    const wrap = $('#studentList');
    wrap.innerHTML = state.students
      .map((s) => {
        const total = Grading.total(state.rubric, s.checks, s.status);
        return `
        <div class="student-row ${statusClass(s.status)} ${state.selectedUserId === s.userId ? 'selected' : ''}" data-uid="${esc(s.userId)}">
          <span class="confirm-dot ${s.confirmed ? 'on' : ''}"></span>
          <span class="name">${esc(s.name)}${s.resubmitted ? ' 🔄' : ''}${Grading.isSuspect(s) ? ' 🤖' : ''}</span>
          <span class="status ${statusClass(s.status)}">${esc(s.status)}</span>
          <span class="total">${total}</span>
        </div>`;
      })
      .join('');
    wrap.querySelectorAll('.student-row').forEach((row) => {
      row.addEventListener('click', () => {
        state.selectedUserId = row.dataset.uid;
        renderStudentList();
        const s = selectedStudent();
        renderDocViewer(s);
        renderGradingPanel(s);
      });
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

    const idx = Math.min(state.viewIdx[s.userId] || 0, Math.max(0, s.files.length - 1));
    const f = s.files[idx];
    const key = s.userId + ':' + (f ? f.id + ':' + (f.mimeType || '') : '-');

    const head = `
      <div class="detail-head">
        <h3>${esc(s.name)}</h3>
        <span class="status ${statusClass(s.status)}">${esc(s.status)}</span>
        ${s.resubmitted ? '<span class="muted">🔄 재제출됨</span>' : ''}
      </div>
      ${Grading.isSuspect(s) ? `<div class="flag-banner">🤖 AI 작성 의심${s.aiSuspect === true ? ' (선생님이 지정)' : ''}${s.flags && s.flags.length ? '<br>· ' + s.flags.map(esc).join('<br>· ') : ''}</div>` : ''}
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
    const absent = s.status === '미제출';
    const suspect = Grading.isSuspect(s);
    const groupsHtml = state.rubric.groups
      .map((g) => {
        const blocked = Grading.groupBlocked(g, s.text);
        const aiBlocked = suspect && g.aiBlock;
        const checksHtml = g.checks
          .map((c) => {
            const on = !!s.checks[c.id];
            let sub = '';
            if (on) {
              const ex = Grading.explain(g, c, s.text, suspect);
              sub = `<div class="evidence">✓ ${ex.met ? esc(ex.reason) : '선생님이 직접 체크'}</div>`;
            } else if (!absent) {
              const edited = s.reasonEdits[c.id] != null;
              sub = `
                <div class="reason-box">
                  <div class="reason-head">미충족 근거 ${edited ? '<span class="edited">수정함</span><button class="link-btn" data-resetreason="' + esc(c.id) + '">자동 근거로 되돌리기</button>' : ''}</div>
                  <textarea data-reason="${esc(c.id)}" rows="2">${esc(Grading.reasonFor(g, c, s))}</textarea>
                </div>`;
            }
            return `
          <div class="check-item ${on ? 'on' : 'unmet'}">
            <label class="check-line">
              <input type="checkbox" data-check="${esc(c.id)}" ${on ? 'checked' : ''} ${absent ? 'disabled' : ''}>
              <span class="c-label">${esc(c.label)}</span>
              <span class="c-points">+${c.points}</span>
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
          ${checksHtml || '<p class="muted" style="font-size:12px">체크 항목이 없습니다. "채점 기준" 탭에서 추가하세요.</p>'}
        </div>`;
      })
      .join('');

    el.innerHTML = `
      <h3 style="margin-top:0">${esc(s.name)} 채점</h3>
      ${absent ? '<p class="muted">미제출 — 0점</p>' : `
      <div class="ai-box ${suspect ? 'on' : ''}">
        <label class="check-line"><input type="checkbox" id="aiSuspectChk" ${suspect ? 'checked' : ''}>
          <span class="c-label"><b>🤖 AI 작성 의심</b></span>
          <span class="c-points">${s.aiSuspect == null ? '자동 판정' : '선생님이 지정'}</span></label>
        ${s.flags && s.flags.length ? `<div class="ai-signals">자동 감지 신호: ${s.flags.map(esc).join(' / ')}</div>` : '<div class="ai-signals">자동 감지 신호 없음</div>'}
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
        renderGradingPanel(s);
        renderStudentList();
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
  }

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

  let initialTab = 'grade';
  try { initialTab = localStorage.getItem('grader:tab') || 'grade'; } catch (e) {}
  showTab(initialTab);
  renderRubricTab();

  window.addEventListener('load', () => {
    Auth.init(onAuthChange);
  });
})();
