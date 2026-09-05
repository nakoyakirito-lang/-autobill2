
function normalizeDateStr(val, fallback) {
  if (!val && fallback) return fallback.split('T')[0];
  if (!val) return '';
  const s = String(val).trim();
  if (s.includes('T')) return s.split('T')[0];
  if (s.match(/^d{4}-d{2}-d{2}$/)) return s;
  const parts = s.split(/[\/\-\.]/);
  if (parts.length === 3) {
    if (parts[0].length === 4) return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
    if (parts[2].length === 4) return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
  }
  return s;
}

function checkBillMatchesDate(item, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return true;
  const dStr = normalizeDateStr(item.dateDeposited, item.sent_at);
  if (!dStr) return true;
  if (dateFrom && dStr < dateFrom) return false;
  if (dateTo && dStr > dateTo) return false;
  return true;
}

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const upload = multer({ dest: path.join(__dirname, '..', 'uploads/') });
const { parseAnousithFile } = require('./csv_parser');
const folderWatcher = require('./folder_watcher');
const WhatsAppBot = require('./whatsapp');
const AnousithService = require('./anousith');
const HalService = require('./hal');
const { formatLaoPhoneToWhatsAppJid } = require('./formatter');
const { 
  isBillSent, 
  markBillSent, upsertBill, 
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
} = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;
const POLL_INTERVAL = (parseInt(process.env.POLL_INTERVAL_SECONDS, 10) || 60) * 1000;
const TEMP_BILLS_DIR = path.join(__dirname, '..', 'temp_bills');
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

if (!fs.existsSync(TEMP_BILLS_DIR)) {
  fs.mkdirSync(TEMP_BILLS_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const bot = new WhatsAppBot();
const anousith = new AnousithService();
const hal = new HalService();

function isHalCarrier(item, tracking = '') {
  const t = String(tracking || '').toUpperCase();
  const c = String(item?.carrier || '').toUpperCase();
  const u = String(item?.billUrl || '').toUpperCase();
  return c.includes('HAL') || t.startsWith('HAL') || t.startsWith('VTE') || u.includes('HALEXPRESS') || u.includes('HAL-LOGISTICS');
}

function getCarrierName(item, tracking = '') {
  if (item?.carrier) return item.carrier;
  if (isHalCarrier(item, tracking)) return 'HAL Express';
  return 'Anousith Express';
}

function getCarrierTrackingUrl(item, tracking = '') {
  if (isHalCarrier(item, tracking)) {
    const cleanTrack = String(tracking || item?.tracking || '').trim();
    return hal.getTrackingUrl(cleanTrack);
  }
  if (item?.billUrl) return item.billUrl;
  return anousith.getBillShareUrl(tracking);
}

async function downloadCarrierSlipImage(item, tracking, savePath) {
  const cleanTrack = String(tracking || item?.tracking || '').trim();
  if (isHalCarrier(item, cleanTrack)) {
    return hal.downloadBillImage(cleanTrack, savePath, item);
  }
  return anousith.downloadBillImage(item?.billUrl || cleanTrack, savePath);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// REST API: Status
app.get('/api/status', (req, res) => {
  const activeUser = getActiveAccount();
  const activeHal = getActiveHalAccount();
  res.json({
    connected: bot.isConnected,
    qrDataUrl: bot.lastQrDataUrl,
    pollIntervalSeconds: POLL_INTERVAL / 1000,
    anousithUser: activeUser?.phone || process.env.ANOUSITH_USERNAME || null,
    activeAccount: activeUser,
    activeHalAccount: activeHal
  });
});

// REST API: Anousith Login for any user
app.post('/api/anousith/login', async (req, res) => {
  const { phone, password, shopName } = req.body;
  if (!phone || !phone.trim()) {
    return res.status(400).json({ error: 'ກະລຸນາປ້ອນເບີໂທ Anousith' });
  }

  try {
    const authResult = await anousith.authenticateCustomer(phone, password || '', shopName);
    const saved = saveAccount({
      phone: authResult.phone,
      name: authResult.name,
      shopName: authResult.shopName,
      profile_img: authResult.profile_img,
      token: authResult.token
    });

    res.json({
      success: true,
      user: saved,
      message: `ເຂົ້າສູ່ລະບົບ Anousith ສຳເລັດແລ້ວ (${saved.shopName || saved.phone})`
    });
  } catch (err) {
    console.error('Anousith login error:', err);
    res.status(500).json({ error: 'ເກີດຂໍ້ຜິດພາດໃນການເຂົ້າສູ່ລະບົບ: ' + err.message });
  }
});

// REST API: Get Current Active Anousith Account & Accounts List
app.get('/api/anousith/accounts', (req, res) => {
  res.json({
    activeAccount: getActiveAccount(),
    accounts: Object.values(getAccounts())
  });
});

// REST API: Switch Active Account
app.post('/api/anousith/switch-account', (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: 'ກະລຸນາລະບຸເບີໂທ' });
  }
  const switched = setActiveAccount(phone);
  if (!switched) {
    return res.status(404).json({ error: 'ບໍ່ພົບຂໍ້ມູນບັນຊີນີ້' });
  }
  res.json({ success: true, activeAccount: switched, message: `ສະຫຼັບໄປໃຊ້ບັນຊີ ${switched.shopName || switched.phone} ແລ້ວ` });
});

// REST API: Delete / Logout Account
app.post('/api/anousith/logout', (req, res) => {
  const { phone } = req.body;
  if (phone) {
    deleteAccount(phone);
  }
  res.json({ success: true, activeAccount: getActiveAccount(), message: 'ອອກຈາກລະບົບຮຽບຮ້ອຍແລ້ວ' });
});

// REST API: HAL Express Login
app.post('/api/hal/login', async (req, res) => {
  const { phone, password, shopName } = req.body;
  if (!phone || !phone.trim()) {
    return res.status(400).json({ error: 'ກະລຸນາປ້ອນເບີໂທ HAL Express' });
  }

  try {
    const authResult = await hal.authenticateCustomer(phone, password || '', shopName);
    const saved = saveHalAccount({
      phone: authResult.phone,
      name: authResult.name,
      shopName: authResult.shopName,
      token: authResult.token
    });

    res.json({
      success: true,
      user: saved,
      message: `ເຂົ້າສູ່ລະບົບ HAL Express ສຳເລັດແລ້ວ (${saved.shopName || saved.phone})`
    });
  } catch (err) {
    console.error('HAL login error:', err);
    res.status(500).json({ error: 'ເກີດຂໍ້ຜິດພາດໃນການເຂົ້າສູ່ລະບົບ: ' + err.message });
  }
});

// REST API: Get HAL Accounts List
app.get('/api/hal/accounts', (req, res) => {
  res.json({
    activeAccount: getActiveHalAccount(),
    accounts: Object.values(getHalAccounts())
  });
});

// REST API: Switch Active HAL Account
app.post('/api/hal/switch-account', (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: 'ກະລຸນາລະບຸເບີໂທ' });
  }
  const switched = setActiveHalAccount(phone);
  if (!switched) {
    return res.status(404).json({ error: 'ບໍ່ພົບຂໍ້ມູນບັນຊີນີ້' });
  }
  res.json({ success: true, activeAccount: switched, message: `ສະຫຼັບໄປໃຊ້ບັນຊີ HAL ${switched.shopName || switched.phone} ແລ້ວ` });
});

// REST API: Delete HAL Account
app.post('/api/hal/logout', (req, res) => {
  const { phone } = req.body;
  if (phone) {
    deleteHalAccount(phone);
  }
  res.json({ success: true, activeAccount: getActiveHalAccount(), message: 'ອອກຈາກລະບົບ HAL ຮຽບຮ້ອຍແລ້ວ' });
});

// REST API: Sent Bills List
app.get('/api/bills', (req, res) => {
  const db = getDatabase();
  res.json(db);
});

// REST API: Mark all bills as sent (reset unsent status to count from now on)

// REST API: Update individual bill status
app.post('/api/update-bill-status', (req, res) => {
  const { tracking, status } = req.body;
  if (!tracking || !status) {
    return res.status(400).json({ error: 'ກະລຸນາລະບຸເລກບິນ ແລະ ສະຖານະໃໝ່' });
  }

  const db = getDatabase();
  db.sent_bills = db.sent_bills || {};
  if (!db.sent_bills[tracking]) {
    return res.status(404).json({ error: 'ບໍ່ພົບເລກບິນນີ້ໃນລະບົບ' });
  }

  db.sent_bills[tracking].shippingStatus = status;
  db.sent_bills[tracking].updated_at = new Date().toISOString();
  saveDatabase(db);

  res.json({
    success: true,
    tracking,
    status,
    message: `ອັບເດດສະຖານະເລກບິນ #${tracking} ເປັນ "${status}" ສຳເລັດ!`
  });
});

app.post('/api/mark-all-sent', (req, res) => {
  const { carrier } = req.body || {};
  const result = markAllBillsAsSent(carrier);
  res.json({
    success: true,
    count: result.count,
    message: `ໝາຍວ່າສົ່ງໃບບິນແລ້ວທັງໝົດ ${result.count} ລາຍການຮຽບຮ້ອຍແລ້ວ (ເລີ່ມນັບບິນໃໝ່ຕັ້ງແຕ່ນີ້ເປັນຕົ້ນໄປ)`
  });
});

// REST API: Mark all arrival reminders as sent (reset reminder cooldowns from now on)
app.post('/api/mark-all-reminders-sent', (req, res) => {
  const { carrier } = req.body || {};
  const result = markAllRemindersAsSent(carrier);
  res.json({
    success: true,
    count: result.count,
    message: `ໝາຍວ່າແຈ້ງເຕືອນຮອດປາຍທາງແລ້ວທັງໝົດ ${result.count} ລາຍການຮຽບຮ້ອຍແລ້ວ (ເລີ່ມນັບຮອບເຕືອນ 48h ຕັ້ງແຕ່ນີ້ເປັນຕົ້ນໄປ)`
  });
});

// REST API: Send Single Bill (WhatsApp)
app.post('/api/send-bill', async (req, res) => {
  const { tracking, phone, name } = req.body;

  if (!tracking) {
    return res.status(400).json({ error: 'ກະລຸນາລະບຸເລກບິນ' });
  }

  const db = getDatabase();
  const existing = db.sent_bills[tracking] || {};
  const recipientPhone = phone || existing.recipientPhone;
  const recipientName = name || existing.recipientName || 'ລູກຄ້າ';

  if (!recipientPhone) {
    return res.status(400).json({ error: 'ກະລຸນາລະບຸເບີໂທລະສັບ' });
  }

  const jid = formatLaoPhoneToWhatsAppJid(recipientPhone);
  if (!jid) {
    return res.status(400).json({ error: 'ຮູບແບບເບີໂທລະສັບບໍ່ຖືກຕ້ອງ' });
  }

  if (!bot.isConnected) {
    return res.status(503).json({ error: 'WhatsApp ຍັງບໍ່ທັນເຊື່ອມຕໍ່ ກະລຸນາສະແກນ QR Code ກ່ອນ' });
  }

  try {
    // Check if phone has WhatsApp
    const waCheck = await bot.checkOnWhatsApp(jid);
    if (waCheck && !waCheck.exists) {
      markBillSent(tracking, {
        ...existing,
        recipientPhone,
        recipientName,
        send_status: 'failed',
        last_error: 'ເບີໂທນີ້ຍັງບໍ່ໄດ້ລົງທະບຽນ WhatsApp'
      });
      return res.status(400).json({ error: 'ເບີໂທນີ້ຍັງບໍ່ໄດ້ລົງທະບຽນ WhatsApp / ບໍ່ພົບຜູ້ໃຊ້' });
    }

    const carrierName = getCarrierName(existing, tracking);
    const billUrl = existing.billUrl || getCarrierShareUrl(existing, tracking);
    const caption = `📦 *ແຈ້ງເລກບິນ ${carrierName}*\nສະບາຍດີ ທ່ານ ${recipientName}\n🔖 ເລກບິນ: *${tracking}*\n🔗 ເບິ່ງໃບບິນ: ${billUrl}\nຂອບໃຈເຈົ້າ 🙏`;

    const imgPath = path.join(TEMP_BILLS_DIR, `${tracking}.jpg`);
    const downloadedImg = await downloadCarrierSlipImage(existing, tracking, imgPath);

    if (downloadedImg && fs.existsSync(downloadedImg)) {
      await bot.sendBillImage(jid, downloadedImg, caption);
    } else {
      await bot.sendMessage(jid, caption);
    }

    markBillSent(tracking, {
      ...existing,
      recipientPhone,
      recipientName,
      sent_to_whatsapp: true,
      sent_at: new Date().toISOString(),
      send_status: 'sent',
      last_error: null
    });

    res.json({ success: true, message: `ສົ່ງໃບບິນ #${tracking} ຫາ ${recipientPhone} ສຳເລັດແລ້ວ!` });
  } catch (err) {
    console.error('Error sending single bill:', err);
    markBillSent(tracking, {
      ...existing,
      recipientPhone,
      recipientName,
      send_status: 'failed',
      last_error: err.message
    });
    res.status(500).json({ error: 'ເກີດຂໍ້ຜິດພາດ: ' + err.message });
  }
});

// REST API: Upload CSV / Excel File from Anousith or HAL
app.post('/api/upload-csv', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'ກະລຸນາເລືອກໄຟລ໌ CSV ຫຼື Excel' });
  }

  try {
    const filePath = req.file.path;
    const parsedItems = parseAnousithFile(filePath);
    
    // Clean up uploaded file
    try { fs.unlinkSync(filePath); } catch (e) {}

    if (parsedItems.length === 0) {
      return res.status(400).json({ error: 'ບໍ່ພົບຂໍ້ມູນເລກບິນໃນໄຟລ໌' });
    }

    console.log(`📁 File Uploaded! Parsed ${parsedItems.length} parcels.`);

    let newCount = 0;
    let updatedCount = 0;

    // Save/Update items to database with duplicate prevention
    for (const item of parsedItems) {
      const exists = isBillSent(item.tracking);
      if (!exists) {
        newCount++;
      } else {
        updatedCount++;
      }

      upsertBill(item.tracking, {
        recipientPhone: item.recipientPhone || '-',
        recipientName: item.recipientName || 'ລູກຄ້າ',
        itemName: item.itemName || '',
        codExpected: item.codExpected || '0 KIP',
        codCollected: item.codCollected || '0 KIP',
        codExpectedNum: item.codExpectedNum || 0,
        codCollectedNum: item.codCollectedNum || 0,
        shippingStatus: item.shippingStatus || 'ກຳລັງຂົນສົ່ງ',
        rawStatus: item.rawStatus || '',
        destinationBranch: item.destinationBranch || '-',
        originBranch: item.originBranch || '-',
        dateDeposited: item.dateDeposited || '',
        carrier: item.carrier || 'Anousith Express',
        sentVia: exists ? 'CSV Update' : 'CSV Import',
        billUrl: item.billUrl
      });
    }

    res.json({
      success: true,
      total: parsedItems.length,
      newCount,
      updatedCount,
      items: parsedItems,
      message: `ນຳເຂົ້າຂໍ້ມູນສຳເລັດ ${parsedItems.length} ລາຍການ (ເພີ່ມໃໝ່ ${newCount}, ອັບເດດສະຖານະ ${updatedCount}) — ບໍ່ມີຂໍ້ມູນຊ້ຳຊ້ອນ`
    });
  } catch (err) {
    console.error('Error parsing CSV:', err);
    res.status(500).json({ error: 'ເກີດຂໍ້ຜິດພາດໃນການອ່ານໄຟລ໌: ' + err.message });
  }
});

// REST API: Paste raw data from Excel / Clipboard
app.post('/api/paste-data', async (req, res) => {
  const { rawText } = req.body;
  if (!rawText || !rawText.trim()) {
    return res.status(400).json({ error: 'ກະລຸນາວາງຂໍ້ມູນຈາກ Excel' });
  }

  try {
    const parsedItems = parseAnousithFile(rawText);
    if (parsedItems.length === 0) {
      return res.status(400).json({ error: 'ບໍ່ພົບຂໍ້ມູນເລກບິນໃນຂໍ້ຄວາມທີ່ວາງ' });
    }

    console.log(`📋 Pasted Data Imported! Parsed ${parsedItems.length} parcels.`);

    let newCount = 0;
    let updatedCount = 0;

    for (const item of parsedItems) {
      const exists = isBillSent(item.tracking);
      if (!exists) {
        newCount++;
      } else {
        updatedCount++;
      }

      upsertBill(item.tracking, {
        recipientPhone: item.recipientPhone || '-',
        recipientName: item.recipientName || 'ລູກຄ້າ',
        itemName: item.itemName || '',
        codExpected: item.codExpected || '0 KIP',
        codCollected: item.codCollected || '0 KIP',
        codExpectedNum: item.codExpectedNum || 0,
        codCollectedNum: item.codCollectedNum || 0,
        shippingStatus: item.shippingStatus || 'ກຳລັງຂົນສົ່ງ',
        rawStatus: item.rawStatus || '',
        destinationBranch: item.destinationBranch || '-',
        originBranch: item.originBranch || '-',
        dateDeposited: item.dateDeposited || '',
        carrier: item.carrier || 'Anousith Express',
        sentVia: exists ? 'Clipboard Update' : 'Clipboard Paste',
        billUrl: item.billUrl
      });
    }

    res.json({
      success: true,
      total: parsedItems.length,
      newCount,
      updatedCount,
      items: parsedItems,
      message: `ນຳເຂົ້າຂໍ້ມູນສຳເລັດ ${parsedItems.length} ລາຍການ (ເພີ່ມໃໝ່ ${newCount}, ອັບເດດສະຖານະ ${updatedCount}) — ບໍ່ມີຂໍ້ມູນຊ້ຳຊ້ອນ`
    });
  } catch (err) {
    console.error('Error parsing pasted data:', err);
    res.status(500).json({ error: 'ເກີດຂໍ້ຜິດພາດ: ' + err.message });
  }
});

// REST API: Auto-Import Folder Watcher Status & Config
app.get('/api/auto-import/status', (req, res) => {
  res.json({
    success: true,
    ...folderWatcher.getStatus()
  });
});

app.post('/api/auto-import/toggle', (req, res) => {
  const { enabled } = req.body;
  const status = folderWatcher.toggle(enabled);
  res.json({
    success: true,
    message: status.enabled ? 'ເປີດລະບົບດຶງຂໍ້ມູນອັດຕະໂນມັດແລ້ວ' : 'ປິດລະບົບດຶງຂໍ້ມູນອັດຕະໂນມັດແລ້ວ',
    ...status
  });
});

app.post('/api/auto-import/scan-now', async (req, res) => {
  try {
    const results = await folderWatcher.scanAllFolders();
    res.json({
      success: true,
      count: results.length,
      results,
      status: folderWatcher.getStatus(),
      message: results.length > 0 
        ? `ກວດພົບ ແລະ ນຳເຂົ້າອັດຕະໂນມັດສຳເລັດ ${results.length} ໄຟລ໌!`
        : `ກວດສອບແລ້ວ — ບໍ່ພົບໄຟລ໌ໃໝ່ທີ່ຍັງບໍ່ໄດ້ນຳເຂົ້າ`
    });
  } catch (err) {
    res.status(500).json({ error: 'ເກີດຂໍ້ຜິດພາດ: ' + err.message });
  }
});

// REST API: Stream Send All Pending Bills to WhatsApp with Real-time Progress & Validation
app.get('/api/send-all-whatsapp-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendSSE = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const isReady = await bot.waitForConnection(10000);
  if (!isReady) {
    sendSSE({ type: 'error', error: 'WhatsApp ຍັງບໍ່ທັນເຊື່ອມຕໍ່ ຫຼື ກຳລັງກຽມພ້ອມເຊື່ອມຕໍ່ໃໝ່ ກະລຸນາລໍຖ້າ 5-10 ວິນາທີ ຫຼື ສະແກນ QR Code ດ້ານເທິງ' });
    return res.end();
  }

  const { carrier, date_from, date_to, date, force } = req.query;
  const fromDate = date || date_from || '';
  const toDate = date || date_to || '';

  const db = getDatabase();
  const list = Object.entries(db.sent_bills || {});
  const pending = list.filter(([t, item]) => {
    if (item.sent_to_whatsapp && force !== 'true') return false;
    if (!item.recipientPhone || item.recipientPhone === '-') return false;
    if (carrier && carrier !== 'all') {
      const itemCarrier = getCarrierName(item, t);
      if (!itemCarrier.toLowerCase().includes(carrier.toLowerCase())) return false;
    }
    if (!checkBillMatchesDate(item, fromDate, toDate)) return false;
    return true;
  });

  if (pending.length === 0) {
    sendSSE({
      type: 'done',
      total: 0,
      successCount: 0,
      failedCount: 0,
      failedList: [],
      message: 'ບໍ່ມີລາຍການໃບບິນທີ່ລໍຖ້າສົ່ງ (ທຸກລາຍການສົ່ງແລ້ວ ຫຼື ບໍ່ມີເບີໂທ)'
    });
    return res.end();
  }

  sendSSE({ type: 'init', total: pending.length, title: 'ກຳລັງສົ່ງໃບບິນເຂົ້າ WhatsApp' });

  let successCount = 0;
  let failedCount = 0;
  const failedList = [];

  for (let i = 0; i < pending.length; i++) {
    const [tracking, item] = pending[i];
    const phone = item.recipientPhone;
    const name = item.recipientName || 'ລູກຄ້າ';
    const carrierName = getCarrierName(item, tracking);
    const billUrl = getCarrierTrackingUrl(item, tracking);

    const jid = formatLaoPhoneToWhatsAppJid(phone);
    if (!jid) {
      failedCount++;
      const reason = 'ຮູບແບບເບີໂທບໍ່ຖືກຕ້ອງ ຫຼື ບໍ່ຄົບຖ້ວນ';
      failedList.push({ tracking, name, phone, carrier: carrierName, reason });
      sendSSE({
        type: 'progress',
        current: i + 1,
        total: pending.length,
        tracking,
        name,
        phone,
        carrier: carrierName,
        status: 'failed',
        reason
      });
      continue;
    }

    try {
      // Check if recipient is on WhatsApp
      const waCheck = await bot.checkOnWhatsApp(jid);
      if (waCheck && !waCheck.exists) {
        failedCount++;
        const reason = 'ເບີໂທນີ້ຍັງບໍ່ໄດ້ລົງທະບຽນ WhatsApp / ບໍ່ພົບຜູ້ໃຊ້';
        failedList.push({ tracking, name, phone, carrier: carrierName, reason });
        sendSSE({
          type: 'progress',
          current: i + 1,
          total: pending.length,
          tracking,
          name,
          phone,
          carrier: carrierName,
          status: 'failed',
          reason
        });
        continue;
      }

      console.log(`📨 [Stream] Sending bill #${tracking} to ${phone}...`);
      const caption = `📦 *ແຈ້ງເລກບິນ ${carrierName}*\nສະບາຍດີ ທ່ານ ${name}\n🔖 ເລກບິນ: *${tracking}*\n🔗 ເບິ່ງໃບບິນ: ${billUrl}\nຂອບໃຈເຈົ້າ 🙏`;

      const imgPath = path.join(TEMP_BILLS_DIR, `${tracking}.jpg`);
      const downloadedImg = await downloadCarrierSlipImage(item, tracking, imgPath);

      if (downloadedImg && fs.existsSync(downloadedImg)) {
        await bot.sendBillImage(jid, downloadedImg, caption);
      } else {
        await bot.sendMessage(jid, caption);
      }

      markBillSent(tracking, {
        ...item,
        sent_to_whatsapp: true,
        sent_at: new Date().toISOString()
      });

      successCount++;
      sendSSE({
        type: 'progress',
        current: i + 1,
        total: pending.length,
        tracking,
        name,
        phone,
        carrier: carrierName,
        status: 'success',
        message: 'ສົ່ງຮູບໃບບິນສຳເລັດແລ້ວ'
      });

      await sleep(2500);
    } catch (e) {
      console.error(`Failed to send stream #${tracking}:`, e.message);
      failedCount++;
      const reason = e.message || 'ເກີດຂໍ້ຜິດພາດໃນການສົ່ງ';
      failedList.push({ tracking, name, phone, carrier: carrierName, reason });
      sendSSE({
        type: 'progress',
        current: i + 1,
        total: pending.length,
        tracking,
        name,
        phone,
        carrier: carrierName,
        status: 'failed',
        reason
      });
    }
  }

  sendSSE({
    type: 'done',
    total: pending.length,
    successCount,
    failedCount,
    failedList,
    message: `ສົ່ງສຳເລັດ ${successCount} ລາຍການ, ບໍ່ສາມາດສົ່ງໄດ້ ${failedCount} ລາຍການ`
  });

  res.end();
});

// REST API: Stream Send All Due Arrival Reminders with Real-time Progress & Validation
app.get('/api/send-all-arrival-reminders-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendSSE = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (!bot.isConnected) {
    sendSSE({ type: 'error', error: 'WhatsApp ຍັງບໍ່ທັນເຊື່ອມຕໍ່ ກະລຸນາສະແກນ QR Code ກ່ອນ' });
    return res.end();
  }

  const { force, carrier, remind_round, date, date_from, date_to } = req.query;
  const db = getDatabase();
  const list = Object.entries(db.sent_bills || {});
  const now = Date.now();

  const targetDateFrom = date || date_from;
  const targetDateTo = date || date_to;

  const atDestDueList = list.filter(([t, item]) => {
    const st = item.shippingStatus || '';
    if (!st.includes('ຮອດປາຍທາງ') || !item.recipientPhone || item.recipientPhone === '-') return false;
    
    if (carrier && carrier !== 'all') {
      const itemCarrier = getCarrierName(item, t);
      if (!itemCarrier.toLowerCase().includes(carrier.toLowerCase())) return false;
    }

    if (targetDateFrom || targetDateTo) {
      if (!checkBillMatchesDate(item, targetDateFrom, targetDateTo)) return false;
    }

    const rCount = item.reminder_count || (item.notified_arrival ? 1 : 0);
    if (remind_round === '1') {
      if (rCount !== 0) return false;
    } else if (remind_round === '2') {
      if (rCount !== 1) return false;
    } else if (remind_round === '3') {
      if (rCount < 2) return false;
    }

    if (force === 'true') return true;

    const lastRemindTime = item.last_reminded_at ? new Date(item.last_reminded_at).getTime() : 0;
    const hoursPassed = lastRemindTime ? (now - lastRemindTime) / (1000 * 60 * 60) : 999;
    return hoursPassed >= 48;
  });

  if (atDestDueList.length === 0) {
    sendSSE({
      type: 'done',
      total: 0,
      successCount: 0,
      failedCount: 0,
      failedList: [],
      message: 'ບໍ່ມີພັດສະດຸທີ່ຮອດກຳນົດເຕືອນ (ທຸກລາຍການຫາກໍ່ເຕືອນພາຍໃນ 48 ຊົ່ວໂມງ)'
    });
    return res.end();
  }

  sendSSE({ type: 'init', total: atDestDueList.length, title: 'ກຳລັງສົ່ງແຈ້ງເຕືອນຮອດປາຍທາງ' });

  let successCount = 0;
  let failedCount = 0;
  const failedList = [];

  for (let i = 0; i < atDestDueList.length; i++) {
    const [tracking, item] = atDestDueList[i];
    const phone = item.recipientPhone;
    const name = item.recipientName || 'ລູກຄ້າ';
    const carrierName = getCarrierName(item, tracking);

    const jid = formatLaoPhoneToWhatsAppJid(phone);
    if (!jid) {
      failedCount++;
      const reason = 'ຮູບແບບເບີໂທບໍ່ຖືກຕ້ອງ ຫຼື ບໍ່ຄົບຖ້ວນ';
      failedList.push({ tracking, name, phone, carrier: carrierName, reason });
      sendSSE({
        type: 'progress',
        current: i + 1,
        total: atDestDueList.length,
        tracking,
        name,
        phone,
        carrier: carrierName,
        status: 'failed',
        reason
      });
      continue;
    }

    try {
      const waCheck = await bot.checkOnWhatsApp(jid);
      if (waCheck && !waCheck.exists) {
        failedCount++;
        const reason = 'ເບີໂທນີ້ຍັງບໍ່ໄດ້ລົງທະບຽນ WhatsApp / ບໍ່ພົບຜູ້ໃຊ້';
        failedList.push({ tracking, name, phone, carrier: carrierName, reason });
        sendSSE({
          type: 'progress',
          current: i + 1,
          total: atDestDueList.length,
          tracking,
          name,
          phone,
          carrier: carrierName,
          status: 'failed',
          reason
        });
        continue;
      }

      console.log(`🔔 [Stream] Sending due 2-day reminder #${tracking} to ${phone}...`);
      const message = formatArrivalReminderMsg(item, tracking);
      const imgPath = path.join(TEMP_BILLS_DIR, `${tracking}.jpg`);
      const downloadedImg = await downloadCarrierSlipImage(item, tracking, imgPath);

      if (downloadedImg && fs.existsSync(downloadedImg)) {
        await bot.sendBillImage(jid, downloadedImg, message);
      } else {
        await bot.sendMessage(jid, message);
      }

      recordReminder(tracking, {
        type: 'bulk_due_reminder',
        recipientPhone: phone
      });

      successCount++;
      sendSSE({
        type: 'progress',
        current: i + 1,
        total: atDestDueList.length,
        tracking,
        name,
        phone,
        carrier: carrierName,
        status: 'success',
        message: 'ສົ່ງແຈ້ງເຕືອນຮອດປາຍທາງສຳເລັດ'
      });

      await sleep(2500);
    } catch (e) {
      console.error(`Failed to send arrival reminder stream #${tracking}:`, e.message);
      failedCount++;
      const reason = e.message || 'ເກີດຂໍ້ຜິດພາດໃນການສົ່ງ';
      failedList.push({ tracking, name, phone, carrier: carrierName, reason });
      sendSSE({
        type: 'progress',
        current: i + 1,
        total: atDestDueList.length,
        tracking,
        name,
        phone,
        carrier: carrierName,
        status: 'failed',
        reason
      });
    }
  }

  sendSSE({
    type: 'done',
    total: atDestDueList.length,
    successCount,
    failedCount,
    failedList,
    message: `ສົ່ງເຕືອນຮອດປາຍທາງສຳເລັດ ${successCount} ລາຍການ, ສົ່ງບໍ່ໄດ້ ${failedCount} ລາຍການ`
  });

  res.end();
});

// REST API: Stream Send All Returned Notifications with Real-time Progress & Validation
app.get('/api/send-all-returned-notifications-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendSSE = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (!bot.isConnected) {
    sendSSE({ type: 'error', error: 'WhatsApp ຍັງບໍ່ທັນເຊື່ອມຕໍ່ ກະລຸນາສະແກນ QR Code ກ່ອນ' });
    return res.end();
  }

  const { carrier } = req.query;
  const db = getDatabase();
  const list = Object.entries(db.sent_bills || {});
  const returnedList = list.filter(([t, item]) => {
    const st = item.shippingStatus || '';
    if (!st.includes('ຕີກັບ') || !item.recipientPhone || item.recipientPhone === '-') return false;
    if (carrier && carrier !== 'all') {
      const itemCarrier = getCarrierName(item, t);
      if (!itemCarrier.toLowerCase().includes(carrier.toLowerCase())) return false;
    }
    return true;
  });

  if (returnedList.length === 0) {
    sendSSE({
      type: 'done',
      total: 0,
      successCount: 0,
      failedCount: 0,
      failedList: [],
      message: 'ບໍ່ພົບພັດສະດຸທີ່ຢູ່ສະຖານະ "ຕີກັບ"'
    });
    return res.end();
  }

  sendSSE({ type: 'init', total: returnedList.length, title: 'ກຳລັງສົ່ງແຈ້ງເຕືອນຕີກັບ (ຄ່າຝາກ x2)' });

  let successCount = 0;
  let failedCount = 0;
  const failedList = [];

  for (let i = 0; i < returnedList.length; i++) {
    const [tracking, item] = returnedList[i];
    const phone = item.recipientPhone;
    const name = item.recipientName || 'ລູກຄ້າ';
    const carrierName = getCarrierName(item, tracking);

    const jid = formatLaoPhoneToWhatsAppJid(phone);
    if (!jid) {
      failedCount++;
      const reason = 'ຮູບແບບເບີໂທບໍ່ຖືກຕ້ອງ ຫຼື ບໍ່ຄົບຖ້ວນ';
      failedList.push({ tracking, name, phone, carrier: carrierName, reason });
      sendSSE({
        type: 'progress',
        current: i + 1,
        total: returnedList.length,
        tracking,
        name,
        phone,
        carrier: carrierName,
        status: 'failed',
        reason
      });
      continue;
    }

    try {
      const waCheck = await bot.checkOnWhatsApp(jid);
      if (waCheck && !waCheck.exists) {
        failedCount++;
        const reason = 'ເບີໂທນີ້ຍັງບໍ່ໄດ້ລົງທະບຽນ WhatsApp / ບໍ່ພົບຜູ້ໃຊ້';
        failedList.push({ tracking, name, phone, carrier: carrierName, reason });
        sendSSE({
          type: 'progress',
          current: i + 1,
          total: returnedList.length,
          tracking,
          name,
          phone,
          carrier: carrierName,
          status: 'failed',
          reason
        });
        continue;
      }

      console.log(`↩️ [Stream] Sending returned notice #${tracking} to ${phone}...`);
      const message = formatReturnedParcelMsg(item, tracking);
      const imgPath = path.join(TEMP_BILLS_DIR, `${tracking}.jpg`);
      const downloadedImg = await downloadCarrierSlipImage(item, tracking, imgPath);

      if (downloadedImg && fs.existsSync(downloadedImg)) {
        await bot.sendBillImage(jid, downloadedImg, message);
      } else {
        await bot.sendMessage(jid, message);
      }

      recordReminder(tracking, {
        type: 'returned_fee_notice',
        recipientPhone: phone
      });

      markBillSent(tracking, {
        ...item,
        notified_returned: true,
        notified_returned_at: new Date().toISOString()
      });

      successCount++;
      sendSSE({
        type: 'progress',
        current: i + 1,
        total: returnedList.length,
        tracking,
        name,
        phone,
        carrier: carrierName,
        status: 'success',
        message: 'ສົ່ງແຈ້ງຕີກັບ (ຄ່າຝາກ x2) ສຳເລັດ'
      });

      await sleep(2500);
    } catch (e) {
      console.error(`Failed to send returned notice stream #${tracking}:`, e.message);
      failedCount++;
      const reason = e.message || 'ເກີດຂໍ້ຜິດພາດໃນການສົ່ງ';
      failedList.push({ tracking, name, phone, carrier: carrierName, reason });
      sendSSE({
        type: 'progress',
        current: i + 1,
        total: returnedList.length,
        tracking,
        name,
        phone,
        carrier: carrierName,
        status: 'failed',
        reason
      });
    }
  }

  sendSSE({
    type: 'done',
    total: returnedList.length,
    successCount,
    failedCount,
    failedList,
    message: `ສົ່ງແຈ້ງຕີກັບສຳເລັດ ${successCount} ລາຍການ, ສົ່ງບໍ່ໄດ້ ${failedCount} ລາຍການ`
  });

  res.end();
});

// REST API: Send All Pending Bills to WhatsApp (Standard fallback)
app.post('/api/send-all-whatsapp', async (req, res) => {
  if (!bot.isConnected) {
    return res.status(503).json({ error: 'WhatsApp ຍັງບໍ່ທັນເຊື່ອມຕໍ່' });
  }

  const db = getDatabase();
  const list = Object.entries(db.sent_bills || {});
  
  res.json({ success: true, message: 'ເລີ່ມຕົ້ນສົ່ງໃບບິນເຂົ້າ WhatsApp ທັງໝົດແລ້ວ' });

  // Background sending loop with delay
  (async () => {
    for (const [tracking, item] of list) {
      if (item.sent_to_whatsapp) continue;
      const phone = item.recipientPhone;
      if (!phone || phone === '-') continue;

      const jid = formatLaoPhoneToWhatsAppJid(phone);
      if (!jid) continue;

      try {
        console.log(`📨 Sending bill #${tracking} to ${phone}...`);
        const carrierName = getCarrierName(item, tracking);
        const billUrl = getCarrierTrackingUrl(item, tracking);
        const name = item.recipientName || 'ລູກຄ້າ';
        const caption = `📦 *ແຈ້ງເລກບິນ ${carrierName}*\nສະບາຍດີ ທ່ານ ${name}\n🔖 ເລກບິນ: *${tracking}*\n🔗 ເບິ່ງໃບບິນ: ${billUrl}\nຂອບໃຈເຈົ້າ 🙏`;

        const imgPath = path.join(TEMP_BILLS_DIR, `${tracking}.jpg`);
        const downloadedImg = await downloadCarrierSlipImage(item, tracking, imgPath);

        if (downloadedImg && fs.existsSync(downloadedImg)) {
          await bot.sendBillImage(jid, downloadedImg, caption);
        } else {
          await bot.sendMessage(jid, caption);
        }

        markBillSent(tracking, {
          ...item,
          sent_to_whatsapp: true,
          sent_at: new Date().toISOString()
        });

        await sleep(3500);
      } catch (e) {
        console.error(`Failed to send #${tracking}:`, e.message);
      }
    }
  })().catch(console.error);
});

let autoReminderEnabled = true;
const REMINDER_INTERVAL_MS = 48 * 60 * 60 * 1000; // 48 hours (every 2 days)

function formatArrivalReminderMsg(item, tracking) {
  const name = item.recipientName || 'ລູກຄ້າ';
  const branch = item.destinationBranch || 'ສາຂາປາຍທາງ';
  const cod = item.codExpected || item.codAmount || '0 KIP';
  const carrierName = getCarrierName(item, tracking);
  const billUrl = getCarrierTrackingUrl(item, tracking);
  const reminderCount = (item.reminder_count || 0) + 1;

  // 7-day countdown estimation
  let daysRemaining = 5;
  if (item.dateDeposited) {
    const depDate = new Date(item.dateDeposited);
    if (!isNaN(depDate.getTime())) {
      const daysPassed = Math.floor((Date.now() - depDate.getTime()) / (1000 * 60 * 60 * 24));
      daysRemaining = Math.max(1, 7 - daysPassed);
    }
  }

  // 1st Reminder: Initial notification
  if (reminderCount === 1) {
    return `📦 *ເຄື່ອງຮອດປາຍທາງແລ້ວ (${carrierName})*\nສະບາຍດີ ທ່ານ ${name}\n🔖 ບິນ: *${tracking}*\n📍 ສາຂາ: *${branch}*\n💰 COD: *${cod}*\n🔗 ເບິ່ງບິນ: ${billUrl}\nລູກຄ້າໄປຮັບໄດ້ເລີຍເດີເຈົ້າ 🙏`;
  }

  // 2nd Reminder: Follow-up (2 days after)
  if (reminderCount === 2) {
    return `🔔 *ແຈ້ງເຕືອນຮັບເຄື່ອງ (${carrierName})*\nສະບາຍດີ ທ່ານ ${name}\n🔖 ບິນ: *${tracking}*\n📍 ຢູ່ສາຂາ: *${branch}*\n⏳ ເຫຼືອເວລາ: *${daysRemaining} ວັນ* (ກ່ອນຕີກັບ)\n💰 COD: *${cod}*\nຢ່າລືມແວ່ຮັບເດີເຈົ້າ 🙏`;
  }

  // 3rd Reminder: Urgent warning (4 days after)
  if (reminderCount === 3) {
    return `⚠️ *ເຕືອນດ່ວນ: ໃກ້ຮອດກຳນົດສົ່ງຄືນ (${carrierName})*\nຮຽນ ທ່ານ ${name}\n🔖 ບິນ: *${tracking}* (ສາຂາ: *${branch}*)\n🚨 ເຫຼືອພຽງ *${daysRemaining} ວັນ* ຈະຖືກຕີກັບ\n💰 COD: *${cod}*\nຟ້າວຕິດຕໍ່ຮັບດ່ວນເດີເຈົ້າ 🙏`;
  }

  // 4th+ Reminder: Final cutoff warning
  return `🚨 *ເຕືອນຄັ້ງສຸດທ້າຍ: ເຄື່ອງຈະຖືກຕີກັບ (${carrierName})*\nຮຽນ ທ່ານ ${name}\n🔖 ບິນ: *${tracking}*\n📍 ຖ້າບໍ່ຮັບມື້ນີ້ ສາຂາ *${branch}* ຈະຕີເຄື່ອງກັບຄືນ\n💰 COD: *${cod}*\nຮີບຕິດຕໍ່ຮັບດ່ວນເຈົ້າ! 🙏`;
}

function formatReturnedParcelMsg(item, tracking) {
  const name = item.recipientName || 'ລູກຄ້າ';
  const branch = item.destinationBranch || 'ສາຂາປາຍທາງ';
  const carrierName = getCarrierName(item, tracking);
  const billUrl = getCarrierTrackingUrl(item, tracking);

  return `↩️ *ແຈ້ງເຕືອນ: ເຄື່ອງຕີກັບຄືນ (${carrierName})*\nຮຽນ ທ່ານ ${name}\n🔖 ບິນ: *${tracking}* (ສາຂາ: *${branch}*)\nເຄື່ອງບໍ່ມີຜູ້ຮັບ ຈຶ່ງຖືກລະບົບຕີກັບມາຮ້ານ.\n\n💳 *ກະລຸນາໂອນຄ່າຝາກ x2 (ໄປ-ກັບ)*\n🔗 ເບິ່ງບິນ: ${billUrl}\n📞 ຕິດຕໍ່ຮ້ານ: 020 28372583 🙏`;
}

// REST API: Send Arrival Notification for Single Bill
app.post('/api/send-arrival-reminder', async (req, res) => {
  const { tracking, force } = req.body;
  if (!tracking) {
    return res.status(400).json({ error: 'ກະລຸນາລະບຸເລກບິນ' });
  }

  if (!bot.isConnected) {
    return res.status(503).json({ error: 'WhatsApp ຍັງບໍ່ທັນເຊື່ອມຕໍ່' });
  }

  const db = getDatabase();
  const item = db.sent_bills?.[tracking];
  if (!item) {
    return res.status(404).json({ error: 'ບໍ່ພົບຂໍ້ມູນເລກບິນໃນລະບົບ' });
  }

  // Enforce 48-hour cooldown rule
  const now = Date.now();
  const lastRemindTime = item.last_reminded_at ? new Date(item.last_reminded_at).getTime() : 0;
  const hoursPassed = lastRemindTime ? (now - lastRemindTime) / (1000 * 60 * 60) : 999;

  if (lastRemindTime && hoursPassed < 48 && !force) {
    const hoursRemaining = (48 - hoursPassed).toFixed(1);
    return res.status(400).json({
      error: `ຫ້າມເຕືອນຊ້ຳ! ຍັງບໍ່ທັນຮອດກຳນົດ (ຫາກໍ່ເຕືອນໄປເມື່ອ ${hoursPassed.toFixed(1)} ຊົ່ວໂມງກ່ອນ, ຕ້ອງລໍຖ້າອີກ ${hoursRemaining} ຊົ່ວໂມງ)`
    });
  }

  const phone = item.recipientPhone;
  const jid = formatLaoPhoneToWhatsAppJid(phone);
  if (!jid) {
    return res.status(400).json({ error: 'ຮູບແບບເບີໂທບໍ່ຖືກຕ້ອງ' });
  }

  try {
    const message = formatArrivalReminderMsg(item, tracking);
    const imgPath = path.join(TEMP_BILLS_DIR, `${tracking}.jpg`);
    const downloadedImg = await downloadCarrierSlipImage(item, tracking, imgPath);

    if (downloadedImg && fs.existsSync(downloadedImg)) {
      await bot.sendBillImage(jid, downloadedImg, message);
    } else {
      await bot.sendMessage(jid, message);
    }

    const updated = recordReminder(tracking, {
      type: 'manual_arrival_reminder',
      recipientPhone: phone
    });

    res.json({
      success: true,
      reminder_count: updated.reminder_count,
      message: `ສົ່ງແຈ້ງເຕືອນຮອດປາຍທາງ (ຄັ້ງທີ ${updated.reminder_count}) ຫາ ${phone} ສຳເລັດແລ້ວ`
    });
  } catch (err) {
    console.error(`Error sending arrival reminder for #${tracking}:`, err);
    res.status(500).json({ error: err.message });
  }
});

// REST API: Send Arrival Notifications to ALL parcels at destination (Only Due items)
app.post('/api/send-all-arrival-reminders', async (req, res) => {
  if (!bot.isConnected) {
    return res.status(503).json({ error: 'WhatsApp ຍັງບໍ່ທັນເຊື່ອມຕໍ່' });
  }

  const { force } = req.body || {};
  const db = getDatabase();
  const list = Object.entries(db.sent_bills || {});
  const now = Date.now();

  const atDestDueList = list.filter(([t, item]) => {
    const st = item.shippingStatus || '';
    if (!st.includes('ຮອດປາຍທາງ') || !item.recipientPhone || item.recipientPhone === '-') return false;
    
    if (force) return true;

    // Check if 48h has passed or never reminded
    const lastRemindTime = item.last_reminded_at ? new Date(item.last_reminded_at).getTime() : 0;
    const hoursPassed = lastRemindTime ? (now - lastRemindTime) / (1000 * 60 * 60) : 999;
    return hoursPassed >= 48;
  });

  if (atDestDueList.length === 0) {
    return res.status(400).json({ error: 'ບໍ່ມີພັດສະດຸທີ່ຮອດກຳນົດເຕືອນ (ທຸກລາຍການຫາກໍ່ເຕືອນພາຍໃນ 48 ຊົ່ວໂມງ)' });
  }

  res.json({
    success: true,
    total: atDestDueList.length,
    message: `ເລີ່ມຕົ້ນສົ່ງແຈ້ງເຕືອນລາຍການທີ່ຮອດກຳນົດ ${atDestDueList.length} ລາຍການແລ້ວ (ພ້ອມຮູບໃບບິນ)`
  });

  // Background sending loop
  (async () => {
    for (const [tracking, item] of atDestDueList) {
      const phone = item.recipientPhone;
      const jid = formatLaoPhoneToWhatsAppJid(phone);
      if (!jid) continue;

      try {
        console.log(`🔔 Sending due 2-day reminder #${tracking} to ${phone}...`);
        const message = formatArrivalReminderMsg(item, tracking);
        const imgPath = path.join(TEMP_BILLS_DIR, `${tracking}.jpg`);
        const downloadedImg = await downloadCarrierSlipImage(item, tracking, imgPath);

        if (downloadedImg && fs.existsSync(downloadedImg)) {
          await bot.sendBillImage(jid, downloadedImg, message);
        } else {
          await bot.sendMessage(jid, message);
        }

        recordReminder(tracking, {
          type: 'bulk_due_reminder',
          recipientPhone: phone
        });

        await sleep(3500);
      } catch (e) {
        console.error(`Failed to send arrival reminder for #${tracking}:`, e.message);
      }
    }
  })().catch(console.error);
});

// REST API: Send Returned Parcel Notification (Single Bill)
app.post('/api/send-returned-notification', async (req, res) => {
  const { tracking } = req.body;
  if (!tracking) {
    return res.status(400).json({ error: 'ກະລຸນາລະບຸເລກບິນ' });
  }

  if (!bot.isConnected) {
    return res.status(503).json({ error: 'WhatsApp ຍັງບໍ່ທັນເຊື່ອມຕໍ່' });
  }

  const db = getDatabase();
  const item = db.sent_bills?.[tracking];
  if (!item) {
    return res.status(404).json({ error: 'ບໍ່ພົບຂໍ້ມູນເລກບິນໃນລະບົບ' });
  }

  const phone = item.recipientPhone;
  const jid = formatLaoPhoneToWhatsAppJid(phone);
  if (!jid) {
    return res.status(400).json({ error: 'ຮູບແບບເບີໂທບໍ່ຖືກຕ້ອງ' });
  }

  try {
    const message = formatReturnedParcelMsg(item, tracking);
    const imgPath = path.join(TEMP_BILLS_DIR, `${tracking}.jpg`);
    const downloadedImg = await downloadCarrierSlipImage(item, tracking, imgPath);

    if (downloadedImg && fs.existsSync(downloadedImg)) {
      await bot.sendBillImage(jid, downloadedImg, message);
    } else {
      await bot.sendMessage(jid, message);
    }

    const updated = recordReminder(tracking, {
      type: 'returned_fee_notice',
      recipientPhone: phone
    });

    markBillSent(tracking, {
      ...item,
      notified_returned: true,
      notified_returned_at: new Date().toISOString()
    });

    res.json({
      success: true,
      message: `ສົ່ງແຈ້ງເຕືອນຕີກັບ (ຄ່າຝາກ x2) ຫາ ${phone} ສຳເລັດແລ້ວ`
    });
  } catch (err) {
    console.error(`Error sending returned notification for #${tracking}:`, err);
    res.status(500).json({ error: err.message });
  }
});

// REST API: Send Returned Notifications to ALL returned parcels
app.post('/api/send-all-returned-notifications', async (req, res) => {
  if (!bot.isConnected) {
    return res.status(503).json({ error: 'WhatsApp ຍັງບໍ່ທັນເຊື່ອມຕໍ່' });
  }

  const db = getDatabase();
  const list = Object.entries(db.sent_bills || {});
  const returnedList = list.filter(([t, item]) => {
    const st = item.shippingStatus || '';
    return st.includes('ຕີກັບ') && item.recipientPhone && item.recipientPhone !== '-';
  });

  if (returnedList.length === 0) {
    return res.status(400).json({ error: 'ບໍ່ພົບພັດສະດຸທີ່ຢູ່ສະຖານະ "ຕີກັບ"' });
  }

  res.json({
    success: true,
    total: returnedList.length,
    message: `ເລີ່ມຕົ້ນສົ່ງແຈ້ງເຕືອນຕີກັບທັງໝົດ ${returnedList.length} ລາຍການແລ້ວ`
  });

  (async () => {
    for (const [tracking, item] of returnedList) {
      const phone = item.recipientPhone;
      const jid = formatLaoPhoneToWhatsAppJid(phone);
      if (!jid) continue;

      try {
        console.log(`↩️ Sending returned notice #${tracking} to ${phone}...`);
        const message = formatReturnedParcelMsg(item, tracking);
        const imgPath = path.join(TEMP_BILLS_DIR, `${tracking}.jpg`);
        const downloadedImg = await downloadCarrierSlipImage(item, tracking, imgPath);

        if (downloadedImg && fs.existsSync(downloadedImg)) {
          await bot.sendBillImage(jid, downloadedImg, message);
        } else {
          await bot.sendMessage(jid, message);
        }

        recordReminder(tracking, {
          type: 'returned_fee_notice',
          recipientPhone: phone
        });

        markBillSent(tracking, {
          ...item,
          notified_returned: true,
          notified_returned_at: new Date().toISOString()
        });

        await sleep(3500);
      } catch (e) {
        console.error(`Failed to send returned notice for #${tracking}:`, e.message);
      }
    }
  })().catch(console.error);
});

// REST API: Get / Toggle Auto-Reminder status
app.get('/api/auto-reminder-status', (req, res) => {
  res.json({
    enabled: autoReminderEnabled,
    intervalHours: 48,
    maxDaysBeforeReturn: 7
  });
});

app.post('/api/toggle-auto-reminder', (req, res) => {
  autoReminderEnabled = !autoReminderEnabled;
  res.json({
    success: true,
    enabled: autoReminderEnabled,
    message: autoReminderEnabled ? 'ເປີດລະບົບແຈ້ງເຕືອນອັດຕະໂນມັດທຸກ 2 ວັນແລ້ວ' : 'ປິດລະບົບແຈ້ງເຕືອນອັດຕະໂນມັດແລ້ວ'
  });
});

// Background Worker: Check and auto-send 2-day pickup reminders
async function checkAndSend2DayReminders() {
  if (!autoReminderEnabled || !bot.isConnected) return;

  const db = getDatabase();
  const list = Object.entries(db.sent_bills || {});
  const now = Date.now();

  for (const [tracking, item] of list) {
    const st = item.shippingStatus || '';
    if (!st.includes('ຮອດປາຍທາງ')) continue;
    if (!item.recipientPhone || item.recipientPhone === '-') continue;

    const jid = formatLaoPhoneToWhatsAppJid(item.recipientPhone);
    if (!jid) continue;

    // Check if due for a reminder (either never reminded or >= 48 hours since last reminder)
    const lastRemindTime = item.last_reminded_at ? new Date(item.last_reminded_at).getTime() : 0;
    const isDue = (now - lastRemindTime) >= REMINDER_INTERVAL_MS;

    if (isDue) {
      try {
        console.log(`⏰ [Auto 2-Day Reminder] Sending reminder for #${tracking} to ${item.recipientPhone}...`);
        const message = formatArrivalReminderMsg(item, tracking);
        const imgPath = path.join(TEMP_BILLS_DIR, `${tracking}.jpg`);
        const downloadedImg = await downloadCarrierSlipImage(item, tracking, imgPath);

        if (downloadedImg && fs.existsSync(downloadedImg)) {
          await bot.sendBillImage(jid, downloadedImg, message);
        } else {
          await bot.sendMessage(jid, message);
        }

        recordReminder(tracking, {
          type: 'auto_2day_interval',
          recipientPhone: item.recipientPhone
        });

        await sleep(3500);
      } catch (err) {
        console.error(`Error in checkAndSend2DayReminders for #${tracking}:`, err.message);
      }
    }
  }
}

// REST API: Batch Fetch / Import Bills
app.post('/api/batch-fetch', async (req, res) => {
  const { trackingNumbers, autoSend } = req.body;

  if (!trackingNumbers || !Array.isArray(trackingNumbers) || trackingNumbers.length === 0) {
    return res.status(400).json({ error: 'ກະລຸນາລະບຸລາຍການເລກບິນ' });
  }

  const results = [];
  for (const tracking of trackingNumbers) {
    const cleanTracking = tracking.toString().trim();
    if (!cleanTracking) continue;

    const billUrl = anousith.getBillShareUrl(cleanTracking);
    const imgPath = path.join(TEMP_BILLS_DIR, `${cleanTracking}.jpg`);
    
    // Download bill slip
    const downloaded = await anousith.downloadBillImage(cleanTracking, imgPath);

    const record = {
      tracking: cleanTracking,
      billUrl: billUrl,
      hasImage: Boolean(downloaded),
      imported_at: new Date().toISOString()
    };

    // If already in DB
    if (!isBillSent(cleanTracking)) {
      markBillSent(cleanTracking, {
        recipientName: 'ລູກຄ້າ',
        recipientPhone: '-',
        sentVia: 'Batch Import / Sync',
        billUrl: billUrl
      });
    }

    results.push(record);
  }

  res.json({
    success: true,
    total: results.length,
    bills: results
  });
});

const AnousithScraper = require('./anousith_scraper');
const scraper = new AnousithScraper();

// REST API: Trigger Sync Now with automated browser scraper
app.post('/api/sync-now', async (req, res) => {
  try {
    console.log('🔄 Triggering full Anousith account sync...');
    const bills = await scraper.syncAllBills();
    res.json({ success: true, count: bills.length, message: `ດຶງຂໍ້ມູນບິນສຳເລັດ ${bills.length} ລາຍການ` });
  } catch (err) {
    console.error('Error during full sync:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Auto-poller logic
async function checkAndSendNewBills() {
  if (!bot.isConnected) return;

  try {
    const orders = await anousith.getRecentOrders();
    if (!orders || orders.length === 0) return;

    for (const order of orders) {
      const trackingNumber = order.tracking_number || order.bill_no || order.id_list;
      const recipientPhone = order.receiver_phone || order.recipient_phone || order.phone;
      const recipientName = order.receiver_name || order.recipient_name || 'ລູກຄ້າ';

      if (!trackingNumber || !recipientPhone) continue;
      if (isBillSent(trackingNumber)) continue;

      const jid = formatLaoPhoneToWhatsAppJid(recipientPhone);
      if (!jid) continue;

      console.log(`📨 [Auto] New bill found #${trackingNumber} for ${recipientName} (${recipientPhone})`);

      const billUrl = anousith.getBillShareUrl(trackingNumber);
      const caption = `📦 ສະບາຍດີ ທ່ານ ${recipientName}!\nເຄື່ອງຂອງທ່ານໄດ້ຖືກຈັດສົ່ງຜ່ານ Anousith Express ແລ້ວເຈົ້າ.\n\n🔖 ເລກບິນ / Tracking: *${trackingNumber}*\n🔗 ກວດສອບສະຖານະ: ${billUrl}\n\nຂອບໃຈທີ່ໃຊ້ບໍລິການ 🙏`;

      const imgPath = path.join(TEMP_BILLS_DIR, `${trackingNumber}.jpg`);
      const downloadedImg = await anousith.downloadBillImage(order.bill_image_url || trackingNumber, imgPath);

      if (downloadedImg && fs.existsSync(downloadedImg)) {
        await bot.sendBillImage(jid, downloadedImg, caption);
      } else {
        await bot.sendMessage(jid, caption);
      }

      markBillSent(trackingNumber, {
        recipientPhone,
        recipientName,
        sentVia: 'Auto Poller'
      });

      console.log(`✅ [Auto] Sent bill #${trackingNumber} to ${recipientPhone}`);
      await sleep(3500);
    }
  } catch (err) {
    console.error('Error in checkAndSendNewBills:', err.message);
  }
}

async function startServer() {
  app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🌐 Web Dashboard running at: http://localhost:${PORT}`);
    console.log(`======================================================\n`);
  });

  // Start WhatsApp Client
  await bot.start();

  // Initialize Anousith
  await anousith.login();

  // Start periodic sync
  setInterval(checkAndSendNewBills, POLL_INTERVAL);
  checkAndSendNewBills();

  // Start 2-day reminder check (every 30 minutes)
  setInterval(checkAndSend2DayReminders, 30 * 60 * 1000);

  // Start Auto-Import Folder Watcher (Downloads & auto_import folders)
  folderWatcher.init();
}

startServer().catch(console.error);
