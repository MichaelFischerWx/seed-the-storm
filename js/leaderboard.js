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
  // metric: 'total' (whole-game ACE) or 'storm' (best single-storm ACE).
  // mode: which basin board ('atl'|'epac'|'wpac'|'nio'|'nh').
  function top(metric, mode, n) {
    if (!ok) return Promise.resolve([]);
    var col = metric === 'storm' ? 'best_storm_ace' : 'total_ace';
    var url = BASE + '?select=name,total_ace,best_storm_ace&mode=eq.' + encodeURIComponent(mode || 'atl') +
      '&order=' + col + '.desc,created_at.asc&limit=' + (n || 20);
    return fetch(url, { headers: headers() })
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; });
  }
  function submit(name, totalAce, bestStormAce, avgPct, mode) {
    if (!ok) return Promise.reject(new Error('Leaderboard not configured.'));
    var err = validName(name);
    if (err) return Promise.reject(new Error(err));
    return fetch(BASE, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
      body: JSON.stringify({
        name: name.trim(),
        mode: mode || 'atl',
        total_ace: Number(totalAce.toFixed(1)),
        best_storm_ace: Number(bestStormAce.toFixed(1)),
        avg_pct: Math.round(avgPct),
      }),
    }).then(function (r) {
      if (r.ok) return r.json();
      return r.json().catch(function () { return {}; }).then(function (e) {
        var m = (e && (e.message || e.hint)) || '';
        throw new Error(/name|profan|allowed/i.test(m) ? 'Please choose a different name.' : 'Could not submit — please try again.');
      });
    });
  }

  window.Leaderboard = {
    configured: function () { return ok; },
    validName: validName, isClean: isClean, top: top, submit: submit,
  };
})();
