// Catalog ranking, default "Recommended" sort & Monorepo viewport slot dampening (`src/shared/ranking.mjs`).
// Pure browser/Node compatible ESM module (zero external dependencies).

export const MONOREPO_SLOT_DAMPENING_STEP = 0.15;

/**
 * Computes the Monorepo viewport slot dampening multiplier for the k-th (1-indexed) entry
 * sharing the same `repository.repositoryId`: `1 / (1 + 0.15 * (k - 1))`.
 */
export function computeMonorepoDampeningFactor(occurrenceIndex) {
  const k = Math.max(1, Math.floor(Number(occurrenceIndex) || 1));
  return 1 / (1 + MONOREPO_SLOT_DAMPENING_STEP * (k - 1));
}

function getFiniteRankingScore(plugin) {
  const raw = plugin?.ranking?.score;
  if (raw === null || raw === undefined || raw === '') return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function getStarsCount(plugin) {
  const num = Number(plugin?.repository?.stars || 0);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function getMonorepoGroupKey(plugin) {
  const repoId = Number(plugin?.repository?.repositoryId || 0);
  return Number.isFinite(repoId) && repoId > 0 ? String(Math.trunc(repoId)) : '';
}

function compareFallbackTieBreak(a, b, locale = 'zh') {
  const starDiff = getStarsCount(b) - getStarsCount(a);
  if (starDiff !== 0) return starDiff;
  const updDiff = String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || ''));
  if (updDiff !== 0) return updDiff;
  const nameDiff = String(a?.displayName || a?.canonicalName || a?.id || '').localeCompare(
    String(b?.displayName || b?.canonicalName || b?.id || ''),
    locale,
  );
  if (nameDiff !== 0) return nameDiff;
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

/**
 * Computes the base recommended sort key for a catalog plugin:
 * - Uses `plugin.ranking.score` when present.
 * - Falls back gracefully to `stars` when `ranking.score` is absent (e.g. custom feeds or older catalogs).
 *   When mixed with scored entries on the `[0, 100]` ranking scale, maps unranked `stars` monotonically
 *   into `[0, 85]` so unranked feeds remain smoothly ordered without blowing past scored Track-1 entries.
 */
export function resolveRecommendedBaseKey(plugin, { hasAnyRankingScore = false } = {}) {
  const explicitScore = getFiniteRankingScore(plugin);
  if (explicitScore !== null) return explicitScore;
  const stars = getStarsCount(plugin);
  if (!hasAnyRankingScore) return stars;
  if (stars <= 0) return 0;
  return Math.min(85, (85 * Math.log1p(stars)) / Math.log1p(500));
}

/**
 * Applies viewport Monorepo slot dampening to a list of plugins under Recommended sort:
 *   1. Pre-orders entries by their base recommended score descending.
 *   2. For entries sharing a positive `repository.repositoryId`, multiplies the k-th entry's
 *      display sort key by `1 / (1 + 0.15 * (k - 1))`.
 *   3. Re-orders by dampened display sort key descending so no monorepo hogs top viewport slots.
 */
export function sortPluginsRecommendedWithDampening(plugins, { locale = 'zh' } = {}) {
  const list = Array.isArray(plugins) ? plugins : [];
  if (list.length <= 1) return [...list];

  const hasAnyRankingScore = list.some((p) => getFiniteRankingScore(p) !== null);

  const scored = list.map((plugin, idx) => ({
    plugin,
    origIdx: idx,
    baseKey: resolveRecommendedBaseKey(plugin, { hasAnyRankingScore }),
    repoKey: getMonorepoGroupKey(plugin),
  }));

  // Step 1: Base order determines each plugin's rank k within its monorepo
  scored.sort((a, b) => {
    if (b.baseKey !== a.baseKey) return b.baseKey - a.baseKey;
    const tb = compareFallbackTieBreak(a.plugin, b.plugin, locale);
    return tb !== 0 ? tb : a.origIdx - b.origIdx;
  });

  // Step 2: Apply 1 / (1 + 0.15 * (k - 1)) per shared repository.repositoryId
  const repoOccurrence = new Map();
  const dampened = scored.map((item) => {
    let factor = 1;
    if (item.repoKey) {
      const k = (repoOccurrence.get(item.repoKey) || 0) + 1;
      repoOccurrence.set(item.repoKey, k);
      factor = computeMonorepoDampeningFactor(k);
    }
    return {
      ...item,
      dampenedKey: item.baseKey * factor,
    };
  });

  // Step 3: Final viewport display order
  dampened.sort((a, b) => {
    if (b.dampenedKey !== a.dampenedKey) return b.dampenedKey - a.dampenedKey;
    if (b.baseKey !== a.baseKey) return b.baseKey - a.baseKey;
    const tb = compareFallbackTieBreak(a.plugin, b.plugin, locale);
    return tb !== 0 ? tb : a.origIdx - b.origIdx;
  });

  return dampened.map((item) => item.plugin);
}

/**
 * Sorts catalog plugins according to `sortBy` (`'recommended' | 'stars' | 'updated' | 'name'`).
 */
export function sortCatalogPlugins(plugins, { sortBy = 'recommended', locale = 'zh' } = {}) {
  const list = Array.isArray(plugins) ? [...plugins] : [];
  if (sortBy === 'updated') {
    return list.sort((a, b) => {
      const cmp = String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || ''));
      return cmp !== 0 ? cmp : compareFallbackTieBreak(a, b, locale);
    });
  }
  if (sortBy === 'name') {
    return list.sort((a, b) =>
      String(a?.displayName || a?.canonicalName || a?.id || '').localeCompare(
        String(b?.displayName || b?.canonicalName || b?.id || ''),
        locale,
      ),
    );
  }
  if (sortBy === 'stars') {
    return list.sort((a, b) => {
      const diff = getStarsCount(b) - getStarsCount(a);
      if (diff !== 0) return diff;
      return compareFallbackTieBreak(a, b, locale);
    });
  }
  return sortPluginsRecommendedWithDampening(list, { locale });
}
