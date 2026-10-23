/* JIN (EKB) core — shared by the Apps Script backend, the PWA and the Node tests.
 * Pure functions only: no Sheets, no DOM, no network.
 * Plain ES2017, no modules, so the same file runs as an Apps Script .gs file.
 */
var EKBCore = (function () {
  'use strict';

  var SCHEMA_VERSION = '3.3';
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
      'difficulty', 'word_id', 'times_repeated', 'fixed', 'rule_key'],
    Learning_History: ['log_id', 'logged_at', 'word_id', 'activity', 'result', 'response_time_s', 'source', 'note'],
    Pattern_Practice: ['practice_id', 'logged_at', 'pattern_id', 'sentence'],
    Practice_Feedback: ['practice_id', 'checked_at', 'ok', 'corrected', 'feedback_th', 'rule_keys'],
    Rule_Book: ['rule_key', 'title_th', 'explain_th', 'wrong_example', 'right_example', 'category', 'created_at']
  };
  var RULE_CATEGORIES = ['Grammar', 'Preposition', 'Word choice', 'Spelling'];

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

  /** Rule identity: lower-case ascii slug, e.g. "Passive for things" -> "passive-for-things". */
  function ruleKey(s) {
    return str(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
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
        // Pattern-practice feedback: {"jin":"pattern_feedback", items, rules, mistakes}
        if (obj && (obj.jin === 'pattern_feedback' || Array.isArray(obj.items))) {
          obj = { ekb: obj.ekb || SCHEMA_VERSION, entries: obj.mistakes || obj.entries || [], rules: obj.rules || [], feedback: obj.items || [] };
        }
        if (obj && !Array.isArray(obj.entries) && Array.isArray(obj.rules)) obj.entries = [];
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
        fixed: 'No',
        rule_key: ruleKey(e.rule_key)
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
      mistakeByText[normalizeKey(r.wrong_text)] = { id: r.mistake_id, times: Number(r.times_repeated) || 1, rule_key: str(r.rule_key) };
    });

    var appends = { Knowledge_Master: [], Pattern_Master: [], Pattern_Examples: [], Mistake_Log: [] };
    var updates = [];
    var report = [];
    var counts = { added: 0, duplicate: 0, invalid: 0, updated: 0, examples: 0 };
    var date = today || '';

    var colNow = {};
    /** Appends new preposition rows to a saved word's collocation; returns how many were added. */
    function appendPrepRows(id, savedValue, incoming) {
      var current = Object.prototype.hasOwnProperty.call(colNow, id) ? colNow[id] : toList(savedValue);
      var have = {};
      splitCollocation(current).preps.forEach(function (r) { have[normalizeKey(r.base) + '|' + r.prep] = true; });
      var add = [];
      splitCollocation(incoming).preps.forEach(function (r) {
        var k = normalizeKey(r.base) + '|' + r.prep;
        if (have[k]) return;
        have[k] = true;
        add.push(r.base + ' + ' + r.prep + ' = ' + r.meaning);
      });
      if (!add.length) return 0;
      // Preposition rows go first so they read as a group; ordinary collocations follow unchanged.
      var parts = splitCollocation(current);
      var oldPrepItems = current.filter(function (x) { return PREP_ROW.test(x); });
      var next = oldPrepItems.concat(add).concat(parts.plain);
      colNow[id] = next;
      var value = next.join(DELIM);
      var existing = updates.filter(function (u) { return u.id === id && u.col === 'collocation'; })[0];
      if (existing) existing.value = value;
      else updates.push({ table: 'Knowledge_Master', idCol: 'word_id', id: id, col: 'collocation', value: value });
      return add.length;
    }

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

    // ---- rules (before mistakes and feedback, so both can point at them) ----
    appends.Rule_Book = [];
    appends.Practice_Feedback = [];
    counts.rules = 0;
    counts.feedback = 0;
    var rb = db.Rule_Book || [];
    var ruleByKey = {};
    var ruleByTitle = {};
    rb.forEach(function (r) {
      var k = ruleKey(r.rule_key);
      if (!k) return;
      ruleByKey[k] = k;
      ruleByTitle[normalizeKey(r.title_th)] = k;
    });
    var ruleAlias = {}; // key Claude wrote -> key stored in the sheet
    function mapRule(k) {
      var kk = ruleKey(k);
      if (!kk) return '';
      return ruleAlias[kk] || ruleByKey[kk] || '';
    }
    var rulesIn = (payload && Array.isArray(payload.rules)) ? payload.rules : [];
    rulesIn.forEach(function (r, i) {
      r = r || {};
      var key = ruleKey(r.key || r.rule_key);
      var title = str(r.title_th || r.title);
      var item = { index: 1000 + i, type: 'rule', label: title || key, status: '', id: '', errors: [], warnings: [] };
      report.push(item);
      if (!key || !title) { item.status = 'invalid'; item.errors.push('กฎต้องมี key และ title_th'); counts.invalid += 1; return; }
      // Same key, or the same title under another key, is the same rule: keep the saved one.
      var hit = ruleByKey[key] || ruleByTitle[normalizeKey(title)];
      if (hit) { ruleAlias[key] = hit; item.status = 'duplicate'; item.id = hit; counts.duplicate += 1; return; }
      var cat = pickEnum(r.category, RULE_CATEGORIES);
      if (!cat) { if (str(r.category)) item.warnings.push('category "' + r.category + '" ไม่รู้จัก ใช้ Grammar'); cat = 'Grammar'; }
      appends.Rule_Book.push({ rule_key: key, title_th: title, explain_th: str(r.explain_th), wrong_example: str(r.wrong),
        right_example: str(r.right), category: cat, created_at: date });
      ruleByKey[key] = key;
      ruleByTitle[normalizeKey(title)] = key;
      ruleAlias[key] = key;
      item.status = 'added'; item.id = key; counts.rules += 1;
    });

    // ---- pattern-practice feedback ----
    var practiceIds = {};
    (db.Pattern_Practice || []).forEach(function (r) { practiceIds[str(r.practice_id)] = r; });
    var fbIn = (payload && Array.isArray(payload.feedback)) ? payload.feedback : [];
    fbIn.forEach(function (f, i) {
      f = f || {};
      var id = str(f.id || f.practice_id);
      var item = { index: 2000 + i, type: 'feedback', label: id, status: '', id: id, errors: [], warnings: [] };
      report.push(item);
      if (!practiceIds[id]) { item.status = 'invalid'; item.errors.push('ไม่พบประโยครหัส ' + (id || '-') + ' (sync ก่อนแล้ววางใหม่)'); counts.invalid += 1; return; }
      var ok = f.ok === true || /^(yes|true|ok|correct)$/i.test(str(f.ok));
      var keys = [];
      (Array.isArray(f.rules) ? f.rules : toList(f.rules)).forEach(function (k) {
        var m = mapRule(k);
        if (!m) { if (str(k)) item.warnings.push('ไม่พบกฎ "' + k + '"'); return; }
        if (keys.indexOf(m) < 0) keys.push(m);
      });
      appends.Practice_Feedback.push({ practice_id: id, checked_at: date, ok: ok ? 'Yes' : 'No', corrected: str(f.corrected),
        feedback_th: str(f.feedback_th || f.feedback), rule_keys: keys.join(DELIM) });
      item.label = practiceIds[id].sentence || id;
      item.ok = ok;
      item.corrected = str(f.corrected);
      item.feedback_th = str(f.feedback_th || f.feedback);
      item.rule_keys = keys;
      item.status = 'checked'; counts.feedback += 1;
    });

    var entries = (payload && Array.isArray(payload.entries)) ? payload.entries : [];
    if (!entries.length && !rulesIn.length && !fbIn.length) {
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
          var changed = false;
          // Fills a blank usage_tip on a saved row; never overwrites a value.
          if (oldRow && v.row.usage_tip && !str(oldRow.usage_tip) && !tipFilled[dupId]) {
            updates.push({ table: 'Knowledge_Master', idCol: 'word_id', id: dupId, col: 'usage_tip', value: v.row.usage_tip });
            tipFilled[dupId] = true;
            changed = true;
          }
          // Adds "base + prep = meaning" rows the saved word does not have yet; keeps every existing item.
          if (oldRow) {
            var addedPreps = appendPrepRows(dupId, oldRow.collocation, v.row.collocation);
            if (addedPreps) {
              item.preps_added = addedPreps;
              changed = true;
            }
          }
          if (changed) { item.status = 'filled'; counts.updated += 1; return; }
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
      if (mv.row.rule_key) {
        var mk = mapRule(mv.row.rule_key);
        if (!mk) item.warnings.push('ไม่พบกฎ "' + mv.row.rule_key + '" เลยไม่ได้ผูก');
        mv.row.rule_key = mk;
      }
      var existing = mistakeByText[normalizeKey(mv.row.wrong_text)];
      if (existing) {
        existing.times += 1;
        if (mv.row.rule_key && !existing.rule_key) {
          updates.push({ table: 'Mistake_Log', idCol: 'mistake_id', id: existing.id, col: 'rule_key', value: mv.row.rule_key });
          existing.rule_key = mv.row.rule_key;
        }
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
      mistakeByText[normalizeKey(mrow.wrong_text)] = { id: mrow.mistake_id, times: 1, rule_key: mrow.rule_key };
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
    var hasMore = payload && ((payload.rules && payload.rules.length) || (payload.feedback && payload.feedback.length));
    var s = hasMore ? canon({ entries: payload.entries || [], rules: payload.rules || [], feedback: payload.feedback || [] })
      : canon((payload && payload.entries) || []);
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

  // ---------- pattern practice (phase 2): free sentences, checked later by Claude ----------
  var PRACTICE_INTERVALS = [3, 7, 14, 30];
  var CHECK_CHUNK = 25;

  function isYes(v) { return v === true || /^(yes|true|ok)$/i.test(str(v)); }

  /** Server Pattern_Practice rows + sentences still on the phone, de-duplicated by practice_id. */
  function mergePractice(serverRows, pending) {
    var out = (serverRows || []).slice();
    var have = {};
    out.forEach(function (r) { have[str(r.practice_id)] = true; });
    (pending || []).forEach(function (r) { if (!have[str(r.practice_id)]) { have[str(r.practice_id)] = true; out.push(r); } });
    return out;
  }

  /** Latest feedback row per practice_id (a sentence checked twice keeps the newer result). */
  function latestFeedback(feedbackRows) {
    var by = {};
    (feedbackRows || []).forEach(function (f, i) {
      var id = str(f.practice_id);
      if (!id) return;
      var cur = by[id];
      var k = String(f.checked_at || '') + '|' + pad(i, 6);
      if (!cur || k >= cur._k) by[id] = Object.assign({ _k: k }, f);
    });
    return by;
  }

  /**
   * Per-pattern state from the practice log:
   *   new      never written
   *   waiting  newest sentence not checked yet (not shown again until feedback arrives)
   *   redo     newest checked sentence was wrong -> comes back every session
   *   passed   newest checked sentence was right -> comes back after 3 / 7 / 14 / 30 days (streak)
   */
  function patternStates(patterns, practiceRows, feedbackRows, intervals) {
    intervals = intervals || PRACTICE_INTERVALS;
    var fb = latestFeedback(feedbackRows);
    var byPattern = {};
    (practiceRows || []).forEach(function (r) {
      var pid = str(r.pattern_id);
      if (!pid) return;
      (byPattern[pid] = byPattern[pid] || []).push(r);
    });
    var out = {};
    (patterns || []).forEach(function (p) {
      var pid = str(p.pattern_id);
      var rows = (byPattern[pid] || []).slice().sort(function (a, b) {
        return String(a.logged_at) < String(b.logged_at) ? -1 : String(a.logged_at) > String(b.logged_at) ? 1 : 0;
      });
      var st = { pattern_id: pid, status: 'new', attempts: rows.length, lastPractice: '', lastFeedback: null, streak: 0, due: '', unchecked: 0 };
      if (!rows.length) { out[pid] = st; return; }
      st.lastPractice = String(rows[rows.length - 1].logged_at || '');
      var checked = [];
      rows.forEach(function (r) {
        var f = fb[str(r.practice_id)];
        if (f) checked.push({ row: r, fb: f }); else st.unchecked += 1;
      });
      var newest = rows[rows.length - 1];
      if (!fb[str(newest.practice_id)]) { st.status = 'waiting'; }
      if (checked.length) {
        var last = checked[checked.length - 1];
        st.lastFeedback = { practice_id: last.row.practice_id, sentence: last.row.sentence, ok: isYes(last.fb.ok),
          corrected: str(last.fb.corrected), feedback_th: str(last.fb.feedback_th), rule_keys: toList(last.fb.rule_keys), checked_at: str(last.fb.checked_at) };
        for (var i = checked.length - 1; i >= 0 && isYes(checked[i].fb.ok); i--) st.streak += 1;
        if (st.status !== 'waiting') {
          if (!st.lastFeedback.ok) st.status = 'redo';
          else {
            st.status = 'passed';
            var day = String(last.fb.checked_at || last.row.logged_at || '').slice(0, 10);
            st.due = day ? addDays(day, intervals[Math.min(st.streak, intervals.length) - 1]) : '';
          }
        }
      }
      out[pid] = st;
    });
    return out;
  }

  /**
   * Next pattern to show. Order: redo -> new -> passed and due -> anything else, least recently practiced.
   * shownIds: patterns already shown in this session (each comes once until every group runs dry).
   */
  function nextPattern(patterns, states, todayYmd, shownIds) {
    var shown = {};
    (shownIds || []).forEach(function (id) { shown[id] = true; });
    var redo = [], fresh = [], due = [], rest = [];
    (patterns || []).forEach(function (p, i) {
      var st = states[p.pattern_id] || { status: 'new' };
      var x = { p: p, st: st, i: i };
      if (st.status === 'redo') redo.push(x);
      else if (st.status === 'new') fresh.push(x);
      else if (st.status === 'passed' && st.due && st.due <= todayYmd) due.push(x);
      else rest.push(x);
    });
    redo.sort(function (a, b) { return String(a.st.lastFeedback.checked_at) < String(b.st.lastFeedback.checked_at) ? -1 : 1; });
    due.sort(function (a, b) { return a.st.due < b.st.due ? -1 : a.st.due > b.st.due ? 1 : a.i - b.i; });
    rest.sort(function (a, b) { return String(a.st.lastPractice) < String(b.st.lastPractice) ? -1 : String(a.st.lastPractice) > String(b.st.lastPractice) ? 1 : a.i - b.i; });
    var groups = [['redo', redo], ['new', fresh], ['due', due], ['again', rest]];
    for (var pass = 0; pass < 2; pass++) {
      for (var g = 0; g < groups.length; g++) {
        var list = groups[g][1];
        for (var j = 0; j < list.length; j++) {
          if (pass === 0 && shown[list[j].p.pattern_id]) continue;
          return { pattern: list[j].p, state: list[j].st, reason: groups[g][0] };
        }
      }
    }
    return null;
  }

  /** Counts for the home screen. */
  function practiceSummary(patterns, states, practiceRows, feedbackRows, todayYmd) {
    var fb = latestFeedback(feedbackRows);
    var unchecked = (practiceRows || []).filter(function (r) { return !fb[str(r.practice_id)]; }).length;
    var redo = 0, fresh = 0, due = 0;
    (patterns || []).forEach(function (p) {
      var st = states[p.pattern_id];
      if (!st) return;
      if (st.status === 'redo') redo += 1;
      if (st.status === 'new') fresh += 1;
      if (st.status === 'passed' && st.due <= todayYmd) due += 1;
    });
    return { unchecked: unchecked, redo: redo, fresh: fresh, due: due };
  }

  /**
   * Text to paste into Claude: every unchecked sentence, split into chunks of 25.
   * Returns [{text, ids}] (one entry per chunk).
   */
  function buildCheckText(practiceRows, feedbackRows, patterns, rules, chunkSize) {
    chunkSize = chunkSize || CHECK_CHUNK;
    var fb = latestFeedback(feedbackRows);
    var pById = {};
    (patterns || []).forEach(function (p) { pById[p.pattern_id] = p; });
    var todo = (practiceRows || []).filter(function (r) { return !fb[str(r.practice_id)] && str(r.sentence); })
      .slice().sort(function (a, b) { return String(a.logged_at) < String(b.logged_at) ? -1 : 1; });
    if (!todo.length) return [];
    var ruleLines = (rules || []).filter(function (r) { return ruleKey(r.rule_key); }).map(function (r) {
      return '- ' + ruleKey(r.rule_key) + ' | ' + str(r.title_th);
    });
    var chunks = [];
    for (var at = 0; at < todo.length; at += chunkSize) chunks.push(todo.slice(at, at + chunkSize));
    return chunks.map(function (list, ci) {
      var lines = [];
      lines.push('JIN · ตรวจประโยคฝึก Pattern' + (chunks.length > 1 ? ' (ชุด ' + (ci + 1) + '/' + chunks.length + ')' : '') + ' · ' + list.length + ' ประโยค');
      lines.push('ใช้ skill jin-pattern-check ตรวจทุกประโยค (ถ้าไม่มี skill: บอกว่าแต่ละประโยคถูกแกรมม่าและใช้ pattern ถูกไหม อธิบายเป็นไทย แล้วปิดท้ายด้วย JSON {"jin":"pattern_feedback","items":[{"id","ok","corrected","feedback_th","rules":[]}],"rules":[],"mistakes":[]})');
      lines.push('');
      list.forEach(function (r) {
        var p = pById[r.pattern_id] || {};
        lines.push('[' + r.practice_id + '] ' + (p.pattern || r.pattern_id) + (p.meaning_th ? ' — ' + p.meaning_th : ''));
        String(r.sentence).split(/\r?\n/).forEach(function (l) { if (str(l)) lines.push('> ' + str(l)); });
        lines.push('');
      });
      lines.push('กฎที่มีอยู่แล้ว (ใช้ key เดิมถ้าเป็นเรื่องเดียวกัน):');
      lines.push(ruleLines.length ? ruleLines.join('\n') : '- (ยังไม่มี)');
      return { text: lines.join('\n'), ids: list.map(function (r) { return r.practice_id; }) };
    });
  }

  /** New practice id, readable and unique enough across devices: PP-YYMMDD-xxxxx. */
  function newPracticeId(todayYmd, rnd) {
    var r = rnd || Math.random;
    var s = '';
    for (var i = 0; i < 5; i++) s += '0123456789abcdefghijkmnpqrstuvwxyz'.charAt(Math.floor(r() * 34));
    return 'PP-' + String(todayYmd).replace(/-/g, '').slice(2) + '-' + s;
  }

  /**
   * Rules sorted by how often Gap breaks them: practice feedback rows (latest per sentence) + Mistake_Log rows
   * (times_repeated) that point at the rule. Ties: most recently broken first.
   */
  function ruleStats(rules, feedbackRows, mistakes, practiceRows) {
    var fb = latestFeedback(feedbackRows);
    var sentenceById = {};
    (practiceRows || []).forEach(function (r) { sentenceById[str(r.practice_id)] = r; });
    var stat = {};
    (rules || []).forEach(function (r) {
      var k = ruleKey(r.rule_key);
      if (k) stat[k] = { rule: r, key: k, count: 0, last: '', examples: [] };
    });
    Object.keys(fb).forEach(function (id) {
      var f = fb[id];
      toList(f.rule_keys).forEach(function (k) {
        var s = stat[ruleKey(k)];
        if (!s) return;
        s.count += 1;
        if (String(f.checked_at) > s.last) s.last = String(f.checked_at);
        var src = sentenceById[id];
        s.examples.push({ wrong: src ? str(src.sentence) : '', right: str(f.corrected), note: str(f.feedback_th), when: str(f.checked_at) });
      });
    });
    (mistakes || []).forEach(function (m) {
      var s = stat[ruleKey(m.rule_key)];
      if (!s) return;
      s.count += Number(m.times_repeated) || 1;
      s.examples.push({ wrong: str(m.wrong_text), right: str(m.correct_text), note: str(m.reason_th), when: '' });
    });
    return Object.keys(stat).map(function (k) { return stat[k]; }).sort(function (a, b) {
      return b.count - a.count || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0) || (a.key < b.key ? -1 : 1);
    });
  }

  // ---------- collocation quiz (type C) ----------
  var LIGHT_VERBS = ['make', 'do', 'take', 'have', 'give', 'get', 'pay', 'keep', 'hold', 'catch', 'set', 'put', 'run', 'go',
    'come', 'bring', 'break', 'raise', 'draw', 'reach'];

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /** Usable collocation items for a word: light-verb ("take a sip") or head-word ("a lively discussion"). */
  function collocItems(word) {
    var out = [];
    var head = str(word.word);
    if (!head) return out;
    var headRe = new RegExp('(^|[^A-Za-z])(' + escapeRe(head) + ')(?![A-Za-z])', 'i');
    splitCollocation(word.collocation).plain.forEach(function (c) {
      if (/[\/()…]|\.\.\./.test(c)) return; // "offer/send", "(sb)": too ambiguous to blank
      var toks = c.split(/\s+/);
      if (toks.length < 2) return;
      var first = toks[0].toLowerCase();
      if (LIGHT_VERBS.indexOf(first) >= 0 && head.toLowerCase().split(/\s+/)[0] !== first) {
        out.push({ kind: 'verb', full: c, prompt: '___ ' + toks.slice(1).join(' '), answer: first });
        return;
      }
      var m = headRe.exec(c);
      if (m && normalizeKey(c) !== normalizeKey(head)) {
        var at = m.index + m[1].length;
        out.push({ kind: 'head', full: c, prompt: c.slice(0, at) + '___' + c.slice(at + m[2].length), answer: c.substr(at, m[2].length) });
      }
    });
    return out;
  }

  function makeQuizC(word, words, rng) {
    rng = rng || Math.random;
    var items = collocItems(word);
    if (!items.length) return null;
    var verbs = items.filter(function (x) { return x.kind === 'verb'; });
    var heads = items.filter(function (x) { return x.kind === 'head'; });
    var pickFrom = (verbs.length && (!heads.length || rng() < 0.5)) ? verbs : heads;
    var it = pickFrom[Math.floor(rng() * pickFrom.length)];
    var opts = [it.answer.toLowerCase()];
    if (it.kind === 'verb') {
      shuffle(LIGHT_VERBS, rng).forEach(function (v) { if (opts.length < 4 && opts.indexOf(v) < 0) opts.push(v); });
    } else {
      var key = posKey(word.pos);
      var multi = /\s/.test(str(word.word));
      var pool = (words || []).filter(function (w) {
        return w.word_id !== word.word_id && posKey(w.pos) === key && /\s/.test(str(w.word)) === multi && !/[\/()]/.test(str(w.word));
      });
      if (pool.length < 3) pool = (words || []).filter(function (w) { return w.word_id !== word.word_id && str(w.word); });
      shuffle(pool, rng).forEach(function (w) {
        var v = str(w.word).toLowerCase();
        if (opts.length < 4 && opts.indexOf(v) < 0) opts.push(v);
      });
    }
    return { type: 'C', kind: it.kind, word: word, prompt: it.prompt, answer: it.answer.toLowerCase(), full: it.full, options: shuffle(opts, rng) };
  }

  /**
   * Quiz between cards, rotating Preposition (B) -> Collocation (C) -> part of speech + meaning (A).
   * turn = how many quizzes this round already had; types that cannot be made are skipped.
   */
  function pickQuizTurn(words, history, excludeIds, turn, rng) {
    rng = rng || Math.random;
    var pool = quizEligible(words, history, excludeIds);
    if (!pool.length) return null;
    var order = ['B', 'C', 'A'];
    for (var k = 0; k < 3; k++) {
      var type = order[(turn + k) % 3];
      var cands;
      if (type === 'B') cands = pool.filter(function (w) { return splitCollocation(w.collocation).preps.length > 0; });
      else if (type === 'C') cands = pool.filter(function (w) { return collocItems(w).length > 0; });
      else cands = pool;
      if (!cands.length) continue;
      var w = cands[Math.floor(rng() * cands.length)];
      var q = type === 'B' ? makeQuizB(w, rng) : type === 'C' ? makeQuizC(w, words, rng) : makeQuizA(w, words, rng);
      if (q) return q;
    }
    return null;
  }

  /** Splits a pattern structure "S + be + supposed to + V1" into chips. */
  function structureChips(structure) {
    return str(structure).split(/\s+\+\s+/).map(str).filter(Boolean);
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
    pickQuiz: pickQuiz,
    ruleKey: ruleKey,
    RULE_CATEGORIES: RULE_CATEGORIES,
    PRACTICE_INTERVALS: PRACTICE_INTERVALS,
    CHECK_CHUNK: CHECK_CHUNK,
    mergePractice: mergePractice,
    latestFeedback: latestFeedback,
    patternStates: patternStates,
    nextPattern: nextPattern,
    practiceSummary: practiceSummary,
    buildCheckText: buildCheckText,
    newPracticeId: newPracticeId,
    ruleStats: ruleStats,
    collocItems: collocItems,
    makeQuizC: makeQuizC,
    pickQuizTurn: pickQuizTurn,
    structureChips: structureChips,
    LIGHT_VERBS: LIGHT_VERBS
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = EKBCore;
