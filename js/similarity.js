// 제출물끼리 내용이 겹치는지 확인한다. 과제 템플릿(안내문·표 양식 등)은 모든 학생이
// 똑같이 갖고 있어서 그대로 비교하면 전부 "유사"하다고 나오므로, 여러 학생이 공통으로
// 가진 줄은 먼저 제외하고, 남은 "그 학생만의 내용"끼리 자카드 유사도로 비교한다.
const Similarity = (() => {
  function normLines(text) {
    return (text || '')
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim().toLowerCase())
      .filter((l) => l.length >= 4); // 너무 짧은 줄(빈칸·기호만 있는 줄)은 제외
  }

  // students: state.students. threshold: 0~1, 이 이상이면 "유사"로 본다.
  function analyze(students, threshold) {
    threshold = threshold || 0.5;
    const cands = students.filter((s) => s.status !== '미제출' && s.text && s.text.trim().length >= 30);
    if (cands.length < 2) return { groups: [], pairs: [], comparedCount: cands.length, commonLineCount: 0 };

    const lineSets = cands.map((s) => new Set(normLines(s.text)));

    const freq = new Map();
    for (const set of lineSets) for (const line of set) freq.set(line, (freq.get(line) || 0) + 1);
    const n = cands.length;
    const commonThreshold = Math.max(3, Math.ceil(n * 0.6));
    const common = new Set([...freq.entries()].filter(([, c]) => c >= commonThreshold).map(([l]) => l));

    const sigs = lineSets.map((set) => new Set([...set].filter((l) => !common.has(l))));

    const pairs = [];
    for (let i = 0; i < cands.length; i++) {
      if (sigs[i].size < 3) continue;
      for (let j = i + 1; j < cands.length; j++) {
        if (sigs[j].size < 3) continue;
        let inter = 0;
        for (const l of sigs[i]) if (sigs[j].has(l)) inter++;
        const union = sigs[i].size + sigs[j].size - inter;
        const score = union ? inter / union : 0;
        if (score >= threshold) pairs.push({ a: cands[i], b: cands[j], score, shared: inter });
      }
    }
    pairs.sort((x, y) => y.score - x.score);

    const parent = cands.map((_, i) => i);
    const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const idxOf = new Map(cands.map((s, i) => [s.userId, i]));
    for (const p of pairs) {
      const ra = find(idxOf.get(p.a.userId)), rb = find(idxOf.get(p.b.userId));
      if (ra !== rb) parent[ra] = rb;
    }

    const groupsMap = new Map();
    const involvedIds = new Set();
    for (const p of pairs) { involvedIds.add(p.a.userId); involvedIds.add(p.b.userId); }
    cands.forEach((s, i) => {
      if (!involvedIds.has(s.userId)) return;
      const root = find(i);
      if (!groupsMap.has(root)) groupsMap.set(root, []);
      groupsMap.get(root).push(s);
    });

    const groups = [...groupsMap.values()]
      .filter((g) => g.length >= 2)
      .map((members) => {
        let best = 0;
        for (const p of pairs) if (members.includes(p.a) && members.includes(p.b)) best = Math.max(best, p.score);
        return { members, score: best };
      })
      .sort((a, b) => b.score - a.score);

    return { groups, pairs, comparedCount: cands.length, commonLineCount: common.size };
  }

  return { analyze };
})();
