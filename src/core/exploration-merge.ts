import { searchResultSchema, type ExplorationSearchResult, type ExplorationCandidate } from './exploration';

/** Preserve raw receipts and separate provider billing. Round-robin candidates
 * so an abundant X result cannot crowd out other discovery channels. */
export function mergeExplorationSearch(web: ExplorationSearchResult, x: ExplorationSearchResult): ExplorationSearchResult {
  const groups = [web.candidates.slice(), x.candidates.slice()], candidates: ExplorationCandidate[] = [], seen = new Set<string>();
  while (candidates.length < 24) {
    let remaining = false;
    for (const group of groups) {
      const candidate = group.shift(); if (!candidate) continue; remaining = true;
      if (seen.has(candidate.id)) continue; seen.add(candidate.id); candidates.push(candidate);
      if (candidates.length === 24) break;
    }
    if (!remaining) break;
  }
  return searchResultSchema.parse({ candidates, warnings: [...x.warnings, ...web.warnings].slice(0,8), snapshots: [...web.snapshots,...x.snapshots].slice(0,14), credits: web.credits, modelUsage: web.modelUsage, xUsage: x.xUsage, freeXUsage: x.freeXUsage });
}
