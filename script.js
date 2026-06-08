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
  } else {
    hide(el.bookedBanner);
    hide(el.bookedBadge);
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
      closeModal();
      // Immediately fetch fresh data so the UI reflects the actual sheet state
      await poll(true);
      announce('success', '✓', "You're booked!", 'Your slot for ' + pendingSlot.time + ' on ' + activeDate + ' is confirmed.');
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
function announce(type, icon, title, body) {
  el.announceCard.className = 'announce-card ' + type;
  el.announceIcon.textContent  = icon;
  el.announceTitle.textContent = title;
  el.announceBody.textContent  = body;
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
