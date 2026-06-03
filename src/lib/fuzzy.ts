// Fuzzy subsequence matching utilities for command palette / quick-open.

export function fuzzyMatch(query: string, target: string): boolean {
  if (query.length === 0) {
    return true;
  }
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      qi += 1;
    }
  }
  return qi === q.length;
}

export function fuzzyScore(query: string, target: string): number {
  if (query.length === 0) {
    return 1;
  }
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let prevIndex = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      score += 1;
      if (ti === 0) {
        // Match at the very start of the target.
        score += 5;
      }
      if (prevIndex === ti - 1) {
        // Contiguous with the previous matched character.
        score += 3;
      }
      prevIndex = ti;
      qi += 1;
    }
  }
  return qi === q.length ? score : 0;
}

export function fuzzyFilter<T>(
  items: T[],
  query: string,
  key: (item: T) => string,
): T[] {
  if (query.trim().length === 0) {
    return items;
  }
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, key(item)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (b.score === a.score ? a.index - b.index : b.score - a.score))
    .map((entry) => entry.item);
}
