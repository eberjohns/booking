# Time Slot Booking System

A zero-backend, Google-Sheets-powered time slot booking system. Anyone can deploy their own instance by connecting the provided frontend to a Google Apps Script Web App — no servers, no databases, no accounts required.

---

## Table of Contents

- [Demo Overview](#demo-overview)
- [File Structure](#file-structure)
- [Google Sheet Setup](#google-sheet-setup)
- [Apps Script Setup](#apps-script-setup)
- [Frontend Hosting](#frontend-hosting)
- [Generating the Booking Link](#generating-the-booking-link)
- [Technical Notes](#technical-notes)
- [Troubleshooting](#troubleshooting)

---

## Demo Overview

1. You create a Google Sheet with time slots.
2. You deploy the Apps Script as a Web App.
3. You share a URL like:

```
https://yourwebsite.com/?api=https://script.google.com/macros/s/XXXXXXXXXXXX/exec
```

Users open that link, pick a date and time, fill in their details, and confirm. The booking is written directly to your Google Sheet. That's it.

---

## File Structure

```
booking-system/
├── index.html      — Main page (single HTML file)
├── styles.css      — All styles
├── script.js       — Frontend logic (vanilla JS)
├── Code.gs         — Google Apps Script backend
└── README.md       — This file
```

---

## Google Sheet Setup

### 1. Create a new Google Sheet

Go to [sheets.google.com](https://sheets.google.com) and create a new blank spreadsheet.

### 2. Name your tabs (each tab = one booking date)

Each worksheet tab represents one day. Name tabs however you like — the name is displayed to users exactly as you write it.

**Examples:**
- `June 3`
- `June 4`
- `July 15`
- `Monday Morning`
- `Session A`

There is no limit on the number of tabs.

### 3. Add the required columns

Row 1 of every tab must be the **header row**. Use these exact column positions:

| Column | Header   | Purpose                              |
|--------|----------|--------------------------------------|
| A      | Time     | The time slot label (shown to users) |
| B      | Status   | `open` or `close`                    |
| C+     | Any name | Dynamic booking fields (optional)    |

**Status values:**
- `open` — the slot can be booked
- `close` — the slot is unavailable (already taken or blocked)

### 4. Add your time slots (from row 2 onward)

Each subsequent row is one time slot. Example:

| Time              | Status | Name | Phone | Email | Notes |
|-------------------|--------|------|-------|-------|-------|
| 09:00 AM - 09:30 AM | open  |      |       |       |       |
| 09:30 AM - 10:00 AM | open  |      |       |       |       |
| 10:00 AM - 10:30 AM | close |      |       |       |       |
| 10:30 AM - 11:00 AM | open  |      |       |       |       |

### 5. Dynamic booking fields

Every column after B becomes an input field in the booking form. The header text (row 1) becomes the field label.

**Examples:**
- Column C: `Name` → text input labelled "Name"
- Column D: `Phone` → text input labelled "Phone"
- Column E: `Email` → text input labelled "Email"
- Column F: `Notes` → auto-detected as textarea (multiline)

Fields labelled `Notes`, `Comments`, `Message`, `Details`, or `Remarks` automatically render as multi-line text areas. All others are single-line text inputs.

You can add as many fields as you need. All are optional from the user's perspective (no built-in validation forces them to fill every field).

---

## Apps Script Setup

### 1. Open the Apps Script editor

From your Google Sheet, go to **Extensions → Apps Script**.

### 2. Replace the default code

Delete any existing code in `Code.gs` and paste the entire contents of the provided `Code.gs` file.

### 3. Save

Press **Ctrl+S** (or **Cmd+S** on Mac) or click the save button.

### 4. Deploy as a Web App

1. Click **Deploy → New deployment**.
2. Click the gear icon next to "Select type" and choose **Web app**.
3. Fill in the fields:
   - **Description:** `Booking API` (or anything you like)
   - **Execute as:** `Me` ← important
   - **Who has access:** `Anyone` ← important (otherwise users can't book)
4. Click **Deploy**.
5. When prompted, click **Authorize access** and follow the Google OAuth flow.
6. Copy the **Web App URL** — it looks like:

```
https://script.google.com/macros/s/XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/exec
```

> **Important:** Every time you edit and re-deploy `Code.gs`, you must choose "New deployment" (not "Manage deployments" → edit an existing one) if you want users to get the latest code immediately. Alternatively, use "Manage deployments" and click the pencil icon to redeploy the existing deployment.

---

## Frontend Hosting

Host the three frontend files (`index.html`, `styles.css`, `script.js`) on any static hosting service:

| Service           | Free Tier | Notes                                |
|-------------------|-----------|--------------------------------------|
| GitHub Pages      | ✓         | Push to `gh-pages` branch            |
| Netlify           | ✓         | Drag-and-drop deploy                 |
| Vercel            | ✓         | `vercel --prod` from the folder      |
| Cloudflare Pages  | ✓         | Git-connected or direct upload       |
| Any web server    | —         | Just serve the three static files    |

All three files must be in the same directory. No build step is required.

---

## Generating the Booking Link

Once hosted, append your Apps Script Web App URL as the `?api=` query parameter:

```
https://yourwebsite.com/?api=YOUR_APPS_SCRIPT_WEBAPP_URL
```

**Full example:**

```
https://mybookings.netlify.app/?api=https://script.google.com/macros/s/AKfycbxABCD1234/exec
```

Share this complete URL with your users. They do not need to configure anything — the link is self-contained.

> The URL is long. That's fine. Users just click it. You can shorten it with bit.ly or a custom redirect if you want a cleaner link.

---

## Technical Notes

### Polling (live availability updates)

The frontend polls the Apps Script endpoint every **12 seconds** using `setInterval`. On each poll:

- A background `fetch()` request is made (no page reload).
- Only the slot cards in the currently visible date are re-rendered.
- The user's scroll position and any open modal are preserved.
- If the poll fails (e.g., network drop), it fails silently — the last known state remains visible.

The polling interval is set by the `POLL_INTERVAL` constant at the top of `script.js`. Increase it to reduce API calls; decrease it for more real-time updates.

### LocalStorage booking restriction

When a user successfully books a slot, the following object is saved to `localStorage` under the key `slotBooking_myBooking_v1`:

```json
{
  "date": "June 3",
  "row": 4,
  "time": "10:00 AM - 10:30 AM"
}
```

On every page load and every poll, the frontend:

1. Reads this key.
2. If a booking exists, disables all other slots and shows a "You already have a booking" banner.
3. Looks up the saved `row` in the live sheet data. If the row no longer exists, or if the slot is back to `open` (admin cleared it), the local booking record is deleted and the user can book again.

This means admins can "reset" a booking simply by changing the slot's status back to `open` in the sheet — the user's frontend will detect this within one polling cycle and allow re-booking.

### Concurrent booking protection

The Apps Script backend uses **`LockService.getPublicLock()`** to serialize concurrent booking requests. The sequence is:

1. User A and User B both click the same `open` slot at nearly the same time.
2. Both send POST requests to the Apps Script.
3. `LockService.waitLock(8000)` ensures only one request runs at a time.
4. The first request re-reads the cell value. It's still `open`, so it writes `close` and returns `{ success: true }`.
5. The second request re-reads the cell. It's now `close`, so it returns `{ conflict: true }` without writing anything.
6. User B sees: **"Someone just booked this slot. Please choose another one."**
7. The slot grid automatically refreshes to show the updated state.

### Automatic slot updates

On a successful booking or conflict response, the frontend calls `fetchData(true)` (silent poll) to immediately re-fetch fresh data and re-render the slot cards — without touching the rest of the page.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Setup screen shown | `?api=` param missing or malformed | Add `?api=YOUR_WEBAPP_URL` to the page URL |
| "Could not load availability" | Wrong Web App URL or not deployed | Redeploy the Apps Script and copy the new URL |
| "Anyone" access error | Web App not set to public | Re-deploy with "Who has access: Anyone" |
| Slots not showing | Header row missing or wrong columns | Ensure row 1 has Time in A, Status in B |
| Booking always fails | Google Script authorization not granted | Re-open the Apps Script, deploy again, and authorize |
| Changes not reflecting | Old deployment active | Create a "New deployment" in Apps Script |
| Users can't rebook | LocalStorage still has old booking | Admin must set the slot back to `open` in the sheet |

---

## Customisation

- **Colors:** Edit the CSS variables at the top of `styles.css` (`:root { ... }`).
- **Poll interval:** Change `POLL_INTERVAL` in `script.js` (milliseconds).

## Future Scope

- **Validation:** Add field validation before `submitBooking()` in `script.js` if you need required fields.
- **Email notifications:** Add `MailApp.sendEmail(...)` calls inside `doPost()` in `Code.gs` to email yourself on each booking.
