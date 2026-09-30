// 제출 파일에서 텍스트를 뽑아낸다. Apps Script가 아니라 브라우저에서 Drive API를 직접
// 호출하므로 응답이 잘리거나 인코딩이 깨지는 문제가 없다.
const Extract = (() => {
  async function hwpxText(buf) {
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files)
      .filter((n) => /Contents\/section\d+\.xml$/.test(n))
      .sort();
    if (!names.length) throw new Error('hwpx 본문을 찾지 못함');
    const parts = [];
    for (const n of names) {
      const xml = await zip.files[n].async('string');
      parts.push(
        xml
          .replace(/<\/hp:p>/g, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
      );
    }
    return parts.join('\n');
  }

  async function pptxText(buf) {
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => {
        const na = Number(a.match(/(\d+)/)[1]), nb = Number(b.match(/(\d+)/)[1]);
        return na - nb;
      });
    const out = [];
    for (let i = 0; i < names.length; i++) {
      const xml = await zip.files[names[i]].async('string');
      const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) =>
        m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      );
      out.push('[슬라이드 ' + (i + 1) + ']\n' + texts.join('\n'));
    }
    return out.join('\n\n');
  }

  function ipynbText(json) {
    const nb = JSON.parse(json);
    return (nb.cells || [])
      .map((c) => {
        const src = Array.isArray(c.source) ? c.source.join('') : c.source || '';
        return (c.cell_type === 'code' ? '[코드]\n' : '[설명]\n') + src;
      })
      .join('\n\n');
  }

  async function docxText(buf) {
    const result = await mammoth.extractRawText({ arrayBuffer: buf });
    return result.value;
  }

  async function pdfText(buf) {
    const task = pdfjsLib.getDocument({ data: buf });
    const pdf = await task.promise;
    const pages = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      pages.push('[' + p + '쪽]\n' + content.items.map((it) => it.str).join(' '));
    }
    const text = pages.join('\n\n');
    if (!text.replace(/\s/g, '').length) throw new Error('텍스트를 찾을 수 없음(스캔 이미지 PDF로 추정) — 직접 확인 필요');
    return text;
  }

  // file: { id, name, mimeType }
  async function extractOne(file) {
    const name = (file.name || '').toLowerCase();
    const mime = file.mimeType || '';

    if (mime === 'application/vnd.google-apps.document') return Api.exportGoogleFile(file.id, 'text/plain');
    if (mime === 'application/vnd.google-apps.presentation') return Api.exportGoogleFile(file.id, 'text/plain');
    if (mime === 'application/vnd.google-apps.spreadsheet') return Api.exportGoogleFile(file.id, 'text/csv');

    if (name.endsWith('.hwpx')) return hwpxText(await Api.downloadArrayBuffer(file.id));
    if (name.endsWith('.hwp')) throw new Error('구형 HWP 파일은 지원하지 않습니다 — 직접 열어 확인해 주세요');
    if (name.endsWith('.ipynb')) return ipynbText(await Api.downloadText(file.id));
    if (name.endsWith('.docx') || mime.includes('wordprocessingml.document'))
      return docxText(await Api.downloadArrayBuffer(file.id));
    if (name.endsWith('.pptx') || mime.includes('presentationml.presentation'))
      return pptxText(await Api.downloadArrayBuffer(file.id));
    if (name.endsWith('.pdf') || mime === 'application/pdf') return pdfText(await Api.downloadArrayBuffer(file.id));
    if (mime.startsWith('image/')) throw new Error('이미지 파일은 텍스트 추출을 지원하지 않습니다 — 직접 확인 필요');
    if (mime.startsWith('text/') || /\.(py|txt|md|csv|json|js|java|c|cpp|html)$/.test(name))
      return Api.downloadText(file.id);

    throw new Error('지원하지 않는 파일 형식: ' + (mime || name));
  }

  // 여러 첨부 파일을 합쳐서 하나의 텍스트로.
  async function extractSubmission(files, answerText) {
    const parts = [];
    const failed = [];
    if (answerText) parts.push('=== 단답형 답변 ===\n' + answerText);
    for (const f of files) {
      try {
        const t = await extractOne(f);
        parts.push('=== ' + f.name + ' ===\n' + t);
      } catch (e) {
        failed.push(f.name + ' (' + e.message + ')');
      }
    }
    if (failed.length) parts.push('[추출 실패 — 직접 확인 필요]\n' + failed.join('\n'));
    const status = !files.length ? (answerText ? '완료' : '없음') : failed.length === 0 ? '완료' : failed.length === files.length ? '추출불가' : '일부불가';
    return { text: parts.join('\n\n'), status };
  }

  // 선생님 컴퓨터의 파일(빈 양식·100점 샘플)을 학생 제출물과 같은 방식으로 텍스트로
  async function extractLocal(file) {
    const name = (file.name || '').toLowerCase();
    const buf = await file.arrayBuffer();
    let text;
    if (name.endsWith('.hwpx')) text = await hwpxText(buf);
    else if (name.endsWith('.hwp')) text = await RubricImport.hwpText(buf);
    else if (name.endsWith('.docx')) text = await docxText(buf);
    else if (name.endsWith('.pptx')) text = await pptxText(buf);
    else if (name.endsWith('.pdf')) text = await pdfText(buf);
    else if (name.endsWith('.ipynb')) text = ipynbText(new TextDecoder('utf-8').decode(buf));
    else if (/\.(py|txt|md|csv|json|js|java|c|cpp|html)$/.test(name)) text = new TextDecoder('utf-8').decode(buf);
    else throw new Error('지원하지 않는 형식입니다 — hwpx, hwp, docx, pdf, pptx, py, txt를 올려 주세요');
    if (!String(text).replace(/\s/g, '').length) throw new Error('파일에서 글자를 찾지 못했습니다(스캔 이미지일 수 있음)');
    return '=== ' + file.name + ' ===\n' + text;
  }

  return { extractSubmission, pptxText, extractLocal };
})();
