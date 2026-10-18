'use strict';

// The renderer consumes this as window.VirtualGrid; tests consume CommonJS.
// It only plans a row window. DOM ownership and card creation stay in app.js.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VirtualGrid = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function plan(options = {}) {
    const items = Array.isArray(options.items) ? options.items : [];
    const columns = Math.max(1, Math.floor(finite(options.columns, 1)));
    const rowHeight = Math.max(1, finite(options.rowHeight, 1));
    const viewportHeight = Math.max(0, finite(options.viewportHeight));
    const overscanRows = Math.max(0, Math.floor(finite(options.overscanRows, 2)));
    const totalRows = Math.ceil(items.length / columns);
    const totalHeight = totalRows * rowHeight;
    const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
    const scrollTop = Math.max(0, Math.min(finite(options.scrollTop), maxScrollTop));

    if (!items.length) {
      return {
        items: [], columns, rowHeight, scrollTop: 0,
        startRow: 0, endRow: 0, startIndex: 0, endIndex: 0,
        totalRows: 0, totalHeight: 0, topSpacer: 0, bottomSpacer: 0,
      };
    }

    const firstVisibleRow = Math.floor(scrollTop / rowHeight);
    const visibleEndRow = Math.max(firstVisibleRow + 1, Math.ceil((scrollTop + viewportHeight) / rowHeight));
    const startRow = Math.max(0, firstVisibleRow - overscanRows);
    const endRow = Math.min(totalRows, visibleEndRow + overscanRows);
    const startIndex = startRow * columns;
    const endIndex = Math.min(items.length, endRow * columns);

    return {
      items: items.slice(startIndex, endIndex),
      columns,
      rowHeight,
      scrollTop,
      startRow,
      endRow,
      startIndex,
      endIndex,
      totalRows,
      totalHeight,
      topSpacer: startRow * rowHeight,
      bottomSpacer: Math.max(0, totalHeight - endRow * rowHeight),
    };
  }

  return { plan };
});
