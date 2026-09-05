const fs = require('fs');
const xlsx = require('xlsx');
const { formatLaoPhoneToWhatsAppJid } = require('./formatter');

function excelDateToDateStr(val) {
  if (!val) return '';
  if (typeof val === 'number') {
    const utc_days = Math.floor(val - 25569);
    const utc_value = utc_days * 86400;
    const date = new Date(utc_value * 1000);
    return !isNaN(date.getTime()) ? date.toISOString().split('T')[0] : String(val);
  }
  const s = String(val).trim();
  // Match DD/MM/YYYY or DD-MM-YYYY (with optional HH:mm:ss)
  const ddmmyyyy = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
  if (ddmmyyyy) {
    const day = ddmmyyyy[1].padStart(2, '0');
    const month = ddmmyyyy[2].padStart(2, '0');
    const year = ddmmyyyy[3];
    return `${year}-${month}-${day}`;
  }
  // Match YYYY-MM-DD
  const yyyymmdd = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  if (yyyymmdd) {
    const year = yyyymmdd[1];
    const month = yyyymmdd[2].padStart(2, '0');
    const day = yyyymmdd[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return s.split('T')[0];
}

function parseCodNumber(val) {
  if (!val) return 0;
  const numStr = val.toString().replace(/[^0-9.]/g, '');
  return parseFloat(numStr) || 0;
}

function cleanStatus(rawStatus) {
  if (!rawStatus) return 'ກຳລັງຂົນສົ່ງ';
  const s = rawStatus.toString();
  if (s.includes('ຕີກັບ') || s.includes('ສົ່ງຄືນ') || s.toLowerCase().includes('return')) return 'ຕີກັບ';
  if (s.includes('ຮອດປາຍທາງ') || s.includes('ເຄື່ອງຮອດສາຂາ') || s.includes('ຮອດສາຂາ') || s.toLowerCase().includes('destination')) return 'ຮອດປາຍທາງ';
  if (s.includes('ສຳເລັດ') || s.includes('ຈັດສົ່ງສຳເລັດ') || s.includes('ຮັບເຄື່ອງແລ້ວ') || s.includes('ເຊັນຮັບ') || s.toLowerCase().includes('delivered') || s.toLowerCase().includes('success')) return 'ສຳເລັດ (ຮັບເຄື່ອງແລ້ວ)';
  if (s.includes('ກຳລັງຂົນສົ່ງ') || s.includes('ກຳລັງຈັດສົ່ງ') || s.includes('ກຳລັງດຳເນີນການ') || s.includes('ກຳລັງສົ່ງ') || s.toLowerCase().includes('transit') || s.toLowerCase().includes('shipping')) return 'ກຳລັງຂົນສົ່ງ';
  return s.split('\n').pop().trim() || 'ກຳລັງຂົນສົ່ງ';
}

function isHalTracking(tracking) {
  if (!tracking) return false;
  const t = tracking.toString().trim().toUpperCase();
  if (t.startsWith('HAL') || t.startsWith('HA')) return true;
  // HAL 2-4 letter provincial prefixes followed by digits e.g. VTE96319719324, LNA12345, SAV99999
  if (/^[A-Z]{2,4}\d{7,}$/.test(t)) return true;
  return false;
}

function parseUniversalLogisticsFile(filePathOrBufferOrText, defaultCarrier = null) {
  let workbook;
  if (typeof filePathOrBufferOrText === 'string') {
    if (fs.existsSync(filePathOrBufferOrText)) {
      workbook = xlsx.readFile(filePathOrBufferOrText);
    } else {
      workbook = xlsx.read(filePathOrBufferOrText, { type: 'string' });
    }
  } else {
    workbook = xlsx.read(filePathOrBufferOrText, { type: 'buffer' });
  }

  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  const rawRows = xlsx.utils.sheet_to_json(worksheet, { defval: '' });

  const parsedItems = [];

  // Detect file-level carrier hint from sheet name or text
  let fileCarrierHint = defaultCarrier;
  const sheetNameLower = (firstSheetName || '').toLowerCase();
  if (sheetNameLower.includes('hal') || sheetNameLower.includes('ຮຸ່ງອາລຸນ') || sheetNameLower.includes('houngahloun')) {
    fileCarrierHint = 'HAL Express';
  } else if (sheetNameLower.includes('anousith') || sheetNameLower.includes('ອະນຸສິດ')) {
    fileCarrierHint = 'Anousith Express';
  }

  for (const row of rawRows) {
    let tracking = '';
    let phone = '';
    let name = 'ລູກຄ້າ';
    let codExpected = '';
    let codCollected = '';
    let originBranch = '';
    let destinationBranch = '';
    let dateDeposited = '';
    let rawStatus = '';
    let itemName = '';
    let rowCarrier = fileCarrierHint;

    // Check if row has explicit HAL signature keys
    const rowKeys = Object.keys(row);
    if (rowKeys.includes('ເລກທີບິນ') || rowKeys.includes('ວັນທີສ້າງບິນ') || rowKeys.includes('ຄ່າສິນຄ້າ') || rowKeys.includes('ລາຍລະອຽດບິນ')) {
      rowCarrier = 'HAL Express';
    }

    // First pass: Match exact known headers
    for (const [key, val] of Object.entries(row)) {
      const k = key.toString().trim();
      const kLow = k.toLowerCase();
      const v = val !== undefined && val !== null ? val.toString().trim() : '';
      if (!v) continue;

      if (kLow.includes('hal') || k.includes('ຮຸ່ງອາລຸນ')) {
        rowCarrier = 'HAL Express';
      }

      // Tracking headers (Handle HAL "ເລກທີບິນ" vs Anousith "ເລກບິນ")
      if (k === 'ເລກທີບິນ' || k === 'ເລກບິນ' || k === 'ເລກພັດສະດຸ' || kLow === 'waybill' || kLow === 'tracking' || kLow === 'tracking_number' || kLow === 'bill_no' || kLow === 'id_list') {
        tracking = v;
      }
      // Recipient phone
      else if (k === 'ເບີຜູ້ຮັບ' || k === 'ເບີໂທຜູ້ຮັບ' || kLow === 'receiver_phone' || kLow === 'recipient_phone') {
        phone = v;
      }
      // Recipient name
      else if (k === 'ຜູ້ຮັບ' || k === 'ຊື່ຜູ້ຮັບ' || kLow === 'receiver_name' || kLow === 'recipient_name' || kLow === 'customer_name') {
        name = v;
      }
      // Item name
      else if (k === 'ປະເພດພັດສະດຸ' || k === 'ຊື່ພັດສະດຸ' || kLow === 'item_name' || kLow === 'item' || kLow === 'product') {
        itemName = v;
      }
      // COD expected (HAL uses "ຄ່າສິນຄ້າ", Anousith uses "COD ຄວນເກັບ")
      else if (k === 'ຄ່າສິນຄ້າ' || k.includes('COD ຄວນເກັບ') || k.includes('ຄວນເກັບ') || k.includes('ຍອດເກັບປາຍທາງ') || kLow === 'cod_amount') {
        codExpected = v.replace(/\n+/g, ' ').trim();
      }
      // COD collected
      else if (k.includes('COD ເກັບໄດ້') || k.includes('ເກັບໄດ້') || kLow.includes('collected')) {
        codCollected = v.replace(/\n+/g, ' ').trim();
      }
      // Origin Branch
      else if (k === 'ສາຂາຕົ້ນທາງ' || k.includes('ຕົ້ນທາງ') || kLow.includes('origin')) {
        originBranch = v;
      }
      // Destination Branch
      else if (k === 'ສາຂາປາຍທາງ' || k.includes('ປາຍທາງ') || k.includes('ຈຸດຮັບ') || kLow.includes('destination') || kLow.includes('branch_dest')) {
        destinationBranch = v;
      }
      // Deposit date (HAL "ວັນທີສ້າງບິນ", Anousith "ວັນທີຝາກ")
      else if (k === 'ວັນທີສ້າງບິນ' || k === 'ວັນທີຝາກ' || k.includes('ວັນທີສ້າງ') || kLow.includes('created') || kLow.includes('date')) {
        dateDeposited = excelDateToDateStr(val);
      }
      // Status
      else if (k === 'ສະຖານະ' || k.includes('ສະຖານະ') || kLow.includes('status') || k.includes('ວັນທີ່ສົ່ງຄືນສຳເລັດ')) {
        rawStatus = v;
      }
    }

    // Second pass: Fuzzy headers if still missing
    if (!tracking || !phone) {
      for (const [key, val] of Object.entries(row)) {
        const k = key.toString().trim().toLowerCase();
        const v = val !== undefined && val !== null ? val.toString().trim() : '';
        if (!v) continue;

        if (k.includes('ຜູ້ຝາກ') || k.includes('sender')) continue;

        if (!tracking && (k.includes('tracking') || k.includes('waybill') || k.includes('bill') || /\b8\d{12}\b/.test(v) || isHalTracking(v))) {
          if (v.length >= 6) tracking = v;
        }

        if (!phone && (k.includes('phone') || k.includes('tel') || k.includes('mobile') || k.includes('ເບີ') || k.includes('contact'))) {
          if (/\d{7,}/.test(v)) phone = v;
        }

        if (name === 'ລູກຄ້າ' && (k.includes('name') || k.includes('customer') || k.includes('receiver') || k.includes('ຜູ້ຮັບ'))) {
          if (!k.includes('phone') && !k.includes('branch') && !k.includes('ເບີ') && v.length > 1) name = v;
        }
      }
    }

    // Final carrier determination
    const finalCarrier = rowCarrier || (isHalTracking(tracking) ? 'HAL Express' : 'Anousith Express');

    const billUrl = finalCarrier === 'HAL Express'
      ? `https://halexpress.la/track?tracking=${encodeURIComponent(tracking)}`
      : `https://app.anousith.express/landing/search_tracking/bill_share?tacking_number=${tracking}`;

    const normalizedStatus = cleanStatus(rawStatus);
    const numExpected = parseCodNumber(codExpected);
    let numCollected = parseCodNumber(codCollected);

    // If parcel is delivered and collected wasn't specified, collected = expected
    if (!numCollected && normalizedStatus.includes('ສຳເລັດ') && numExpected > 0) {
      numCollected = numExpected;
    }

    if (tracking) {
      const whatsappJid = formatLaoPhoneToWhatsAppJid(phone);
      parsedItems.push({
        tracking: tracking,
        carrier: finalCarrier,
        recipientName: name,
        recipientPhone: phone,
        itemName: itemName,
        whatsappJid: whatsappJid,
        codExpected: numExpected ? `${numExpected.toLocaleString()} KIP` : (codExpected || '0 KIP'),
        codCollected: numCollected ? `${numCollected.toLocaleString()} KIP` : (codCollected || '0 KIP'),
        codExpectedNum: numExpected,
        codCollectedNum: numCollected,
        shippingStatus: normalizedStatus,
        rawStatus: rawStatus,
        originBranch: originBranch,
        destinationBranch: destinationBranch,
        dateDeposited: dateDeposited,
        billUrl: billUrl,
        raw: row
      });
    }
  }

  return parsedItems;
}

module.exports = {
  parseUniversalLogisticsFile,
  parseAnousithFile: parseUniversalLogisticsFile,
  cleanStatus,
  parseCodNumber,
  isHalTracking
};

