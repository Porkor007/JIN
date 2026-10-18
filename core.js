/* EKB core — shared by the Apps Script backend, the PWA and the Node tests.
 * Pure functions only: no Sheets, no DOM, no network.
 * Plain ES2017, no modules, so the same file runs as an Apps Script .gs file.
 */
var EKBCore = (function () {
  'use strict';

  var SCHEMA_VERSION = '3.1';
  var DELIM = '; ';
  var CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  var FREQUENCY = ['High', 'Medium', 'Low'];
  var REGISTER = ['Formal', 'Neutral', 'Informal'];
  var RESULTS = ['Correct', 'Wrong', 'Partial'];
  var TYPES = ['vocab', 'pattern', 'mistake'];

  var COLUMNS = {
    Knowledge_Master: ['word_id', 'word', 'word_key', 'ipa', 'thai_pron', 'cefr', 'pos', 'meaning_en', 'meaning_th',
      'synonym', 'antonym', 'collocation', 'word_family', 'root', 'prefix', 'suffix', 'frequency', 'register',
      'example', 'example_th', 'pattern_id', 'related_expressions', 'tags', 'difficulty', 'source', 'date_added', 'notes'],
    Pattern_Master: ['pattern_id', 'pattern', 'category', 'cefr', 'meaning_en', 'meaning_th', 'structure', 'formality', 'notes', 'difficulty'],
    Pattern_Examples: ['example_id', 'pattern_id', 'example_en', 'example_th', 'note', 'source'],
    Mistake_Log: ['mistake_id', 'wrong_text', 'correct_text', 'error_type', 'reason_en', 'reason_th', 'pattern_id',
      'difficulty', 'word_id', 'times_repeated', 'fixed'],
    Learning_History: ['log_id', 'logged_at', 'word_id', 'activity', 'result', 'response_time_s', 'source', 'note']
  };

  var LIST_FIELDS = ['synonym', 'antonym', 'collocation', 'word_family', 'related_expressions', 'tags'];

  // ---------- small helpers ----------
  function str(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  }

  /** The dedup key: trim + lowercase + collapse spaces + straighten apostrophes/quotes. */
  function normalizeKey(s) {
    return str(s)
      .replace(/[‘’‛′`´]/g, "'")
      .replace(/[“”″]/g, '"')
      .replace(/[–—]/g, '-')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Accepts an array or a "; " / "," separated string and returns a clean, de-duplicated array. */
  function toList(v) {
    if (v === null || v === undefined || v === '') return [];
    var arr = Array.isArray(v) ? v : String(v).split(/\s*;\s*/);
    var seen = {};
    var out = [];
    arr.forEach(function (x) {
      var t = str(x);
      var k = t.toLowerCase();
      if (t && !seen[k]) { seen[k] = true; out.push(t); }
    });
    return out;
  }

  function joinList(v) { return toList(v).join(DELIM); }

  function pickEnum(v, allowed) {
    var t = str(v);
    if (!t) return '';
    for (var i = 0; i < allowed.length; i++) {
      if (allowed[i].toLowerCase() === t.toLowerCase()) return allowed[i];
    }
    return null; // invalid
  }

  function toInt(v, min, max) {
    if (v === null || v === undefined || v === '') return '';
    var n = Number(v);
    if (!isFinite(n)) return null;
    n = Math.round(n);
    if (n < min || n > max) return null;
    return n;
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  /** Next id for a simple prefix scheme (VOC0001, ERR001...). Keeps the widest width already in use. */
  function makeIdAllocator(prefix, existingIds, defaultWidth) {
    var max = 0;
    var width = defaultWidth;
    var re = new RegExp('^' + prefix + '(\\d+)$');
    (existingIds || []).forEach(function (id) {
      var m = re.exec(str(id));
      if (m) {
        max = Math.max(max, parseInt(m[1], 10));
        width = Math.max(width, m[1].length);
      }
    });
    return function next() { max += 1; return prefix + pad(max, width); };
  }

  /** PAT-<HINT>-<nn>. One counter per hint. */
  function makePatternIdAllocator(existingIds) {
    var counters = {};
    (existingIds || []).forEach(function (id) {
      var m = /^PAT-([A-Z0-9]+)-(\d+)$/.exec(str(id));
      if (m) counters[m[1]] = Math.max(counters[m[1]] || 0, parseInt(m[2], 10));
    });
    return function next(hint) {
      var h = str(hint).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || 'GEN';
      counters[h] = (counters[h] || 0) + 1;
      return 'PAT-' + h + '-' + pad(counters[h], 2);
    };
  }

  function hintFromPattern(pattern) {
    var stop = { be: 1, s: 1, v: 1, sth: 1, sb: 1, to: 1, the: 1, a: 1, an: 1, it: 1, i: 1, am: 1, is: 1, are: 1, what: 1 };
    var words = str(pattern).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/);
    for (var i = 0; i < words.length; i++) {
      if (words[i].length > 1 && !stop[words[i]]) return words[i].toUpperCase();
    }
    return 'GEN';
  }

  // ---------- extracting JSON from a chat reply ----------
  /**
   * Finds the EKB payload inside a pasted Claude reply.
   * Accepts: a ```json fenced block, any fenced block, or bare JSON.
   * Returns {ok, payload, error}.
   */
  function extractPayload(text) {
    var t = String(text || '');
    var candidates = [];
    var fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
    var m;
    while ((m = fence.exec(t)) !== null) candidates.push(m[1]);
    if (!candidates.length) candidates.push(t);

    var lastErr = 'ไม่พบ JSON ในข้อความ';
    // Prefer the last block (the reply puts JSON at the end).
    for (var i = candidates.length - 1; i >= 0; i--) {
      var c = candidates[i].trim();
      var start = c.indexOf('{');
      var end = c.lastIndexOf('}');
      if (start < 0 || end < start) continue;
      var body = c.slice(start, end + 1)
        .replace(/[“”]/g, '"') // smart quotes that sneak in through copy/paste
        .replace(/,\s*([}\]])/g, '$1');  // trailing commas
      try {
        var obj = JSON.parse(body);
        if (Array.isArray(obj)) obj = { entries: obj };
        if (obj && !obj.entries && obj.type) obj = { entries: [obj] };
        if (!obj || !Array.isArray(obj.entries)) { lastErr = 'JSON ไม่มี "entries"'; continue; }
        return { ok: true, payload: obj };
      } catch (e) {
        lastErr = 'JSON อ่านไม่ได้: ' + e.message;
      }
    }
    if (lastErr === 'ไม่พบ JSON ในข้อความ' && t.indexOf('{') >= 0) {
      lastErr = 'JSON ไม่ครบ (น่าจะถูกตัดกลางทาง) ให้ Claude ส่งบล็อก JSON ใหม่';
    }
    return { ok: false, error: lastErr };
  }

  // ---------- validation ----------
  function validateVocab(e) {
    var errors = [];
    var warnings = [];
    var word = str(e.word);
    if (!word) errors.push('ไม่มี word');
    if (!str(e.meaning_th) && !str(e.meaning_en)) errors.push('ไม่มีความหมาย (meaning_th / meaning_en)');
    var cefr = pickEnum(e.cefr, CEFR);
    if (cefr === null) { warnings.push('cefr "' + e.cefr + '" ไม่ถูกต้อง เว้นว่างไว้'); cefr = ''; }
    var freq = pickEnum(e.frequency, FREQUENCY);
    if (freq === null) { warnings.push('frequency "' + e.frequency + '" ไม่ถูกต้อง เว้นว่างไว้'); freq = ''; }
    var reg = pickEnum(e.register, REGISTER);
    if (reg === null) { warnings.push('register "' + e.register + '" ไม่ถูกต้อง เว้นว่างไว้'); reg = ''; }
    var diff = toInt(e.difficulty, 1, 5);
    if (diff === null) { warnings.push('difficulty ต้องเป็น 1-5 เว้นว่างไว้'); diff = ''; }

    var row = {
      word: word,
      word_key: normalizeKey(word),
      ipa: str(e.ipa),
      thai_pron: str(e.thai_pron),
      cefr: cefr,
      pos: str(e.pos).toLowerCase(),
      meaning_en: str(e.meaning_en),
      meaning_th: str(e.meaning_th),
      root: str(e.root),
      prefix: str(e.prefix),
      suffix: str(e.suffix),
      frequency: freq,
      register: reg,
      example: str(e.example),
      example_th: str(e.example_th),
      difficulty: diff,
      source: str(e.source) || 'claude',
      notes: str(e.notes)
    };
    LIST_FIELDS.forEach(function (f) { row[f] = joinList(e[f]); });
    return { errors: errors, warnings: warnings, row: row, pattern_ref: str(e.pattern_ref || e.pattern_id) };
  }

  function validatePattern(e) {
    var errors = [];
    var warnings = [];
    if (!str(e.pattern)) errors.push('ไม่มี pattern');
    var cefr = pickEnum(e.cefr, CEFR);
    if (cefr === null) { warnings.push('cefr ไม่ถูกต้อง เว้นว่างไว้'); cefr = ''; }
    var form = pickEnum(e.formality, REGISTER);
    if (form === null) { warnings.push('formality ไม่ถูกต้อง เว้นว่างไว้'); form = ''; }
    var diff = toInt(e.difficulty, 1, 5);
    if (diff === null) { warnings.push('difficulty ต้องเป็น 1-5 เว้นว่างไว้'); diff = ''; }
    var examples = (Array.isArray(e.examples) ? e.examples : []).map(function (x) {
      if (typeof x === 'string') return { example_en: str(x), example_th: '', note: '' };
      return { example_en: str(x.en || x.example_en), example_th: str(x.th || x.example_th), note: str(x.note) };
    }).filter(function (x) { return x.example_en; });
    return {
      errors: errors,
      warnings: warnings,
      row: {
        pattern: str(e.pattern),
        category: str(e.category),
        cefr: cefr,
        meaning_en: str(e.meaning_en),
        meaning_th: str(e.meaning_th),
        structure: str(e.structure),
        formality: form,
        notes: str(e.notes),
        difficulty: diff
      },
      id_hint: str(e.id_hint) || hintFromPattern(e.pattern),
      examples: examples
    };
  }

  function validateMistake(e) {
    var errors = [];
    var warnings = [];
    if (!str(e.wrong_text)) errors.push('ไม่มี wrong_text');
    if (!str(e.correct_text)) errors.push('ไม่มี correct_text');
    var diff = toInt(e.difficulty, 1, 5);
    if (diff === null) { warnings.push('difficulty ต้องเป็น 1-5 เว้นว่างไว้'); diff = ''; }
    return {
      errors: errors,
      warnings: warnings,
      row: {
        wrong_text: str(e.wrong_text),
        correct_text: str(e.correct_text),
        error_type: str(e.error_type),
        reason_en: str(e.reason_en),
        reason_th: str(e.reason_th),
        difficulty: diff,
        times_repeated: 1,
        fixed: 'No'
      },
      pattern_ref: str(e.pattern_ref || e.pattern_id),
      word_ref: str(e.word_ref || e.word_id)
    };
  }

  // ---------- planning an ingest ----------
  /**
   * Turns a payload into rows to append, without touching any storage.
   * db = {
   *   Knowledge_Master: [{word_id, word_key, word}], Pattern_Master: [{pattern_id, pattern}],
   *   Pattern_Examples: [{example_id, pattern_id, example_en}], Mistake_Log: [{mistake_id, wrong_text, times_repeated}]
   * }
   * Returns { appends: {table: [rowObj]}, updates: [{table, idCol, id, col, value}], report: [...], counts }.
   */
  function planIngest(payload, db, today) {
    db = db || {};
    var km = db.Knowledge_Master || [];
    var pm = db.Pattern_Master || [];
    var pe = db.Pattern_Examples || [];
    var ml = db.Mistake_Log || [];

    var nextWord = makeIdAllocator('VOC', km.map(function (r) { return r.word_id; }), 4);
    var nextExample = makeIdAllocator('PEX', pe.map(function (r) { return r.example_id; }), 4);
    var nextMistake = makeIdAllocator('ERR', ml.map(function (r) { return r.mistake_id; }), 3);
    var nextPattern = makePatternIdAllocator(pm.map(function (r) { return r.pattern_id; }));

    var wordByKey = {};
    km.forEach(function (r) { wordByKey[normalizeKey(r.word_key || r.word)] = r.word_id; });
    var patternIds = {};
    var patternByText = {};
    pm.forEach(function (r) {
      patternIds[str(r.pattern_id).toUpperCase()] = r.pattern_id;
      patternByText[normalizeKey(r.pattern)] = r.pattern_id;
    });
    var exampleKeys = {};
    pe.forEach(function (r) { exampleKeys[str(r.pattern_id) + '|' + normalizeKey(r.example_en)] = true; });
    var mistakeByText = {};
    ml.forEach(function (r) {
      mistakeByText[normalizeKey(r.wrong_text)] = { id: r.mistake_id, times: Number(r.times_repeated) || 1 };
    });

    var appends = { Knowledge_Master: [], Pattern_Master: [], Pattern_Examples: [], Mistake_Log: [] };
    var updates = [];
    var report = [];
    var counts = { added: 0, duplicate: 0, invalid: 0, updated: 0, examples: 0 };
    var date = today || '';

    function resolvePattern(ref) {
      if (!ref) return { id: '' };
      var byId = patternIds[ref.toUpperCase()];
      if (byId) return { id: byId };
      var byText = patternByText[normalizeKey(ref)];
      if (byText) return { id: byText };
      return { id: '', warning: 'ไม่พบ pattern "' + ref + '" เลยไม่ได้ผูก' };
    }
    function resolveWord(ref) {
      if (!ref) return { id: '' };
      if (/^VOC\d+$/i.test(ref)) {
        var found = km.some(function (r) { return str(r.word_id).toUpperCase() === ref.toUpperCase(); }) ||
          appends.Knowledge_Master.some(function (r) { return r.word_id.toUpperCase() === ref.toUpperCase(); });
        return found ? { id: ref.toUpperCase() } : { id: '', warning: 'ไม่พบ ' + ref };
      }
      var id = wordByKey[normalizeKey(ref)];
      return id ? { id: id } : { id: '', warning: 'ไม่พบคำ "' + ref + '" ในคลัง เลยไม่ได้ผูก' };
    }

    var entries = (payload && Array.isArray(payload.entries)) ? payload.entries : [];
    if (!entries.length) {
      report.push({ index: -1, type: '-', label: '-', status: 'invalid', errors: ['ไม่มี entries'], warnings: [] });
      counts.invalid += 1;
    }

    // Patterns first, so vocab/mistakes in the same batch can point at them.
    var order = entries.map(function (e, i) { return i; }).sort(function (a, b) {
      var ta = (entries[a] && entries[a].type) === 'pattern' ? 0 : 1;
      var tb = (entries[b] && entries[b].type) === 'pattern' ? 0 : 1;
      return ta - tb || a - b;
    });

    order.forEach(function (i) {
      var e = entries[i] || {};
      var type = str(e.type).toLowerCase();
      var item = { index: i, type: type || '?', label: '', status: '', id: '', errors: [], warnings: [] };
      report.push(item);

      if (TYPES.indexOf(type) < 0) {
        item.status = 'invalid';
        item.errors.push('type ต้องเป็น vocab / pattern / mistake');
        counts.invalid += 1;
        return;
      }

      if (type === 'vocab') {
        var v = validateVocab(e);
        item.label = v.row.word;
        item.warnings = v.warnings;
        if (v.errors.length) { item.status = 'invalid'; item.errors = v.errors; counts.invalid += 1; return; }
        if (wordByKey[v.row.word_key]) {
          item.status = 'duplicate'; item.id = wordByKey[v.row.word_key]; counts.duplicate += 1; return;
        }
        var p = resolvePattern(v.pattern_ref);
        if (p.warning) item.warnings.push(p.warning);
        var row = Object.assign({}, v.row, { word_id: nextWord(), pattern_id: p.id, date_added: date });
        wordByKey[row.word_key] = row.word_id;
        appends.Knowledge_Master.push(row);
        item.status = 'added'; item.id = row.word_id; counts.added += 1;
        return;
      }

      if (type === 'pattern') {
        var pv = validatePattern(e);
        item.label = pv.row.pattern;
        item.warnings = pv.warnings;
        if (pv.errors.length) { item.status = 'invalid'; item.errors = pv.errors; counts.invalid += 1; return; }
        var pid = patternByText[normalizeKey(pv.row.pattern)];
        if (pid) {
          item.status = 'duplicate'; item.id = pid; counts.duplicate += 1;
        } else {
          pid = nextPattern(pv.id_hint);
          var prow = Object.assign({ pattern_id: pid }, pv.row);
          appends.Pattern_Master.push(prow);
          patternByText[normalizeKey(prow.pattern)] = pid;
          patternIds[pid] = pid;
          item.status = 'added'; item.id = pid; counts.added += 1;
        }
        // Examples are added even when the pattern already exists, minus duplicates.
        var added = 0;
        pv.examples.forEach(function (x) {
          var key = pid + '|' + normalizeKey(x.example_en);
          if (exampleKeys[key]) return;
          exampleKeys[key] = true;
          appends.Pattern_Examples.push({
            example_id: nextExample(), pattern_id: pid, example_en: x.example_en,
            example_th: x.example_th, note: x.note, source: 'claude'
          });
          added += 1;
        });
        item.examples_added = added;
        counts.examples += added;
        return;
      }

      // mistake
      var mv = validateMistake(e);
      item.label = mv.row.wrong_text;
      item.warnings = mv.warnings;
      if (mv.errors.length) { item.status = 'invalid'; item.errors = mv.errors; counts.invalid += 1; return; }
      var existing = mistakeByText[normalizeKey(mv.row.wrong_text)];
      if (existing) {
        existing.times += 1;
        var isNewInBatch = appends.Mistake_Log.some(function (r) { return r.mistake_id === existing.id; });
        if (isNewInBatch) {
          appends.Mistake_Log.forEach(function (r) { if (r.mistake_id === existing.id) r.times_repeated = existing.times; });
        } else {
          updates.push({ table: 'Mistake_Log', idCol: 'mistake_id', id: existing.id, col: 'times_repeated', value: existing.times });
          updates.push({ table: 'Mistake_Log', idCol: 'mistake_id', id: existing.id, col: 'fixed', value: 'No' });
        }
        item.status = 'repeated'; item.id = existing.id; counts.updated += 1;
        return;
      }
      var mp = resolvePattern(mv.pattern_ref);
      if (mp.warning) item.warnings.push(mp.warning);
      var mw = resolveWord(mv.word_ref);
      if (mw.warning) item.warnings.push(mw.warning);
      var mrow = Object.assign({ mistake_id: nextMistake() }, mv.row, { pattern_id: mp.id, word_id: mw.id });
      mistakeByText[normalizeKey(mrow.wrong_text)] = { id: mrow.mistake_id, times: 1 };
      appends.Mistake_Log.push(mrow);
      item.status = 'added'; item.id = mrow.mistake_id; counts.added += 1;
    });

    report.sort(function (a, b) { return a.index - b.index; });
    return { appends: appends, updates: updates, report: report, counts: counts };
  }

  /** Stable fingerprint of a payload (FNV-1a over canonical JSON of its entries). */
  function hashPayload(payload) {
    function canon(v) {
      if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
      if (v && typeof v === 'object') {
        return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
      }
      return JSON.stringify(v === undefined ? null : v);
    }
    var s = canon((payload && payload.entries) || []);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8) + '-' + s.length;
  }

  // ---------- spaced repetition (derived from Learning_History, never stored) ----------
  function parseIntervals(v) {
    var arr = String(v || '0;1;3;7;14;30;90').split(/\s*;\s*/).map(Number).filter(function (n) { return isFinite(n) && n >= 0; });
    return arr.length ? arr : [0, 1, 3, 7, 14, 30, 90];
  }

  function dayString(d) {
    // yyyy-mm-dd in local time
    var dt = (d instanceof Date) ? d : new Date(d);
    return dt.getFullYear() + '-' + pad(dt.getMonth() + 1, 2) + '-' + pad(dt.getDate(), 2);
  }

  function addDays(ymd, n) {
    var p = ymd.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2] + n);
    return dayString(d);
  }

  /**
   * Replays the log and returns {word_id: state}.
   * Rules: Correct -> stage+1, Partial -> stage stays, Wrong -> stage 0.
   * Several reviews of one word on the same day: only the first counts for the stage
   * (so drilling a word 5 times today does not jump it to a 3-month interval).
   */
  function replayHistory(history, config) {
    config = config || {};
    var intervals = parseIntervals(config.review_intervals_days);
    var minReviews = Number(config.mastery_min_reviews) || 5;
    var minAcc = Number(config.mastery_min_accuracy) || 0.85;
    var top = intervals.length - 1;

    var events = (history || []).filter(function (h) { return h && h.word_id && h.logged_at && RESULTS.indexOf(h.result) >= 0; })
      .slice().sort(function (a, b) { return String(a.logged_at) < String(b.logged_at) ? -1 : String(a.logged_at) > String(b.logged_at) ? 1 : 0; });

    var state = {};
    events.forEach(function (h) {
      var s = state[h.word_id];
      if (!s) s = state[h.word_id] = { stage: 0, reviews: 0, correct: 0, wrong: 0, last: '', lastDay: '', first: '' };
      var day = String(h.logged_at).slice(0, 10);
      s.reviews += 1;
      if (h.result === 'Correct') s.correct += 1;
      if (h.result === 'Wrong') s.wrong += 1;
      if (!s.first) s.first = day;
      if (s.lastDay !== day) {
        if (h.result === 'Correct') s.stage = Math.min(top, s.stage + 1);
        else if (h.result === 'Wrong') s.stage = 0;
        s.lastDay = day;
      } else if (h.result === 'Wrong') {
        s.stage = 0;
      }
      s.last = String(h.logged_at);
    });

    Object.keys(state).forEach(function (id) {
      var s = state[id];
      s.accuracy = s.reviews ? (s.correct / s.reviews) : 0;
      s.due = addDays(s.lastDay, intervals[s.stage]);
      if (s.stage === 0) s.due = addDays(s.lastDay, intervals.length > 1 ? intervals[1] : 1);
      s.status = (s.reviews >= minReviews && s.accuracy >= minAcc && s.stage >= Math.min(4, top)) ? 'mastered' : 'learning';
    });
    return state;
  }

  /**
   * Builds today's queue: due reviews first (oldest due first), then new words up to the daily goal
   * minus the new words already started today.
   */
  function buildQueue(words, history, config, todayYmd) {
    config = config || {};
    var st = replayHistory(history, config);
    var goalNew = Number(config.daily_goal_new_words) || 5;
    var goalRev = Number(config.daily_goal_reviews) || 20;
    var due = [];
    var fresh = [];
    var startedToday = 0;
    (words || []).forEach(function (w) {
      var s = st[w.word_id];
      if (!s) { fresh.push(w); return; }
      if (s.first === todayYmd) startedToday += 1;
      if (s.due <= todayYmd) due.push({ w: w, due: s.due });
    });
    due.sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; });
    fresh.sort(function (a, b) { return String(a.word_id) < String(b.word_id) ? -1 : 1; });
    var newSlots = Math.max(0, goalNew - startedToday);
    return {
      due: due.slice(0, goalRev).map(function (x) { return x.w; }),
      dueTotal: due.length,
      fresh: fresh.slice(0, newSlots),
      freshTotal: fresh.length,
      state: st
    };
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    DELIM: DELIM,
    COLUMNS: COLUMNS,
    RESULTS: RESULTS,
    normalizeKey: normalizeKey,
    toList: toList,
    joinList: joinList,
    extractPayload: extractPayload,
    planIngest: planIngest,
    hashPayload: hashPayload,
    makeIdAllocator: makeIdAllocator,
    replayHistory: replayHistory,
    buildQueue: buildQueue,
    dayString: dayString,
    addDays: addDays
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = EKBCore;
