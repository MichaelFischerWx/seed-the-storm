/* leaderboard.js — optional global leaderboard via Supabase (PostgREST).
 *
 * Degrades to a no-op if window.SEEDSTORM_SUPABASE isn't configured, so the
 * game stays fully playable as a pure static site.
 *
 * The Supabase ANON key is public by design — it is safe to ship in the client.
 * Writes are guarded server-side by Row-Level Security + a profanity/validation
 * trigger (see supabase_setup.sql); the client-side checks below are only for
 * instant feedback and can't be trusted as the gate.
 */
(function () {
  'use strict';
  var cfg = window.SEEDSTORM_SUPABASE || null;
  var ok = !!(cfg && cfg.url && cfg.anonKey);
  var BASE = ok ? cfg.url.replace(/\/+$/, '') + '/rest/v1/scores' : null;

  function headers(extra) {
    var h = { apikey: cfg.anonKey, Authorization: 'Bearer ' + cfg.anonKey };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  // ---- client-side profanity pre-filter (UX only; server trigger is authoritative) ----
  var LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'i' };
  // Substring denylist (matched against a normalized, de-leeted, de-repeated name).
  // Extend to taste — keep it lowercase. Mirrors the server list in supabase_setup.sql.
  var BAD = [
    'fuck', 'shit', 'bitch', 'cunt', 'asshole', 'dick', 'pussy', 'bastard', 'slut',
    'whore', 'cock', 'twat', 'wank', 'bollock', 'prick', 'douche', 'jizz', 'cum',
    'penis', 'vagina', 'boner', 'dildo', 'porn', 'rape', 'molest', 'nazi', 'hitler',
    'nigger', 'nigga', 'faggot', 'fag', 'retard', 'spic', 'chink', 'kike', 'wetback',
    'coon', 'tranny', 'kkk', 'sex', 'anal', 'orgy'
  ];
  function norm(s) {                       // lowercase → de-leetspeak → letters only
    s = (s || '').toLowerCase();
    var out = '';
    for (var i = 0; i < s.length; i++) out += (LEET[s[i]] || s[i]);
    return out.replace(/[^a-z]/g, '');
  }
  function isClean(name) {
    // Match the denylist against BOTH the normalized name (catches leetspeak +
    // double-letter words like "nigger") and a repeat-collapsed copy (catches
    // elongations like "fuuuck"). Only the INPUT is collapsed, never the list —
    // collapsing "kkk"→"k" would flag every name with a "k".
    var n1 = norm(name), n2 = n1.replace(/(.)\1+/g, '$1');
    for (var i = 0; i < BAD.length; i++) {
      if (n1.indexOf(BAD[i]) >= 0 || n2.indexOf(BAD[i]) >= 0) return false;
    }
    return true;
  }
  function validName(name) {
    name = (name || '').trim();
    if (name.length < 3 || name.length > 12) return 'Name must be 3–12 characters.';
    if (!/^[A-Za-z0-9 _'\-]+$/.test(name)) return 'Use letters, numbers, spaces, _ - \' only.';
    if (!isClean(name)) return 'Please choose a different name.';
    return null;
  }

  // ---- REST ----
  // board: 'total'/'storm' (ACE-objective games) or 'peak' (Vmax-objective games).
  // mode: which basin board ('atl'|'epac'|'wpac'|'nio'|'nh'). Boards are segregated
  // by the objective the player was optimizing.
  var BOARD = { total: ['ace', 'total_ace'], storm: ['ace', 'best_storm_ace'], peak: ['vmax', 'best_peak_kt'] };
  var OBJ_COL = { ace: 'total_ace', vmax: 'best_peak_kt' };   // headline metric per objective (for ranks)

  // Public board = NAMED rows only (anonymous rows are for ranking, not display).
  function top(board, mode, n) {
    if (!ok) return Promise.resolve([]);
    var b = BOARD[board] || BOARD.total;
    var url = BASE + '?select=name,total_ace,best_storm_ace,best_peak_kt' +
      '&mode=eq.' + encodeURIComponent(mode || 'atl') +
      '&objective=eq.' + b[0] + '&name=not.is.null' +
      '&order=' + b[1] + '.desc,created_at.asc&limit=' + (n || 20);
    return fetch(url, { headers: headers() })
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; });
  }

  // Record a completed game as an anonymous row (name null). Returns its id (or null).
  // m = { totalAce, bestStormAce, bestPeakKt }.
  function record(mode, objective, m, avgPct) {
    if (!ok) return Promise.resolve(null);
    return fetch(BASE, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
      body: JSON.stringify({
        mode: mode || 'atl', objective: objective || 'ace',
        total_ace: Number((m.totalAce || 0).toFixed(1)),
        best_storm_ace: Number((m.bestStormAce || 0).toFixed(1)),
        best_peak_kt: Number((m.bestPeakKt || 0).toFixed(1)),
        avg_pct: Math.round(avgPct),
      }),
    }).then(function (r) { return r.ok ? r.json().then(function (a) { return a[0] && a[0].id; }) : null; })
      .catch(function () { return null; });
  }

  // Attach a name to a previously-recorded anonymous row (opt-in → public board).
  function claim(id, name) {
    if (!ok || id == null) return Promise.reject(new Error('Leaderboard not configured.'));
    var err = validName(name);
    if (err) return Promise.reject(new Error(err));
    return fetch(BASE + '?id=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
      body: JSON.stringify({ name: name.trim() }),
    }).then(function (r) {
      if (r.ok) return r.json();
      return r.json().catch(function () { return {}; }).then(function (e) {
        var msg = (e && (e.message || e.hint)) || '';
        throw new Error(/name|profan|allowed/i.test(msg) ? 'Please choose a different name.' : 'Could not save — please try again.');
      });
    });
  }

  // Where this score ranks (today + all-time) within its basin × objective, using
  // the objective's headline metric. Returns { today:{rank,total}, all:{rank,total} } or null.
  function _count(qs) {
    return fetch(BASE + '?' + qs + '&select=id&limit=1', { headers: headers({ Prefer: 'count=exact' }) })
      .then(function (r) { var cr = r.headers.get('content-range') || '*/0'; var t = parseInt(cr.split('/')[1], 10); return isFinite(t) ? t : 0; })
      .catch(function () { return 0; });
  }
  function rank(mode, objective, value) {
    if (!ok) return Promise.resolve(null);
    var col = OBJ_COL[objective] || 'total_ace';
    var base = 'mode=eq.' + mode + '&objective=eq.' + objective;
    var d = new Date();
    var midnight = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
    var gt = '&' + col + '=gt.' + value, day = '&created_at=gte.' + midnight;
    return Promise.all([_count(base), _count(base + gt), _count(base + day), _count(base + day + gt)])
      .then(function (c) { return { all: { rank: c[1] + 1, total: c[0] }, today: { rank: c[3] + 1, total: c[2] } }; });
  }

  window.Leaderboard = {
    configured: function () { return ok; },
    validName: validName, isClean: isClean, top: top, record: record, claim: claim, rank: rank,
  };
})();
