require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { getDatabase, saveDatabase, upsertBill, getActiveAccount } = require('./db');

function normalizeAnousithStatus(rawStatus) {
  if (!rawStatus) return 'ກຳລັງຂົນສົ່ງ';
  const s = String(rawStatus).toLowerCase();

  if (s.includes('ຮັບເຄື່ອງ') || s.includes('ສຳເລັດ') || s.includes('delivered') || s.includes('success') || s.includes('finish') || s.includes('close') || s.includes('ສະຫຼຸບ')) {
    return 'ສະຫຼຸບແລ້ວ (ພ້ອມໂອນ)';
  }
  if (s.includes('ຕີກັບ') || s.includes('return') || s.includes('reject') || s.includes('cancel')) {
    return 'ຕີກັບ';
  }
  if (s.includes('ຮອດປາຍທາງ') || s.includes('destination') || s.includes('arrived') || s.includes('reach') || s.includes('wait')) {
    return 'ຮອດປາຍທາງ';
  }
  if (s.includes('ກຳລັງ') || s.includes('transit') || s.includes('shipping') || s.includes('process') || s.includes('send')) {
    return 'ກຳລັງຂົນສົ່ງ';
  }
  return rawStatus;
}

class AnousithScraper {
  constructor() {
    const activeAcc = getActiveAccount ? getActiveAccount() : null;
    let rawPhone = activeAcc?.phone || process.env.ANOUSITH_USERNAME || '02028372583';
    this.phone = rawPhone.replace(/^(\+?85620|020|20)/, '');
    if (this.phone.length < 8) this.phone = '28372583';
    this.password = process.env.ANOUSITH_PASSWORD || 'Jo112233';
    this.baseUrl = 'https://app.anousith.express';
  }

  async syncAllBills() {
    console.log(`\n🤖 Starting Anousith Live Status Sync for account: ${this.phone}...`);

    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const collectedBills = new Map();

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      // Listen to all network responses
      page.on('response', async (response) => {
        try {
          const resType = response.request().resourceType();
          if (resType === 'fetch' || resType === 'xhr') {
            const text = await response.text();
            if (
              text.includes('data') &&
              (text.includes('tracking') ||
                text.includes('receiver') ||
                text.includes('id_list') ||
                text.includes('bill_no') ||
                text.includes('itemSameDays') ||
                text.includes('itemsV2') ||
                text.includes('itemsFinalCustomers') ||
                text.includes('status'))
            ) {
              try {
                const json = JSON.parse(text);
                const scanObj = (obj) => {
                  if (!obj || typeof obj !== 'object') return;
                  if (Array.isArray(obj)) {
                    obj.forEach(scanObj);
                    return;
                  }
                  const tracking = obj.tracking_number || obj.trackingId || obj.bill_no || obj.id_list;
                  const phone = obj.receiver_phone || obj.recipient_phone || obj.phone || obj.contact_info;
                  const name = obj.receiver_name || obj.recipient_name || obj.customer_name;
                  const rawSt = obj.status_name || obj.status || obj.shipping_status || obj.item_status || obj.status_description || obj.delivery_status;
                  const cod = obj.cod_amount || obj.cod || obj.cod_expected || obj.price || obj.total_price;
                  const branch = obj.destination_branch_name || obj.branch_name || obj.to_branch || obj.destination;
                  const dateDep = obj.created_at || obj.deposit_date || obj.date;

                  if (tracking && (typeof tracking === 'string' || typeof tracking === 'number')) {
                    const trStr = tracking.toString().trim();
                    if (trStr.length >= 7) {
                      const normalizedSt = rawSt ? normalizeAnousithStatus(rawSt) : null;
                      const existing = collectedBills.get(trStr) || {};
                      collectedBills.set(trStr, {
                        tracking: trStr,
                        phone: phone || existing.phone || '',
                        name: name || existing.name || 'ລູກຄ້າ',
                        status: normalizedSt || existing.status || 'ກຳລັງຂົນສົ່ງ',
                        rawStatus: rawSt || existing.rawStatus || '',
                        cod: cod || existing.cod || 0,
                        branch: branch || existing.branch || '-',
                        date: dateDep || existing.date || ''
                      });
                    }
                  }
                  Object.values(obj).forEach(scanObj);
                };
                scanObj(json.data || json);
              } catch (e) {}
            }
          }
        } catch (e) {}
      });

      console.log('🌐 Opening login page...');
      await page.goto(`${this.baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      await new Promise((r) => setTimeout(r, 2000));

      const userInput = await page.$('input[name="username"]');
      const passInput = await page.$('input[name="password"]');

      if (userInput && passInput) {
        console.log(`✍️ Entering credentials (${this.phone})...`);
        await userInput.click({ clickCount: 3 });
        await userInput.type(this.phone, { delay: 30 });
        await passInput.click({ clickCount: 3 });
        await passInput.type(this.password, { delay: 30 });

        const btn = await page.$('button.button-login');
        if (btn) await btn.click();
        else await page.keyboard.press('Enter');

        await new Promise((r) => setTimeout(r, 4000));
        console.log('✅ Logged in successfully! Dashboard URL:', page.url());
      }

      // Directly visit management pages
      const pagesToVisit = [
        `${this.baseUrl}/nextday/manage-parcels`,
        `${this.baseUrl}/nextday/bills`,
        `${this.baseUrl}/nextday/cod`,
        `${this.baseUrl}/nextday/home`
      ];

      for (const targetUrl of pagesToVisit) {
        try {
          console.log(`📑 Loading page: ${targetUrl}...`);
          await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
          await new Promise((r) => setTimeout(r, 3000));
          await page.evaluate(() => window.scrollBy(0, 1500));
          await new Promise((r) => setTimeout(r, 2000));
        } catch (e) {}
      }

      console.log(`\n🎉 Live Sync extracted ${collectedBills.size} parcels from Anousith!`);

      const db = getDatabase();
      db.sent_bills = db.sent_bills || {};

      let updatedCount = 0;
      let newCount = 0;

      for (const [tracking, bill] of collectedBills.entries()) {
        const exists = Boolean(db.sent_bills[tracking]);
        if (!exists) newCount++;
        else updatedCount++;

        const billUrl = `https://app.anousith.express/landing/search_tracking/bill_share?tacking_number=${tracking}`;
        
        upsertBill(tracking, {
          recipientPhone: bill.phone || db.sent_bills[tracking]?.recipientPhone || '-',
          recipientName: bill.name || db.sent_bills[tracking]?.recipientName || 'ລູກຄ້າ',
          shippingStatus: bill.status || db.sent_bills[tracking]?.shippingStatus || 'ກຳລັງຂົນສົ່ງ',
          rawStatus: bill.rawStatus || db.sent_bills[tracking]?.rawStatus || '',
          destinationBranch: bill.branch || db.sent_bills[tracking]?.destinationBranch || '-',
          carrier: 'Anousith Express',
          sentVia: exists ? 'Live Status Sync Update' : 'Live Status Sync',
          billUrl: billUrl
        });
      }

      await browser.close();
      return Array.from(collectedBills.values());
    } catch (err) {
      console.error('❌ Error in syncAllBills:', err.message);
      await browser.close().catch(() => {});
      throw err;
    }
  }
}

module.exports = AnousithScraper;
