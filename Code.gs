/**
 * JIN (EKB) backend — Google Apps Script Web App, bound to the EKB Google Sheet.
 *
 * Files in this Apps Script project:
 *   Code.gs  (this file)
 *   Core.gs  (copy of app/core.js — the same parser the app uses)
 *
 * First run: choose function `setup` and press Run. It creates the token,
 * the _Inbox sheet and the weekly backup trigger, and prints the token in the log.
 * Upgrading from 3.1: run `migrate_3_2` once (safe to run again).
 * Upgrading to 3.3 (pattern practice + rules): run `migrate_3_3` once (safe to run again).
 * Upgrading to 3.4 (quiz before writing a pattern sentence): run `migrate_3_4` once (safe to run again).
 *
 * Every request is POST with a text/plain JSON body (no CORS preflight):
 *   {action:"ping",        token}
 *   {action:"export",      token}                      -> every table as JSON
 *   {action:"ingest",      token, text | payload, dry_run?}
 *   {action:"log_reviews", token, events:[{cid, logged_at, word_id, activity, result, response_time_s}]}
 *   {action:"log_practice", token, rows:[{practice_id, logged_at, pattern_id, sentence}]}
 */

var TZ = 'Asia/Bangkok';
var EXPORT_TABLES = ['Knowledge_Master', 'Pattern_Master', 'Pattern_Examples', 'Sentence_Bank', 'Sentence_Vocab',
  'Mistake_Log', 'Word_Network', 'Learning_History', 'Pattern_Practice', 'Practice_Feedback', 'Rule_Book', '_Config'];
var PHASE2_SHEETS = ['Pattern_Practice', 'Practice_Feedback', 'Rule_Book'];
var INBOX = '_Inbox';
var INBOX_COLUMNS = ['received_at', 'hash', 'status', 'added', 'duplicate', 'invalid', 'updated', 'report', 'raw'];

// ---------------------------------------------------------------- setup

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(TZ);

  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('EKB_TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '').slice(0, 24);
    props.setProperty('EKB_TOKEN', token);
  }

  var inbox = ss.getSheetByName(INBOX);
  if (!inbox) {
    inbox = ss.insertSheet(INBOX);
    inbox.setFrozenRows(1);
  }
  inbox.getRange(1, 1, 1, INBOX_COLUMNS.length).setValues([INBOX_COLUMNS]).setFontWeight('bold');

  // Learning_History must have its header row.
  var lh = ss.getSheetByName('Learning_History');
  if (lh && lh.getLastRow() < 1) {
    lh.getRange(1, 1, 1, EKBCore.COLUMNS.Learning_History.length).setValues([EKBCore.COLUMNS.Learning_History]);
  }

  installBackupTrigger_();
  Logger.log('EKB TOKEN (ใส่ในแอป): ' + token);
  Logger.log('เสร็จแล้ว ขั้นต่อไป: Deploy > New deployment > Web app');
}

function installBackupTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'weeklyBackup') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('weeklyBackup').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create();
}

/** Copies the whole spreadsheet into Drive folder "EKB_Backups" and keeps the newest 8 copies. */
function weeklyBackup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var folders = DriveApp.getFoldersByName('EKB_Backups');
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder('EKB_Backups');
  var name = ss.getName() + ' backup ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  DriveApp.getFileById(ss.getId()).makeCopy(name, folder);

  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(8).forEach(function (f) { f.setTrashed(true); });
}

/** Rotates the token. Run it if the token ever leaks, then update the app's settings. */
function resetToken() {
  PropertiesService.getScriptProperties().deleteProperty('EKB_TOKEN');
  setup();
}

// ---------------------------------------------------------------- HTTP

function doGet() {
  return json_({ ok: true, service: 'EKB', schema: EKBCore.SCHEMA_VERSION, hint: 'use POST' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad JSON body' });
  }
  var token = PropertiesService.getScriptProperties().getProperty('EKB_TOKEN');
  if (!token || req.token !== token) return json_({ ok: false, error: 'unauthorized' });

  try {
    switch (req.action) {
      case 'ping': return json_({ ok: true, schema: EKBCore.SCHEMA_VERSION, now: nowIso_() });
      case 'export': return json_(exportAll_());
      case 'ingest': return json_(withLock_(function () { return ingest_(req); }));
      case 'log_reviews': return json_(withLock_(function () { return logReviews_(req.events || []); }));
      case 'log_practice': return json_(withLock_(function () { return logPractice_(req.rows || []); }));
      default: return json_({ ok: false, error: 'unknown action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function nowIso_() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss"); }
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

// ---------------------------------------------------------------- table I/O

function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('missing sheet ' + name);
  return sh;
}

/** Reads a sheet into [{col: value}], skipping fully empty rows. Dates become yyyy-mm-dd strings. */
function readTable_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 1) return [];
  var values = sh.getDataRange().getValues();
  var head = values.shift().map(String);
  var out = [];
  values.forEach(function (r) {
    if (r.every(function (v) { return v === '' || v === null; })) return;
    var o = {};
    head.forEach(function (h, i) {
      if (!h) return;
      var v = r[i];
      if (Object.prototype.toString.call(v) === '[object Date]') {
        v = (h === 'logged_at' || h === 'checked_at')
          ? Utilities.formatDate(v, TZ, "yyyy-MM-dd'T'HH:mm:ss")
          : Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
      }
      o[h] = v;
    });
    out.push(o);
  });
  return out;
}

function headers_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

/** Appends row objects, matching columns by header name (column order in the sheet does not matter). */
function appendRows_(name, rows) {
  if (!rows.length) return;
  var sh = sheet_(name);
  var head = headers_(sh);
  var data = rows.map(function (o) {
    return head.map(function (h) { return (o[h] === undefined || o[h] === null) ? '' : o[h]; });
  });
  var start = lastDataRow_(sh) + 1;
  sh.getRange(start, 1, data.length, head.length).setValues(data);
}

/** Last row with something in column A (getLastRow counts formatted-but-empty rows). */
function lastDataRow_(sh) {
  var n = sh.getLastRow();
  if (n < 2) return n;
  var col = sh.getRange(1, 1, n, 1).getValues();
  for (var i = col.length - 1; i >= 0; i--) if (col[i][0] !== '' && col[i][0] !== null) return i + 1;
  return 1;
}

/** Writes cell updates, one read + one write per column (fast even for hundreds of cells). */
function applyUpdates_(updates) {
  var groups = {};
  updates.forEach(function (u) {
    var k = u.table + '|' + u.col;
    (groups[k] = groups[k] || []).push(u);
  });
  Object.keys(groups).forEach(function (k) {
    var list = groups[k];
    var sh = sheet_(list[0].table);
    var head = headers_(sh);
    var n = lastDataRow_(sh);
    var idc = head.indexOf(list[0].idCol);
    var c = head.indexOf(list[0].col);
    if (n < 2 || idc < 0 || c < 0) return;
    var ids = sh.getRange(2, idc + 1, n - 1, 1).getValues().map(function (r) { return String(r[0]); });
    var range = sh.getRange(2, c + 1, n - 1, 1);
    var vals = range.getValues();
    list.forEach(function (u) {
      var r = ids.indexOf(String(u.id));
      if (r >= 0) vals[r][0] = u.value;
    });
    range.setValues(vals);
  });
}

// ---------------------------------------------------------------- actions

function exportAll_() {
  var tables = {};
  EXPORT_TABLES.forEach(function (t) { tables[t] = readTable_(t); });
  var config = {};
  tables._Config.forEach(function (r) { config[r.key] = r.value; });
  delete tables._Config;
  return { ok: true, schema: EKBCore.SCHEMA_VERSION, exported_at: nowIso_(), config: config, tables: tables };
}

function ingest_(req) {
  var payload = req.payload;
  if (!payload) {
    var ex = EKBCore.extractPayload(req.text || '');
    if (!ex.ok) return { ok: false, error: ex.error };
    payload = ex.payload;
  }
  // The same reply pasted twice must not count a mistake as repeated.
  var hash = EKBCore.hashPayload(payload);
  var seenBefore = readTable_(INBOX).some(function (r) { return r.hash === hash; });
  if (seenBefore && !req.dry_run) {
    return { ok: true, already: true, counts: { added: 0, duplicate: 0, invalid: 0, updated: 0, examples: 0 },
      report: [{ index: -1, type: '-', label: 'ข้อความนี้เคยบันทึกไปแล้ว', status: 'duplicate', errors: [], warnings: [] }] };
  }
  // A 3.2 usage_tip would be dropped silently if the column is missing: stop and say why.
  var wantsTip = (payload.entries || []).some(function (e) { return e && String(e.usage_tip || '').trim(); });
  if (wantsTip && headers_(sheet_('Knowledge_Master')).indexOf('usage_tip') < 0) {
    return { ok: false, error: 'ชีตยังไม่มีคอลัมน์ usage_tip ให้เปิด Apps Script แล้วรัน migrate_3_2 ก่อน' };
  }
  // Rules and practice feedback need the 3.3 sheets.
  var wantsRules = (payload.rules && payload.rules.length) || (payload.feedback && payload.feedback.length) ||
    (payload.entries || []).some(function (e) { return e && String(e.rule_key || '').trim(); });
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (wantsRules && PHASE2_SHEETS.some(function (n) { return !ss.getSheetByName(n); })) {
    return { ok: false, error: 'ชีตยังไม่มีตารางกฎ/ฝึก Pattern ให้เปิด Apps Script แล้วรัน migrate_3_3 ก่อน' };
  }
  var wantsQuiz = (payload.entries || []).some(function (e) { return e && e.type === 'pattern' && e.slot_quiz; });
  if (wantsQuiz && headers_(sheet_('Pattern_Master')).indexOf('slot_quiz') < 0) {
    return { ok: false, error: 'ชีตยังไม่มีคอลัมน์ slot_quiz ให้เปิด Apps Script แล้วรัน migrate_3_4 ก่อน' };
  }
  var db = {
    Knowledge_Master: readTable_('Knowledge_Master'),
    Pattern_Master: readTable_('Pattern_Master'),
    Pattern_Examples: readTable_('Pattern_Examples'),
    Mistake_Log: readTable_('Mistake_Log'),
    Rule_Book: readTable_('Rule_Book'),
    Pattern_Practice: readTable_('Pattern_Practice')
  };
  var plan = EKBCore.planIngest(payload, db, today_());
  if (req.dry_run) return { ok: true, dry_run: true, counts: plan.counts, report: plan.report };

  var dateAdded = new Date();
  plan.appends.Knowledge_Master.forEach(function (r) { r.date_added = dateAdded; });
  // Patterns first so foreign keys never point at a row that is not written yet.
  var checkedAt = nowIso_();
  (plan.appends.Practice_Feedback || []).forEach(function (r) { r.checked_at = checkedAt; });
  ['Rule_Book', 'Pattern_Master', 'Pattern_Examples', 'Knowledge_Master', 'Mistake_Log', 'Practice_Feedback'].forEach(function (t) {
    if (plan.appends[t] && plan.appends[t].length) appendRows_(t, plan.appends[t]);
  });
  applyUpdates_(plan.updates);
  if (plan.appends.Rule_Book && plan.appends.Rule_Book.length) refreshRulesDoc_();

  appendRows_(INBOX, [{
    received_at: new Date(),
    hash: hash,
    status: plan.counts.invalid ? 'partial' : 'ok',
    added: plan.counts.added,
    duplicate: plan.counts.duplicate,
    invalid: plan.counts.invalid,
    updated: plan.counts.updated,
    report: JSON.stringify(plan.report).slice(0, 45000),
    raw: JSON.stringify(payload).slice(0, 45000)
  }]);

  return { ok: true, counts: plan.counts, report: plan.report };
}

/** Sentences written in pattern practice. Idempotent by practice_id; unknown patterns are skipped. */
function logPractice_(rows) {
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Pattern_Practice')) {
    return { ok: false, error: 'ชีตยังไม่มี Pattern_Practice ให้รัน migrate_3_3 ก่อน' };
  }
  var seen = {};
  readTable_('Pattern_Practice').forEach(function (r) { seen[String(r.practice_id)] = true; });
  var patterns = {};
  readTable_('Pattern_Master').forEach(function (r) { patterns[r.pattern_id] = true; });
  var out = [];
  var accepted = [];
  var skipped = [];
  rows.forEach(function (r) {
    var id = String((r && r.practice_id) || '');
    if (!id) return;
    if (seen[id]) { accepted.push(id); return; }
    if (!patterns[r.pattern_id] || !String(r.sentence || '').trim()) { skipped.push(id); accepted.push(id); return; }
    seen[id] = true;
    out.push({ practice_id: id, logged_at: String(r.logged_at || nowIso_()).slice(0, 19), pattern_id: r.pattern_id,
      sentence: String(r.sentence).trim().slice(0, 2000) });
    accepted.push(id);
  });
  if (out.length) appendRows_('Pattern_Practice', out);
  return { ok: true, written: out.length, accepted: accepted, skipped_ids: skipped };
}

function logReviews_(events) {
  var existing = readTable_('Learning_History');
  var seen = {};
  existing.forEach(function (r) {
    var m = /cid:([\w-]+)/.exec(String(r.note || ''));
    if (m) seen[m[1]] = true;
  });
  var known = {};
  readTable_('Knowledge_Master').forEach(function (r) { known[r.word_id] = true; });
  var nextLog = EKBCore.makeIdAllocator('LOG', existing.map(function (r) { return r.log_id; }), 5);

  var rows = [];
  var skipped = 0;
  var accepted = [];
  var skippedCids = []; // accepted but never stored: the app can forget them
  events.forEach(function (ev) {
    if (!ev || !ev.cid) { skipped++; return; }
    if (seen[ev.cid]) { accepted.push(ev.cid); return; } // already stored: idempotent
    if (!known[ev.word_id] || EKBCore.RESULTS.indexOf(ev.result) < 0) { skipped++; accepted.push(ev.cid); skippedCids.push(ev.cid); return; }
    seen[ev.cid] = true;
    rows.push({
      log_id: nextLog(),
      logged_at: String(ev.logged_at || nowIso_()).slice(0, 19),
      word_id: ev.word_id,
      activity: ev.activity || 'flashcard',
      result: ev.result,
      response_time_s: ev.response_time_s === undefined ? '' : ev.response_time_s,
      source: 'app',
      note: 'cid:' + ev.cid
    });
    accepted.push(ev.cid);
  });
  appendRows_('Learning_History', rows);
  return { ok: true, written: rows.length, skipped: skipped, accepted: accepted, skipped_cids: skippedCids };
}

// ---------------------------------------------------------------- migrations

/**
 * Schema 3.1 -> 3.2. Run once from the Apps Script editor; running it again does nothing.
 *  - Knowledge_Master gets a usage_tip column at the far right (after notes)
 *  - _Schema documents it, _Config.schema_version becomes 3.2, _Config.quiz_every defaults to 6
 * Before changing anything it copies the whole spreadsheet into Drive folder EKB_Backups.
 */
function migrate_3_2() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var km = sheet_('Knowledge_Master');
  var needCol = headers_(km).indexOf('usage_tip') < 0;

  var schema = ss.getSheetByName('_Schema');
  var needSchema = !!schema && !readTable_('_Schema').some(function (r) {
    return r.table === 'Knowledge_Master' && r.column === 'usage_tip';
  });

  var cfg = {};
  readTable_('_Config').forEach(function (r) { cfg[r.key] = String(r.value); });
  var needVersion = cfg.schema_version !== '3.2';
  var needQuiz = !Object.prototype.hasOwnProperty.call(cfg, 'quiz_every');

  if (!needCol && !needSchema && !needVersion && !needQuiz) {
    Logger.log('migrate_3_2: เป็น 3.2 อยู่แล้ว ไม่ได้แก้อะไร');
    return { changed: false };
  }

  var backupName = backupCopy_('ก่อน 3.2');
  Logger.log('migrate_3_2: สำรองไฟล์แล้ว -> EKB_Backups/' + backupName);

  if (needCol) {
    var last = km.getLastColumn();
    if (km.getMaxColumns() <= last) km.insertColumnAfter(last);
    km.getRange(1, last + 1).setValue('usage_tip').setFontWeight('bold');
  }
  if (needSchema) {
    appendRows_('_Schema', [{ table: 'Knowledge_Master', column: 'usage_tip', type: 'text', key: '', references: '',
      required: 'no', note: 'ทริคการใช้ เช่น +with ต่างจาก +to ยังไง' }]);
  }
  if (needVersion) setConfig_('schema_version', '3.2', 'bump this whenever a column is added or renamed');
  if (needQuiz) setConfig_('quiz_every', '6', 'app-side: ask one quiz question every N cards (0 = off)');

  Logger.log('migrate_3_2: เสร็จแล้ว เป็น schema 3.2');
  return { changed: true, column: needCol, schema: needSchema, version: needVersion, quiz: needQuiz };
}

function setConfig_(key, value, note) {
  var sh = sheet_('_Config');
  var head = headers_(sh);
  var kc = head.indexOf('key');
  var vc = head.indexOf('value');
  var n = lastDataRow_(sh);
  var keys = n >= 2 ? sh.getRange(2, kc + 1, n - 1, 1).getValues().map(function (r) { return String(r[0]); }) : [];
  var at = keys.indexOf(key);
  if (at >= 0) sh.getRange(at + 2, vc + 1).setValue(value);
  else appendRows_('_Config', [{ key: key, value: value, note: note || '' }]);
}

function backupCopy_(label) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var folders = DriveApp.getFoldersByName('EKB_Backups');
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder('EKB_Backups');
  var name = ss.getName() + ' ' + label + ' ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HHmm');
  DriveApp.getFileById(ss.getId()).makeCopy(name, folder);
  return name;
}


/**
 * Schema 3.2 -> 3.3: pattern practice + rules. Run once; running it again does nothing.
 *  - new sheets Pattern_Practice, Practice_Feedback, Rule_Book (headers only)
 *  - Mistake_Log gets rule_key at the far right
 *  - _Schema documents them, _Config.schema_version becomes 3.3
 *  - creates the Google Doc "JIN Rule_Book" that Claude reads before adding a rule
 * Copies the whole spreadsheet into EKB_Backups first.
 */
function migrate_3_3() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var missing = PHASE2_SHEETS.filter(function (n) { return !ss.getSheetByName(n); });
  var ml = sheet_('Mistake_Log');
  var needCol = headers_(ml).indexOf('rule_key') < 0;
  var schemaRows = readTable_('_Schema');
  var documented = {};
  schemaRows.forEach(function (r) { documented[r.table + '.' + r.column] = true; });
  var SCHEMA_3_3 = [
    ['Pattern_Practice', 'practice_id', 'text', 'PK', '', 'yes', 'PP-YYMMDD-xxxxx, made by the app'],
    ['Pattern_Practice', 'logged_at', 'datetime', '', '', 'yes', 'when the sentence was written (Asia/Bangkok)'],
    ['Pattern_Practice', 'pattern_id', 'text', 'FK', 'Pattern_Master.pattern_id', 'yes', ''],
    ['Pattern_Practice', 'sentence', 'text', '', '', 'yes', 'free sentence written in practice'],
    ['Practice_Feedback', 'practice_id', 'text', 'FK', 'Pattern_Practice.practice_id', 'yes', 'append-only; newest row wins'],
    ['Practice_Feedback', 'checked_at', 'datetime', '', '', 'yes', ''],
    ['Practice_Feedback', 'ok', 'enum', '', '', 'yes', 'Yes = grammar and pattern correct'],
    ['Practice_Feedback', 'corrected', 'text', '', '', 'no', 'better / corrected sentence'],
    ['Practice_Feedback', 'feedback_th', 'text', '', '', 'no', ''],
    ['Practice_Feedback', 'rule_keys', 'list', 'FK', 'Rule_Book.rule_key', 'no', '"; " separated'],
    ['Rule_Book', 'rule_key', 'text', 'PK', '', 'yes', 'ascii slug, e.g. passive-for-things'],
    ['Rule_Book', 'title_th', 'text', '', '', 'yes', ''],
    ['Rule_Book', 'explain_th', 'text', '', '', 'no', ''],
    ['Rule_Book', 'wrong_example', 'text', '', '', 'no', ''],
    ['Rule_Book', 'right_example', 'text', '', '', 'no', ''],
    ['Rule_Book', 'category', 'enum', '', '', 'yes', 'Grammar / Preposition / Word choice / Spelling'],
    ['Rule_Book', 'created_at', 'date', '', '', 'yes', ''],
    ['Mistake_Log', 'rule_key', 'text', 'FK', 'Rule_Book.rule_key', 'no', 'rule this mistake breaks']
  ].filter(function (r) { return !documented[r[0] + '.' + r[1]]; });
  var cfg = {};
  readTable_('_Config').forEach(function (r) { cfg[r.key] = String(r.value); });
  var needVersion = cfg.schema_version !== '3.3';
  var props = PropertiesService.getScriptProperties();
  var needDoc = !props.getProperty('JIN_RULES_DOC');

  if (!missing.length && !needCol && !SCHEMA_3_3.length && !needVersion && !needDoc) {
    Logger.log('migrate_3_3: เป็น 3.3 อยู่แล้ว ไม่ได้แก้อะไร');
    return { changed: false };
  }
  Logger.log('migrate_3_3: สำรองไฟล์แล้ว -> EKB_Backups/' + backupCopy_('ก่อน 3.3'));

  missing.forEach(function (name) {
    var sh = ss.insertSheet(name);
    var cols = EKBCore.COLUMNS[name];
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  if (needCol) {
    var last = ml.getLastColumn();
    if (ml.getMaxColumns() <= last) ml.insertColumnAfter(last);
    ml.getRange(1, last + 1).setValue('rule_key').setFontWeight('bold');
  }
  if (SCHEMA_3_3.length && ss.getSheetByName('_Schema')) {
    appendRows_('_Schema', SCHEMA_3_3.map(function (r) {
      return { table: r[0], column: r[1], type: r[2], key: r[3], references: r[4], required: r[5], note: r[6] };
    }));
  }
  if (needVersion) setConfig_('schema_version', '3.3', 'bump this whenever a column is added or renamed');
  refreshRulesDoc_();
  Logger.log('migrate_3_3: เสร็จแล้ว เป็น schema 3.3 · เอกสารกฎ: ' + rulesDocUrl_());
  return { changed: true, sheets: missing, column: needCol, version: needVersion };
}

/**
 * Writes every rule into the Google Doc "JIN Rule_Book" (a read-only copy for Claude, so a chat can check
 * which rules already exist before adding one). The sheet stays the source of truth.
 */
function refreshRulesDoc_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty('JIN_RULES_DOC');
    var doc = null;
    if (id) { try { doc = DocumentApp.openById(id); } catch (e) { doc = null; } }
    if (!doc) {
      doc = DocumentApp.create('JIN Rule_Book');
      props.setProperty('JIN_RULES_DOC', doc.getId());
    }
    var body = doc.getBody();
    body.clear();
    body.appendParagraph('JIN Rule_Book (สำเนาอัตโนมัติจากชีต EKB Database อัปเดต ' + nowIso_() + ')');
    body.appendParagraph('รูปแบบ: rule_key | หัวข้อ | category | ตัวอย่างผิด → ถูก');
    var rules = readTable_('Rule_Book');
    if (!rules.length) body.appendParagraph('(ยังไม่มีกฎ)');
    rules.forEach(function (r) {
      body.appendParagraph([r.rule_key, r.title_th, r.category, (r.wrong_example || '') + ' → ' + (r.right_example || '')].join(' | '));
    });
    doc.saveAndClose();
  } catch (err) {
    Logger.log('refreshRulesDoc_: ' + err);
  }
}

function rulesDocUrl_() {
  var id = PropertiesService.getScriptProperties().getProperty('JIN_RULES_DOC');
  return id ? 'https://docs.google.com/document/d/' + id : '(ยังไม่มี)';
}


/**
 * Schema 3.3 -> 3.4: Pattern_Master gets slot_quiz at the far right (the question asked before writing a sentence:
 * "prompt | answer | wrong 1; wrong 2; wrong 3 | why"). Run once; running it again does nothing. Backs up first.
 */
function migrate_3_4() {
  var pm = sheet_('Pattern_Master');
  var needCol = headers_(pm).indexOf('slot_quiz') < 0;
  var documented = readTable_('_Schema').some(function (r) { return r.table === 'Pattern_Master' && r.column === 'slot_quiz'; });
  var cfg = {};
  readTable_('_Config').forEach(function (r) { cfg[r.key] = String(r.value); });
  var needVersion = Number(cfg.schema_version) < 3.4;
  if (!needCol && documented && !needVersion) {
    Logger.log('migrate_3_4: เป็น 3.4 อยู่แล้ว ไม่ได้แก้อะไร');
    return { changed: false };
  }
  Logger.log('migrate_3_4: สำรองไฟล์แล้ว -> EKB_Backups/' + backupCopy_('ก่อน 3.4'));
  if (needCol) {
    var last = pm.getLastColumn();
    if (pm.getMaxColumns() <= last) pm.insertColumnAfter(last);
    pm.getRange(1, last + 1).setValue('slot_quiz').setFontWeight('bold');
  }
  if (!documented && SpreadsheetApp.getActiveSpreadsheet().getSheetByName('_Schema')) {
    appendRows_('_Schema', [{ table: 'Pattern_Master', column: 'slot_quiz', type: 'text', key: '', references: '', required: 'no',
      note: 'คำถามก่อนแต่งประโยค: prompt | answer | ตัวหลอก; ตัวหลอก; ตัวหลอก | เหตุผล' }]);
  }
  if (needVersion) setConfig_('schema_version', '3.4', 'bump this whenever a column is added or renamed');
  Logger.log('migrate_3_4: เสร็จแล้ว เป็น schema 3.4');
  return { changed: true, column: needCol };
}
