const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;

if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  });
  console.log('✅ Supabase connected successfully:', SUPABASE_URL);
} else {
  console.log('ℹ️ Supabase not configured in .env (falling back to local JSON database)');
}

function isSupabaseConfigured() {
  return Boolean(supabase);
}

// Map local object format to Supabase row format
function mapBillToRow(tracking, item) {
  return {
    tracking_number: tracking,
    carrier: item.carrier || (tracking.startsWith('HAL') || tracking.startsWith('HA') ? 'HAL Express' : 'Anousith Express'),
    recipient_name: item.recipientName || '',
    recipient_phone: item.recipientPhone || '',
    destination_branch: item.destinationBranch || '',
    cod_expected: item.codExpected || '0 KIP',
    cod_collected: item.codCollected || '0 KIP',
    shipping_status: item.shippingStatus || 'ກຳລັງຂົນສົ່ງ',
    date_deposited: item.dateDeposited || '',
    sent_to_whatsapp: Boolean(item.sent_to_whatsapp),
    sent_at: item.sent_at || null,
    send_status: item.send_status || (item.sent_to_whatsapp ? 'sent' : 'unsent'),
    last_error: item.last_error || null,
    notified_arrival: Boolean(item.notified_arrival),
    first_arrival_reminded_at: item.first_arrival_reminded_at || null,
    last_reminded_at: item.last_reminded_at || null,
    reminder_count: item.reminder_count || 0,
    reminder_history: item.reminder_history || [],
    bill_url: item.billUrl || null,
    metadata: item,
    updated_at: new Date().toISOString()
  };
}

// Map Supabase row back to local item format
function mapRowToBill(row) {
  return {
    ...(row.metadata || {}),
    trackingNumber: row.tracking_number,
    carrier: row.carrier,
    recipientName: row.recipient_name,
    recipientPhone: row.recipient_phone,
    destinationBranch: row.destination_branch,
    codExpected: row.cod_expected,
    codCollected: row.cod_collected,
    shippingStatus: row.shipping_status,
    dateDeposited: row.date_deposited,
    sent_to_whatsapp: row.sent_to_whatsapp,
    sent_at: row.sent_at,
    send_status: row.send_status,
    last_error: row.last_error,
    notified_arrival: row.notified_arrival,
    first_arrival_reminded_at: row.first_arrival_reminded_at,
    last_reminded_at: row.last_reminded_at,
    reminder_count: row.reminder_count,
    reminder_history: row.reminder_history,
    billUrl: row.bill_url
  };
}

// Sync all local bills to Supabase
async function syncLocalBillsToSupabase(localSentBills) {
  if (!supabase || !localSentBills) return;
  const rows = Object.entries(localSentBills).map(([tracking, item]) => mapBillToRow(tracking, item));
  if (rows.length === 0) return;

  const { data, error } = await supabase
    .from('bills')
    .upsert(rows, { onConflict: 'tracking_number' });

  if (error) {
    console.error('❌ Error syncing bills to Supabase:', error.message);
  } else {
    console.log(`✅ Successfully synced ${rows.length} bills to Supabase!`);
  }
}

// Fetch all bills from Supabase
async function fetchBillsFromSupabase() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('bills')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('❌ Error fetching bills from Supabase:', error.message);
    return null;
  }

  const billsMap = {};
  (data || []).forEach(row => {
    billsMap[row.tracking_number] = mapRowToBill(row);
  });
  return billsMap;
}

module.exports = {
  supabase,
  isSupabaseConfigured,
  mapBillToRow,
  mapRowToBill,
  syncLocalBillsToSupabase,
  fetchBillsFromSupabase
};
