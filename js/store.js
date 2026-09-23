// 채점 결과를 브라우저(localStorage)에 저장한다. 서버가 없으므로 이 브라우저·이 계정에만
// 남는다는 점에 주의 — 정기적으로 "JSON 내보내기"로 백업하기를 권장한다.
const Store = (() => {
  function key(courseId, courseWorkId) {
    return 'grader:v1:' + courseId + ':' + courseWorkId;
  }

  function load(courseId, courseWorkId) {
    try {
      const raw = localStorage.getItem(key(courseId, courseWorkId));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function save(courseId, courseWorkId, data) {
    try {
      localStorage.setItem(key(courseId, courseWorkId), JSON.stringify(data));
      return true;
    } catch (e) {
      console.warn('저장 실패(용량 초과 가능성):', e);
      return false;
    }
  }

  function exportJson(courseId, courseWorkId, meta) {
    const data = load(courseId, courseWorkId) || {};
    const payload = Object.assign({ meta: Object.assign({ courseId, courseWorkId }, meta) }, data);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '채점_백업_' + (meta && meta.courseWorkTitle ? meta.courseWorkTitle : 'data') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function exportCsv(rubric, students, meta) {
    const header = ['이름', '상태'].concat(rubric.map((r) => r.name), ['합계', '확인', '비고']);
    const rows = [header];
    for (const s of students) {
      const row = [s.name, s.status];
      for (const r of rubric) row.push(Grading.itemScore(r, s.checks || {}));
      row.push(Grading.total(rubric, s.checks || {}, s.status));
      row.push(s.confirmed ? 'Y' : '');
      row.push(s.note || '');
      rows.push(row);
    }
    const csv = rows
      .map((row) => row.map((v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(','))
      .join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '채점표_' + (meta && meta.courseWorkTitle ? meta.courseWorkTitle : 'data') + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function importJsonFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const payload = JSON.parse(reader.result);
          const meta = payload.meta || {};
          if (!meta.courseId || !meta.courseWorkId) {
            reject(new Error('백업 파일에 courseId/courseWorkId 정보가 없습니다.'));
            return;
          }
          const data = Object.assign({}, payload);
          delete data.meta;
          save(meta.courseId, meta.courseWorkId, data);
          resolve(meta);
        } catch (e) {
          reject(e);
        }
      };
      reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
      reader.readAsText(file);
    });
  }

  return { load, save, exportJson, exportCsv, importJsonFile };
})();
