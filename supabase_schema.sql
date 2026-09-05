-- ===================================================
-- Supabase Database Schema for Auto Bill & Reminder App
-- ===================================================

-- 1. Table for Bills (Tracking Orders)
CREATE TABLE IF NOT EXISTS bills (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tracking_number TEXT UNIQUE NOT NULL,
  carrier TEXT DEFAULT 'Anousith Express',
  recipient_name TEXT,
  recipient_phone TEXT,
  destination_branch TEXT,
  cod_expected TEXT DEFAULT '0 KIP',
  cod_collected TEXT DEFAULT '0 KIP',
  shipping_status TEXT DEFAULT 'ກຳລັງຂົນສົ່ງ',
  date_deposited TEXT,
  sent_to_whatsapp BOOLEAN DEFAULT FALSE,
  sent_at TIMESTAMPTZ,
  send_status TEXT,
  last_error TEXT,
  notified_arrival BOOLEAN DEFAULT FALSE,
  first_arrival_reminded_at TIMESTAMPTZ,
  last_reminded_at TIMESTAMPTZ,
  reminder_count INTEGER DEFAULT 0,
  reminder_history JSONB DEFAULT '[]'::JSONB,
  bill_url TEXT,
  metadata JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_bills_tracking ON bills(tracking_number);
CREATE INDEX IF NOT EXISTS idx_bills_phone ON bills(recipient_phone);
CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(shipping_status);

-- 2. Table for Saved Accounts (Anousith & HAL)
CREATE TABLE IF NOT EXISTS accounts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  carrier TEXT NOT NULL DEFAULT 'Anousith Express',
  name TEXT,
  token TEXT,
  branch_code TEXT,
  is_active BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Table for System Settings (Auto-reminder toggle, etc.)
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Default settings
INSERT INTO system_settings (key, value)
VALUES ('auto_reminder', '{"enabled": true, "interval_hours": 48}'::JSONB)
ON CONFLICT (key) DO NOTHING;

-- Enable Row Level Security (RLS)
ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

-- Allow access via Service Role and Anon Key
CREATE POLICY "Allow public access for bills" ON bills FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public access for accounts" ON accounts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow public access for system_settings" ON system_settings FOR ALL USING (true) WITH CHECK (true);
