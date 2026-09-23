// Classroom API / Drive API를 fetch로 직접 호출한다 (Apps Script 없이, 서버 없이).
const Api = (() => {
  async function authHeader() {
    const token = await Auth.ensureFreshToken();
    if (!token) throw new Error('로그인이 만료되었습니다. 다시 로그인해 주세요.');
    return { Authorization: 'Bearer ' + token };
  }

  async function getJson(url) {
    const res = await fetch(url, { headers: await authHeader() });
    if (!res.ok) {
      let msg = res.status + ' ' + res.statusText;
      try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
      throw new Error(msg);
    }
    return res.json();
  }

  async function listAll(baseUrl, itemsKey, extraParams) {
    let out = [], pageToken = null;
    do {
      const params = new URLSearchParams(Object.assign({ pageSize: '100' }, extraParams || {}));
      if (pageToken) params.set('pageToken', pageToken);
      const data = await getJson(baseUrl + '?' + params.toString());
      out = out.concat(data[itemsKey] || []);
      pageToken = data.nextPageToken || null;
    } while (pageToken);
    return out;
  }

  const CR = 'https://classroom.googleapis.com/v1';

  return {
    async listCourses() {
      const list = await listAll(CR + '/courses', 'courses', { teacherId: 'me', courseStates: 'ACTIVE' });
      return list.map((c) => ({ id: c.id, name: c.name + (c.section ? ' (' + c.section + ')' : '') }));
    },
    async listCourseWork(courseId) {
      const list = await listAll(CR + '/courses/' + courseId + '/courseWork', 'courseWork', {});
      return list
        .filter((w) => w.state !== 'DELETED')
        .map((w) => ({ id: w.id, title: w.title }))
        .reverse();
    },
    async listStudents(courseId) {
      return listAll(CR + '/courses/' + courseId + '/students', 'students', {});
    },
    async listSubmissions(courseId, courseWorkId) {
      return listAll(
        CR + '/courses/' + courseId + '/courseWork/' + courseWorkId + '/studentSubmissions',
        'studentSubmissions',
        {}
      );
    },

    async getFileMetaSafe(fileId) {
      const fields = 'id,name,mimeType,webViewLink,iconLink';
      return getJson('https://www.googleapis.com/drive/v3/files/' + fileId + '?fields=' + encodeURIComponent(fields));
    },
    // ---- Drive: 파일 내용 ----
    async downloadArrayBuffer(fileId) {
      const res = await fetch('https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media', {
        headers: await authHeader(),
      });
      if (!res.ok) throw new Error('다운로드 실패(' + res.status + ')');
      return res.arrayBuffer();
    },
    async downloadText(fileId) {
      const buf = await this.downloadArrayBuffer(fileId);
      return new TextDecoder('utf-8').decode(buf);
    },
    async exportGoogleFile(fileId, mimeType) {
      const url =
        'https://www.googleapis.com/drive/v3/files/' + fileId + '/export?mimeType=' + encodeURIComponent(mimeType);
      const res = await fetch(url, { headers: await authHeader() });
      if (!res.ok) {
        let msg = res.status + ' ' + res.statusText;
        try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
        throw new Error(msg);
      }
      return res.text();
    },
    // 브라우저로 파일을 그대로 내려받게 한다 (Google 문서류는 지정 형식으로 내보내기).
    async downloadToDisk(file) {
      const isGoogleNative = file.mimeType.startsWith('application/vnd.google-apps.');
      let blob, filename = file.name;
      if (isGoogleNative) {
        const exportMime = file.mimeType.includes('spreadsheet')
          ? 'text/csv'
          : file.mimeType.includes('presentation')
          ? 'application/pdf'
          : 'application/pdf';
        const url =
          'https://www.googleapis.com/drive/v3/files/' + file.id + '/export?mimeType=' + encodeURIComponent(exportMime);
        const res = await fetch(url, { headers: await authHeader() });
        if (!res.ok) throw new Error('내보내기 실패(' + res.status + ')');
        blob = await res.blob();
        filename += exportMime === 'text/csv' ? '.csv' : '.pdf';
      } else {
        const buf = await this.downloadArrayBuffer(file.id);
        blob = new Blob([buf]);
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    },
  };
})();
