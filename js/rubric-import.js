// 채점 기준 파일 업로드 → 루브릭으로 변환.
//  - .json: 이 앱에서 내보낸 형식 그대로 불러옴
//  - .xlsx/.xls/.csv: 표 머리글(평가 영역/체크 항목/배점…)을 알아보면 그대로 읽고, 모르는 표면 AI로
//  - 그 밖의 모든 파일(pdf, hwpx, hwp, docx, pptx, 이미지, txt …): 브라우저에서 내용을 뽑은 뒤
//    제미나이에게 "기본 점수 + 체크 항목" 구조로 바꿔 달라고 한다(스캔 PDF·이미지는 파일째로 보냄).
const RubricImport = (() => {
  const MAX_TEXT = 60000;
  const GEMINI_IMAGE = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];

  const extOf = (name) => ((name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';

  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function decodeText(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return new TextDecoder('euc-kr').decode(buf); }
  }

  // ---------------- 표(엑셀/CSV) 직접 읽기 ----------------
  function sheetRows(wb) {
    const out = [];
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false });
      out.push({ name, rows: rows.map((r) => r.map((v) => String(v == null ? '' : v).trim())) });
    }
    return out;
  }

  const H = {
    area: /평가\s*영역|평가\s*요소|평가\s*항목|^영역$|^요소$/,
    check: /체크|세부|채점\s*기준|^항목|내용|기준\s*문항/,
    points: /^배점|^점수/,
    base: /기본/,
    auto: /감지|방식|유형/,
    pattern: /패턴|키워드/,
    reason: /근거|미충족/,
  };
  const AUTO_MAP = [[/모두/, 'keywordAll'], [/정규/, 'regex'], [/키워드/, 'keyword'], [/직접|없음|수동/, 'none']];

  function tryTable(rows) {
    const h = rows.findIndex((r) => r.some((c) => H.check.test(c)) && r.some((c) => H.points.test(c)));
    if (h < 0) return null;
    const head = rows[h];
    const col = {};
    const used = new Set();
    for (const key of ['base', 'area', 'pattern', 'reason', 'auto', 'points', 'check']) {
      const i = head.findIndex((c, idx) => !used.has(idx) && c && H[key].test(c));
      if (i >= 0) { col[key] = i; used.add(i); }
    }
    if (col.check == null || col.points == null) return null;

    const rubric = { name: '', step: 5, baseScore: 0, groups: [], flags: [] };
    for (const r of rows.slice(0, h)) {
      const [k, v] = [r[0] || '', r[1] || ''];
      if (/이름|제목|과제/.test(k) && v) rubric.name = v;
      else if (/간격/.test(k) && Number(v)) rubric.step = Number(v);
      else if (/최저|기본\s*점수/.test(k) && v !== '') rubric.baseScore = Number(v) || 0;
    }

    let group = null;
    for (const r of rows.slice(h + 1)) {
      const area = col.area != null ? r[col.area] : '';
      if (area && (!group || group.name !== area)) {
        group = { name: area, base: 0, checks: [] };
        rubric.groups.push(group);
      }
      if (!group) { group = { name: '평가 영역', base: 0, checks: [] }; rubric.groups.push(group); }
      if (col.base != null && r[col.base] !== '' && !isNaN(Number(r[col.base]))) group.base = Number(r[col.base]);
      const label = r[col.check];
      if (!label) continue;
      const pts = Number(String(r[col.points]).replace(/[^\d.]/g, ''));
      if (/^\(?기본\s*점수\)?$/.test(label)) { group.base = pts || 0; continue; }
      const autoCell = col.auto != null ? r[col.auto] : '';
      const pattern = col.pattern != null ? r[col.pattern] : '';
      let type = 'none';
      for (const [re, t] of AUTO_MAP) if (re.test(autoCell)) { type = t; break; }
      if (type === 'none' && pattern && !/직접|없음|수동/.test(autoCell)) type = 'keyword';
      group.checks.push({ label, points: pts || 0, auto: { type, pattern }, reason: col.reason != null ? r[col.reason] : '' });
    }
    if (!rubric.groups.some((g) => g.checks.length)) return null;
    return rubric;
  }

  // ---------------- 문서에서 텍스트(표 구조 유지) 뽑기 ----------------
  const kids = (el, name) => Array.from(el.children).filter((c) => c.localName === name);

  // hwpx: 섹션 XML을 돌면서 표는 "칸 | 칸" 줄로, 문단은 한 줄로.
  async function hwpxText(buf) {
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).filter((n) => /Contents\/section\d+\.xml$/i.test(n)).sort();
    if (!names.length) throw new Error('hwpx 본문을 찾지 못했습니다');
    const lines = [];
    const textOf = (el) => Array.from(el.getElementsByTagNameNS('*', 'p'))
      .map((p) => Array.from(p.getElementsByTagNameNS('*', 't')).map((t) => t.textContent).join(''))
      .filter(Boolean).join(' ');
    const walk = (el) => {
      for (const c of Array.from(el.children)) {
        if (c.localName === 'tbl') {
          for (const tr of kids(c, 'tr')) lines.push(kids(tr, 'tc').map((tc) => textOf(tc).trim()).join(' | '));
          lines.push('');
        } else if (c.localName === 'p' && !c.getElementsByTagNameNS('*', 'tbl').length) {
          const t = Array.from(c.getElementsByTagNameNS('*', 't')).map((x) => x.textContent).join('');
          if (t.trim()) lines.push(t);
        } else {
          walk(c);
        }
      }
    };
    for (const n of names) {
      const doc = new DOMParser().parseFromString(await zip.files[n].async('string'), 'application/xml');
      walk(doc.documentElement);
    }
    return lines.join('\n');
  }

  // HWP 스트림은 압축 데이터 뒤에 섹터 채움(0)이 붙어 있어 "Junk found after end" 오류가 난다 —
  // 그때까지 풀린 내용은 온전하므로 받아 둔 조각만 이어 붙인다.
  async function inflateRaw(bytes) {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks = [];
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
    } catch (e) {
      if (!chunks.length) throw new Error('HWP 압축을 풀지 못했습니다');
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  // 구형 한글(.hwp, HWP 5.0) — OLE 복합 파일 안의 BodyText/Section* 레코드에서 문단 텍스트를 읽는다.
  async function hwpText(buf) {
    const CFBlib = window.CFB || (window.XLSX && XLSX.CFB);
    if (!CFBlib) throw new Error('HWP 해석 라이브러리를 불러오지 못했습니다');
    const cfb = CFBlib.read(new Uint8Array(buf), { type: 'array' });
    const header = CFBlib.find(cfb, 'FileHeader');
    if (!header) throw new Error('HWP 5.0 형식이 아닙니다');
    const props = new DataView(Uint8Array.from(header.content).buffer).getUint32(36, true);
    if (props & 2) throw new Error('암호가 걸린 HWP 파일입니다');
    if (props & 4) throw new Error('배포용(보안) HWP 문서라 읽을 수 없습니다 — PDF로 저장해서 올려 주세요');
    const compressed = props & 1;

    const sections = cfb.FullPaths
      .map((p, i) => ({ p, i }))
      .filter((x) => /BodyText\/Section\d+$/i.test(x.p))
      .sort((a, b) => Number(a.p.match(/(\d+)$/)[1]) - Number(b.p.match(/(\d+)$/)[1]));
    if (!sections.length) throw new Error('HWP 본문을 찾지 못했습니다');

    const lines = [];
    for (const { i } of sections) {
      let data = Uint8Array.from(cfb.FileIndex[i].content);
      if (compressed) data = await inflateRaw(data);
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const tables = []; // { level, row, cells, cell }
      const flushRow = (t) => { if (t.cells.length) lines.push(t.cells.join(' | ')); t.cells = []; };
      let pos = 0;
      while (pos + 4 <= data.length) {
        const h = dv.getUint32(pos, true); pos += 4;
        const tag = h & 0x3ff, level = (h >>> 10) & 0x3ff;
        let size = (h >>> 20) & 0xfff;
        if (size === 0xfff) { size = dv.getUint32(pos, true); pos += 4; }
        while (tables.length && level < tables[tables.length - 1].level) { flushRow(tables.pop()); lines.push(''); }
        const top = tables[tables.length - 1];
        if (tag === 77) {
          // HWPTAG_TABLE: 같은 레벨의 LIST_HEADER들이 셀이다
          tables.push({ level, row: -1, cells: [] });
        } else if (tag === 72 && top && level === top.level && size >= 12) {
          const row = dv.getUint16(pos + 10, true);
          if (row !== top.row) { flushRow(top); top.row = row; }
          top.cells.push('');
        } else if (tag === 67) {
          let s = '';
          for (let p = pos; p + 2 <= pos + size; p += 2) {
            const c = dv.getUint16(p, true);
            if (c >= 32) s += String.fromCharCode(c);
            else if (c === 10) s += ' ';
            else if (c === 13 || c === 0) {}
            else if (c >= 24) s += ' ';
            else { if (c === 9) s += ' '; p += 14; } // 인라인/확장 컨트롤은 8글자(16바이트) 차지
          }
          s = s.trim();
          if (s) {
            if (top && top.cells.length) top.cells[top.cells.length - 1] = (top.cells[top.cells.length - 1] + ' ' + s).trim();
            else lines.push(s);
          }
        }
        pos += size;
      }
      while (tables.length) flushRow(tables.pop());
    }
    return lines.join('\n');
  }

  function htmlToText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const lines = [];
    const walk = (el) => {
      for (const c of Array.from(el.children)) {
        const tag = c.tagName.toLowerCase();
        if (tag === 'table') {
          for (const tr of c.querySelectorAll('tr')) lines.push(Array.from(tr.children).map((td) => td.textContent.trim().replace(/\s+/g, ' ')).join(' | '));
          lines.push('');
        } else if (/^(p|h\d|li)$/.test(tag)) {
          const t = c.textContent.trim();
          if (t) lines.push((tag === 'li' ? '- ' : '') + t);
        } else walk(c);
      }
    };
    walk(doc.body);
    return lines.join('\n');
  }

  async function imageToPng(file) {
    const bmp = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width; canvas.height = bmp.height;
    canvas.getContext('2d').drawImage(bmp, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return blob.arrayBuffer();
  }

  // 파일 → 제미나이에게 보낼 parts
  async function fileParts(file) {
    const ext = extOf(file.name);
    const mime = file.type || '';
    const buf = await file.arrayBuffer();
    const textPart = (t) => {
      if (!t || !t.replace(/\s/g, '')) throw new Error('파일에서 글자를 찾지 못했습니다');
      return [{ text: '[채점 기준 자료: ' + file.name + ']\n' + t.slice(0, MAX_TEXT) }];
    };

    if (ext === 'pdf' || mime === 'application/pdf') {
      if (buf.byteLength > 18 * 1024 * 1024) throw new Error('PDF가 너무 큽니다(18MB 이하)');
      return [{ inline_data: { mime_type: 'application/pdf', data: b64(buf) } }];
    }
    if (mime.startsWith('image/') || /^(png|jpe?g|webp|gif|bmp|heic|heif)$/.test(ext)) {
      if (GEMINI_IMAGE.includes(mime)) return [{ inline_data: { mime_type: mime, data: b64(buf) } }];
      return [{ inline_data: { mime_type: 'image/png', data: b64(await imageToPng(file)) } }];
    }
    if (ext === 'hwpx') return textPart(await hwpxText(buf));
    if (ext === 'hwp') return textPart(await hwpText(buf));
    if (ext === 'docx') return textPart(htmlToText((await mammoth.convertToHtml({ arrayBuffer: buf })).value));
    if (ext === 'pptx') return textPart(await Extract.pptxText(buf));
    if (/^(xlsx|xlsm|xls|ods|csv)$/.test(ext)) {
      const wb = ext === 'csv' ? XLSX.read(decodeText(buf), { type: 'string' }) : XLSX.read(buf, { type: 'array' });
      return textPart(wb.SheetNames.map((n) => '[시트: ' + n + ']\n' + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n\n'));
    }
    if (ext === 'doc' || ext === 'ppt') throw new Error('.' + ext + ' 형식은 PDF로 저장해서 올려 주세요');
    // 그 밖: 텍스트로 읽어 보고, 글자가 거의 없으면(바이너리) 포기
    const t = decodeText(buf);
    const printable = t.replace(/[^\p{L}\p{N}\p{P}\s]/gu, '').length / Math.max(1, t.length);
    if (printable < 0.8) throw new Error('이 형식(.' + (ext || '?') + ')은 읽을 수 없습니다 — PDF나 이미지로 저장해서 올려 주세요');
    return textPart(t);
  }

  function prompt(fileName, stepHint) {
    return `너는 한국 고등학교 수행평가 채점기준표를 "채점 프로그램용 체크리스트"로 바꾸는 도우미다.
첨부한 채점 기준 자료(파일명: ${fileName})를 읽고 아래 형식의 JSON 하나만 출력하라.

[변환 규칙]
1. 평가 영역(평가 요소)마다 group 하나를 만든다. 자료에 있는 순서를 지킨다.
2. 점수가 수준(밴드)별로 되어 있으면(예: 40/35/30/25/20):
   - base = 그 영역의 최저 점수(제출하면 받는 가장 낮은 수준의 점수)
   - 체크 항목 배점의 합 = (그 영역 최고점 - base)
   - 한 수준씩 올라갈 때 추가로 충족해야 하는 요소를 체크 항목으로 나눈다. 그러면 체크를 하나씩 더할 때마다 다음 수준 점수가 된다.
   자료가 이미 항목별 배점(체크리스트)이면 base = 0으로 두고 그대로 옮긴다.
3. step = 점수 간격(수준 사이 점수 차이, 예: 5). 알 수 없으면 ${stepHint}. 모든 체크 항목 배점과 base는 step의 배수여야 한다.
4. 자료에 없는 기준을 지어내지 않는다. 체크 항목(label)은 채점기준표의 표현을 살려 짧고 구체적으로 쓴다.
5. 자동 감지: 학생 제출물(코드, 보고서 등의 텍스트)에서 찾을 수 있는 구체적인 단어로 판단할 수 있으면
   autoType "keyword"(키워드 중 하나라도 있으면 충족) 또는 "keywordAll"(모두 있어야 충족),
   pattern = 쉼표로 구분한 키워드(한국어와 영어·코드 표현을 함께, 예: "push, 삽입").
   글의 질·논리성처럼 텍스트 검색으로 판단할 수 없는 항목은 autoType "none", pattern "".
6. reason = 이 항목을 충족하지 못했을 때 적을 짧은 근거 문장(예: "스택의 삭제 연산 설계가 확인되지 않음").
7. baseScore = 자료에 제출자 "기본 점수"(합계 최저점)가 따로 있고 영역별 base 합과 다를 때만 그 값, 아니면 0.
8. name = 수행평가 이름(자료에 있으면), notes = 변환하면서 애매했던 점이나 선생님이 확인할 점(한국어, 1~3문장, 없으면 "").
9. 채점 기준 자료가 아니면 groups를 빈 배열로 하고 notes에 이유를 쓴다.

[출력 형식]
{"name":"...","step":5,"baseScore":0,"groups":[{"name":"...","base":20,"checks":[{"label":"...","points":5,"autoType":"keyword","pattern":"...","reason":"..."}]}],"notes":"..."}`;
  }

  async function viaAi(parts, fileName, stepHint) {
    const out = await Gemini.generateJson([{ text: prompt(fileName, stepHint) }].concat(parts));
    const raw = {
      name: out.name || fileName.replace(/\.[^.]+$/, ''),
      step: out.step, baseScore: out.baseScore,
      groups: (out.groups || []).map((g) => ({
        name: g.name, base: g.base,
        checks: (g.checks || []).map((c) => ({ label: c.label, points: c.points, auto: { type: c.autoType, pattern: c.pattern || '' }, reason: c.reason || '' })),
      })),
      flags: [],
    };
    if (!raw.groups.length) throw new Error('채점 기준을 찾지 못했습니다' + (out.notes ? ' — ' + out.notes : ''));
    return { rubric: raw, notes: out.notes || '' };
  }

  // 결과: { rubric, via: 'json'|'table'|'ai', notes }
  async function importFile(file, opts) {
    const stepHint = (opts && opts.stepHint) || 5;
    const ext = extOf(file.name);
    let result;
    if (ext === 'json') {
      const data = JSON.parse(decodeText(await file.arrayBuffer()));
      result = { rubric: data.rubric || data, via: 'json', notes: '' };
    } else if (/^(xlsx|xlsm|xls|ods|csv)$/.test(ext)) {
      const buf = await file.arrayBuffer();
      const wb = ext === 'csv' ? XLSX.read(decodeText(buf), { type: 'string' }) : XLSX.read(buf, { type: 'array' });
      const table = sheetRows(wb).map((s) => tryTable(s.rows)).find(Boolean);
      result = table ? { rubric: table, via: 'table', notes: '' } : Object.assign({ via: 'ai' }, await viaAi(await fileParts(file), file.name, stepHint));
    } else {
      result = Object.assign({ via: 'ai' }, await viaAi(await fileParts(file), file.name, stepHint));
    }
    if (!result.rubric.name) result.rubric.name = file.name.replace(/\.[^.]+$/, '');
    result.rubric = Grading.normalize(result.rubric);
    result.rubric.source = { fileName: file.name, via: result.via, importedAt: Date.now() };
    return result;
  }

  // 현재 기준을 엑셀 양식으로 — 이 파일을 고쳐서 다시 올리면 AI 없이 그대로 적용된다.
  function exportXlsx(r) {
    const autoName = { none: '직접 확인', keyword: '키워드', keywordAll: '키워드(모두)', regex: '정규식' };
    const rows = [
      ['기준 이름', r.name], ['배점 간격', r.step], ['합계 최저점', r.baseScore || 0], [],
      ['평가 영역', '영역 기본 점수', '체크 항목', '배점', '자동 감지', '패턴(키워드는 쉼표로 구분)', '미충족 시 근거'],
    ];
    for (const g of r.groups) {
      g.checks.forEach((c, i) => rows.push([g.name, i === 0 ? g.base : '', c.label, c.points, autoName[c.auto.type], c.auto.pattern, c.reason]));
      if (!g.checks.length) rows.push([g.name, g.base, '', '', '', '', '']);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 28 }, { wch: 12 }, { wch: 40 }, { wch: 6 }, { wch: 12 }, { wch: 36 }, { wch: 40 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '채점기준');
    XLSX.writeFile(wb, '채점기준_' + r.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) + '.xlsx');
  }

  return { importFile, exportXlsx };
})();
