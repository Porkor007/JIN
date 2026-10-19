/* JIN (EKB) core — shared by the Apps Script backend, the PWA and the Node tests.
 * Pure functions only: no Sheets, no DOM, no network.
 * Plain ES2017, no modules, so the same file runs as an Apps Script .gs file.
 */
var EKBCore = (function () {
  'use strict';

  var SCHEMA_VERSION = '3.2';
  var DELIM = '; ';
  var CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  var FREQUENCY = ['High', 'Medium', 'Low'];
  var REGISTER = ['Formal', 'Neutral', 'Informal'];
  var RESULTS = ['Correct', 'Wrong', 'Partial'];
  var TYPES = ['vocab', 'pattern', 'mistake'];

  var COLUMNS = {
    Knowledge_Master: ['word_id', 'word', 'word_key', 'ipa', 'thai_pron', 'cefr', 'pos', 'meaning_en', 'meaning_th',
      'synonym', 'antonym', 'collocation', 'word_family', 'root', 'prefix', 'suffix', 'frequency', 'register',
      'example', 'example_th', 'pattern_id', 'related_expressions', 'tags', 'difficulty', 'source', 'date_added', 'notes', 'usage_tip'],
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
      notes: str(e.notes),
      usage_tip: str(e.usage_tip)
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
    var wordRowById = {};
    var tipFilled = {};
    km.forEach(function (r) { wordByKey[normalizeKey(r.word_key || r.word)] = r.word_id; wordRowById[r.word_id] = r; });
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
          var dupId = wordByKey[v.row.word_key];
          item.id = dupId;
          var oldRow = wordRowById[dupId];
          // Only fills a blank usage_tip on a saved row; never overwrites a value.
          if (oldRow && v.row.usage_tip && !str(oldRow.usage_tip) && !tipFilled[dupId]) {
            updates.push({ table: 'Knowledge_Master', idCol: 'word_id', id: dupId, col: 'usage_tip', value: v.row.usage_tip });
            tipFilled[dupId] = true;
            item.status = 'filled'; counts.updated += 1; return;
          }
          item.status = 'duplicate'; counts.duplicate += 1; return;
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

  /** yyyy-mm-dd for an instant, in Asia/Bangkok (UTC+7, no DST), whatever the device timezone is. */
  function bkkDay(d) {
    var t = (d instanceof Date) ? d.getTime() : (d === undefined ? Date.now() : new Date(d).getTime());
    var b = new Date(t + 7 * 3600 * 1000);
    return b.getUTCFullYear() + '-' + pad(b.getUTCMonth() + 1, 2) + '-' + pad(b.getUTCDate(), 2);
  }

  /** yyyy-mm-ddTHH:MM:SS in Asia/Bangkok: the format Learning_History.logged_at uses. */
  function bkkIso(d) {
    var t = (d instanceof Date) ? d.getTime() : (d === undefined ? Date.now() : new Date(d).getTime());
    var b = new Date(t + 7 * 3600 * 1000);
    return bkkDay(d === undefined ? new Date(t) : d) + 'T' + pad(b.getUTCHours(), 2) + ':' + pad(b.getUTCMinutes(), 2) + ':' + pad(b.getUTCSeconds(), 2);
  }

  // ---------- history (server rows + events still on the phone) ----------
  function cidOf(row) {
    if (!row) return '';
    if (row.cid) return String(row.cid);
    var m = /cid:([\w-]+)/.exec(String(row.note || ''));
    return m ? m[1] : '';
  }

  /** Server Learning_History plus local pending events, de-duplicated by cid. */
  function mergeHistory(serverHistory, pending) {
    var out = (serverHistory || []).slice();
    var have = {};
    out.forEach(function (r) { var c = cidOf(r); if (c) have[c] = true; });
    (pending || []).forEach(function (e) {
      var c = cidOf(e);
      if (c && have[c]) return;
      if (c) have[c] = true;
      out.push(e);
    });
    return out;
  }

  /**
   * Which local events can be forgotten: only those the freshly exported history already holds,
   * or that the server said it will never store (skipped). Everything else stays on the phone,
   * even after log_reviews answered OK, until an export proves the rows are there.
   */
  function prunePending(pending, serverHistory, skippedCids) {
    var have = {};
    (serverHistory || []).forEach(function (r) { var c = cidOf(r); if (c) have[c] = true; });
    (skippedCids || []).forEach(function (c) { have[c] = true; });
    return (pending || []).filter(function (e) { return !have[cidOf(e)]; });
  }

  /** Spaced repetition only counts flashcard reviews (old rows may have no activity: treat as flashcard). */
  function isFlashcard(activity) {
    var a = str(activity);
    return !a || a.indexOf('flashcard') === 0;
  }

  // ---------- spaced repetition (derived from Learning_History, never stored) ----------
  /**
   * Replays the log and returns {word_id: state}.
   * Rules: Correct -> stage+1, Partial -> stage stays, Wrong -> stage 0.
   * Several reviews of one word on the same day: only the first counts for the stage
   * (so drilling a word 5 times today does not jump it to a 3-month interval).
   * Quiz rows (activity quiz_*) are ignored here.
   */
  function replayHistory(history, config) {
    config = config || {};
    var intervals = parseIntervals(config.review_intervals_days);
    var minReviews = Number(config.mastery_min_reviews) || 5;
    var minAcc = Number(config.mastery_min_accuracy) || 0.85;
    var top = intervals.length - 1;

    var events = (history || []).filter(function (h) {
      return h && h.word_id && h.logged_at && RESULTS.indexOf(h.result) >= 0 && isFlashcard(h.activity);
    }).slice().sort(function (a, b) { return String(a.logged_at) < String(b.logged_at) ? -1 : String(a.logged_at) > String(b.logged_at) ? 1 : 0; });

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
   * The review queue, with no target:
   *   due    = every word whose review date has come, oldest due first
   *   fresh  = never-reviewed words, oldest id first
   *   freshCap = how many new words to start today before the round says "nothing due"
   *              (daily_goal_new_words, a quiet cap; the user can still ask for more)
   *   ahead  = words not due yet, soonest first (for "review ahead")
   */
  function buildQueue(words, history, config, todayYmd) {
    config = config || {};
    var st = replayHistory(history, config);
    var goalNew = config.daily_goal_new_words === undefined || config.daily_goal_new_words === '' ? 5 : Number(config.daily_goal_new_words);
    if (!isFinite(goalNew) || goalNew < 0) goalNew = 5;
    var due = [];
    var fresh = [];
    var ahead = [];
    var startedToday = 0;
    (words || []).forEach(function (w) {
      var s = st[w.word_id];
      if (!s) { fresh.push(w); return; }
      if (s.first === todayYmd) startedToday += 1;
      if (s.due <= todayYmd) due.push({ w: w, due: s.due });
      else ahead.push({ w: w, due: s.due });
    });
    var byDue = function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : (String(a.w.word_id) < String(b.w.word_id) ? -1 : 1); };
    due.sort(byDue);
    ahead.sort(byDue);
    fresh.sort(function (a, b) { return String(a.word_id) < String(b.word_id) ? -1 : 1; });
    return {
      due: due.map(function (x) { return x.w; }),
      dueTotal: due.length,
      fresh: fresh,
      freshTotal: fresh.length,
      freshCap: Math.max(0, goalNew - startedToday),
      ahead: ahead.map(function (x) { return x.w; }),
      state: st
    };
  }

  /** "ทบทวนวันนี้": distinct words with a flashcard review today, and the share answered Correct. */
  function todayStats(history, todayYmd) {
    var ids = {};
    var total = 0;
    var correct = 0;
    (history || []).forEach(function (h) {
      if (!h || !h.word_id || !isFlashcard(h.activity) || RESULTS.indexOf(h.result) < 0) return;
      if (String(h.logged_at).slice(0, 10) !== todayYmd) return;
      ids[h.word_id] = true;
      total += 1;
      if (h.result === 'Correct') correct += 1;
    });
    return { words: Object.keys(ids).length, total: total, correct: correct, pct: total ? Math.round(100 * correct / total) : null };
  }

  // ---------- parts of speech and preposition colours (one table for the whole app) ----------
  var POS_STYLE = {
    noun: { label: 'N', full: 'noun', bg: '#FFF1C2', box: '#F2C230', ink: '#15171A', dark: '#F2D15C' },
    verb: { label: 'V', full: 'verb', bg: '#D7F2E0', box: '#3DB06E', ink: '#0F1F15', dark: '#6FD99A' },
    'phrasal verb': { label: 'PHV', full: 'phrasal verb', bg: '#A9D4B8', box: '#1E6B40', ink: '#FFFFFF', dark: '#8FD1A8' },
    adjective: { label: 'ADJ', full: 'adjective', bg: '#D9ECFA', box: '#4FA3E0', ink: '#0E1A24', dark: '#7CC0EE' },
    adverb: { label: 'ADV', full: 'adverb', bg: '#EAE1FA', box: '#A98BE0', ink: '#1A1029', dark: '#C3AEEE' },
    idiom: { label: 'IDM', full: 'idiom', bg: '#FBDDE5', box: '#E0567A', ink: '#2A0A14', dark: '#FF8FB0' },
    other: { label: 'PHR', full: 'phrase', bg: '#FDE3D2', box: '#F08A4B', ink: '#2A1406', dark: '#FFB384' }
  };
  var POS_ALIAS = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', phv: 'phrasal verb', 'phrasal-verb': 'phrasal verb' };
  var CARD_INK = '#15171A';
  var PREP_COLORS = { to: '#C2410C', about: '#1D6FB8', over: '#5B21B6', into: '#B4235A', 'with': '#0F766E', as: '#A15C07', 'for': '#475569', on: '#166534', 'in': '#9F1239', of: '#3F3F46' };
  var PREP_COLORS_LIGHT = { to: '#FF9B6A', about: '#7CC4FF', over: '#C3AEEE', into: '#FF8FB8', 'with': '#5EEAD4', as: '#F2B45A', 'for': '#CBD5E1' };
  var PREP_DEFAULT = '#3F3F46';
  var PREP_DEFAULT_LIGHT = '#D4D4D8';
  var QUIZ_PREP_FILL = ['to', 'about', 'for', 'with', 'as', 'on', 'in', 'of'];

  /** "noun/verb" -> "noun"; unknown -> "other". */
  function posKey(pos) {
    var p = str(pos).toLowerCase().split('/')[0].trim().replace(/\s+/g, ' ');
    p = POS_ALIAS[p] || p;
    return POS_STYLE[p] ? p : 'other';
  }

  function posStyle(pos) {
    var k = posKey(pos);
    var s = POS_STYLE[k];
    var first = str(pos).toLowerCase().split('/')[0].trim();
    return { key: k, label: s.label, full: k === 'other' ? (first || s.full) : s.full, bg: s.bg, box: s.box, ink: s.ink, dark: s.dark, text: CARD_INK };
  }

  function prepColor(prep, onDark) {
    var p = str(prep).toLowerCase();
    if (onDark) return Object.prototype.hasOwnProperty.call(PREP_COLORS_LIGHT, p) ? PREP_COLORS_LIGHT[p] : PREP_DEFAULT_LIGHT;
    return Object.prototype.hasOwnProperty.call(PREP_COLORS, p) ? PREP_COLORS[p] : PREP_DEFAULT;
  }

  /**
   * collocation "talk + to = คุยกับ (ใคร); small talk" ->
   *   { preps: [{base:'talk', prep:'to', meaning:'คุยกับ (ใคร)'}], plain: ['small talk'] }
   */
  var PREP_ROW = /^(.+?)\s*\+\s*([a-z]+(?: [a-z]+)?)\s*=\s*(.+)$/i;
  function splitCollocation(v) {
    var preps = [];
    var plain = [];
    toList(v).forEach(function (item) {
      var m = PREP_ROW.exec(item);
      if (m) preps.push({ base: str(m[1]), prep: m[2].toLowerCase(), meaning: str(m[3]) });
      else plain.push(item);
    });
    return { preps: preps, plain: plain };
  }

  /** Splits text into [{t, hit}] so the UI can bold the head word (case-insensitive). No match -> one plain part. */
  function highlightParts(text, word) {
    var t = String(text == null ? '' : text);
    var w = str(word);
    if (!w || !t) return [{ t: t, hit: false }];
    var lower = t.toLowerCase();
    var key = w.toLowerCase();
    var out = [];
    var from = 0;
    var at = lower.indexOf(key);
    if (at < 0) return [{ t: t, hit: false }];
    while (at >= 0) {
      if (at > from) out.push({ t: t.slice(from, at), hit: false });
      out.push({ t: t.slice(at, at + key.length), hit: true });
      from = at + key.length;
      at = lower.indexOf(key, from);
    }
    if (from < t.length) out.push({ t: t.slice(from), hit: false });
    return out;
  }

  /** Splits a usage tip into [{t, prep}] where prep is set for whole-word prepositions from the colour table. */
  function tipParts(text) {
    var t = String(text == null ? '' : text);
    var out = [];
    var re = /(^|[^A-Za-z])(to|about|over|into|with|as|for|on|in|of)(?![A-Za-z])/gi;
    var from = 0;
    var m;
    while ((m = re.exec(t)) !== null) {
      var start = m.index + m[1].length;
      if (start > from) out.push({ t: t.slice(from, start), prep: '' });
      out.push({ t: m[2], prep: m[2].toLowerCase() });
      from = start + m[2].length;
      re.lastIndex = from;
    }
    if (from < t.length) out.push({ t: t.slice(from), prep: '' });
    return out.length ? out : [{ t: t, prep: '' }];
  }

  // ---------- quizzes shown between cards ----------
  function shuffle(arr, rng) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var x = a[i]; a[i] = a[j]; a[j] = x;
    }
    return a;
  }

  /** Words answered Correct on a flashcard at least once, minus the excluded ids (the card just seen). */
  function quizEligible(words, history, excludeIds) {
    var ok = {};
    (history || []).forEach(function (h) {
      if (h && h.result === 'Correct' && isFlashcard(h.activity)) ok[h.word_id] = true;
    });
    var ex = {};
    (excludeIds || []).forEach(function (id) { ex[id] = true; });
    return (words || []).filter(function (w) { return ok[w.word_id] && !ex[w.word_id]; });
  }

  /** Type A: part of speech (4 buttons) + Thai meaning (4 choices). */
  function makeQuizA(word, words, rng) {
    rng = rng || Math.random;
    var answer = posKey(word.pos);
    var base = ['noun', 'verb', 'adjective', 'adverb'];
    var opts = base.slice();
    if (opts.indexOf(answer) < 0) {
      var wrongs = opts.filter(function (k) { return k !== answer; });
      opts[opts.indexOf(wrongs[Math.floor(rng() * wrongs.length)])] = answer;
    }
    var right = str(word.meaning_th) || str(word.meaning_en);
    var seen = {};
    seen[normalizeKey(right)] = true;
    var pool = [];
    shuffle(words || [], rng).forEach(function (w) {
      if (w.word_id === word.word_id) return;
      var m = str(w.meaning_th) || str(w.meaning_en);
      var k = normalizeKey(m);
      if (!m || seen[k]) return;
      seen[k] = true;
      pool.push(m);
    });
    var meanings = shuffle([right].concat(pool.slice(0, 3)), rng);
    return { type: 'A', word: word, posOptions: opts, posAnswer: answer, meaningOptions: meanings, meaningAnswer: right };
  }

  /** Type B: guess the preposition. Only for words with "base + prep = meaning" collocations. */
  function makeQuizB(word, rng) {
    rng = rng || Math.random;
    var rows = splitCollocation(word.collocation).preps;
    if (!rows.length) return null;
    var target = rows[Math.floor(rng() * rows.length)];
    var opts = [target.prep];
    shuffle(rows, rng).forEach(function (r) { if (opts.length < 4 && opts.indexOf(r.prep) < 0) opts.push(r.prep); });
    QUIZ_PREP_FILL.forEach(function (p) { if (opts.length < 4 && opts.indexOf(p) < 0) opts.push(p); });
    return { type: 'B', word: word, base: target.base, meaning: target.meaning, answer: target.prep, options: shuffle(opts, rng), rows: rows };
  }

  /** Picks the quiz to show, or null when no word qualifies. B about half the time when the word allows it. */
  function pickQuiz(words, history, excludeIds, rng) {
    rng = rng || Math.random;
    var pool = quizEligible(words, history, excludeIds);
    if (!pool.length) return null;
    var w = pool[Math.floor(rng() * pool.length)];
    var hasB = splitCollocation(w.collocation).preps.length > 0;
    if (hasB && rng() < 0.5) return makeQuizB(w, rng);
    return makeQuizA(w, words, rng);
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    DELIM: DELIM,
    COLUMNS: COLUMNS,
    RESULTS: RESULTS,
    POS_STYLE: POS_STYLE,
    PREP_COLORS: PREP_COLORS,
    PREP_COLORS_LIGHT: PREP_COLORS_LIGHT,
    normalizeKey: normalizeKey,
    toList: toList,
    joinList: joinList,
    extractPayload: extractPayload,
    planIngest: planIngest,
    hashPayload: hashPayload,
    makeIdAllocator: makeIdAllocator,
    replayHistory: replayHistory,
    buildQueue: buildQueue,
    todayStats: todayStats,
    mergeHistory: mergeHistory,
    prunePending: prunePending,
    isFlashcard: isFlashcard,
    dayString: dayString,
    addDays: addDays,
    bkkDay: bkkDay,
    bkkIso: bkkIso,
    posKey: posKey,
    posStyle: posStyle,
    prepColor: prepColor,
    splitCollocation: splitCollocation,
    highlightParts: highlightParts,
    tipParts: tipParts,
    shuffle: shuffle,
    quizEligible: quizEligible,
    makeQuizA: makeQuizA,
    makeQuizB: makeQuizB,
    pickQuiz: pickQuiz
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = EKBCore;
