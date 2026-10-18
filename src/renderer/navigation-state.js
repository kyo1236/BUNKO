'use strict';

const NavigationState = (() => {
  const DEFAULT_MAX_ENTRIES = 3;
  const DEFAULT_MAX_ITEMS = 4800;

  function cloneItems(items, limit = DEFAULT_MAX_ITEMS) {
    const slice = (Array.isArray(items) ? items : []).slice(0, limit);
    if (typeof structuredClone === 'function') return structuredClone(slice);
    return JSON.parse(JSON.stringify(slice));
  }

  function createCache({ maxEntries = DEFAULT_MAX_ENTRIES, maxItems = DEFAULT_MAX_ITEMS } = {}) {
    const entries = new Map();
    return {
      put(key, value) {
        if (!key) return;
        if ((Array.isArray(value.galleries) ? value.galleries.length : 0) > maxItems) {
          entries.delete(key);
          return;
        }
        entries.delete(key);
        entries.set(key, {
          ...value,
          galleries: cloneItems(value.galleries, maxItems),
          page: Number(value.page) || 0,
        });
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      },
      get(key) {
        const found = entries.get(key);
        if (!found) return null;
        entries.delete(key);
        entries.set(key, found);
        return { ...found, galleries: cloneItems(found.galleries, maxItems) };
      },
      get size() { return entries.size; },
    };
  }

  function scrollAnchor(cards, scrollY) {
    const y = Number(scrollY) || 0;
    for (const card of cards || []) {
      const top = Number(card.top) || 0;
      const height = Math.max(1, Number(card.height) || 1);
      if (top + height > y) return { id: String(card.id), offset: y - top };
    }
    return null;
  }

  function anchorScrollTop(anchor, cards, fallback = 0) {
    if (!anchor) return Number(fallback) || 0;
    const card = (cards || []).find((item) => String(item.id) === String(anchor.id));
    if (!card) return Number(fallback) || 0;
    const height = Math.max(1, Number(card.height) || 1);
    const offset = Math.max(0, Math.min(height - 1, Number(anchor.offset) || 0));
    return Math.max(0, (Number(card.top) || 0) + offset);
  }

  function createGeneration() {
    let value = 0;
    return {
      next() { value += 1; return value; },
      isCurrent(token) { return token === value; },
      get current() { return value; },
    };
  }

  return { createCache, createGeneration, scrollAnchor, anchorScrollTop, DEFAULT_MAX_ITEMS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = NavigationState;
if (typeof window !== 'undefined') window.NavigationState = NavigationState;
