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

  return { extractSubmission };
})();
