// 제미나이(Gemini) API를 브라우저에서 직접 호출한다. API 키는 선생님 브라우저의
// localStorage에만 저장되고 저장소(공개)에는 들어가지 않는다.
const Gemini = (() => {
  const KEY_STORE = 'grader:geminiKey';
  const MODEL_STORE = 'grader:geminiModel';
  const BASE = 'https://generativelanguage.googleapis.com/v1beta';

  function getKey() { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } }
  function setKey(k) { try { k ? localStorage.setItem(KEY_STORE, k.trim()) : localStorage.removeItem(KEY_STORE); } catch (e) {} }
  function getModel() { try { return localStorage.getItem(MODEL_STORE) || CONFIG.GEMINI_MODEL; } catch (e) { return CONFIG.GEMINI_MODEL; } }

  // 응답이 없으면 2분 뒤 끊는다(멈춘 것처럼 보이지 않게)
  const TIMEOUT_MS = 120000;
  let onWait = null; // 한도 초과로 기다리는 동안 화면에 알릴 때 쓰는 콜백
  function setWaitListener(fn) { onWait = fn; }
  async function call(model, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetch(BASE + '/models/' + model + ':generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': getKey() },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Gemini 응답 시간 초과(2분) — 잠시 뒤 다시 시도해 주세요');
      throw new Error('Gemini에 연결하지 못했습니다(네트워크): ' + e.message);
    } finally {
      clearTimeout(timer);
    }
  }

  // 이 키로 쓸 수 있는 Gemini 모델 목록(한 번 받아 두고 재사용). 순서: flash 최신 → flash-lite → pro.
  // 특정 모델이 503(서버 과부하)·429(한도)·404(없어짐)로 안 될 때 다음 모델로 넘어가기 위한 후보들이다.
  let modelCache = null;
  async function listModels() {
    if (modelCache) return modelCache;
    try {
      const res = await fetch(BASE + '/models?pageSize=200', { headers: { 'x-goog-api-key': getKey() } });
      if (!res.ok) return [];
      const names = ((await res.json()).models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''))
        .filter((n) => /^gemini-/i.test(n) && !/image|tts|live|audio|embedding|robotics|computer-use|learnlm/i.test(n));
      const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]) || 0;
      const rank = (n) => (/flash/i.test(n) && !/lite/i.test(n) ? 0 : /flash-lite|lite/i.test(n) ? 1 : 2);
      const stable = (n) => (/preview|exp|latest/i.test(n) ? 1 : 0);
      names.sort((a, b) => rank(a) - rank(b) || stable(a) - stable(b) || ver(b) - ver(a));
      modelCache = names;
      return names;
    } catch (e) {
      return [];
    }
  }
  async function findFlashModel() { const l = await listModels(); return l[0] || null; }

  let lastModel = '';
  function getLastModel() { return lastModel || getModel(); }

  async function errorMessage(res) {
    let msg = res.status + ' ' + res.statusText;
    try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
    return msg;
  }

  // parts: [{ text }, { inline_data: { mime_type, data } }, ...]  →  JSON 객체
  // 한 모델이 과부하(503)·한도(429)·없음(404)이면 잠깐 기다려 한 번 더 해 보고, 그래도 안 되면 다음 모델로 넘어간다.
  async function generateJson(parts) {
    if (!getKey()) throw new Error('Gemini API 키가 없습니다. ⚙ 설정 아래쪽에서 입력해 주세요.');
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    };
    const tried = [];
    let candidates = [getModel()];
    let listed = false;
    let lastErr = '';
    for (let i = 0; i < candidates.length && tried.length < 6; i++) {
      const model = candidates[i];
      tried.push(model);
      let res = await call(model, body);
      if (res.status === 429 || res.status >= 500) {
        const wait = res.status === 429 ? 12 : 5;
        if (onWait) onWait(wait, res.status, model);
        await new Promise((r) => setTimeout(r, wait * 1000));
        res = await call(model, body);
      }
      if (res.ok) {
        const data = await res.json();
        const cand = data.candidates && data.candidates[0];
        const text = cand && cand.content && (cand.content.parts || []).map((p) => p.text || '').join('');
        if (!text) throw new Error('Gemini 응답이 비어 있습니다' + (cand && cand.finishReason ? ' (' + cand.finishReason + ')' : ''));
        lastModel = model;
        if (model !== getModel()) { try { localStorage.setItem(MODEL_STORE, model); } catch (e) {} }
        const cleaned = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
        try { return JSON.parse(cleaned); } catch (e) { throw new Error('Gemini 응답을 해석하지 못했습니다(JSON 아님)'); }
      }
      lastErr = res.status + ' ' + (await errorMessage(res));
      // 키 오류·잘못된 요청은 모델을 바꿔도 소용없음
      if (![404, 429, 500, 502, 503, 504].includes(res.status)) throw new Error('Gemini 호출 실패: ' + lastErr);
      if (!listed) {
        listed = true;
        const more = (await listModels()).filter((m) => !candidates.includes(m));
        candidates = candidates.concat(more);
      }
      if (onWait && candidates[i + 1]) onWait(0, res.status, model, candidates[i + 1]);
    }
    throw new Error('Gemini 모델이 모두 응답하지 않습니다(시도: ' + tried.join(', ') + ') — 마지막 오류: ' + lastErr + '. 구글 서버가 붐비는 시간일 수 있으니 몇 분 뒤 다시 시도해 주세요.');
  }

  // 제출물을 Gemini가 읽고 체크리스트를 판단한다(Claude 채점과 같은 지시문·같은 결과 형식).
  // 반환: { checks: { [checkId]: { met, reason } }, aiSuspect, aiSuspectReason }
  async function gradeSubmission(rubric, text) {
    const ids = rubric.groups.flatMap((g) => g.checks.map((c) => c.id));
    const format = [
      '',
      '[출력 형식] 아래 모양의 JSON 하나만 출력하세요. checks에는 위 체크리스트의 대괄호 안 id를 빠짐없이 모두 넣습니다.',
      '{"checks": {' + ids.map((id) => '"' + id + '": {"met": true 또는 false, "reason": "한 문장"}').join(', ') + '}, "aiSuspect": true 또는 false, "aiSuspectReason": "문자열"}',
    ].join('\n');
    const out = await generateJson([{ text: Claude.buildPrompt(rubric, text) + format }]);
    if (!out || typeof out.checks !== 'object') throw new Error('Gemini 응답 형식이 올바르지 않습니다');
    return out;
  }

  return { getKey, setKey, getModel, generateJson, gradeSubmission, setWaitListener, getLastModel, listModels };
})();
