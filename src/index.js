require('dotenv').config();
const path = require('path');
const fs = require('fs');
const WhatsAppBot = require('./whatsapp');
const AnousithService = require('./anousith');
const { formatLaoPhoneToWhatsAppJid } = require('./formatter');
const { isBillSent, markBillSent } = require('./db');

// Configuration
const POLL_INTERVAL = (parseInt(process.env.POLL_INTERVAL_SECONDS, 10) || 60) * 1000;
const TEMP_BILLS_DIR = path.join(__dirname, '..', 'temp_bills');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_BILLS_DIR)) {
  fs.mkdirSync(TEMP_BILLS_DIR, { recursive: true });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('====================================================');
  console.log('📦 Anousith Express - WhatsApp Auto Bill Bot 📦');
  console.log('====================================================');

  const anousith = new AnousithService();
  const bot = new WhatsAppBot();

  // 1. Start WhatsApp
  await bot.start();

  // 2. Wait until WhatsApp connects
  console.log('⏳ Waiting for WhatsApp connection...');
  while (!bot.isConnected) {
    await sleep(2000);
  }

  // 3. Login to Anousith
  if (process.env.ANOUSITH_USERNAME && process.env.ANOUSITH_PASSWORD) {
    await anousith.login();
  } else {
    console.log('ℹ️ Tip: Set ANOUSITH_USERNAME and ANOUSITH_PASSWORD in .env for auto-sync.');
  }

  // 4. Message listening for interactive commands (Optional command helper)
  if (bot.sock) {
    bot.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const from = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

        // Example command: /bill <tracking> <phone>
        if (text.startsWith('/bill') || text.startsWith('#bill')) {
          const parts = text.split(' ');
          const tracking = parts[1];
          const targetPhone = parts[2] || from;

          if (!tracking) {
            await bot.sendMessage(from, '⚠️ ກະລຸນາລະບຸເລກບິນ ເຊັ່ນ: /bill 8707221950159 02099999999');
            continue;
          }

          const jid = formatLaoPhoneToWhatsAppJid(targetPhone);
          if (!jid) {
            await bot.sendMessage(from, '❌ ເບີໂທລະສັບບໍ່ຖືກຕ້ອງ');
            continue;
          }

          await bot.sendMessage(from, `⏳ ກຳລັງດາວໂຫຼດ ແລະ ສົ່ງໃບບິນເລກທີ່ ${tracking}...`);
          
          const billShareUrl = anousith.getBillShareUrl(tracking);
          const caption = `📦 ສະບາຍດີເຈົ້າ!\nນີ້ແມ່ນໃບບິນພັດສະດຸຂອງທ່ານ:\n🔖 ເລກບິນ: ${tracking}\n🚚 ຈັດສົ່ງໂດຍ: Anousith Express\n🔗 ລິ້ງກວດສອບສະຖານະ: ${billShareUrl}\n\nຂອບໃຈທີ່ໃຊ້ບໍລິການ! 🙏`;

          // Send message / bill
          try {
            await bot.sendMessage(jid, caption);
            await bot.sendMessage(from, `✅ ສົ່ງໃບບິນໄປທີ່ ${targetPhone} ສຳເລັດແລ້ວ!`);
          } catch (err) {
            await bot.sendMessage(from, `❌ ເກີດຂໍ້ຜິດພາດໃນການສົ່ງ: ${err.message}`);
          }
        }
      }
    });
  }

  // 5. Background Poller for new Anousith bills
  console.log(`\n🔄 Auto Poller started (checks every ${POLL_INTERVAL / 1000}s)...`);

  async function checkAndSendNewBills() {
    try {
      const orders = await anousith.getRecentOrders();
      if (!orders || orders.length === 0) {
        return;
      }

      for (const order of orders) {
        const trackingNumber = order.tracking_number || order.bill_no || order.id;
        const recipientPhone = order.recipient_phone || order.receiver_phone || order.phone;
        const recipientName = order.recipient_name || order.receiver_name || 'ລູກຄ້າ';

        if (!trackingNumber || !recipientPhone) continue;

        // Skip if already sent
        if (isBillSent(trackingNumber)) {
          continue;
        }

        const jid = formatLaoPhoneToWhatsAppJid(recipientPhone);
        if (!jid) {
          console.log(`⚠️ Invalid phone number format for tracking ${trackingNumber}: ${recipientPhone}`);
          continue;
        }

        console.log(`📨 Found new order #${trackingNumber} for ${recipientName} (${recipientPhone})`);

        const billUrl = anousith.getBillShareUrl(trackingNumber);
        const caption = `📦 ສະບາຍດີ ທ່ານ ${recipientName}!\nເຄື່ອງຂອງທ່ານໄດ້ຖືກຈັດສົ່ງຜ່ານ Anousith Express ແລ້ວເຈົ້າ.\n\n🔖 ເລກບິນ / Tracking: *${trackingNumber}*\n🔗 ກວດສອບສະຖານະພັດສະດຸ: ${billUrl}\n\nຂອບໃຈທີ່ໄວ້ວາງໃຈໃຊ້ບໍລິການ 🙏`;

        // Check if order has direct bill image
        const imgPath = path.join(TEMP_BILLS_DIR, `${trackingNumber}.jpg`);
        const downloadedImg = await anousith.downloadBillImage(order.bill_image_url || trackingNumber, imgPath);

        if (downloadedImg && fs.existsSync(downloadedImg)) {
          await bot.sendBillImage(jid, downloadedImg, caption);
        } else {
          // Fallback to text with link if image download is not available
          await bot.sendMessage(jid, caption);
        }

        // Mark as sent
        markBillSent(trackingNumber, {
          recipientPhone,
          recipientName,
          sentVia: 'WhatsApp'
        });

        console.log(`✅ Successfully sent bill #${trackingNumber} to ${recipientPhone}`);

        // Safe delay to prevent spam rate limiting
        await sleep(3500);
      }
    } catch (err) {
      console.error('Error in checkAndSendNewBills loop:', err.message);
    }
  }

  // Run poll loop
  setInterval(checkAndSendNewBills, POLL_INTERVAL);
  // Run first check immediately
  checkAndSendNewBills();
}

main().catch((err) => {
  console.error('Fatal Error:', err);
});
