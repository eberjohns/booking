/**
 * Booking System — Frontend
 *
 * Slot states (from the sheet):
 *   status = "close"             → blocked by admin (break/lunch). Red, unclickable.
 *   status = "open", booked=true → filled by a user.              Red, unclickable.
 *   status = "open", booked=false → free to book.                 Green, clickable.
 *
 * The booking system NEVER writes to the Status column.
 * "Taken" = booking fields (col C+) contain data.
 * Admin clears those cells → slot becomes free again automatically.
 */

'use strict';

const POLL_MS = 10000;
const LS_KEY  = 'slotBooking_v4';   // bumped — clears any stale localStorage

let apiUrl       = null;
let allData      = {};   // { date: [ {row, slotId, time, status, booked} ] }
let extraHeaders = [];   // field names from col C+
let activeDate   = null;
let myBooking    = null; // { slotId, date, row, time } | null
let pollTimer    = null;
let modalOpen    = false;
let pendingSlot  = null;

// ─── DOM ──────────────────────────────────────────────────────────────────────
const el = {
  setupScreen  : document.getElementById('setup-screen'),
  app          : document.getElementById('app'),
  loadingState : document.getElementById('loading-state'),
  errorState   : document.getElementById('error-state'),
  errorTitle   : document.getElementById('error-title'),
  errorMessage : document.getElementById('error-message'),
  retryBtn     : document.getElementById('retry-btn'),
  bookingUi    : document.getElementById('booking-ui'),
  dateTabs     : document.getElementById('date-tabs'),
  slotsGrid    : document.getElementById('slots-grid'),
  noSlotsMsg   : document.getElementById('no-slots-msg'),
  bookedBanner : document.getElementById('booked-banner'),
  bookedDetail : document.getElementById('booked-detail'),
  bookedBadge  : document.getElementById('already-booked-badge'),
  bookedAddCal  : document.getElementById('booked-addcal'),
  modalOverlay : document.getElementById('modal-overlay'),
  modalClose   : document.getElementById('modal-close'),
  modalCancel  : document.getElementById('modal-cancel'),
  modalSubmit  : document.getElementById('modal-submit'),
  modalSubmitTxt: document.getElementById('modal-submit-text'),
  modalSubmitSpn: document.getElementById('modal-submit-spinner'),
  modalDateLbl : document.getElementById('modal-date-label'),
  modalSlotTime: document.getElementById('modal-slot-time'),
  modalFields  : document.getElementById('modal-form-fields'),
  modalError   : document.getElementById('modal-error'),
  announceOverlay: document.getElementById('announce-overlay'),
  announceCard   : document.getElementById('announce-card'),
  announceIcon   : document.getElementById('announce-icon'),
  announceTitle  : document.getElementById('announce-title'),
  announceBody   : document.getElementById('announce-body'),
  announceBtn    : document.getElementById('announce-btn'),
  announceAddCal  : document.getElementById('announce-addcal'),
};

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  bindSetupEvents();  // Always bind setup events
  apiUrl = readApiParam();
  if (!apiUrl) { show(el.setupScreen); return; }

  show(el.app);
  myBooking = loadBooking();
  bindEvents();
  poll(false);
  pollTimer = setInterval(() => poll(true), POLL_MS);
});

function readApiParam() {
  try {
    const raw = new URLSearchParams(window.location.search).get('api');
    if (!raw) return null;
    const u = decodeURIComponent(raw).trim();
    return u.startsWith('http') ? u : null;
  } catch { return null; }
}

// ─── LocalStorage ─────────────────────────────────────────────────────────────
function loadBooking() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || null; }
  catch { return null; }
}
function saveBooking(b) {
  myBooking = b;
  try { localStorage.setItem(LS_KEY, JSON.stringify(b)); } catch {}
}
function dropBooking() {
  myBooking = null;
  try { localStorage.removeItem(LS_KEY); } catch {}
}

// ─── API (always POST — Apps Script never caches POST) ────────────────────────
async function apiFetch(body) {
  const res = await fetch(apiUrl, {
    method : 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body   : JSON.stringify(body),
    cache  : 'no-store',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// ─── Poll ─────────────────────────────────────────────────────────────────────
async function poll(silent) {
  if (!silent) showSkeleton();

  try {
    const json = await apiFetch({ action: 'getSlots' });
    if (json.error) throw new Error(json.error);
    if (!json.data)  throw new Error('No data returned. Check sheet structure.');

    allData      = json.data;
    extraHeaders = json.headers || [];

    // Always reconcile BEFORE rendering — sheet is the source of truth
    reconcile();
    renderAll();
    if (!silent) hideSkeleton();

  } catch (err) {
    if (!silent) showError('Could not load availability', friendlyError(err));
    // silent failures: keep showing the last known state
  }
}

// ─── Reconcile ────────────────────────────────────────────────────────────────
// Drop the local booking if the sheet no longer shows it as booked.
// This is what lets admins free a slot by clearing the cells.
function reconcile() {
  if (!myBooking) return;

  const slots = allData[myBooking.date];
  if (!slots) { dropBooking(); return; }   // date tab deleted

  const live = slots.find(s => s.slotId === myBooking.slotId);
  if (!live)  { dropBooking(); return; }   // row deleted or time changed

  // The slot is free again if:
  //   - admin set status to "close" (blocked — no longer an open bookable slot)
  //   - admin cleared the booking fields (booked flips back to false)
  //   - status changed away from "open" for any reason
  if (!live.booked || live.status !== 'open') {
    dropBooking();
    return;
  }

  // Still valid — sync row number in case rows shifted
  myBooking.row = live.row;
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderAll() {
  hide(el.errorState);
  hide(el.loadingState);

  const dates = Object.keys(allData);
  if (dates.length === 0) {
    showError('No dates found', 'The sheet has no valid tabs with Time/Status columns.');
    return;
  }

  show(el.bookingUi);

  if (!activeDate || !dates.includes(activeDate)) {
    activeDate = (myBooking && dates.includes(myBooking.date))
      ? myBooking.date : dates[0];
  }

  renderTabs(dates);
  renderSlots(activeDate);
  renderBanner();
}

function renderTabs(dates) {
  el.dateTabs.innerHTML = '';
  dates.forEach(date => {
    const btn = document.createElement('button');
    btn.className  = 'date-tab' + (date === activeDate ? ' active' : '');
    btn.textContent = date;
    btn.setAttribute('role', 'tab');
    btn.addEventListener('click', () => {
      activeDate = date;
      renderTabs(dates);
      renderSlots(date);
    });
    el.dateTabs.appendChild(btn);
  });
}

function renderSlots(date) {
  el.slotsGrid.innerHTML = '';
  const slots = (allData[date] || []).filter(
    s => s.status === 'open' || s.status === 'close'
  );

  if (slots.length === 0) { show(el.noSlotsMsg); return; }
  hide(el.noSlotsMsg);
  slots.forEach(s => el.slotsGrid.appendChild(makeCard(s)));
}

function makeCard(slot) {
  // ── Determine display state ──────────────────────────────────────────────
  // Priority order:
  //   1. isMine  — this user's own booking
  //   2. taken   — status=open but fields filled (another user booked it)
  //   3. blocked — status=close (admin-set: break, lunch, etc.)
  //   4. disabled — user already has a booking elsewhere, can't book again
  //   5. open    — free to book

  const isMine    = !!myBooking && myBooking.slotId === slot.slotId;
  const isBlocked = slot.status === 'close';
  const isTaken   = !isBlocked && slot.booked;
  const isFree    = !isBlocked && !isTaken;
  const isDisabled = !!myBooking && !isMine; // user has a booking on a different slot

  const card = document.createElement('div');

  let cls   = 'slot-card';
  let label = '';

  if (isMine) {
    cls   += ' mine';
    label  = 'Your booking';
  } else if (isBlocked) {
    cls   += ' taken';
    label  = 'Unavailable';
  } else if (isTaken) {
    cls   += ' taken';
    label  = 'Unavailable';
  } else if (isDisabled) {
    // Free slot, but this user can't book twice
    cls   += ' disabled';
    label  = 'Available';
  } else {
    // Genuinely free and this user hasn't booked yet
    cls   += ' open';
    label  = 'Available — click to book';
    card.addEventListener('click', () => openModal(slot));
  }

  card.className = cls;
  card.innerHTML =
    '<span class="slot-time">'         + esc(slot.time) + '</span>' +
    '<span class="slot-status-label">' + label          + '</span>' +
    (isMine ? '<span class="slot-mine-mark">✓ Yours</span>' : '');

  return card;
}

function renderBanner() {
  if (myBooking) {
    el.bookedDetail.textContent = ' — ' + myBooking.date + ', ' + myBooking.time;
    show(el.bookedBanner);
    show(el.bookedBadge);
    if (el.bookedAddCal) {
      el.bookedAddCal.style.display = '';
      el.bookedAddCal.onclick = () => {
        addCalendarFromBooking();
      };
    }
  } else {
    hide(el.bookedBanner);
    hide(el.bookedBadge);
    if (el.bookedAddCal) {
      el.bookedAddCal.style.display = 'none';
      el.bookedAddCal.onclick = null;
    }
  }
}

function addCalendarFromBooking() {
  if (!myBooking) return alert('No booking found');
  const startDate = parseDateTime(myBooking.date, myBooking.time);
  const endDate = new Date(startDate.getTime() + 60*60*1000);
  const eventObj = {
    title: 'Booking: ' + (extraHeaders[0] || 'Appointment'),
    description: 'Booked via booking page',
    location: '',
    startDate,
    endDate,
  };
  const ok = confirm('Open Google Calendar? OK to open Google Calendar, Cancel to download .ics');
  if (ok) {
    window.open(googleCalendarUrl(eventObj), '_blank');
  } else {
    const ics = generateICS(eventObj);
    downloadICS(ics, 'booking-event.ics');
  }
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function openModal(slot) {
  if (myBooking || modalOpen) return;
  pendingSlot = { ...slot };
  modalOpen   = true;

  el.modalDateLbl.textContent  = activeDate;
  el.modalSlotTime.textContent = slot.time;
  el.modalFields.innerHTML     = '';
  hide(el.modalError);

  if (extraHeaders.length === 0) {
    const p = document.createElement('p');
    p.style.cssText = 'color:var(--text-mid);font-size:.9rem;';
    p.textContent   = 'Click "Confirm Booking" to reserve this slot.';
    el.modalFields.appendChild(p);
  } else {
    extraHeaders.forEach(h => {
      const isArea = /note|comment|message|detail|remark/i.test(h);
      const id     = 'f_' + h.replace(/\W/g, '_');
      const div    = document.createElement('div');
      div.className = 'form-field';
      div.innerHTML =
        '<label for="' + id + '">' + esc(h) + '</label>' +
        (isArea
          ? '<textarea id="'  + id + '" name="' + esc(h) + '" placeholder="' + esc(h) + '" rows="3"></textarea>'
          : '<input type="text" id="' + id + '" name="' + esc(h) + '" placeholder="' + esc(h) + '" />');
      el.modalFields.appendChild(div);
    });
  }

  show(el.modalOverlay);
  setTimeout(() => {
    const f = el.modalFields.querySelector('input,textarea');
    if (f) f.focus();
  }, 50);
}

function closeModal() {
  hide(el.modalOverlay);
  modalOpen   = false;
  pendingSlot = null;
  hide(el.modalError);
  setBusy(false);
}

function setBusy(on) {
  el.modalSubmit.disabled = on;
  on ? (hide(el.modalSubmitTxt), show(el.modalSubmitSpn))
     : (show(el.modalSubmitTxt), hide(el.modalSubmitSpn));
}

// ─── Submit ───────────────────────────────────────────────────────────────────
async function submitBooking() {
  if (!pendingSlot) return;
  setBusy(true);
  hide(el.modalError);

  const fields = {};
  el.modalFields.querySelectorAll('input,textarea')
    .forEach(i => { fields[i.name] = i.value.trim(); });

  try {
    const json = await apiFetch({
      action: 'bookSlot',
      date  : activeDate,
      row   : pendingSlot.row,
      fields,
    });

    if (json.conflict) {
      setBusy(false);
      closeModal();
      await poll(true);
      announce('error', '⚡', 'Slot just taken!', 'Someone else booked this slot a moment before you. Please choose another available time.');
      return;
    }

    if (json.error) throw new Error(json.error);

    if (json.success) {
      saveBooking({
        slotId: pendingSlot.slotId,
        date  : activeDate,
        row   : pendingSlot.row,
        time  : pendingSlot.time,
      });
        // Prepare calendar event data
        const startDate = parseDateTime(activeDate, pendingSlot.time);
        const endDate = new Date(startDate.getTime() + 60*60*1000); // default 1 hour
        const eventObj = {
          title: 'Booking: ' + (extraHeaders[0] || 'Appointment'),
          description: 'Booked via booking page',
          location: '',
          startDate,
          endDate,
        };

        closeModal();
        // Immediately fetch fresh data so the UI reflects the actual sheet state
        await poll(true);
        announce('success', '✓', "You're booked!", 'Your slot for ' + pendingSlot.time + ' on ' + activeDate + ' is confirmed.', eventObj);
          console.log('submitBooking: announce called with eventObj=', eventObj);
    }

  } catch (err) {
    setBusy(false);
    showModalErr(friendlyError(err));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function show(e) { e.classList.remove('hidden'); }
function hide(e) { e.classList.add('hidden');    }

function showSkeleton() {
  show(el.loadingState);
  hide(el.errorState);
  hide(el.bookingUi);
}
function hideSkeleton() { hide(el.loadingState); }

function showError(title, msg) {
  hide(el.loadingState);
  hide(el.bookingUi);
  el.errorTitle.textContent   = title;
  el.errorMessage.textContent = msg;
  show(el.errorState);
}

function showModalErr(msg) {
  el.modalError.textContent = msg;
  show(el.modalError);
}

// ─── Announcement overlay ─────────────────────────────────────────────────────
// type: 'success' | 'error'
// Calendar helpers
function convertTimeTo24(timeStr) {
  // returns HH:MM:SS
  if (!timeStr) return '00:00:00';
  // if a range like '09:30 AM - 10:00 AM', take the start
  if (/[\-–—]/.test(timeStr)) timeStr = timeStr.split(/[\-–—]/)[0].trim();
  const m = timeStr.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (m) {
    let hh = parseInt(m[1], 10);
    const mm = m[2];
    const ss = m[3] || '00';
    const ampm = m[4];
    if (ampm) {
      if (/pm/i.test(ampm) && hh !== 12) hh = hh + 12;
      if (/am/i.test(ampm) && hh === 12) hh = 0;
    }
    return String(hh).padStart(2,'0') + ':' + mm + ':' + ss;
  }
  // fallback: if plain hour like '9 AM'
  const m2 = timeStr.match(/(\d{1,2})\s*(AM|PM)/i);
  if (m2) {
    let hh = parseInt(m2[1],10);
    const ampm = m2[2];
    if (/pm/i.test(ampm) && hh !== 12) hh = hh + 12;
    if (/am/i.test(ampm) && hh === 12) hh = 0;
    return String(hh).padStart(2,'0') + ':00:00';
  }
  // 24h simple
  const m3 = timeStr.match(/(\d{1,2}):(\d{2})/);
  if (m3) return String(m3[1]).padStart(2,'0') + ':' + m3[2] + ':00';
  return '00:00:00';
}

function parseDateTime(dateStr, timeStr) {
  // Try if dateStr already ISO
  let datePart = String(dateStr||'').trim();
  let timeInput = String(timeStr||'').trim();
  // If time is a range like '09:30 AM - 10:00 AM', use the start
  if (/[\-–—]/.test(timeInput)) timeInput = timeInput.split(/[\-–—]/)[0].trim();
  // If date lacks a 4-digit year, append the current year
  if (!/\b\d{4}\b/.test(datePart)) {
    const curYear = new Date().getFullYear();
    datePart = datePart.replace(/,?\s*$/, '') + ' ' + curYear;
  }
  // If date looks like 'YYYY-MM-DD' keep it
  const isoCandidate = datePart.match(/^\d{4}-\d{2}-\d{2}/);
  const timePart = convertTimeTo24(timeInput);
  if (isoCandidate) {
    // YYYY-MM-DD
    return new Date(datePart + 'T' + timePart);
  }
  // Try combined parse
  const parsed = new Date(datePart + ' ' + timeInput);
  if (!isNaN(parsed.getTime())) return parsed;
  // Try parsing by splitting common formats like 'June 8, 2026'
  const d = new Date(datePart + ' ' + timePart);
  if (!isNaN(d.getTime())) return d;
  // Fallback: now
  return new Date();
}

function formatForGCal(date) {
  // Use local (floating) timestamp WITHOUT trailing Z so Google treats it as local time
  const Y = date.getFullYear();
  const M = String(date.getMonth() + 1).padStart(2, '0');
  const D = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${Y}${M}${D}T${h}${m}${s}`;
}

function googleCalendarUrl({title, description, location, startDate, endDate}) {
  const dates = `${formatForGCal(startDate)}/${formatForGCal(endDate)}`;
  return `https://www.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${dates}&details=${encodeURIComponent(description||'')}&location=${encodeURIComponent(location||'')}&sf=true&output=xml`;
}

function uid() { return Date.now() + '-' + Math.random().toString(36).slice(2); }

function toICSTimestamp(date) {
  const u = new Date(date.getTime() - date.getTimezoneOffset()*60000);
  return u.toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z';
}

function escapeICSText(s='') {
  return String(s).replace(/\\n/g,'\\n').replace(/,/g,'\\,');
}

function generateICS({title, description, location, startDate, endDate}) {
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BookingApp//EN',
    'BEGIN:VEVENT',
    `UID:${uid()}`,
    `DTSTAMP:${toICSTimestamp(new Date())}`,
    `DTSTART:${toICSTimestamp(startDate)}`,
    `DTEND:${toICSTimestamp(endDate)}`,
    `SUMMARY:${escapeICSText(title)}`,
    `DESCRIPTION:${escapeICSText(description||'')}`,
    `LOCATION:${escapeICSText(location||'')}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
  return ics;
}

function downloadICS(icsContent, filename='event.ics') {
  const blob = new Blob([icsContent], {type: 'text/calendar;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function announce(type, icon, title, body, eventObj) {
  el.announceCard.className = 'announce-card ' + type;
  el.announceIcon.textContent  = icon;
  el.announceTitle.textContent = title;
  el.announceBody.textContent  = body;

  // Wire buttons
  el.announceBtn.onclick = () => {
    hide(el.announceOverlay);
    hide(el.announceAddCal);
  };

  if (eventObj && type === 'success') {
    // show add-to-calendar button and attach handler
    show(el.announceAddCal);
    if (el.announceAddCal) el.announceAddCal.style.display = '';
    el.announceAddCal.onclick = () => {
      const ok = confirm('Open Google Calendar? Click OK to open Google Calendar, Cancel to download an .ics file to open in your calendar app.');
      if (ok) {
        window.open(googleCalendarUrl(eventObj), '_blank');
      } else {
        const ics = generateICS(eventObj);
        downloadICS(ics, 'booking-event.ics');
      }
    };
  } else {
    hide(el.announceAddCal);
    if (el.announceAddCal) el.announceAddCal.style.display = 'none';
    el.announceAddCal.onclick = null;
  }

  console.log('announce:', {type, title, body, hasEvent: !!eventObj, addCalEl: el.announceAddCal});

  show(el.announceOverlay);
  el.announceBtn.focus();
}

function closeAnnounce() {
  hide(el.announceOverlay);
}

function friendlyError(err) {
  const m = err.message || '';
  if (m.includes('Failed to fetch') || m.includes('NetworkError'))
    return 'Network error. Check your connection and try again.';
  if (m.includes('HTTP 401') || m.includes('HTTP 403'))
    return 'Access denied. Re-deploy the Apps Script with "Who has access: Anyone".';
  if (m.includes('HTTP 404'))
    return 'API not found. Check the ?api= URL.';
  return m || 'Something went wrong. Please try again.';
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

// ─── Events ───────────────────────────────────────────────────────────────────
function bindEvents() {
  el.retryBtn.addEventListener('click', () => poll(false));
  el.announceBtn.addEventListener('click', closeAnnounce);
  el.modalClose.addEventListener('click', closeModal);
  el.modalCancel.addEventListener('click', closeModal);
  el.modalSubmit.addEventListener('click', submitBooking);
  el.modalOverlay.addEventListener('click', e => {
    if (e.target === el.modalOverlay) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modalOpen) closeModal();
  });
  el.modalFields.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      submitBooking();
    }
  });
}

function bindSetupEvents() {
  loadCodeGsFile();
  
  const copyCodeBtn = document.getElementById('copy-code-btn');
  const webappUrlInput = document.getElementById('webapp-url-input');
  const finalBookingLink = document.getElementById('final-booking-link');

  if (copyCodeBtn) {
    copyCodeBtn.addEventListener('click', copyCodeToClipboard);
  }

  if (webappUrlInput) {
    webappUrlInput.addEventListener('input', (e) => {
      const webappUrl = e.target.value.trim();
      if (webappUrl) {
        const bookingLink = 'https://eberjohns.github.io/booking/?api=' + encodeURIComponent(webappUrl);
        finalBookingLink.textContent = bookingLink;
      } else {
        finalBookingLink.textContent = 'https://eberjohns.github.io/booking/?api=YOUR_APPS_SCRIPT_URL';
      }
    });
  }
}

function loadCodeGsFile() {
  const codeContent = document.querySelector('#code-gs-content code');
  const codeLoading = document.getElementById('code-loading');
  const codePre = document.getElementById('code-gs-content');

  // Try to fetch Code.gs file
  fetch('./Code.gs')
    .then(response => {
      if (!response.ok) throw new Error('Failed to load Code.gs');
      return response.text();
    })
    .then(code => {
      // Hide loading state
      if (codeLoading) codeLoading.classList.add('hidden');
      
      // Set code content
      codeContent.textContent = code;
      
      // Show code block
      codePre.classList.remove('hidden');
    })
    .catch(error => {
      console.error('Error loading Code.gs:', error);
      if (codeLoading) {
        codeLoading.textContent = 'Error loading Code.gs. Please refresh the page.';
      }
    });
}

function copyCodeToClipboard() {
  const codeElement = document.querySelector('#code-gs-content code');
  if (!codeElement || !codeElement.textContent.trim()) {
    alert('Code is still loading. Please wait a moment and try again.');
    return;
  }

  const text = codeElement.textContent;
  
  // Use the Clipboard API if available
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showCopySuccess();
    }).catch(() => {
      fallbackCopyToClipboard(text);
    });
  } else {
    fallbackCopyToClipboard(text);
  }
}

function fallbackCopyToClipboard(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    showCopySuccess();
  } catch (err) {
    console.error('Failed to copy:', err);
  }
  document.body.removeChild(textarea);
}

function showCopySuccess() {
  const copyBtn = document.getElementById('copy-code-btn');
  if (!copyBtn) return;

  const originalText = copyBtn.textContent;
  copyBtn.textContent = '✓ Copied!';
  copyBtn.style.background = 'var(--open)';

  setTimeout(() => {
    copyBtn.textContent = originalText;
    copyBtn.style.background = '';
  }, 2000);
}
