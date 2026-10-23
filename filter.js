// Client-side mirror of routes._get_items / _get_global_counts / feed().
// Pure functions, no DOM access. Constants come from Python via configure().
(function (root) {
  'use strict';
  const DAY_MS = 86400000;
  let CFG = null;

  function configure(cfg) { CFG = cfg; }

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function safeHref(u) {
    return (u && /^https?:\/\//.test(u)) ? u : '#';
  }

  // FastAPI bool parsing: these spell false, anything else true.
  const FALSY = ['false', '0', 'off', 'no', 'f', 'n'];

  function parseParams(search) {
    const p = new URLSearchParams(search || '');
    const str = k => p.get(k) || null;
    const int = k => {
      const v = p.get(k);
      if (v === null || v.trim() === '') return null;
      const n = Number(v);
      return Number.isInteger(n) ? n : null;
    };
    const hp = p.get('high_priority');
    return {
      category: str('category'),
      company_id: str('company_id'),
      media_category: str('media_category'),
      days: int('days'),
      subtype: str('subtype'),
      country: str('country'),
      min_score: int('min_score'),
      high_priority: hp === null ? true : !FALSY.includes(hp.toLowerCase()),
    };
  }

  // Company view and days=0: no cutoff. Otherwise days, default 7.
  function cutoffMs(params, nowMs) {
    if (params.company_id) return null;
    if (params.days === 0) return null;
    return nowMs - (params.days !== null ? params.days : 7) * DAY_MS;
  }

  // Timestamps without an offset are UTC (JS would read them as local time).
  function parseUtc(s) {
    return Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(s) || !s.includes('T') ? s : s + 'Z');
  }

  // Explicit min_score wins; company view = floor only; else toggle.
  function threshold(params) {
    if (params.min_score !== null) return params.min_score;
    if (params.company_id) return CFG.RELEVANT_SCORE_FLOOR;
    return params.high_priority ? CFG.HIGH_PRIORITY_THRESHOLD : CFG.RELEVANT_SCORE_FLOOR;
  }

  // The SQL part of _get_items: window, stored-score threshold (min may be null), eq filters,
  // then the post-query media_category check.
  function select(items, params, nowMs, min) {
    const cutoff = cutoffMs(params, nowMs);
    return items.filter(i => {
      if (cutoff !== null) {
        // published_at, falling back to collected_at only when published_at is null
        const ref = i.published_at != null ? i.published_at : i.collected_at;
        const t = ref == null ? NaN : parseUtc(ref);
        if (!(t >= cutoff)) return false;
      }
      if (min !== null && (i.stored_score || 0) < min) return false;
      if (params.category && i.signal_category !== params.category) return false;
      if (params.company_id && i.company_id !== params.company_id) return false;
      if (params.subtype && i.signal_subtype !== params.subtype) return false;
      if (params.country && i.country !== params.country) return false;
      if (params.media_category && (i.sources || {}).media_category !== params.media_category) return false;
      return true;
    });
  }

  // ORDER BY <score> DESC, collected_at DESC
  function byDesc(key) {
    return (x, y) => {
      const d = (y[key] || 0) - (x[key] || 0);
      if (d) return d;
      const a = x.collected_at || '', b = y.collected_at || '';
      return a < b ? 1 : a > b ? -1 : 0;
    };
  }

  // Title dedup in DB order (stored score), keeping the first occurrence.
  function dedupe(items) {
    const seen = new Set();
    return items.slice().sort(byDesc('stored_score')).filter(i => {
      const key = String(i.title ?? '').toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // _get_items: filter, dedup within the filtered set, then sort by fresh composite.
  function filterItems(items, params, nowMs) {
    return dedupe(select(items, params, nowMs, threshold(params))).sort(byDesc('relevance_score'));
  }

  function categoryCounts(items) {
    const counts = {};
    for (const c of CFG.CATEGORIES) counts[c] = 0;
    for (const i of items) if (i.signal_category in counts) counts[i.signal_category] += 1;
    return counts;
  }

  // _get_global_counts: every filter except category; dedup BEFORE the threshold.
  function globalCounts(items, params, nowMs) {
    const min = threshold(params);
    const pool = dedupe(select(items, Object.assign({}, params, {category: null}), nowMs, null))
      .filter(i => (i.stored_score || 0) >= min);
    const counts = categoryCounts(pool);
    let total = 0;
    for (const c of CFG.CATEGORIES) total += counts[c];
    return {counts, total};
  }

  function tally(items, keyFn) {
    const out = {};
    for (const i of items) {
      const k = keyFn(i);
      if (k) out[k] = (out[k] || 0) + 1;
    }
    return out;
  }

  function subtypeCounts(items, params, nowMs) {
    if (!params.category) return {};
    const pool = filterItems(items, Object.assign({}, params, {subtype: null}), nowMs);
    return tally(pool, i => i.signal_subtype);
  }

  function countryCounts(items, params, nowMs) {
    if (!params.category) return {};
    const pool = filterItems(items, Object.assign({}, params, {country: null}), nowMs);
    return tally(pool, i => i.country || (i.companies || {}).country);
  }

  function companyCounts(items, params, nowMs) {
    const pool = params.company_id
      ? filterItems(items, Object.assign(parseParams(''), {days: 0, high_priority: false}), nowMs)
      : filterItems(items, params, nowMs);
    return tally(pool, i => i.company_id);
  }

  const api = {
    configure, esc, safeHref, parseParams, filterItems, categoryCounts,
    globalCounts, subtypeCounts, countryCounts, companyCounts,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CoirFilter = api;
})(typeof window !== 'undefined' ? window : this);
