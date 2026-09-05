const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'sent_bills.json');

// Ensure data directory exists
function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ sent_bills: {} }, null, 2), 'utf8');
  }
}

function getDatabase() {
  ensureDb();
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading DB:', err);
    return { sent_bills: {} };
  }
}

function saveDatabase(data) {
  ensureDb();
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving DB:', err);
  }
}

function isBillSent(trackingNumber) {
  if (!trackingNumber) return false;
  const db = getDatabase();
  return Boolean(db.sent_bills && db.sent_bills[trackingNumber]);
}

function asyncSyncBillToSupabase(tracking, billData) {
  try {
    const { supabase, isSupabaseConfigured, mapBillToRow } = require('./supabase');
    if (!isSupabaseConfigured() || !supabase) return;
    const row = mapBillToRow(tracking, billData);
    supabase.from('bills').upsert([row], { onConflict: 'tracking_number' }).then(() => {}).catch(err => {
      console.error(`Supabase sync error for #${tracking}:`, err.message);
    });
  } catch (e) {}
}

function upsertBill(trackingNumber, metadata = {}) {
  if (!trackingNumber) return;
  const db = getDatabase();
  db.sent_bills = db.sent_bills || {};
  const existing = db.sent_bills[trackingNumber] || {};

  db.sent_bills[trackingNumber] = {
    ...existing,
    ...metadata,
    sent_to_whatsapp: metadata.sent_to_whatsapp !== undefined 
      ? metadata.sent_to_whatsapp 
      : (existing.sent_to_whatsapp !== undefined ? existing.sent_to_whatsapp : false),
    sent_at: existing.sent_at || metadata.sent_at || null,
    updated_at: new Date().toISOString()
  };
  saveDatabase(db);
  asyncSyncBillToSupabase(trackingNumber, db.sent_bills[trackingNumber]);
  return db.sent_bills[trackingNumber];
}

function markBillSent(trackingNumber, metadata = {}) {
  if (!trackingNumber) return;
  const db = getDatabase();
  db.sent_bills = db.sent_bills || {};
  const existing = db.sent_bills[trackingNumber] || {};

  db.sent_bills[trackingNumber] = {
    ...existing,
    ...metadata,
    sent_to_whatsapp: true,
    sent_at: existing.sent_at || metadata.sent_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  saveDatabase(db);
  asyncSyncBillToSupabase(trackingNumber, db.sent_bills[trackingNumber]);
  return db.sent_bills[trackingNumber];
}

function markAllBillsAsSent(carrierFilter = null) {
  const db = getDatabase();
  db.sent_bills = db.sent_bills || {};
  let updatedCount = 0;
  const now = new Date().toISOString();

  Object.entries(db.sent_bills).forEach(([tracking, item]) => {
    if (carrierFilter && carrierFilter !== 'all') {
      const carrier = item.carrier || (tracking.startsWith('HAL') || tracking.startsWith('HA') ? 'HAL Express' : 'Anousith Express');
      if (!carrier.toLowerCase().includes(carrierFilter.toLowerCase())) {
        return;
      }
    }
    item.sent_to_whatsapp = true;
    item.send_status = 'sent';
    delete item.last_error;
    delete item.no_whatsapp;
    item.marked_sent_at = item.marked_sent_at || now;
    item.updated_at = now;
    updatedCount++;
  });

  saveDatabase(db);
  return { success: true, count: updatedCount };
}

function markAllRemindersAsSent(carrierFilter = null) {
  const db = getDatabase();
  db.sent_bills = db.sent_bills || {};
  let updatedCount = 0;
  const now = new Date().toISOString();

  Object.entries(db.sent_bills).forEach(([tracking, item]) => {
    const st = (item.shippingStatus || '').toLowerCase();
    if (!st.includes('ຮອດປາຍທາງ')) {
      return;
    }

    if (carrierFilter && carrierFilter !== 'all') {
      const carrier = item.carrier || (tracking.startsWith('HAL') || tracking.startsWith('HA') ? 'HAL Express' : 'Anousith Express');
      if (!carrier.toLowerCase().includes(carrierFilter.toLowerCase())) {
        return;
      }
    }

    const count = item.reminder_count && item.reminder_count > 0 ? item.reminder_count : 1;
    const history = Array.isArray(item.reminder_history) ? item.reminder_history : [];
    if (history.length === 0) {
      history.push({
        reminder_num: 1,
        timestamp: now,
        type: 'arrival_reminder_baseline',
        recipientPhone: item.recipientPhone,
        status: 'sent'
      });
    }

    item.notified_arrival = true;
    item.last_reminded_at = now;
    item.first_arrival_reminded_at = item.first_arrival_reminded_at || now;
    item.reminder_count = count;
    item.reminder_history = history;
    item.updated_at = now;
    updatedCount++;
  });

  saveDatabase(db);
  return { success: true, count: updatedCount };
}

function recordReminder(trackingNumber, details = {}) {
  if (!trackingNumber) return;
  const db = getDatabase();
  db.sent_bills = db.sent_bills || {};
  const existing = db.sent_bills[trackingNumber] || {};

  const history = Array.isArray(existing.reminder_history) ? existing.reminder_history : [];
  const count = (existing.reminder_count || 0) + 1;
  const now = new Date().toISOString();

  const logEntry = {
    reminder_num: count,
    timestamp: now,
    type: details.type || 'arrival_reminder',
    recipientPhone: details.recipientPhone || existing.recipientPhone,
    status: 'sent'
  };
  history.push(logEntry);

  db.sent_bills[trackingNumber] = {
    ...existing,
    notified_arrival: true,
    last_reminded_at: now,
    first_arrival_reminded_at: existing.first_arrival_reminded_at || now,
    reminder_count: count,
    reminder_history: history,
    updated_at: now
  };
  saveDatabase(db);
  return db.sent_bills[trackingNumber];
}

function getAccounts() {
  const db = getDatabase();
  return db.accounts || {};
}

function getActiveAccount() {
  const db = getDatabase();
  const accounts = db.accounts || {};
  const activePhone = db.active_account_phone;
  if (activePhone && accounts[activePhone]) {
    return accounts[activePhone];
  }
  // Default first account if any
  const first = Object.values(accounts)[0];
  return first || null;
}

function saveAccount(accountData) {
  if (!accountData || !accountData.phone) return null;
  const db = getDatabase();
  db.accounts = db.accounts || {};
  const phone = accountData.phone;
  
  db.accounts[phone] = {
    ...(db.accounts[phone] || {}),
    ...accountData,
    phone,
    updated_at: new Date().toISOString()
  };
  db.active_account_phone = phone;
  saveDatabase(db);
  return db.accounts[phone];
}

function setActiveAccount(phone) {
  const db = getDatabase();
  db.accounts = db.accounts || {};
  if (db.accounts[phone]) {
    db.active_account_phone = phone;
    saveDatabase(db);
    return db.accounts[phone];
  }
  return null;
}

function deleteAccount(phone) {
  const db = getDatabase();
  db.accounts = db.accounts || {};
  if (db.accounts[phone]) {
    delete db.accounts[phone];
    if (db.active_account_phone === phone) {
      const remaining = Object.keys(db.accounts);
      db.active_account_phone = remaining.length > 0 ? remaining[0] : null;
    }
    saveDatabase(db);
    return true;
  }
  return false;
}

// HAL Express Account Management
function getHalAccounts() {
  const db = getDatabase();
  return db.hal_accounts || {};
}

function getActiveHalAccount() {
  const db = getDatabase();
  const accounts = db.hal_accounts || {};
  const activePhone = db.active_hal_account_phone;
  if (activePhone && accounts[activePhone]) {
    return accounts[activePhone];
  }
  const first = Object.values(accounts)[0];
  return first || null;
}

function saveHalAccount(accountData) {
  if (!accountData || !accountData.phone) return null;
  const db = getDatabase();
  db.hal_accounts = db.hal_accounts || {};
  const phone = accountData.phone;
  
  db.hal_accounts[phone] = {
    ...(db.hal_accounts[phone] || {}),
    ...accountData,
    carrier: 'HAL Express',
    phone,
    updated_at: new Date().toISOString()
  };
  db.active_hal_account_phone = phone;
  saveDatabase(db);
  return db.hal_accounts[phone];
}

function setActiveHalAccount(phone) {
  const db = getDatabase();
  db.hal_accounts = db.hal_accounts || {};
  if (db.hal_accounts[phone]) {
    db.active_hal_account_phone = phone;
    saveDatabase(db);
    return db.hal_accounts[phone];
  }
  return null;
}

function deleteHalAccount(phone) {
  const db = getDatabase();
  db.hal_accounts = db.hal_accounts || {};
  if (db.hal_accounts[phone]) {
    delete db.hal_accounts[phone];
    if (db.active_hal_account_phone === phone) {
      const remaining = Object.keys(db.hal_accounts);
      db.active_hal_account_phone = remaining.length > 0 ? remaining[0] : null;
    }
    saveDatabase(db);
    return true;
  }
  return false;
}

module.exports = {
  upsertBill,
  isBillSent,
  markBillSent,
  markAllBillsAsSent,
  markAllRemindersAsSent,
  recordReminder,
  getDatabase,
  getAccounts,
  getActiveAccount,
  saveAccount,
  setActiveAccount,
  deleteAccount,
  getHalAccounts,
  getActiveHalAccount,
  saveHalAccount,
  setActiveHalAccount,
  deleteHalAccount
};
