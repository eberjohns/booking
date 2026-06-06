/**
 * Google Apps Script — Time Slot Booking API
 * ============================================
 * Deploy as Web App:  Execute as: Me,  Who has access: Anyone
 *
 * KEY DESIGN DECISION:
 *   The "Status" column (col B) is ONLY for the admin.
 *     "open"  = slot is available for booking
 *     "close" = slot is blocked by admin (break, lunch, etc.)
 *   The booking system NEVER writes to col B.
 *
 *   A slot is considered BOOKED when col C+ fields contain data.
 *   Admin clears those cells → slot is free again. Simple.
 *
 * Sheet structure (every tab):
 *   Row 1  : Headers  — A:"Time"  B:"Status"  C+: field names (Name, Phone…)
 *   Row 2+ : Data     — A: time   B: open/close  C+: booking data (empty = free)
 *
 * ALL requests use POST — Apps Script never caches POST responses.
 */

var INTERNAL = ['booked at', 'booked_at', 'bookedat', 'timestamp', 'booked on'];

// ─── doGet ────────────────────────────────────────────────────────────────────
function doGet() {
  return ContentService
    .createTextOutput('Booking API is live. All requests must use POST.')
    .setMimeType(ContentService.MimeType.TEXT);
}

// ─── doPost ───────────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    var payload;
    try { payload = JSON.parse(e.postData.contents); }
    catch (err) { return respond({ error: 'Bad JSON: ' + err.message }); }

    if (payload.action === 'getSlots') return actionGetSlots();
    if (payload.action === 'bookSlot') return actionBookSlot(payload);
    return respond({ error: 'Unknown action.' });
  } catch (err) {
    return respond({ error: 'Server error: ' + err.message });
  }
}

// ─── actionGetSlots ───────────────────────────────────────────────────────────
function actionGetSlots() {
  var ss      = SpreadsheetApp.getActiveSpreadsheet();
  var sheets  = ss.getSheets();
  var result  = {};
  var globalHeaders = [];  // user-visible field names from col C+

  for (var si = 0; si < sheets.length; si++) {
    var sheet     = sheets[si];
    var sheetName = sheet.getName().trim();
    var lastRow   = sheet.getLastRow();
    var lastCol   = sheet.getLastColumn();

    if (lastRow < 2 || lastCol < 2) continue;

    var data      = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    var headerRow = data[0];

    // Must have Time (A) and Status (B)
    if (!String(headerRow[0]).trim() || !String(headerRow[1]).trim()) continue;

    // Collect user-visible field headers from col C onward
    // Keep the longest valid list seen across all sheets
    var sheetHeaders = [];
    for (var h = 2; h < headerRow.length; h++) {
      var hname = String(headerRow[h]).trim();
      if (hname && INTERNAL.indexOf(hname.toLowerCase()) === -1) {
        sheetHeaders.push(hname);
      }
    }
    if (sheetHeaders.length > globalHeaders.length) {
      globalHeaders = sheetHeaders;
    }

    var slots = [];
    for (var r = 1; r < data.length; r++) {
      var timeVal   = String(data[r][0] || '').trim();
      var statusVal = String(data[r][1] || '').trim().toLowerCase();

      if (!timeVal) continue;
      if (statusVal !== 'open' && statusVal !== 'close') continue;

      // A slot is "booked" if ANY user-visible field in col C+ has a value.
      // We deliberately ignore internal columns (Booked At, etc.).
      var isBooked = false;
      for (var c = 2; c < data[r].length; c++) {
        var colHeader = String(headerRow[c] || '').trim();
        if (!colHeader || INTERNAL.indexOf(colHeader.toLowerCase()) !== -1) continue;
        if (String(data[r][c] || '').trim() !== '') {
          isBooked = true;
          break;
        }
      }

      slots.push({
        row:    r + 1,                        // 1-based sheet row
        slotId: sheetName + '||' + timeVal,   // stable identity key
        time:   timeVal,
        status: statusVal,                    // admin-controlled: "open" | "close"
        booked: isBooked                      // true if booking fields are filled
      });
    }

    if (slots.length > 0) {
      result[sheetName] = slots;
    }
  }

  if (Object.keys(result).length === 0) {
    return respond({ error: 'No valid slot data found. Check sheet structure.' });
  }

  return respond({ data: result, headers: globalHeaders });
}

// ─── actionBookSlot ───────────────────────────────────────────────────────────
function actionBookSlot(payload) {
  var date   = payload.date;
  var row    = payload.row;
  var fields = payload.fields || {};

  if (!date || !row) return respond({ error: 'Missing date or row.' });

  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(date);
  if (!sheet) return respond({ error: 'Sheet "' + date + '" not found.' });

  // Serialise concurrent writes
  var lock = LockService.getPublicLock();
  try { lock.waitLock(8000); }
  catch (e) { return respond({ error: 'Server busy. Please try again.' }); }

  try {
    var lastCol     = sheet.getLastColumn();
    var headerRow   = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    var dataRow     = sheet.getRange(row, 1, 1, lastCol).getValues()[0];

    // ── Concurrency check ──────────────────────────────────────────────────
    // Re-read the status — if admin blocked it since the user loaded the page
    var liveStatus = String(dataRow[1] || '').trim().toLowerCase();
    if (liveStatus !== 'open') {
      return respond({ conflict: true });
    }

    // Re-check booking fields — another user may have filled them just now
    for (var c = 2; c < dataRow.length; c++) {
      var colHeader = String(headerRow[c] || '').trim();
      if (!colHeader || INTERNAL.indexOf(colHeader.toLowerCase()) !== -1) continue;
      if (String(dataRow[c] || '').trim() !== '') {
        return respond({ conflict: true });
      }
    }

    // ── Write booking fields (col C+) — NEVER touch col B ─────────────────
    for (var wc = 2; wc < headerRow.length; wc++) {
      var colName = String(headerRow[wc]).trim();
      if (!colName || INTERNAL.indexOf(colName.toLowerCase()) !== -1) continue;
      var val = fields.hasOwnProperty(colName) ? String(fields[colName]) : '';
      sheet.getRange(row, wc + 1).setValue(val);
    }

    // ── Write timestamp ────────────────────────────────────────────────────
    var tsCol = -1;
    for (var tc = 0; tc < headerRow.length; tc++) {
      if (String(headerRow[tc]).trim().toLowerCase() === 'booked at') {
        tsCol = tc + 1;
        break;
      }
    }
    if (tsCol === -1) {
      tsCol = lastCol + 1;
      sheet.getRange(1, tsCol).setValue('Booked At');
    }
    sheet.getRange(row, tsCol).setValue(new Date().toISOString());

    return respond({ success: true });

  } finally {
    lock.releaseLock();
  }
}

// ─── respond ──────────────────────────────────────────────────────────────────
function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
