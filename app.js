/* JIN review app. Vanilla JS, offline-first. Data lives in IndexedDB; the Google Sheet is the source of truth. */
(function () {
  'use strict';
  var APP_VERSION = '2.0.1';
  var $ = function (id) { return document.getElementById(id); };
  var C = EKBCore;

  // ---------------------------------------------------------------- bottom tabs: add "dungeon" / "rules" later by adding rows here
  var ICONS = {
    home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"></path>',
    import: '<path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M4 21h16"></path>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z"></path><path d="M8 7h6"></path><path d="M8 11h6"></path>',
    dungeon: '<path d="M4 21V10a8 8 0 0 1 16 0v11"></path><path d="M4 21h16"></path><path d="M9 21v-6a3 3 0 0 1 6 0v6"></path>',
    rules: '<path d="M12 3l9 16H3z"></path><path d="M12 10v4"></path><path d="M12 17h.01"></path>'
  };
  var TABS = [
    { view: 'home', label: 'หน้าแรก', icon: 'home' },
    { view: 'add', label: 'นำเข้า', icon: 'import' },
    { view: 'lib', label: 'คลังคำ', icon: 'book' }
  ];
  var SVG = {
    tick: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7"></path></svg>',
    cross: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"></path><path d="M18 6L6 18"></path></svg>',
    left: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5"></path><path d="M11 6l-6 6 6 6"></path></svg>',
    right: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path></svg>',
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"></path><path d="M6 11l6-6 6 6"></path></svg>',
    flip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path><path d="M3 21v-5h5"></path></svg>',
    bulb: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6"></path><path d="M10 21h4"></path><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"></path></svg>'
  };
  var RESULT_UI = {
    Correct: { cls: 'good', label: 'ได้', icon: SVG.right, tint: '#3DB06E' },
    Wrong: { cls: 'bad', label: 'ไม่ได้', icon: SVG.left, tint: '#E5484D' },
    Partial: { cls: 'mid', label: 'เกือบ', icon: SVG.up, tint: '#F5C518' }
  };

  // ---------------------------------------------------------------- storage (IndexedDB key/value; db name stays "ekb" so nothing on the phone is lost)
  var idb = (function () {
    var dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (res, rej) {
        var r = indexedDB.open('ekb', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
      return dbp;
    }
    function tx(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (res, rej) {
          var t = db.transaction('kv', mode);
          var req = fn(t.objectStore('kv'));
          t.oncomplete = function () { res(req && req.result); };
          t.onerror = function () { rej(t.error); };
        });
      });
    }
    return {
      get: function (k) { return tx('readonly', function (s) { return s.get(k); }); },
      set: function (k, v) { return tx('readwrite', function (s) { return s.put(v, k); }); },
      del: function (k) { return tx('readwrite', function (s) { return s.delete(k); }); },
      clear: function () { return tx('readwrite', function (s) { return s.clear(); }); }
    };
  })();

  // ---------------------------------------------------------------- state
  var S = {
    settings: { url: '', token: '' },
    data: null,          // {config, tables, exported_at}
    pending: [],         // review/quiz events not yet confirmed by an export
    pendingIngest: [],   // pasted payloads waiting for a connection
    lastSync: '',
    session: null,       // the round in progress (also saved in IndexedDB)
    summary: null,       // the round just ended
    libTab: 'words'
  };
  var byId = {};

  function today() { return C.bkkDay(new Date()); }
  function nowIso() { return C.bkkIso(new Date()); }
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function tables() { return (S.data && S.data.tables) || {}; }
  function words() { return tables().Knowledge_Master || []; }
  function config() { return (S.data && S.data.config) || {}; }
  function indexWords() { byId = {}; words().forEach(function (w) { byId[w.word_id] = w; }); }
  /** Server history plus everything still on this phone. Every SRS / queue / today number uses this. */
  function fullHistory() { return C.mergeHistory(tables().Learning_History || [], S.pending); }
  function quizEvery() {
    var v = config().quiz_every;
    if (v === undefined || v === null || v === '') return 6;
    var n = Number(v);
    return isFinite(n) && n >= 0 ? Math.floor(n) : 6;
  }
  function bold(text, word) {
    return C.highlightParts(text, word).map(function (p) { return p.hit ? '<b>' + esc(p.t) + '</b>' : esc(p.t); }).join('');
  }
  function thaiDate() {
    var b = new Date(Date.now() + 7 * 3600e3);
    var days = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
    var months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
    return days[b.getUTCDay()] + ' ' + b.getUTCDate() + ' ' + months[b.getUTCMonth()];
  }

  function persist() {
    return Promise.all([
      idb.set('pending', S.pending),
      idb.set('pendingIngest', S.pendingIngest),
      idb.set('settings', S.settings),
      idb.set('lastSync', S.lastSync)
    ]);
  }
  function saveSession() {
    if (!S.session) return idb.del('session').catch(function () {});
    var s = S.session;
    return idb.set('session', {
      id: s.id, day: s.day, startedAt: s.startedAt, mode: s.mode, queue: s.queue, i: s.i, answers: s.answers,
      retried: s.retried, quizzes: s.quizzes, sinceQuiz: s.sinceQuiz
    }).catch(function () {});
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 3200);
  }

  // ---------------------------------------------------------------- network
  function call(action, body) {
    if (!S.settings.url || !S.settings.token) return Promise.reject(new Error('ยังไม่ได้ตั้งค่า URL และ Token'));
    var payload = Object.assign({ action: action, token: S.settings.token }, body || {});
    return fetch(S.settings.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // simple request: no CORS preflight
      body: JSON.stringify(payload),
      redirect: 'follow'
    }).then(function (r) {
      if (!r.ok) throw new Error('เซิร์ฟเวอร์ตอบ ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!j.ok) throw new Error(j.error === 'unauthorized' ? 'Token ไม่ถูกต้อง' : (j.error || 'ผิดพลาด'));
      return j;
    });
  }

  var syncing = false;
  /**
   * 1) send pasted payloads, 2) send review events, 3) pull the whole database.
   * Events stay in S.pending until the export in step 3 shows their rows (or the server says it skipped them).
   * Dropping them right after step 2 was bug 9: while the export was still loading, or when it failed,
   * the phone had neither the pending events nor the new rows, so the same words came back.
   */
  function sync(opts) {
    opts = opts || {};
    if (syncing) return Promise.resolve();
    if (!navigator.onLine) { if (!opts.quiet) toast('ออฟไลน์อยู่ ผลทบทวนเก็บไว้ในเครื่องแล้ว'); return Promise.resolve(); }
    syncing = true;
    $('sync-btn').disabled = true;
    $('sync-btn').classList.add('spin');
    $('sync-status').textContent = 'กำลัง sync...';
    var report = { reviews: 0, ingested: 0 };
    var skipped = [];

    var chain = Promise.resolve();
    S.pendingIngest.slice().forEach(function (item) {
      chain = chain.then(function () {
        return call('ingest', { payload: item.payload }).then(function (r) {
          report.ingested += r.counts.added;
          S.pendingIngest = S.pendingIngest.filter(function (x) { return x.id !== item.id; });
        });
      });
    });
    var sent = S.pending.slice();
    for (var at = 0; at < sent.length; at += 500) {
      (function (batch) {
        chain = chain.then(function () {
          return call('log_reviews', { events: batch }).then(function (r) {
            report.reviews += r.written || 0;
            skipped = skipped.concat(r.skipped_cids || []);
          });
        });
      })(sent.slice(at, at + 500));
    }
    return chain.then(function () { return call('export'); })
      .then(function (r) {
        S.data = { config: r.config, tables: r.tables, exported_at: r.exported_at };
        indexWords();
        S.pending = C.prunePending(S.pending, r.tables.Learning_History || [], skipped);
        S.lastSync = nowIso();
        return idb.set('data', S.data).then(persist);
      })
      .then(function () {
        if (!opts.quiet) {
          var parts = ['Sync แล้ว'];
          if (report.reviews) parts.push('ส่งผลทบทวน ' + report.reviews + ' รายการ');
          if (report.ingested) parts.push('เพิ่มคำใหม่ ' + report.ingested + ' รายการ');
          toast(parts.join(' '));
        }
      })
      .catch(function (err) {
        persist();
        if (!opts.quiet) toast('Sync ไม่สำเร็จ: ' + err.message, 5000);
      })
      .then(function () {
        syncing = false;
        $('sync-btn').disabled = false;
        $('sync-btn').classList.remove('spin');
        if (current === 'home') renderHome();
        else renderSyncLine();
      });
  }

  // ---------------------------------------------------------------- navigation
  var current = 'home';
  function renderTabs() {
    $('tabs').innerHTML = TABS.map(function (t) {
      return '<button class="tab" data-view="' + t.view + '"><svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[t.icon] + '</svg>' + esc(t.label) + '</button>';
    }).join('');
  }
  function show(view) {
    current = view;
    ['home', 'review', 'quiz', 'done', 'add', 'lib', 'settings'].forEach(function (v) { $('view-' + v).hidden = v !== view; });
    var tabView = (view === 'done' || view === 'settings') ? 'home' : view;
    document.querySelectorAll('.tab').forEach(function (t) {
      if (t.dataset.view === tabView) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    var immersive = view === 'review' || view === 'quiz';
    $('tabs').hidden = immersive;
    document.body.classList.toggle('no-scroll', immersive);
    window.scrollTo(0, 0);
    if (view === 'home') renderHome();
    if (view === 'lib') renderLib();
    if (view === 'settings') renderSettings();
  }

  // ---------------------------------------------------------------- home
  function renderSyncLine() {
    $('sync-status').textContent = S.lastSync ? 'Sync ล่าสุด ' + S.lastSync.replace('T', ' ').slice(0, 16) : 'ยังไม่เคย sync';
    var pend = [];
    if (S.pending.length) pend.push('· รอส่ง ' + S.pending.length + ' รายการ');
    if (S.pendingIngest.length) pend.push('· ชุดคำรอส่ง ' + S.pendingIngest.length);
    $('sync-pending').textContent = pend.join(' ');
  }

  function renderHome() {
    var ws = words();
    var hist = fullHistory();
    var q = C.buildQueue(ws, hist, config(), today());
    var ts = C.todayStats(hist, today());
    $('home-date').textContent = thaiDate();
    $('stat-words').textContent = ws.length;
    $('stat-patterns').textContent = '+ Pattern ' + (tables().Pattern_Master || []).length;
    $('stat-today').textContent = ts.words;
    $('stat-acc').textContent = ts.pct === null ? 'ยังไม่ได้ทบทวน' : 'ถูก ' + ts.pct + '%';
    var resume = S.session && S.session.answers.length && S.session.day === today();
    $('start-title').textContent = resume ? 'ทบทวนต่อ' : 'เริ่มทบทวน';
    $('start-btn').disabled = !S.data || !ws.length;
    $('start-sub').textContent = !S.data ? 'กด Sync หรือไปที่ตั้งค่าเพื่อเชื่อมฐานข้อมูล'
      : 'ครบกำหนด ' + q.dueTotal + ' คำ · พอเมื่อไหร่กดจบรอบ';
    renderSyncLine();
  }

  // ---------------------------------------------------------------- review round
  function newSession(ids, mode) {
    return { id: uid(), day: today(), startedAt: Date.now(), mode: mode || 'normal', queue: ids, i: 0, answers: [],
      retried: {}, quizzes: { A: { n: 0, ok: 0 }, B: { n: 0, ok: 0 } }, sinceQuiz: 0 };
  }

  function startSession() {
    if (!S.data) return;
    if (!(S.session && S.session.day === today())) {
      var q = C.buildQueue(words(), fullHistory(), config(), today());
      var ids = q.due.concat(q.fresh.slice(0, q.freshCap)).map(function (w) { return w.word_id; });
      S.session = newSession(ids, 'normal');
      saveSession();
    }
    show('review');
    renderCard();
  }

  function reviewedCount() {
    var seen = {};
    (S.session ? S.session.answers : []).forEach(function (a) { seen[a.id] = true; });
    return Object.keys(seen).length;
  }

  function currentWord() {
    var s = S.session;
    while (s && s.i < s.queue.length && !byId[s.queue[s.i]]) s.i += 1; // word deleted from the sheet
    return s && s.i < s.queue.length ? byId[s.queue[s.i]] : null;
  }

  function posBox(w, mini) {
    var p = C.posStyle(w.pos);
    if (mini) return '<span class="mini-pos" style="background:' + p.box + ';color:' + p.ink + '">' + p.label + '</span>';
    return '<div class="pos-box" style="background:' + p.box + ';color:' + p.ink + '"><span class="abbr">' + p.label +
      '</span><span class="rule"></span><span class="full">' + esc(p.full) + '</span></div>';
  }

  function frontHtml(w) {
    return '<div class="front"><div class="tags">' + posBox(w) +
      (w.cefr ? '<div class="lvl-box"><small>LEVEL</small><span>' + esc(w.cefr) + '</span></div>' : '') +
      '</div><div class="front-mid"><span class="front-word" id="front-word">' + esc(w.word) + '</span>' +
      (w.ipa ? '<span class="front-ipa">' + esc(w.ipa) + '</span>' : '') +
      (w.thai_pron ? '<span class="front-pron">' + esc(w.thai_pron) + '</span>' : '') +
      '</div><div class="front-tap">' + SVG.flip + 'แตะการ์ดเพื่อพลิกดูความหมาย</div></div>';
  }

  /** The back of a card. Every section is hidden when its data is empty (old rows show what they have). */
  function backHtml(w) {
    var p = C.posStyle(w.pos);
    var col = C.splitCollocation(w.collocation);
    var syn = C.toList(w.synonym);
    var html = '<div class="back-head">' + posBox(w, true) + (w.cefr ? '<span class="mini-lvl">' + esc(w.cefr) + '</span>' : '') +
      '<span class="back-word">' + esc(w.word) + '</span>' + (w.ipa ? '<span class="back-ipa">' + esc(w.ipa) + '</span>' : '') + '</div>';
    if (w.meaning_th || w.meaning_en) {
      html += '<div class="sec" style="gap:1px">' + (w.meaning_th ? '<span class="mean-th">' + esc(w.meaning_th) + '</span>' : '') +
        (w.meaning_en ? '<span class="mean-en">' + esc(w.meaning_en) + '</span>' : '') + '</div>';
    }
    if (col.preps.length) {
      html += '<div class="sec"><span class="sec-label">+ PREPOSITION</span><div class="prep-grid">' + col.preps.map(function (r) {
        return '<span class="prep-base">' + esc(r.base) + '</span><span class="prep-op">+</span><span class="pill" style="background:' +
          C.prepColor(r.prep) + '">' + esc(r.prep) + '</span><span class="prep-op">=</span><span class="prep-mean">' + esc(r.meaning) + '</span>';
      }).join('') + '</div></div>';
    }
    if (syn.length || col.plain.length) {
      var cols = [];
      if (syn.length) cols.push('<div class="sec"><span class="sec-label">คำใกล้เคียง</span><div class="chips">' +
        syn.map(function (x) { return '<span class="chip">' + esc(x) + '</span>'; }).join('') + '</div></div>');
      if (col.plain.length) cols.push('<div class="sec"><span class="sec-label">ใช้คู่กับ</span><div class="chips">' +
        col.plain.map(function (x) { return '<span class="chip">' + bold(x, w.word) + '</span>'; }).join('') + '</div></div>');
      html += '<div class="two-col' + (cols.length === 1 ? ' one' : '') + '">' + cols.join('') + '</div>';
    }
    if (w.example) {
      html += '<div class="example" style="border-color:' + p.box + '"><span class="en">' + bold(w.example, w.word) + '</span>' +
        (w.example_th ? '<span class="th">' + esc(w.example_th) + '</span>' : '') + '</div>';
    }
    if (w.usage_tip) {
      html += '<div class="tip"><span class="tip-title">' + SVG.bulb + 'ทริคการใช้</span><span class="tip-text">' +
        C.tipParts(w.usage_tip).map(function (x) {
          return x.prep ? '<b style="color:' + C.prepColor(x.prep, true) + '">' + esc(x.t) + '</b>' : esc(x.t);
        }).join('') + '</span></div>';
    }
    return html;
  }

  function fitWord() {
    var el = $('front-word');
    if (!el) return;
    var box = el.parentNode;
    var size = 72;
    el.style.fontSize = size + 'px';
    var maxH = box.clientHeight * 0.62;
    while (size > 26 && (el.scrollWidth > box.clientWidth || el.offsetHeight > maxH)) {
      size -= 4;
      el.style.fontSize = size + 'px';
    }
  }

  function renderCard() {
    var s = S.session;
    $('review-count').textContent = reviewedCount();
    var w = currentWord();
    var card = $('card');
    resetCardPosition();
    if (!w) {
      card.hidden = true;
      $('card-peek').hidden = true;
      $('answers').hidden = true;
      var q = C.buildQueue(words(), fullHistory(), config(), today());
      var inQ = {};
      s.queue.forEach(function (id) { inQ[id] = true; });
      var newLeft = q.fresh.filter(function (x) { return !inQ[x.word_id]; }).length;
      var aheadLeft = q.ahead.filter(function (x) { return !inQ[x.word_id]; }).length;
      $('more-new').hidden = !newLeft;
      $('more-ahead').hidden = !aheadLeft;
      $('empty-sub').textContent = newLeft ? 'ยังมีคำใหม่อีก ' + newLeft + ' คำ' : (aheadLeft ? 'ทบทวนล่วงหน้าได้ ' + aheadLeft + ' คำ' : 'ท่องครบทุกคำในคลังแล้ว');
      $('review-empty').hidden = false;
      return;
    }
    $('review-empty').hidden = true;
    card.hidden = false;
    $('answers').hidden = false;
    var p = C.posStyle(w.pos);
    // A new card always starts on its front, without playing the flip animation backwards.
    var inner = $('card-inner');
    inner.style.transition = 'none';
    card.classList.remove('flipped');
    $('face-front').style.background = p.bg;
    $('face-back').style.background = p.bg;
    $('face-front').innerHTML = frontHtml(w);
    $('back-scroll').innerHTML = backHtml(w);
    $('back-scroll').scrollTop = 0;
    void inner.offsetWidth;
    inner.style.transition = '';
    var next = s.queue[s.i + 1] && byId[s.queue[s.i + 1]];
    $('card-peek').hidden = !next;
    if (next) $('card-peek').style.background = C.posStyle(next.pos).bg;
    s.shownAt = Date.now();
    s.flippedAt = 0;
    fitWord();
    card.focus({ preventScroll: true });
  }

  function flip() {
    var s = S.session;
    if (!s || !currentWord() || busy) return;
    if (!s.flippedAt) s.flippedAt = Date.now();
    $('card').classList.toggle('flipped');
  }

  function logEvent(wordId, activity, result, startedAt) {
    var ev = {
      cid: uid(),
      logged_at: nowIso(),
      word_id: wordId,
      activity: activity,
      result: result,
      response_time_s: startedAt ? Math.round((Date.now() - startedAt) / 100) / 10 : ''
    };
    S.pending.push(ev);
    idb.set('pending', S.pending);
    return ev;
  }

  function answer(result) {
    var s = S.session;
    var w = currentWord();
    if (!s || !w) return;
    var ev = logEvent(w.word_id, 'flashcard_en_th', result, s.shownAt);
    if (s.flippedAt) ev.response_time_s = Math.round((s.flippedAt - s.shownAt) / 100) / 10;
    s.answers.push({ id: w.word_id, result: result });
    // A missed card comes back once at the end of the round.
    if (result === 'Wrong' && !s.retried[w.word_id]) {
      s.retried[w.word_id] = true;
      s.queue.push(w.word_id);
    }
    s.i += 1;
    s.sinceQuiz += 1;
    saveSession();
    var every = quizEvery();
    if (every > 0 && s.sinceQuiz >= every) {
      s.sinceQuiz = 0;
      var quiz = C.pickQuiz(words(), fullHistory(), [w.word_id]);
      if (quiz) { showQuiz(quiz); return; }
    }
    renderCard();
  }

  // ---------------------------------------------------------------- swipe
  var busy = false;
  var drag = null;
  function resetCardPosition() {
    var card = $('card');
    card.classList.remove('animating');
    card.style.transform = '';
    setFeedback(null, 0);
  }
  function setFeedback(kind, amount) {
    var tag = $('swipe-tag');
    var tint = $('card').querySelector('.tint');
    if (!kind) { tag.style.opacity = 0; if (tint) tint.style.opacity = 0; return; }
    var ui = RESULT_UI[kind];
    if (tag.dataset.kind !== kind) {
      tag.dataset.kind = kind;
      tag.className = 'swipe-tag ' + ui.cls;
      tag.innerHTML = ui.icon + ui.label;
    }
    tag.style.opacity = Math.min(1, amount);
    tint.style.background = ui.tint;
    tint.style.opacity = Math.min(0.35, amount * 0.35);
  }
  function canScrollBack(dy) {
    if (!$('card').classList.contains('flipped')) return false;
    var el = $('back-scroll');
    var max = el.scrollHeight - el.clientHeight;
    if (max <= 1) return false;
    return dy < 0 ? el.scrollTop < max - 1 : el.scrollTop > 0;
  }
  function flyOut(result) {
    if (busy) return;
    busy = true;
    var card = $('card');
    var w = card.clientWidth;
    var h = card.clientHeight;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setFeedback(result, 1);
    card.classList.add('animating');
    if (result === 'Partial') card.style.transform = 'translate(0,' + (-h * 1.3) + 'px)';
    else card.style.transform = 'translate(' + (result === 'Correct' ? 1 : -1) * w * 1.5 + 'px,' + (drag ? drag.dy : 0) + 'px) rotate(' + (result === 'Correct' ? 18 : -18) + 'deg)';
    setTimeout(function () {
      busy = false;
      drag = null;
      answer(result);
    }, reduce ? 150 : 260);
  }
  function snapBack() {
    var card = $('card');
    card.classList.add('animating');
    card.style.transform = '';
    setFeedback(null, 0);
    setTimeout(function () { card.classList.remove('animating'); }, 270);
  }
  function bindSwipe() {
    var card = $('card');
    var tint = document.createElement('div');
    tint.className = 'tint';
    card.appendChild(tint);
    card.addEventListener('pointerdown', function (e) {
      if (busy || !currentWord() || (e.button !== undefined && e.button !== 0)) return;
      drag = { x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, mode: null, samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }], scroll0: $('back-scroll').scrollTop };
      try { card.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    });
    card.addEventListener('pointermove', function (e) {
      if (!drag || busy) return;
      drag.dx = e.clientX - drag.x0;
      drag.dy = e.clientY - drag.y0;
      drag.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
      if (drag.samples.length > 8) drag.samples.shift();
      if (!drag.mode) {
        if (Math.hypot(drag.dx, drag.dy) < 8) return;
        var vertical = Math.abs(drag.dy) > Math.abs(drag.dx);
        drag.mode = vertical && canScrollBack(drag.dy) ? 'scroll' : 'swipe';
      }
      e.preventDefault();
      if (drag.mode === 'scroll') { $('back-scroll').scrollTop = drag.scroll0 - drag.dy; return; }
      var w = card.clientWidth;
      var h = card.clientHeight;
      var y = drag.dy > 0 ? drag.dy * 0.3 : drag.dy;
      var rot = Math.max(-12, Math.min(12, drag.dx / w * 24));
      card.style.transform = 'translate(' + drag.dx + 'px,' + y + 'px) rotate(' + rot + 'deg)';
      if (Math.abs(drag.dx) >= Math.abs(drag.dy)) setFeedback(drag.dx > 0 ? 'Correct' : 'Wrong', Math.abs(drag.dx) / (w * 0.3));
      else if (drag.dy < 0) setFeedback('Partial', -drag.dy / (h * 0.25));
      else setFeedback(null, 0);
    });
    function end(e, cancelled) {
      if (!drag || busy) return;
      var d = drag;
      if (!d.mode) { drag = null; if (!cancelled) flip(); return; }
      if (d.mode === 'scroll') { drag = null; return; }
      var w = card.clientWidth;
      var h = card.clientHeight;
      var last = d.samples[d.samples.length - 1];
      var first = d.samples[0];
      for (var i = d.samples.length - 1; i >= 0; i--) { if (last.t - d.samples[i].t <= 100) first = d.samples[i]; }
      var dt = Math.max(1, last.t - first.t);
      var vx = (last.x - first.x) / dt;
      var vy = (last.y - first.y) / dt;
      var result = null;
      if (!cancelled) {
        if (Math.abs(d.dx) >= Math.abs(d.dy)) {
          if (d.dx > w * 0.3 || (vx > 0.5 && d.dx > 0)) result = 'Correct';
          else if (d.dx < -w * 0.3 || (vx < -0.5 && d.dx < 0)) result = 'Wrong';
        } else if (d.dy < 0 && (-d.dy > h * 0.25 || vy < -0.5)) {
          result = 'Partial';
        }
      }
      if (result) flyOut(result);
      else { drag = null; snapBack(); }
    }
    card.addEventListener('pointerup', function (e) { end(e, false); });
    card.addEventListener('pointercancel', function (e) { end(e, true); });
    // Older iOS ignores touch-action inside a scrolling page: stop it here too.
    card.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
  }

  // ---------------------------------------------------------------- quiz between cards
  var QZ = null;
  function daysAgoText(wordId) {
    var st = C.replayHistory(fullHistory(), config())[wordId];
    if (!st || !st.lastDay) return 'คำที่เคยท่องผ่านมา';
    var a = st.lastDay.split('-').map(Number);
    var b = today().split('-').map(Number);
    var n = Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
    return n <= 0 ? 'คำที่ท่องผ่านมาวันนี้' : 'คำที่ท่องผ่านมาเมื่อ ' + n + ' วันก่อน';
  }
  function showQuiz(q) {
    QZ = { q: q, shownAt: Date.now(), pos: null, mean: null, prep: null };
    $('quiz-title').textContent = q.type === 'B' ? 'ทาย Preposition' : 'คำถามแทรก';
    $('quiz-reviewed').textContent = reviewedCount();
    show('quiz');
    renderQuiz();
  }
  function markClass(isAnswer, isPicked, answered) {
    if (!answered) return '';
    if (isAnswer) return ' opt-right';
    if (isPicked) return ' opt-wrong';
    return ' opt-dim';
  }
  function renderQuiz() {
    var q = QZ.q;
    var w = q.word;
    var body = '';
    var foot = '';
    if (q.type === 'A') {
      body += '<div class="q-word"><span class="q-sub">' + esc(daysAgoText(w.word_id)) + '</span><span class="q-big">' + esc(w.word) + '</span>' +
        (w.ipa ? '<span class="q-ipa">' + esc(w.ipa) + '</span>' : '') + '</div>';
      body += '<div class="q-block"><span class="q-label">1. เป็นคำประเภทไหน?</span><div class="pos-opts">' + q.posOptions.map(function (k) {
        var st = C.POS_STYLE[k];
        var isAns = k === q.posAnswer;
        var picked = QZ.pos === k;
        var done = QZ.pos !== null;
        var style = done && isAns ? 'background:' + st.box + ';color:' + st.ink + ';border:3px solid #F2F0EA' : 'color:' + st.dark;
        var mark = done && (isAns || picked) ? (isAns ? SVG.tick : SVG.cross) : '';
        return '<button class="pos-opt' + (done && !isAns ? markClass(false, picked, true) : '') + '" data-pos="' + k + '" style="' + style + '"' +
          (done ? ' disabled' : '') + ' aria-label="' + st.full + (done && isAns ? ' (คำตอบที่ถูก)' : (done && picked ? ' (ผิด)' : '')) + '">' + mark + st.label + '</button>';
      }).join('') + '</div></div>';
      body += '<div class="q-block"><span class="q-label">2. แปลว่าอะไร?</span>' + q.meaningOptions.map(function (m, i) {
        var isAns = m === q.meaningAnswer;
        var picked = QZ.mean === m;
        var done = QZ.mean !== null;
        var mark = done && isAns ? '<span class="opt-mark">' + SVG.tick + 'ถูก</span>' : (done && picked ? '<span class="opt-mark">' + SVG.cross + 'ผิด</span>' : '');
        return '<button class="mean-opt' + markClass(isAns, picked, done) + '" data-mean="' + i + '"' + (done ? ' disabled' : '') + '><span>' + esc(m) + '</span>' + mark + '</button>';
      }).join('') + '</div>';
      if (QZ.pos !== null && QZ.mean !== null) {
        var right = (QZ.pos === q.posAnswer ? 1 : 0) + (QZ.mean === q.meaningAnswer ? 1 : 0);
        var title = right === 2 ? 'ถูกทั้ง 2 ข้อ' : right === 1 ? 'ถูก 1 จาก 2 ข้อ' : 'ผิดทั้ง 2 ข้อ';
        foot = '<div class="q-result ' + (right === 2 ? 'ok' : 'no') + '"><div class="q-result-text"><span class="q-result-title">' + title + '</span>' +
          (w.example ? '<span class="q-result-ex">' + bold(w.example, w.word) + '</span>' : '') + '</div><button class="q-next" id="quiz-next">ไปต่อ</button></div>';
      }
    } else {
      var done = QZ.prep !== null;
      body += '<div class="qb-prompt"><div class="qb-line"><span class="qb-base">' + esc(q.base) + '</span>' +
        (done ? '<span class="qb-blank filled" style="background:' + C.prepColor(q.answer) + '">' + esc(q.answer) + '</span>'
          : '<span class="qb-blank" aria-label="ช่องว่าง">?</span>') +
        '</div><span class="qb-mean">= ' + esc(q.meaning) + '</span></div>';
      body += '<div class="qb-opts">' + q.options.map(function (p) {
        var isAns = p === q.answer;
        var picked = QZ.prep === p;
        var style = done && isAns ? 'background:' + C.prepColor(p) + ';color:#FFFFFF;border-color:#F2F0EA;border-width:3px'
          : 'border-color:' + C.prepColor(p) + ';color:' + C.prepColor(p, true);
        var mark = done && isAns ? SVG.tick : (done && picked ? SVG.cross : '');
        return '<button class="qb-opt' + (done && !isAns ? (picked ? ' opt-wrong' : ' opt-dim') : '') + '" data-prep="' + esc(p) + '" style="' + style + '"' +
          (done ? ' disabled' : '') + ' aria-label="' + esc(p) + (done && isAns ? ' (คำตอบที่ถูก)' : (done && picked ? ' (ผิด)' : '')) + '">' + mark + esc(p) + '</button>';
      }).join('') + '</div>';
      if (done) {
        body += '<div class="qb-table"><span class="qb-table-title">เปลี่ยนคำเดียว ความหมายเปลี่ยน</span>' + q.rows.map(function (r) {
          return '<div class="qb-row"><span class="pill" style="background:' + C.prepColor(r.prep) + '">' + esc(r.prep) + '</span><span>' +
            esc(r.base) + ' ' + esc(r.prep) + ' = ' + esc(r.meaning) + '</span></div>';
        }).join('') + '</div>';
        foot = '<div class="q-result ' + (QZ.prep === q.answer ? 'ok' : 'no') + '"><div class="q-result-text"><span class="q-result-title">' +
          (QZ.prep === q.answer ? 'ถูกต้อง' : 'ยังไม่ใช่ คำตอบคือ ' + esc(q.answer)) + '</span></div><button class="q-next" id="quiz-next">ไปต่อ</button></div>';
      }
    }
    $('quiz-body').innerHTML = body;
    $('quiz-foot').innerHTML = foot;
    if (foot) $('quiz-next').focus({ preventScroll: true });
  }
  function quizClick(e) {
    if (!QZ) return;
    var q = QZ.q;
    var b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.pos && QZ.pos === null) {
      QZ.pos = b.dataset.pos;
      logEvent(q.word.word_id, 'quiz_pos', QZ.pos === q.posAnswer ? 'Correct' : 'Wrong', QZ.shownAt);
    } else if (b.dataset.mean !== undefined && QZ.mean === null) {
      QZ.mean = q.meaningOptions[Number(b.dataset.mean)];
      logEvent(q.word.word_id, 'quiz_meaning', QZ.mean === q.meaningAnswer ? 'Correct' : 'Wrong', QZ.shownAt);
    } else if (b.dataset.prep && QZ.prep === null) {
      QZ.prep = b.dataset.prep;
      logEvent(q.word.word_id, 'quiz_prep', QZ.prep === q.answer ? 'Correct' : 'Wrong', QZ.shownAt);
    } else {
      return;
    }
    var finished = q.type === 'A' ? (QZ.pos !== null && QZ.mean !== null) : QZ.prep !== null;
    if (finished && S.session) {
      var box = S.session.quizzes[q.type];
      box.n += 1;
      if (q.type === 'A' ? (QZ.pos === q.posAnswer && QZ.mean === q.meaningAnswer) : QZ.prep === q.answer) box.ok += 1;
      saveSession();
    }
    renderQuiz();
  }
  function leaveQuiz() {
    QZ = null;
    show('review');
    renderCard();
  }

  // ---------------------------------------------------------------- end of round
  function endSession() {
    var s = S.session;
    if (!s || !s.answers.length) {
      S.session = null;
      saveSession();
      show('home');
      return;
    }
    var r = { Correct: 0, Partial: 0, Wrong: 0 };
    var lastById = {};
    s.answers.forEach(function (a) { r[a.result] += 1; lastById[a.id] = a.result; });
    S.summary = {
      results: r, total: s.answers.length, words: Object.keys(lastById).length, ms: Date.now() - s.startedAt, quizzes: s.quizzes,
      missed: Object.keys(lastById).filter(function (id) { return lastById[id] !== 'Correct'; })
    };
    S.session = null;
    saveSession();
    renderSummary();
    show('done');
    if (S.settings.url && navigator.onLine) sync({ quiet: true });
  }

  function renderSummary() {
    var m = S.summary;
    var r = m.results;
    var mins = Math.round(m.ms / 60000);
    $('sum-time').textContent = 'จบรอบแล้ว · ' + (mins < 1 ? 'ใช้เวลาไม่ถึง 1 นาที' : 'ใช้เวลา ' + mins + ' นาที');
    $('sum-pct').textContent = Math.round(100 * r.Correct / m.total) + '%';
    $('sum-words').textContent = 'ทบทวน ' + m.words + ' คำในรอบนี้';
    $('sum-bar').innerHTML = [['Correct', '#3DB06E'], ['Partial', '#F5C518'], ['Wrong', '#E5484D']].map(function (x) {
      return r[x[0]] ? '<div style="flex:' + r[x[0]] + ';background:' + x[1] + '"></div>' : '';
    }).join('');
    $('sum-bar').setAttribute('aria-label', 'ได้ ' + r.Correct + ' เกือบ ' + r.Partial + ' ไม่ได้ ' + r.Wrong);
    $('sum-good').textContent = r.Correct;
    $('sum-mid').textContent = r.Partial;
    $('sum-bad').textContent = r.Wrong;
    var rows = '';
    if (m.quizzes.A.n) rows += '<div class="sum-row"><span>คำถามแทรก (ประเภท + ความหมาย)</span><b>' + m.quizzes.A.ok + ' / ' + m.quizzes.A.n + '</b></div>';
    if (m.quizzes.B.n) rows += '<div class="sum-row"><span>ทาย Preposition</span><b>' + m.quizzes.B.ok + ' / ' + m.quizzes.B.n + '</b></div>';
    $('sum-quiz').innerHTML = rows;
    $('sum-missed-wrap').hidden = !m.missed.length;
    $('retry-btn').hidden = !m.missed.length;
    $('sum-missed').innerHTML = m.missed.map(function (id) {
      var w = byId[id];
      if (!w) return '';
      var p = C.posStyle(w.pos);
      return '<span class="pos-chip" style="background:' + p.bg + '"><span class="tagc" style="background:' + p.box + ';color:' + p.ink + '">' + p.label + '</span>' + esc(w.word) + '</span>';
    }).join('');
  }

  function retryMissed() {
    if (!S.summary || !S.summary.missed.length) return;
    S.session = newSession(S.summary.missed.slice(), 'retry');
    saveSession();
    show('review');
    renderCard();
  }

  function addMore(kind) {
    var s = S.session;
    if (!s) return;
    var q = C.buildQueue(words(), fullHistory(), config(), today());
    var inQ = {};
    s.queue.forEach(function (id) { inQ[id] = true; });
    var list = (kind === 'new' ? q.fresh : q.ahead).filter(function (w) { return !inQ[w.word_id]; }).slice(0, 5);
    list.forEach(function (w) { s.queue.push(w.word_id); });
    saveSession();
    renderCard();
  }

  // ---------------------------------------------------------------- import from chat
  var lastParsed = null;
  var STATUS_TH = { added: 'ใหม่', duplicate: 'มีแล้ว', filled: 'เติมทริค', repeated: 'ผิดซ้ำ', invalid: 'ใช้ไม่ได้' };
  var TYPE_TH = { vocab: 'คำศัพท์', pattern: 'Pattern', mistake: 'ที่ผิด' };

  function previewAdd() {
    var text = $('add-text').value;
    $('add-result').textContent = '';
    if (!text.trim()) { $('add-preview').innerHTML = ''; $('save-btn').hidden = true; lastParsed = null; return; }
    var ex = C.extractPayload(text);
    if (!ex.ok) {
      $('add-preview').innerHTML = '<p class="preview-note err">' + esc(ex.error) + '</p>';
      $('save-btn').hidden = true;
      lastParsed = null;
      return;
    }
    var plan = C.planIngest(ex.payload, tables(), today());
    lastParsed = ex.payload;
    renderReport(plan.counts, plan.report, 'จะเพิ่ม');
    $('save-btn').hidden = plan.counts.added + plan.counts.updated + plan.counts.examples === 0;
  }

  function renderReport(counts, report, verb) {
    var html = '<p class="preview-summary">' + verb + ' ' + counts.added + ' รายการ';
    if (counts.examples) html += ' ตัวอย่าง pattern ' + counts.examples;
    if (counts.duplicate) html += '  มีอยู่แล้ว ' + counts.duplicate;
    if (counts.updated) html += '  อัปเดต ' + counts.updated;
    if (counts.invalid) html += '  ใช้ไม่ได้ ' + counts.invalid;
    html += '</p><ul class="preview-list">';
    report.forEach(function (r) {
      var notes = [];
      if (r.id && r.status !== 'added') notes.push('<span class="preview-note">' + esc(r.id) + '</span>');
      (r.errors || []).forEach(function (e) { notes.push('<span class="preview-note err">' + esc(e) + '</span>'); });
      (r.warnings || []).forEach(function (w) { notes.push('<span class="preview-note">' + esc(w) + '</span>'); });
      html += '<li><span class="badge badge-' + r.status + '">' + (STATUS_TH[r.status] || r.status) + '</span>' +
        '<div><div class="preview-label">' + esc(r.label || '-') + '</div>' +
        '<div class="preview-note">' + (TYPE_TH[r.type] || r.type) + '</div>' + notes.join('<br>') + '</div></li>';
    });
    $('add-preview').innerHTML = html + '</ul>';
  }

  function saveAdd() {
    if (!lastParsed) return;
    var payload = lastParsed;
    if (!S.settings.url) { toast('ตั้งค่า URL และ Token ก่อน'); show('settings'); return; }
    if (!navigator.onLine) {
      S.pendingIngest.push({ id: uid(), payload: payload, at: nowIso() });
      persist();
      $('add-result').textContent = 'ออฟไลน์อยู่ เก็บไว้แล้ว จะส่งตอนกด Sync';
      resetAdd(false);
      return;
    }
    $('save-btn').disabled = true;
    call('ingest', { payload: payload }).then(function (r) {
      renderReport(r.counts, r.report, 'บันทึกแล้ว');
      $('add-text').value = '';
      $('save-btn').hidden = true;
      lastParsed = null;
      toast('บันทึกลงฐานแล้ว ' + r.counts.added + ' รายการ');
      return sync({ quiet: true });
    }).catch(function (err) {
      $('add-result').textContent = 'บันทึกไม่สำเร็จ: ' + err.message;
    }).then(function () { $('save-btn').disabled = false; });
  }

  function resetAdd(clearPreview) {
    $('add-text').value = '';
    $('save-btn').hidden = true;
    lastParsed = null;
    if (clearPreview !== false) $('add-preview').innerHTML = '';
  }

  // ---------------------------------------------------------------- library
  function renderLib() {
    var qtext = C.normalizeKey($('lib-search').value);
    var t = tables();
    var html = '';
    var n = 0;
    document.querySelectorAll('.seg-btn').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.lib === S.libTab)); });

    if (S.libTab === 'words') {
      var st = C.replayHistory(fullHistory(), config());
      (t.Knowledge_Master || []).slice().reverse().forEach(function (w) {
        var hay = C.normalizeKey([w.word, w.meaning_th, w.meaning_en, w.tags].join(' '));
        if (qtext && hay.indexOf(qtext) < 0) return;
        n++;
        if (n > 300) return;
        var s = st[w.word_id];
        var p = C.posStyle(w.pos);
        html += '<li><button data-kind="word" data-id="' + esc(w.word_id) + '"><span class="lib-pos" style="background:' + p.box + ';color:' + p.ink + '">' + p.label + '</span>' +
          '<span class="lib-text"><span class="lib-word">' + esc(w.word) + '</span><span class="lib-th">' + esc(w.meaning_th) + '</span></span>' +
          '<span class="lib-meta">' + esc(w.cefr || '') + '</span><span class="status-dot ' + (s ? s.status : '') + '" title="' +
          (s ? (s.status === 'mastered' ? 'จำได้แล้ว' : 'กำลังเรียน') : 'ยังไม่เคยทบทวน') + '"></span></button></li>';
      });
    } else if (S.libTab === 'patterns') {
      (t.Pattern_Master || []).forEach(function (p) {
        var hay = C.normalizeKey([p.pattern, p.meaning_th, p.category].join(' '));
        if (qtext && hay.indexOf(qtext) < 0) return;
        n++;
        html += '<li><button data-kind="pattern" data-id="' + esc(p.pattern_id) + '">' +
          '<span class="lib-text"><span class="lib-word">' + esc(p.pattern) + '</span><span class="lib-th">' + esc(p.meaning_th) + '</span></span>' +
          '<span class="lib-meta">' + esc(p.cefr || '') + '</span></button></li>';
      });
    } else {
      (t.Mistake_Log || []).forEach(function (m) {
        var hay = C.normalizeKey([m.wrong_text, m.correct_text, m.error_type].join(' '));
        if (qtext && hay.indexOf(qtext) < 0) return;
        n++;
        html += '<li><button data-kind="mistake" data-id="' + esc(m.mistake_id) + '">' +
          '<span class="lib-text"><span class="lib-word">' + esc(m.correct_text) + '</span><span class="lib-th">เคยเขียน: ' + esc(m.wrong_text) + '</span></span>' +
          '<span class="lib-meta">x' + esc(m.times_repeated || 1) + '</span></button></li>';
      });
    }
    $('lib-list').innerHTML = html || '<li class="hint" style="padding:14px 0">' + (S.data ? 'ไม่พบรายการที่ค้นหา' : 'กด Sync ที่หน้าแรกเพื่อโหลดคลัง') + '</li>';
    $('lib-count').textContent = n ? n + ' รายการ' + (n > 300 ? ' แสดง 300 รายการล่าสุด พิมพ์ค้นหาเพื่อกรอง' : '') : '';
  }

  function row(label, value) {
    return value ? '<dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd>' : '';
  }

  function openDetail(kind, id) {
    var t = tables();
    var html = '';
    if (kind === 'word') {
      var w = byId[id];
      if (!w) return;
      var s = C.replayHistory(fullHistory(), config())[id];
      html = '<h2>' + esc(w.word) + '</h2><div class="detail-card" style="background:' + C.posStyle(w.pos).bg + '"><div class="back-scroll">' + backHtml(w) + '</div></div><dl>' +
        row('ตรงข้าม', w.antonym) + row('ตระกูลคำ', w.word_family) + row('สำนวนที่เกี่ยวข้อง', w.related_expressions) +
        row('Pattern', w.pattern_id) + row('แท็ก', w.tags) + row('หมายเหตุ', w.notes) +
        row('การทบทวน', s ? ('ทบทวน ' + s.reviews + ' ครั้ง ถูก ' + Math.round(s.accuracy * 100) + '% รอบถัดไป ' + s.due) : 'ยังไม่เคยทบทวน') +
        row('รหัส', w.word_id + (w.date_added ? '  เพิ่มเมื่อ ' + w.date_added : '')) + '</dl>';
    } else if (kind === 'pattern') {
      var p = (t.Pattern_Master || []).filter(function (x) { return x.pattern_id === id; })[0];
      if (!p) return;
      var exs = (t.Pattern_Examples || []).filter(function (x) { return x.pattern_id === id; });
      html = '<h2>' + esc(p.pattern) + '</h2><p class="hint">' + esc(p.structure) + '</p><dl>' +
        row('ความหมาย', p.meaning_th) + row('Meaning', p.meaning_en) + row('หมวด', [p.category, p.cefr, p.formality].filter(Boolean).join(', ')) +
        row('หมายเหตุ', p.notes) + '</dl>' +
        (exs.length ? '<dl>' + exs.map(function (x) { return '<dt>ตัวอย่าง</dt><dd>' + esc(x.example_en) + '<br><span class="hint">' + esc(x.example_th) + '</span></dd>'; }).join('') + '</dl>' : '');
    } else {
      var m = (t.Mistake_Log || []).filter(function (x) { return x.mistake_id === id; })[0];
      if (!m) return;
      html = '<h2>' + esc(m.correct_text) + '</h2><dl>' + row('เคยเขียน', m.wrong_text) + row('ประเภท', m.error_type) +
        row('เหตุผล', m.reason_th) + row('Reason', m.reason_en) + row('Pattern', m.pattern_id) + row('ผิดซ้ำ', String(m.times_repeated || 1) + ' ครั้ง') + '</dl>';
    }
    $('sheet-content').innerHTML = html;
    $('sheet').hidden = false;
  }

  // ---------------------------------------------------------------- settings
  function renderSettings() {
    $('set-url').value = S.settings.url || '';
    $('set-token').value = S.settings.token || '';
    $('version').textContent = 'JIN ' + APP_VERSION + ' · schema ' + C.SCHEMA_VERSION + (S.data && S.data.config ? ' · ชีต ' + (S.data.config.schema_version || '?') : '');
  }

  function saveSettings() {
    S.settings.url = $('set-url').value.trim();
    S.settings.token = $('set-token').value.trim();
    persist();
    if (!S.settings.url || !S.settings.token) { $('set-result').textContent = 'ใส่ URL และ Token เพื่อเชื่อมต่อ'; return; }
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(S.settings.url) && !/^http:\/\/localhost[:/]/.test(S.settings.url)) {
      $('set-result').textContent = 'URL ควรขึ้นต้นด้วย https://script.google.com/ และลงท้ายด้วย /exec';
      return;
    }
    $('set-result').textContent = 'กำลังทดสอบการเชื่อมต่อ...';
    call('ping').then(function () {
      $('set-result').textContent = 'เชื่อมต่อได้ กำลังโหลดฐานข้อมูล...';
      return sync().then(function () { $('set-result').textContent = 'เชื่อมต่อแล้ว มี ' + words().length + ' คำในคลัง'; });
    }).catch(function (err) {
      $('set-result').textContent = 'เชื่อมต่อไม่ได้: ' + err.message;
    });
  }

  // ---------------------------------------------------------------- wiring
  function bind() {
    renderTabs();
    $('tabs').addEventListener('click', function (e) {
      var b = e.target.closest('.tab');
      if (b) show(b.dataset.view);
    });
    $('start-btn').addEventListener('click', startSession);
    $('sync-btn').addEventListener('click', function () {
      if (!S.settings.url) { toast('ตั้งค่า URL และ Token ก่อน'); show('settings'); return; }
      sync();
    });
    $('settings-btn').addEventListener('click', function () { show('settings'); });
    $('settings-back').addEventListener('click', function () { show('home'); });

    bindSwipe();
    document.querySelectorAll('.ans').forEach(function (b) {
      b.addEventListener('click', function () { if (currentWord()) flyOut(b.dataset.result); });
    });
    $('review-end').addEventListener('click', endSession);
    $('empty-end').addEventListener('click', endSession);
    $('more-new').addEventListener('click', function () { addMore('new'); });
    $('more-ahead').addEventListener('click', function () { addMore('ahead'); });

    $('quiz-body').addEventListener('click', quizClick);
    $('quiz-foot').addEventListener('click', function (e) { if (e.target.closest('#quiz-next')) leaveQuiz(); });
    $('quiz-close').addEventListener('click', leaveQuiz);

    $('retry-btn').addEventListener('click', retryMissed);
    $('done-home').addEventListener('click', function () { show('home'); });

    document.addEventListener('keydown', function (e) {
      if (current !== 'review' || !currentWord() || busy) return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
      if (e.key === 'ArrowLeft' || e.key === '1') flyOut('Wrong');
      if (e.key === 'ArrowUp' || e.key === '2') flyOut('Partial');
      if (e.key === 'ArrowRight' || e.key === '3') flyOut('Correct');
    });

    var debounce = null;
    $('add-text').addEventListener('input', function () { clearTimeout(debounce); debounce = setTimeout(previewAdd, 250); });
    $('paste-btn').addEventListener('click', function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) { toast('เบราว์เซอร์นี้ไม่ให้อ่านคลิปบอร์ด กดค้างในช่องแล้วเลือกวาง'); return; }
      navigator.clipboard.readText().then(function (t) { $('add-text').value = t; previewAdd(); })
        .catch(function () { toast('อ่านคลิปบอร์ดไม่ได้ กดค้างในช่องแล้วเลือกวาง'); });
    });
    $('clear-btn').addEventListener('click', function () { resetAdd(); $('add-result').textContent = ''; });
    $('save-btn').addEventListener('click', saveAdd);

    document.querySelectorAll('.seg-btn').forEach(function (b) {
      b.addEventListener('click', function () { S.libTab = b.dataset.lib; renderLib(); });
    });
    $('lib-search').addEventListener('input', function () { clearTimeout(debounce); debounce = setTimeout(renderLib, 150); });
    $('lib-list').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-id]');
      if (b) openDetail(b.dataset.kind, b.dataset.id);
    });
    $('sheet-close').addEventListener('click', function () { $('sheet').hidden = true; });
    $('sheet').addEventListener('click', function (e) { if (e.target.id === 'sheet') $('sheet').hidden = true; });

    $('set-save').addEventListener('click', saveSettings);
    $('wipe-btn').addEventListener('click', function () {
      if (!window.confirm('ล้างข้อมูลในเครื่อง? ผลทบทวนที่ยังไม่ได้ sync จะหาย')) return;
      idb.clear().then(function () {
        S.data = null; S.pending = []; S.pendingIngest = []; S.lastSync = ''; S.session = null; byId = {};
        persist();
        toast('ล้างข้อมูลในเครื่องแล้ว');
        show('settings');
      });
    });
    window.addEventListener('online', function () { if (current === 'home') renderHome(); });
    window.addEventListener('offline', function () { if (current === 'home') renderHome(); });
    window.addEventListener('resize', function () { if (current === 'review') fitWord(); });
  }

  function boot() {
    bind();
    Promise.all(['settings', 'data', 'pending', 'pendingIngest', 'lastSync', 'session'].map(function (k) { return idb.get(k).catch(function () { return null; }); }))
      .then(function (v) {
        if (v[0]) S.settings = { url: v[0].url || '', token: v[0].token || '' };
        S.data = v[1] || null;
        S.pending = v[2] || [];
        S.pendingIngest = v[3] || [];
        S.lastSync = v[4] || '';
        var saved = v[5];
        if (saved && saved.day === today() && saved.queue) {
          S.session = saved;
          S.session.quizzes = saved.quizzes || { A: { n: 0, ok: 0 }, B: { n: 0, ok: 0 } };
          S.session.retried = saved.retried || {};
        } else if (saved) {
          idb.del('session').catch(function () {});
        }
        indexWords();
        show(S.settings.url ? 'home' : 'settings');
        if (!S.settings.url) $('set-result').textContent = 'เริ่มต้นใช้งาน: ใส่ Web App URL และ Token จาก Apps Script';
      });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  window.JINApp = window.EKBApp = { S: S, show: show, sync: sync }; // for debugging in the console
  boot();
})();
