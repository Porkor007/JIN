/* EKB review app. Vanilla JS, offline-first. Data lives in IndexedDB; the Google Sheet is the source of truth. */
(function () {
  'use strict';
  var APP_VERSION = '1.0.0';
  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- storage (IndexedDB key/value)
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
      clear: function () { return tx('readwrite', function (s) { return s.clear(); }); }
    };
  })();

  // ---------------------------------------------------------------- state
  var S = {
    settings: { url: '', token: '', dir: 'en' },
    data: null,          // {config, tables, exported_at}
    pending: [],         // review events not yet sent
    pendingIngest: [],   // pasted payloads waiting for a connection
    lastSync: '',
    session: null,
    libTab: 'words'
  };

  function nowLocalIso() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return EKBCore.dayString(d) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function today() { return EKBCore.dayString(new Date()); }
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

  /** Server history plus events still waiting on this phone. */
  function fullHistory() {
    var h = (tables().Learning_History || []).slice();
    var have = {};
    h.forEach(function (r) { var m = /cid:([\w-]+)/.exec(String(r.note || '')); if (m) have[m[1]] = true; });
    S.pending.forEach(function (e) { if (!have[e.cid]) h.push(e); });
    return h;
  }

  function persist() {
    return Promise.all([
      idb.set('pending', S.pending),
      idb.set('pendingIngest', S.pendingIngest),
      idb.set('settings', S.settings),
      idb.set('lastSync', S.lastSync)
    ]);
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
  function sync(opts) {
    opts = opts || {};
    if (syncing) return Promise.resolve();
    if (!navigator.onLine) { if (!opts.quiet) toast('ออฟไลน์อยู่ ผลทบทวนเก็บไว้ในเครื่องแล้ว'); return Promise.resolve(); }
    syncing = true;
    $('sync-btn').disabled = true;
    $('sync-status').textContent = 'กำลัง sync...';
    var report = { reviews: 0, ingested: 0 };

    var chain = Promise.resolve();
    // 1) pasted entries saved while offline
    S.pendingIngest.slice().forEach(function (item) {
      chain = chain.then(function () {
        return call('ingest', { payload: item.payload }).then(function (r) {
          report.ingested += r.counts.added;
          S.pendingIngest = S.pendingIngest.filter(function (x) { return x.id !== item.id; });
        });
      });
    });
    // 2) review results
    chain = chain.then(function () {
      if (!S.pending.length) return;
      var batch = S.pending.slice(0, 500);
      return call('log_reviews', { events: batch }).then(function (r) {
        var ok = {};
        (r.accepted || []).forEach(function (c) { ok[c] = true; });
        report.reviews += r.written;
        S.pending = S.pending.filter(function (e) { return !ok[e.cid]; });
      });
    });
    // 3) pull the whole database
    return chain.then(function () { return call('export'); })
      .then(function (r) {
        S.data = { config: r.config, tables: r.tables, exported_at: r.exported_at };
        S.lastSync = nowLocalIso();
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
        toast('Sync ไม่สำเร็จ: ' + err.message, 5000);
      })
      .then(function () {
        syncing = false;
        $('sync-btn').disabled = false;
        renderHome();
      });
  }

  // ---------------------------------------------------------------- navigation
  var current = 'home';
  function show(view) {
    current = view;
    ['home', 'review', 'done', 'add', 'lib', 'settings'].forEach(function (v) { $('view-' + v).hidden = v !== view; });
    var tabView = (view === 'review' || view === 'done') ? 'home' : view;
    document.querySelectorAll('.tab').forEach(function (t) {
      if (t.dataset.view === tabView) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    document.querySelector('.tabs').hidden = view === 'review';
    window.scrollTo(0, 0);
    if (view === 'home') renderHome();
    if (view === 'lib') renderLib();
    if (view === 'settings') renderSettings();
  }

  // ---------------------------------------------------------------- home
  function sta(n) {
    var km = Math.floor(n / 1000);
    var m = n % 1000;
    return km + '+' + String(m).padStart(3, '0');
  }

  function renderHome() {
    var ws = words();
    var cfg = config();
    var target = Number(cfg.target_words) || 1000;
    var q = EKBCore.buildQueue(ws, fullHistory(), cfg, today());
    var mastered = 0;
    Object.keys(q.state).forEach(function (k) { if (q.state[k].status === 'mastered') mastered++; });

    $('sta').textContent = 'STA ' + sta(ws.length);
    $('sta-goal').textContent = 'เป้า ' + sta(target);
    var span = Math.max(target, ws.length);
    $('road-done').style.width = (100 * ws.length / span) + '%';
    $('road-mastered').style.width = (100 * mastered / span) + '%';
    var ticks = '';
    var step = span > 2000 ? 500 : 100;
    for (var t = step; t < span; t += step) ticks += '<i style="left:' + (100 * t / span) + '%"></i>';
    $('road-ticks').innerHTML = ticks;
    $('road-caption').innerHTML = S.data
      ? 'มี <b>' + ws.length + '</b> คำ จำได้แล้ว <b>' + mastered + '</b> กำลังเรียน ' + Object.keys(q.state).length
      : 'ยังไม่มีข้อมูล ไปที่ตั้งค่าเพื่อเชื่อมฐานข้อมูล';

    var d = new Date();
    $('today-title').textContent = d.toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long' });
    $('due-count').textContent = q.dueTotal;
    $('new-count').textContent = q.fresh.length;
    var total = q.due.length + q.fresh.length;
    var extra = Math.min(q.freshTotal, Number(cfg.daily_goal_new_words) || 5);
    $('start-btn').disabled = total === 0 && extra === 0;
    $('start-btn').textContent = total ? 'เริ่มทบทวน ' + total + ' คำ' : (extra ? 'เรียนคำใหม่อีก ' + extra + ' คำ' : 'ทบทวนครบทุกคำแล้ว');
    $('start-hint').textContent = q.dueTotal > q.due.length
      ? 'ค้างอีก ' + (q.dueTotal - q.due.length) + ' คำ จะเข้ารอบถัดไป'
      : (!S.data ? '' : (total ? '' : 'วันนี้ครบตามเป้าแล้ว จะไปต่อก็ได้'));

    $('sync-status').textContent = S.lastSync ? 'Sync ล่าสุด ' + S.lastSync.replace('T', ' ').slice(0, 16) : 'ยังไม่เคย sync';
    var pend = [];
    if (S.pending.length) pend.push('ผลทบทวนรอส่ง ' + S.pending.length);
    if (S.pendingIngest.length) pend.push('ชุดคำรอส่ง ' + S.pendingIngest.length);
    $('sync-pending').textContent = pend.join(' และ ');
  }

  // ---------------------------------------------------------------- review session
  function startSession() {
    var q = EKBCore.buildQueue(words(), fullHistory(), config(), today());
    var fresh = q.fresh;
    if (!q.due.length && !fresh.length) {
      // Daily goal reached: offer the next batch of never-seen words.
      fresh = words().filter(function (w) { return !q.state[w.word_id]; }).slice(0, Number(config().daily_goal_new_words) || 5);
    }
    var cards = q.due.concat(fresh).map(function (w) { return { w: w, isNew: fresh.indexOf(w) >= 0 }; });
    if (!cards.length) return;
    S.session = { cards: cards, i: 0, shownAt: 0, flippedAt: 0, results: { Correct: 0, Partial: 0, Wrong: 0 }, retried: {} };
    show('review');
    renderCard();
  }

  function renderCard() {
    var s = S.session;
    var c = s.cards[s.i];
    var w = c.w;
    var thFirst = S.settings.dir === 'th';
    $('review-progress').textContent = (s.i + 1) + ' / ' + s.cards.length;
    $('review-bar').style.width = (100 * s.i / s.cards.length) + '%';
    $('card').classList.remove('flipped');
    $('card-kind').textContent = [c.isNew ? 'คำใหม่' : 'ทบทวน', w.pos, w.cefr].filter(Boolean).join('  ');
    var front = thFirst ? (w.meaning_th || w.meaning_en) : w.word;
    $('card-word').textContent = front;
    $('card-word').classList.toggle('thai', thFirst);
    $('card-sub').textContent = thFirst ? '' : (w.ipa || '');
    $('card-tap').hidden = false;
    $('card-back').hidden = true;
    $('answers').hidden = true;
    s.shownAt = Date.now();
    s.flippedAt = 0;
    $('card').focus({ preventScroll: true });
  }

  function flip() {
    var s = S.session;
    if (!s || s.flippedAt) return;
    var w = s.cards[s.i].w;
    var thFirst = S.settings.dir === 'th';
    s.flippedAt = Date.now();
    $('card').classList.add('flipped');
    $('card-tap').hidden = true;
    if (thFirst) {
      $('card-meaning').textContent = w.word;
      $('card-meaning-en').textContent = [w.ipa, w.meaning_en].filter(Boolean).join('   ');
    } else {
      $('card-meaning').textContent = w.meaning_th || '';
      $('card-meaning-en').textContent = w.meaning_en || '';
      $('card-sub').textContent = [w.ipa, w.thai_pron].filter(Boolean).join('   ');
    }
    $('card-example').innerHTML = w.example
      ? '<p>' + esc(w.example) + '</p>' + (w.example_th ? '<p>' + esc(w.example_th) + '</p>' : '')
      : '';
    $('card-example').hidden = !w.example;
    var extra = [];
    if (w.synonym) extra.push('ใกล้เคียง: ' + w.synonym);
    if (w.collocation) extra.push('ใช้คู่กับ: ' + w.collocation);
    $('card-extra').textContent = extra.join('\n');
    $('card-extra').style.whiteSpace = 'pre-line';
    $('card-back').hidden = false;
    $('answers').hidden = false;
  }

  function answer(result) {
    var s = S.session;
    if (!s || !s.flippedAt) return;
    var c = s.cards[s.i];
    var ev = {
      cid: uid(),
      logged_at: nowLocalIso(),
      word_id: c.w.word_id,
      activity: S.settings.dir === 'th' ? 'flashcard_th_en' : 'flashcard_en_th',
      result: result,
      response_time_s: Math.round((s.flippedAt - s.shownAt) / 100) / 10
    };
    S.pending.push(ev);
    idb.set('pending', S.pending);
    s.results[result] += 1;
    // A missed card comes back once at the end of the round.
    if (result === 'Wrong' && !s.retried[c.w.word_id]) {
      s.retried[c.w.word_id] = true;
      s.cards.push({ w: c.w, isNew: false });
    }
    s.i += 1;
    if (s.i >= s.cards.length) finishSession(); else renderCard();
  }

  function finishSession() {
    var r = S.session.results;
    var n = r.Correct + r.Partial + r.Wrong;
    $('done-big').textContent = n ? Math.round(100 * r.Correct / n) + '%' : '0';
    $('done-detail').textContent = 'ได้ ' + r.Correct + '  เกือบ ' + r.Partial + '  ไม่ได้ ' + r.Wrong;
    S.session = null;
    show('done');
    if (S.settings.url && navigator.onLine) sync({ quiet: true });
  }

  function speak() {
    var s = S.session;
    if (!s || !('speechSynthesis' in window)) return;
    var w = s.cards[s.i].w;
    var u = new SpeechSynthesisUtterance(s.flippedAt && w.example ? w.word + '. ' + w.example : w.word);
    u.lang = 'en-US';
    u.rate = 0.92;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  // ---------------------------------------------------------------- add from chat
  var lastParsed = null;
  var STATUS_TH = { added: 'ใหม่', duplicate: 'มีแล้ว', repeated: 'ผิดซ้ำ', invalid: 'ใช้ไม่ได้' };
  var TYPE_TH = { vocab: 'คำศัพท์', pattern: 'Pattern', mistake: 'ที่ผิด' };

  function previewAdd() {
    var text = $('add-text').value;
    $('add-result').textContent = '';
    if (!text.trim()) { $('add-preview').innerHTML = ''; $('save-btn').hidden = true; lastParsed = null; return; }
    var ex = EKBCore.extractPayload(text);
    if (!ex.ok) {
      $('add-preview').innerHTML = '<p class="preview-note err">' + esc(ex.error) + '</p>';
      $('save-btn').hidden = true;
      lastParsed = null;
      return;
    }
    var plan = EKBCore.planIngest(ex.payload, tables(), today());
    lastParsed = ex.payload;
    renderReport(plan.counts, plan.report, 'จะเพิ่ม');
    $('save-btn').hidden = plan.counts.added + plan.counts.updated + plan.counts.examples === 0;
  }

  function renderReport(counts, report, verb) {
    var html = '<p class="preview-summary">' + verb + ' ' + counts.added + ' รายการ';
    if (counts.examples) html += ' ตัวอย่าง pattern ' + counts.examples;
    if (counts.duplicate) html += '  มีอยู่แล้ว ' + counts.duplicate;
    if (counts.updated) html += '  ผิดซ้ำ ' + counts.updated;
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
      S.pendingIngest.push({ id: uid(), payload: payload, at: nowLocalIso() });
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
    var qtext = EKBCore.normalizeKey($('lib-search').value);
    var t = tables();
    var html = '';
    var n = 0;
    document.querySelectorAll('.seg-btn').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.lib === S.libTab)); });

    if (S.libTab === 'words') {
      var st = EKBCore.replayHistory(fullHistory(), config());
      (t.Knowledge_Master || []).slice().reverse().forEach(function (w) {
        var hay = EKBCore.normalizeKey([w.word, w.meaning_th, w.meaning_en, w.tags].join(' '));
        if (qtext && hay.indexOf(qtext) < 0) return;
        n++;
        if (n > 300) return;
        var s = st[w.word_id];
        var cls = s ? 'dot-' + s.status : '';
        html += '<li><button data-kind="word" data-id="' + esc(w.word_id) + '"><span class="dot ' + cls + '"></span>' +
          '<span><span class="lib-word">' + esc(w.word) + '</span><span class="lib-th">' + esc(w.meaning_th) + '</span></span>' +
          '<span class="lib-meta">' + esc(w.cefr || '') + '</span></button></li>';
      });
    } else if (S.libTab === 'patterns') {
      (t.Pattern_Master || []).forEach(function (p) {
        var hay = EKBCore.normalizeKey([p.pattern, p.meaning_th, p.category].join(' '));
        if (qtext && hay.indexOf(qtext) < 0) return;
        n++;
        html += '<li><button data-kind="pattern" data-id="' + esc(p.pattern_id) + '"><span class="dot"></span>' +
          '<span><span class="lib-word">' + esc(p.pattern) + '</span><span class="lib-th">' + esc(p.meaning_th) + '</span></span>' +
          '<span class="lib-meta">' + esc(p.cefr || '') + '</span></button></li>';
      });
    } else {
      (t.Mistake_Log || []).forEach(function (m) {
        var hay = EKBCore.normalizeKey([m.wrong_text, m.correct_text, m.error_type].join(' '));
        if (qtext && hay.indexOf(qtext) < 0) return;
        n++;
        html += '<li><button data-kind="mistake" data-id="' + esc(m.mistake_id) + '"><span class="dot ' + (m.fixed === 'Yes' ? 'dot-mastered' : 'dot-learning') + '"></span>' +
          '<span><span class="lib-word">' + esc(m.correct_text) + '</span><span class="lib-th">เคยเขียน: ' + esc(m.wrong_text) + '</span></span>' +
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
      var w = (t.Knowledge_Master || []).filter(function (x) { return x.word_id === id; })[0];
      if (!w) return;
      var s = EKBCore.replayHistory(fullHistory(), config())[id];
      html = '<h2>' + esc(w.word) + '</h2><p class="card-sub">' + esc([w.ipa, w.thai_pron].filter(Boolean).join('   ')) + '</p><dl>' +
        row('ความหมาย', w.meaning_th) + row('Meaning', w.meaning_en) + row('ชนิดคำ', [w.pos, w.cefr, w.register].filter(Boolean).join(', ')) +
        row('ตัวอย่าง', w.example) + row('แปล', w.example_th) + row('ใกล้เคียง', w.synonym) + row('ตรงข้าม', w.antonym) +
        row('ใช้คู่กับ', w.collocation) + row('ตระกูลคำ', w.word_family) + row('สำนวนที่เกี่ยวข้อง', w.related_expressions) +
        row('Pattern', w.pattern_id) + row('แท็ก', w.tags) + row('หมายเหตุ', w.notes) +
        row('การทบทวน', s ? ('ทบทวน ' + s.reviews + ' ครั้ง ถูก ' + Math.round(s.accuracy * 100) + '% รอบถัดไป ' + s.due) : 'ยังไม่เคยทบทวน') +
        row('รหัส', w.word_id + (w.date_added ? '  เพิ่มเมื่อ ' + w.date_added : '')) + '</dl>';
    } else if (kind === 'pattern') {
      var p = (t.Pattern_Master || []).filter(function (x) { return x.pattern_id === id; })[0];
      if (!p) return;
      var exs = (t.Pattern_Examples || []).filter(function (x) { return x.pattern_id === id; });
      html = '<h2>' + esc(p.pattern) + '</h2><p class="card-sub">' + esc(p.structure) + '</p><dl>' +
        row('ความหมาย', p.meaning_th) + row('Meaning', p.meaning_en) + row('หมวด', [p.category, p.cefr, p.formality].filter(Boolean).join(', ')) +
        row('หมายเหตุ', p.notes) + '</dl>' +
        (exs.length ? '<div class="card-example" style="margin-top:18px">' + exs.map(function (x) {
          return '<p>' + esc(x.example_en) + '</p><p>' + esc(x.example_th) + '</p>';
        }).join('') + '</div>' : '');
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
    $('set-dir').value = S.settings.dir || 'en';
    $('version').textContent = 'EKB app ' + APP_VERSION + '  schema ' + EKBCore.SCHEMA_VERSION;
  }

  function saveSettings() {
    S.settings.url = $('set-url').value.trim();
    S.settings.token = $('set-token').value.trim();
    S.settings.dir = $('set-dir').value;
    persist();
    if (!S.settings.url || !S.settings.token) { $('set-result').textContent = 'บันทึกทิศทางการ์ดแล้ว ใส่ URL และ Token เพื่อเชื่อมต่อ'; return; }
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
    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { show(t.dataset.view); });
    });
    $('start-btn').addEventListener('click', startSession);
    $('sync-btn').addEventListener('click', function () {
      if (!S.settings.url) { toast('ตั้งค่า URL และ Token ก่อน'); show('settings'); return; }
      sync();
    });
    $('card').addEventListener('click', function (e) { if (!e.target.closest('#speak-btn')) flip(); });
    $('speak-btn').addEventListener('click', speak);
    document.querySelectorAll('.ans').forEach(function (b) {
      b.addEventListener('click', function () { answer(b.dataset.result); });
    });
    $('review-quit').addEventListener('click', function () {
      if (S.session && S.session.i > 0) finishSession(); else { S.session = null; show('home'); }
    });
    $('done-home').addEventListener('click', function () { show('home'); });

    document.addEventListener('keydown', function (e) {
      if (current !== 'review') return;
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
      if (S.session && S.session.flippedAt) {
        if (e.key === '1') answer('Wrong');
        if (e.key === '2') answer('Partial');
        if (e.key === '3') answer('Correct');
      }
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
      idb.clear().then(function () {
        S.data = null; S.pending = []; S.pendingIngest = []; S.lastSync = '';
        persist();
        toast('ล้างข้อมูลในเครื่องแล้ว');
        show('home');
      });
    });
    window.addEventListener('online', renderHome);
    window.addEventListener('offline', renderHome);
  }

  function boot() {
    bind();
    Promise.all(['settings', 'data', 'pending', 'pendingIngest', 'lastSync'].map(function (k) { return idb.get(k).catch(function () { return null; }); }))
      .then(function (v) {
        if (v[0]) S.settings = Object.assign(S.settings, v[0]);
        S.data = v[1] || null;
        S.pending = v[2] || [];
        S.pendingIngest = v[3] || [];
        S.lastSync = v[4] || '';
        show(S.settings.url ? 'home' : 'settings');
        if (!S.settings.url) $('set-result').textContent = 'เริ่มต้นใช้งาน: ใส่ Web App URL และ Token จาก Apps Script';
      });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  window.EKBApp = { S: S, show: show, sync: sync }; // for debugging in the console
  boot();
})();
