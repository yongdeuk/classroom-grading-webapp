// 화면 전체를 조립하는 메인 스크립트. 서버 없이 브라우저에서 Classroom/Drive API를
// 직접 호출해 제출물을 불러오고, 텍스트를 뽑아 체크리스트 자동 채점 초안을 채운 뒤
// localStorage에 저장한다.
(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const AUTO_LABEL = { none: '자동 감지 없음', keyword: '키워드', regex: '정규식' };

  const state = {
    courseId: null, courseWorkId: null, courseName: '', courseWorkTitle: '',
    rubric: clone(Grading.DEFAULT_RUBRIC),
    students: [],
    selectedUserId: null,
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
    const students = {};
    for (const s of state.students) {
      students[s.userId] = {
        sig: s.sig, text: s.text, extractStatus: s.extractStatus,
        checks: s.checks, confirmed: s.confirmed, note: s.note,
      };
    }
    Store.save(state.courseId, state.courseWorkId, { rubric: state.rubric, students, updatedAt: Date.now() });
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
      loadCourses();
    } else {
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
      await loadCourseWorks(sel.value);
    } catch (e) {
      sel.innerHTML = '<option>불러오기 실패</option>';
      toast('수업 목록을 불러오지 못했습니다: ' + e.message);
    }
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
      state.rubric = (cached && cached.rubric) || clone(Grading.DEFAULT_RUBRIC);

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
          return {
            userId, name,
            status, files, links, answer, sig,
            resubmitted: !!prev.sig && !sigMatch,
            text: sigMatch ? prev.text || '' : '',
            flags: sigMatch ? Grading.detectFlags(prev.text || '') : [],
            extractStatus: sigMatch ? prev.extractStatus || '대기' : (files.length || answer ? '대기' : '없음'),
            checks: prev.checks || {},
            confirmed: sigMatch ? !!prev.confirmed : false,
            note: prev.note || '',
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'));

      $('#rubricPanel').classList.remove('hidden');
      $('#workArea').classList.remove('hidden');
      renderRubricEditor();
      renderStudentList();
      persist();

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
    if (!s.confirmed) s.checks = Grading.suggestChecks(state.rubric, s.text);
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
    s.flags = Grading.detectFlags(s.text);
    applyAutoChecks(s);
    renderStudentList();
    if (state.selectedUserId === s.userId) { renderDocViewer(s); renderGradingPanel(s); }
  }

  // ---------------- 루브릭(체크리스트 기준) 편집 ----------------
  function renderRubricEditor() {
    const wrap = $('#rubricGroups');
    wrap.innerHTML = state.rubric
      .map(
        (item, gi) => `
      <div class="rubric-group" data-gi="${gi}">
        <div class="rubric-group-head">
          <input type="text" data-field="name" value="${esc(item.name)}" placeholder="평가 영역 이름">
          <span class="group-max">배점 합계 ${Grading.itemMax(item)}점</span>
          <button class="btn ghost small" data-delgroup="${gi}">영역 삭제</button>
        </div>
        ${(item.checks || [])
          .map(
            (c, ci) => `
          <div class="check-row" data-ci="${ci}">
            <input type="text" data-cfield="label" value="${esc(c.label)}" placeholder="체크 항목 설명">
            <input type="number" min="0" step="0.5" data-cfield="points" value="${c.points}" title="배점">
            <select data-cfield="autoType" title="자동 감지 방식">
              <option value="none" ${!c.auto || c.auto.type === 'none' ? 'selected' : ''}>자동감지 없음</option>
              <option value="keyword" ${c.auto && c.auto.type === 'keyword' ? 'selected' : ''}>키워드</option>
              <option value="regex" ${c.auto && c.auto.type === 'regex' ? 'selected' : ''}>정규식</option>
            </select>
            <input type="text" data-cfield="pattern" value="${esc((c.auto && c.auto.pattern) || '')}" placeholder="키워드(쉼표 구분) 또는 정규식">
            <button class="del" data-delcheck="${ci}" title="이 체크 항목 삭제">✕</button>
          </div>`
          )
          .join('')}
        <div class="rubric-group-foot">
          <button class="btn ghost small" data-addcheck="${gi}">+ 체크 항목 추가</button>
        </div>
      </div>`
      )
      .join('');

    wrap.querySelectorAll('.rubric-group').forEach((groupEl) => {
      const gi = Number(groupEl.dataset.gi);
      groupEl.querySelector('[data-field="name"]').addEventListener('change', (e) => {
        state.rubric[gi].name = e.target.value;
        persist();
      });
      groupEl.querySelector('[data-delgroup]').addEventListener('click', () => {
        state.rubric.splice(gi, 1);
        renderRubricEditor();
        persist();
      });
      groupEl.querySelector('[data-addcheck]').addEventListener('click', () => {
        state.rubric[gi].checks.push({ id: 'chk_' + Date.now(), label: '새 체크 항목', points: 5, auto: { type: 'none', pattern: '' } });
        renderRubricEditor();
        persist();
      });
      groupEl.querySelectorAll('.check-row').forEach((row) => {
        const ci = Number(row.dataset.ci);
        row.querySelectorAll('[data-cfield]').forEach((input) => {
          input.addEventListener('change', () => {
            const c = state.rubric[gi].checks[ci];
            const field = input.dataset.cfield;
            if (field === 'points') c.points = Number(input.value);
            else if (field === 'label') c.label = input.value;
            else if (field === 'autoType') { c.auto = c.auto || {}; c.auto.type = input.value; }
            else if (field === 'pattern') { c.auto = c.auto || { type: 'none' }; c.auto.pattern = input.value; }
            renderRubricEditor();
            persist();
          });
        });
        row.querySelector('[data-delcheck]').addEventListener('click', () => {
          state.rubric[gi].checks.splice(ci, 1);
          renderRubricEditor();
          persist();
        });
      });
    });
  }

  $('#addRubricGroupBtn').addEventListener('click', () => {
    state.rubric.push({ id: 'group_' + Date.now(), name: '새 평가 영역', checks: [] });
    renderRubricEditor();
    persist();
  });

  $('#regradeBtn').addEventListener('click', () => {
    let n = 0;
    for (const s of state.students) {
      if (s.confirmed) continue;
      applyAutoChecks(s);
      n++;
    }
    renderStudentList();
    const sel = state.students.find((x) => x.userId === state.selectedUserId);
    if (sel) renderGradingPanel(sel);
    persist();
    toast(n + '명 재채점 완료 (확인 완료된 학생은 유지)');
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
          <span class="name">${esc(s.name)}${s.resubmitted ? ' 🔄' : ''}${s.flags && s.flags.length ? ' ⚠️' : ''}</span>
          <span class="status ${statusClass(s.status)}">${esc(s.status)}</span>
          <span class="total">${total}</span>
        </div>`;
      })
      .join('');
    wrap.querySelectorAll('.student-row').forEach((row) => {
      row.addEventListener('click', () => {
        state.selectedUserId = row.dataset.uid;
        renderStudentList();
        const s = state.students.find((x) => x.userId === state.selectedUserId);
        renderDocViewer(s);
        renderGradingPanel(s);
      });
    });
  }

  // ---------------- 가운데: 제출한 과제 보기 ----------------
  function renderDocViewer(s) {
    const el = $('#docViewer');
    if (!s) { el.innerHTML = '<p class="muted">왼쪽 목록에서 학생을 선택하세요.</p>'; return; }

    const fileChips =
      s.files
        .map(
          (f) => `
        <span class="file-chip">📎 ${esc(f.name)}
          ${f.webViewLink ? `<a href="${esc(f.webViewLink)}" target="_blank" rel="noopener">새 창에서 열기</a>` : f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">새 창에서 열기</a>` : ''}
          <button data-dl="${esc(f.id)}">다운로드</button>
        </span>`
        )
        .join('') +
      s.links.map((u) => `<span class="file-chip">🔗 <a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a></span>`).join('');

    el.innerHTML = `
      <div class="detail-head">
        <h3>${esc(s.name)}</h3>
        <span class="status ${statusClass(s.status)}">${esc(s.status)}</span>
        ${s.resubmitted ? '<span class="muted">🔄 재제출됨</span>' : ''}
        <button class="btn ghost small" id="reextractBtn" style="margin-left:auto">다시 추출</button>
      </div>
      ${s.flags && s.flags.length ? `<div class="flag-banner">⚠️ ${s.flags.map(esc).join('<br>⚠️ ')}</div>` : ''}
      <div>${fileChips || '<span class="muted">제출 파일 없음</span>'}</div>
      <div class="doc-status">추출 상태: ${esc(s.extractStatus || '')}</div>
      <div class="doc-body">${esc(s.text) || '(추출된 내용 없음)'}</div>
    `;

    const reBtn = el.querySelector('#reextractBtn');
    if (reBtn) reBtn.addEventListener('click', async () => {
      toast('다시 추출 중…');
      await processStudent(s);
      persist();
      toast('추출 완료');
    });
    el.querySelectorAll('[data-dl]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const f = s.files.find((x) => x.id === btn.dataset.dl);
        await ensureFileMeta(f);
        try { await Api.downloadToDisk(f); } catch (e) { toast('다운로드 실패: ' + e.message); }
      });
    });
  }

  // ---------------- 오른쪽: 채점 체크리스트 ----------------
  function renderGradingPanel(s) {
    const el = $('#gradingPanel');
    if (!s) { el.innerHTML = '<p class="muted">왼쪽 목록에서 학생을 선택하세요.</p>'; return; }

    s.checks = s.checks || {};
    const hasClass = /\bclass\s+\w+/.test(s.text || '');
    const groupsHtml = state.rubric
      .map((item) => {
        const gScore = Grading.itemScore(item, s.checks);
        const blocked = item.requiresClass && !hasClass;
        const checksHtml = (item.checks || [])
          .map(
            (c) => `
          <label class="check-item">
            <input type="checkbox" data-check="${esc(c.id)}" ${s.checks[c.id] ? 'checked' : ''}>
            <span class="c-label">${esc(c.label)}</span>
            <span class="c-points">${c.points}점</span>
          </label>`
          )
          .join('');
        return `
        <div class="grade-group">
          <div class="grade-group-head"><span>${esc(item.name)}</span><span class="g-score">${gScore} / ${Grading.itemMax(item)}점</span></div>
          ${blocked ? '<p class="flag-note">⚠ class 없이 구현되어 자동으로 모두 미체크 처리됨 — AI 작성 의심. 필요하면 직접 체크하세요.</p>' : ''}
          ${checksHtml || '<p class="muted" style="font-size:12px">체크 항목이 없습니다. 위 채점 기준에서 추가하세요.</p>'}
        </div>`;
      })
      .join('');

    el.innerHTML = `
      <h3 style="margin-top:0">${esc(s.name)} 채점</h3>
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
  $('#courseSelect').addEventListener('change', (e) => loadCourseWorks(e.target.value));
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
        await loadSubmissions();
      }
    } catch (err) {
      toast('가져오기 실패: ' + err.message);
    } finally {
      e.target.value = '';
    }
  });

  window.addEventListener('load', () => {
    Auth.init(onAuthChange);
  });
})();
