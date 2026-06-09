/* sheet.js — mobile bottom-sheet behaviour for the side panel.
 *
 * On narrow screens (≤820 px) the map fills the whole play area and #panel
 * becomes a draggable bottom sheet with three snap heights:
 *   peek — just the grab handle + headline (map is the star during playback)
 *   half — pick/result content alongside a usable map
 *   full — long content (final summary / leaderboard)
 * The sheet animates `height` (not transform) so the panel's sticky footer
 * ("Next round →") always rides its visible bottom edge. The visible height is
 * mirrored into a `--sheet-h` CSS var on #main so map overlays (legend,
 * attribution, attract caption) float above the sheet. Game code drives snap
 * changes on stage transitions; a user drag wins until the next transition.
 */
(function () {
  'use strict';

  var mq = window.matchMedia('(max-width: 820px)');
  var main, panel, handle;
  var state = 'half';          // current snap: 'peek' | 'half' | 'full'
  var userMoved = false;       // user dragged since the last programmatic set
  var dragging = false, startY = 0, startH = 0, movedPx = 0;

  function active() { return mq.matches && !!panel; }

  function safeBottom() {
    // env(safe-area-inset-bottom) isn't readable from JS; approximate via a
    // probe once. Cheap enough to recompute on demand.
    var probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;bottom:0;height:env(safe-area-inset-bottom,0px);width:0;';
    document.body.appendChild(probe);
    var h = probe.offsetHeight; probe.remove();
    return h;
  }

  function snapPx(s) {
    var H = main.clientHeight;
    if (s === 'peek') return Math.min(H - 60, 170 + safeBottom());
    if (s === 'full') return Math.max(220, H - 64);
    return Math.round(H * 0.46);                     // half
  }

  function applyHeight(px, animate) {
    panel.classList.toggle('sheet-anim', !!animate);
    panel.style.height = px + 'px';
    main.style.setProperty('--sheet-h', px + 'px');
    // At peek the sliver of content below the headline shouldn't scroll.
    panel.classList.toggle('sheet-peek', px <= snapPx('peek') + 4);
  }

  function set(s, opts) {
    state = s;
    if (!(opts && opts.keepUser)) userMoved = false;
    if (!active()) return;
    applyHeight(snapPx(s), true);
  }

  // Stage-driven raise that yields to an explicit user drag.
  function raiseIfUntouched(s) { if (!userMoved) set(s); }

  function visiblePx() { return active() ? (parseFloat(panel.style.height) || snapPx(state)) : 0; }

  function nearestSnap(px) {
    var best = 'half', bd = Infinity;
    ['peek', 'half', 'full'].forEach(function (s) {
      var d = Math.abs(snapPx(s) - px);
      if (d < bd) { bd = d; best = s; }
    });
    return best;
  }

  function onDown(e) {
    if (!active()) return;
    dragging = true; movedPx = 0;
    startY = e.clientY; startH = visiblePx();
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function onMove(e) {
    if (!dragging) return;
    var dy = startY - e.clientY;
    movedPx = Math.max(movedPx, Math.abs(dy));
    var px = Math.max(snapPx('peek') * 0.6, Math.min(snapPx('full'), startH + dy));
    applyHeight(px, false);
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    if (movedPx < 6) {                       // a tap on the handle steps the sheet up
      set(state === 'peek' ? 'half' : state === 'half' ? 'full' : 'half', { keepUser: true });
      userMoved = true;
      return;
    }
    userMoved = true;
    state = nearestSnap(visiblePx());
    applyHeight(snapPx(state), true);
  }

  function refresh() {
    if (!panel) return;
    if (active()) { applyHeight(snapPx(state), false); }
    else {
      panel.style.height = '';               // desktop: CSS layout takes over
      panel.classList.remove('sheet-peek', 'sheet-anim');
      if (main) main.style.setProperty('--sheet-h', '0px');
    }
  }

  function init() {
    main = document.getElementById('main');
    panel = document.getElementById('panel');
    handle = document.getElementById('sheet-handle');
    if (!main || !panel || !handle) return;
    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    if (mq.addEventListener) mq.addEventListener('change', refresh);
    else mq.addListener(refresh);            // older Safari
    window.addEventListener('resize', refresh);
    window.addEventListener('orientationchange', refresh);
    refresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.Sheet = { active: active, set: set, raiseIfUntouched: raiseIfUntouched, visiblePx: visiblePx };
})();
