require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { isBillSent, markBillSent } = require('./db');

const TEMP_BILLS_DIR = path.join(__dirname, '..', 'temp_bills');
if (!fs.existsSync(TEMP_BILLS_DIR)) {
  fs.mkdirSync(TEMP_BILLS_DIR, { recursive: true });
}

class AnousithScraper {
  constructor() {
    let rawPhone = process.env.ANOUSITH_USERNAME || '02028372583';
    // Format to 8 digits if prefixed with 020 / 85620 / +85620
    this.phone = rawPhone.replace(/^(\+?85620|020|20)/, '');
    if (this.phone.length < 8) this.phone = '28372583';
    this.password = process.env.ANOUSITH_PASSWORD || 'Jo112233';
    this.baseUrl = 'https://app.anousith.express';
  }

  async syncAllBills() {
    console.log(`\n🤖 Starting Anousith Web Sync for account: ${this.phone}...`);

    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const collectedBills = [];

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
                text.includes('itemsFinalCustomers'))
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
                  if (tracking && (typeof tracking === 'string' || typeof tracking === 'number')) {
                    const trStr = tracking.toString();
                    if (trStr.length >= 7 && !collectedBills.some((b) => b.tracking === trStr)) {
                      collectedBills.push({
                        tracking: trStr,
                        phone: phone || '',
                        name: name || 'ລູກຄ້າ',
                        raw: obj
                      });
                    }
                  }
                  Object.values(obj).forEach(scanObj);
                };
                scanObj(json.data);
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

      // Visit sections
      const clickTargets = ['ບິນຝາກພັດສະດຸ', 'ຈັດການພັດສະດຸ', 'ການເຄື່ອນໄຫວ', 'ສະຫຼຸບ COD'];
      for (const target of clickTargets) {
        try {
          console.log(`📑 Loading section: ${target}...`);
          await page.evaluate((t) => {
            const els = Array.from(document.querySelectorAll('button, a, div, span, p'));
            const match = els.find((el) => el.innerText && el.innerText.trim().includes(t));
            if (match) match.click();
          }, target);
          await new Promise((r) => setTimeout(r, 3500));
          await page.evaluate(() => window.scrollBy(0, 1000));
          await new Promise((r) => setTimeout(r, 2000));
        } catch (e) {}
      }

      // Check DOM trackings
      const domTrackings = await page.evaluate(() => {
        const text = document.body.innerText;
        const matches = text.match(/\b87\d{11}\b|\b[0-9]{13}\b/g) || [];
        return [...new Set(matches)];
      });

      domTrackings.forEach((tr) => {
        if (!collectedBills.some((b) => b.tracking === tr)) {
          collectedBills.push({
            tracking: tr,
            phone: '',
            name: 'ລູກຄ້າ',
            fromDom: true
          });
        }
      });

      console.log(`\n🎉 Extracted ${collectedBills.length} total bills from Savage Shop!`);

      // Save to database
      for (const bill of collectedBills) {
        const tracking = bill.tracking;
        const billUrl = `https://app.anousith.express/landing/search_tracking/bill_share?tacking_number=${tracking}`;
        markBillSent(tracking, {
          recipientPhone: bill.phone || '-',
          recipientName: bill.name || 'ລູກຄ້າ',
          sentVia: 'Anousith Savage Shop Sync',
          billUrl: billUrl
        });
      }

      await browser.close();
      return collectedBills;
    } catch (err) {
      console.error('❌ Error in syncAllBills:', err.message);
      await browser.close().catch(() => {});
      throw err;
    }
  }
}

module.exports = AnousithScraper;
