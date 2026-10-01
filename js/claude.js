// Claude(Anthropic) API를 브라우저에서 직접 호출해 실제로 "읽고 판단해서" 채점한다.
// 키워드/정규식 자동 감지보다 훨씬 정확하게 —  class 없이 짠 코드인지, 표의 빈칸을
// 정말 안 채운 건지, 코드 로직이 실제로 맞는지까지 Claude가 읽고 판단한다.
// API 키는 선생님 브라우저의 localStorage에만 저장되고 저장소(공개)에는 들어가지 않는다.
const Claude = (() => {
  const KEY_STORE = 'grader:claudeKey';
  const MODEL_STORE = 'grader:claudeModel';
  const DEFAULT_MODEL = 'claude-opus-5-5';
  const MODELS = [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (가장 정확, 비쌈)' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (균형)' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (가장 저렴)' },
  ];
  const BASE = 'https://api.anthropic.com/v1/messages';

  function getKey() { try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; } }
  function setKey(k) { try { k ? localStorage.setItem(KEY_STORE, k.trim()) : localStorage.removeItem(KEY_STORE); } catch (e) {} }
  function getModel() {
    // 예전 세션에 저장된 모델 id가 더 이상 유효하지 않으면(모델 이름이 바뀐 경우 등)
    // 조용히 실패하지 말고 지금 목록에 있는 기본 모델로 되돌아간다.
    let m;
    try { m = localStorage.getItem(MODEL_STORE); } catch (e) { m = null; }
    if (m && MODELS.some((x) => x.id === m)) return m;
    return DEFAULT_MODEL;
  }
  function setModel(m) { try { localStorage.setItem(MODEL_STORE, m); } catch (e) {} }

  // rubric(설계 20 + 체크...형태)의 체크 id들을 그대로 스키마 필드로 삼는다 —
  // 루브릭을 자유롭게 편집해도 항상 정확히 그 항목들에 대한 판단을 구조화해서 받는다.
  function buildSchema(rubric) {
    const properties = {}, required = [];
    for (const g of rubric.groups) {
      for (const c of g.checks) {
        properties[c.id] = {
          type: 'object',
          properties: { met: { type: 'boolean' }, reason: { type: 'string' } },
          required: ['met', 'reason'],
          additionalProperties: false,
        };
        required.push(c.id);
      }
    }
    return {
      type: 'object',
      properties: {
        checks: { type: 'object', properties, required, additionalProperties: false },
        aiSuspect: { type: 'boolean' },
        aiSuspectReason: { type: 'string' },
      },
      required: ['checks', 'aiSuspect', 'aiSuspectReason'],
      additionalProperties: false,
    };
  }

  function buildPrompt(rubric, text) {
    const lines = [];
    lines.push('당신은 고등학교 정보 교사의 채점 보조입니다. 학생이 제출한 과제 내용을 읽고, 아래 채점 체크리스트의');
    lines.push('각 항목이 "실제로 충족됐는지" 판단하세요. 표나 빈칸이 인쇄만 되어 있고 학생이 아무 내용도 안 적었으면');
    lines.push('충족(met=true)으로 보지 마세요. 코드가 있다면 그 로직이 실제로 말이 되는지도 확인하세요.');
    lines.push('');
    lines.push('[채점 체크리스트]');
    for (const g of rubric.groups) {
      lines.push('- 평가 영역: ' + g.name + (g.base ? ' (기본 ' + g.base + '점 포함)' : ''));
      for (const c of g.checks) lines.push('  · [' + c.id + '] ' + c.label + ' (' + c.points + '점)' + (c.reason ? ' — 미충족 예시: ' + c.reason : ''));
    }
    lines.push('');
    lines.push('[AI 작성 의심 판단] 학생이 직접 작성한 것이 아니라 생성형 AI가 대신 써 준 것으로 보이면 aiSuspect를 true로,');
    lines.push('그 근거를 aiSuspectReason에 한국어로 짧게 적으세요. 근거가 없으면 aiSuspect는 false, aiSuspectReason은 빈 문자열로 두세요.');
    lines.push('모든 reason은 한국어로, 한 문장으로 간결하게 적으세요.');
    lines.push('');
    lines.push('[학생 제출물 — 여러 파일을 이어 붙인 텍스트]');
    lines.push(text || '(추출된 내용 없음 — 제출물이 비어 있는 것으로 보고 모든 항목을 met=false로 판단하세요)');
    return lines.join('\n');
  }

  async function errorMessage(res) {
    let msg = res.status + ' ' + res.statusText;
    try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch (e) {}
    return msg;
  }

  // 반환: { checks: { [checkId]: { met, reason } }, aiSuspect, aiSuspectReason }
  async function gradeSubmission(rubric, text) {
    const key = getKey();
    if (!key) throw new Error('Claude API 키가 없습니다. ⚙ 설정 아래쪽 AI 설정에서 입력해 주세요.');
    const body = {
      model: getModel(),
      max_tokens: 4096,
      output_config: { format: { type: 'json_schema', schema: buildSchema(rubric) } },
      messages: [{ role: 'user', content: buildPrompt(rubric, text) }],
    };
    const res = await fetch(BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Claude 호출 실패: ' + (await errorMessage(res)));
    const data = await res.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock) throw new Error('Claude 응답에서 결과를 찾지 못함(stop_reason: ' + data.stop_reason + ')');
    return JSON.parse(textBlock.text);
  }

  return { getKey, setKey, getModel, setModel, MODELS, DEFAULT_MODEL, gradeSubmission, buildPrompt };
})();
