// 제미나이(Gemini) API를 브라우저에서 직접 호출한다. API 키는 선생님 브라우저의
// localStorage에만 저장되고 저장소(공개)에는 들어가지 않는다.
const Gemini = (() => {
  const KEY_STORE = 'grader:geminiKey';
  const MODEL_STORE = 'grader:geminiModel';
  const BASE = 'https://generativelanguage.googleapis.com/v1beta';

  function getKey() { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } }
  function setKey(k) { try { k ? localStorage.setItem(KEY_STORE, k.trim()) : localStorage.removeItem(KEY_STORE); } catch (e) {} }
  function getModel() { try { return localStorage.getItem(MODEL_STORE) || CONFIG.GEMINI_MODEL; } catch (e) { return CONFIG.GEMINI_MODEL; } }

  async function call(model, body) {
    return fetch(BASE + '/models/' + model + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': getKey() },
      body: JSON.stringify(body),
    });
  }

  // 모델 이름은 구글 쪽에서 종종 바뀐다. 404가 나면 이 키로 쓸 수 있는 flash 모델을 찾아 재시도.
  async function findFlashModel() {
    const res = await fetch(BASE + '/models?pageSize=100', { headers: { 'x-goog-api-key': getKey() } });
    if (!res.ok) return null;
    const models = ((await res.json()).models || []).filter(
      (m) => (m.supportedGenerationMethods || []).includes('generateContent') && /flash/i.test(m.name) && !/lite|image|tts|live/i.test(m.name)
    );
    const ver = (m) => parseFloat((m.name.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
    models.sort((a, b) => ver(b) - ver(a));
    return models.length ? models[0].name.replace(/^models\//, '') : null;
  }

  async function errorMessage(res) {
    let msg = res.status + ' ' + res.statusText;
    try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
    return msg;
  }

  // parts: [{ text }, { inline_data: { mime_type, data } }, ...]  →  JSON 객체
  async function generateJson(parts) {
    if (!getKey()) throw new Error('Gemini API 키가 없습니다. "채점 기준" 탭 아래쪽 설정에서 입력해 주세요.');
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    };
    let model = getModel();
    let res = await call(model, body);
    if (res.status === 404) {
      const alt = await findFlashModel();
      if (alt && alt !== model) {
        model = alt;
        try { localStorage.setItem(MODEL_STORE, alt); } catch (e) {}
        res = await call(model, body);
      }
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000));
      res = await call(model, body);
    }
    if (!res.ok) throw new Error('Gemini 호출 실패: ' + (await errorMessage(res)));
    const data = await res.json();
    const cand = data.candidates && data.candidates[0];
    const text = cand && cand.content && (cand.content.parts || []).map((p) => p.text || '').join('');
    if (!text) throw new Error('Gemini 응답이 비어 있습니다' + (cand && cand.finishReason ? ' (' + cand.finishReason + ')' : ''));
    const cleaned = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
    return JSON.parse(cleaned);
  }

  return { getKey, setKey, getModel, generateJson };
})();
