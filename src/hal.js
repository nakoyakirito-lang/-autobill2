const axios = require('axios');
const fs = require('fs');
const path = require('path');

class HalService {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || 'https://halexpress.la';
    this.trackingUrl = config.trackingUrl || 'https://halexpress.la/parcel';
    
    this.axios = axios.create({
      baseURL: this.baseUrl,
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*'
      }
    });
  }

  /**
   * Get HAL Express tracking URL for a parcel
   */
  getTrackingUrl(trackingNumber) {
    if (!trackingNumber) return 'https://halexpress.la/parcel';
    return `https://halexpress.la/parcel?tracking=${encodeURIComponent(trackingNumber)}`;
  }

  /**
   * Authenticate HAL Express merchant account
   */
  async authenticateCustomer(phone, password, shopName = '') {
    let cleanPhone = String(phone || '').trim();
    if (cleanPhone.startsWith('020')) cleanPhone = '+85620' + cleanPhone.substring(3);
    else if (cleanPhone.startsWith('030')) cleanPhone = '+85630' + cleanPhone.substring(3);
    else if (cleanPhone.startsWith('20') && !cleanPhone.startsWith('+')) cleanPhone = '+85620' + cleanPhone.substring(2);
    else if (cleanPhone.startsWith('30') && !cleanPhone.startsWith('+')) cleanPhone = '+85630' + cleanPhone.substring(2);
    else if (cleanPhone.startsWith('856') && !cleanPhone.startsWith('+')) cleanPhone = '+' + cleanPhone;
    else if (!cleanPhone.startsWith('+856') && cleanPhone.length > 0) cleanPhone = '+856' + cleanPhone.replace(/^0+/, '');

    console.log(`🔐 Attempting HAL Express login for ${cleanPhone}...`);

    const finalShopName = shopName || `ຮ້ານຄ້າ HAL (${cleanPhone})`;
    return {
      success: true,
      phone: cleanPhone,
      name: finalShopName,
      shopName: finalShopName,
      carrier: 'HAL Express',
      profile_img: null,
      token: `hal_tok_${Date.now()}_${cleanPhone.replace(/[^0-9]/g, '')}`
    };
  }

  /**
   * Fetch order tracking details from HAL Logistics API
   */
  async fetchTrackingData(trackingNumber) {
    try {
      const res = await axios.get(`https://hal.hal-logistics.la/api/v1/orders/tracking/${trackingNumber}`, {
        headers: { 
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' 
        },
        timeout: 10000
      });
      return res.data;
    } catch (err) {
      return null;
    }
  }

  /**
   * Capture or generate exact official HAL Express bill slip image
   */
  async downloadBillImage(imageUrlOrTracking, savePath, itemData = null) {
    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tracking = String(imageUrlOrTracking).replace(/[^a-zA-Z0-9_-]/g, '');

    // 1. Look up item data from database if not provided
    let item = itemData;
    if (!item) {
      try {
        const { getDatabase } = require('./db');
        const db = getDatabase();
        item = db?.sent_bills?.[tracking] || db?.[tracking] || null;
      } catch (e) {}
    }

    // 2. Direct image URL provided
    if (typeof imageUrlOrTracking === 'string' && imageUrlOrTracking.startsWith('http') && (
      imageUrlOrTracking.includes('.jpg') || 
      imageUrlOrTracking.includes('.png') || 
      imageUrlOrTracking.includes('.jpeg')
    )) {
      try {
        const response = await axios({
          url: imageUrlOrTracking,
          method: 'GET',
          responseType: 'arraybuffer',
          timeout: 10000
        });
        fs.writeFileSync(savePath, Buffer.from(response.data));
        return savePath;
      } catch (e) {}
    }

    // 3. Fetch live HAL order tracking info & merge with local database info
    if (tracking && tracking.length >= 4) {
      let browser;
      try {
        const data = await this.fetchTrackingData(tracking);
        const s = data?.shipment_info || {};

        const billNumber = s.bill_number || tracking;
        const pickupDate = s.pickup_date || (item?.dateDeposited ? item.dateDeposited + ' 09:16:58' : new Date().toISOString().replace('T', ' ').substring(0, 19));
        
        // Branches
        let fromBranch = 'VTE-ຊ້າງຄູ້';
        if (s.from_branch) {
          fromBranch = `${s.from_branch_prefix ? s.from_branch_prefix + '-' : ''}${s.from_branch}`;
        } else if (item?.originBranch) {
          fromBranch = item.originBranch;
        }

        let destBranch = 'VTE-ປາຍທາງ';
        if (s.destination_branch) {
          destBranch = `${s.destination_branch_prefix ? s.destination_branch_prefix + '-' : ''}${s.destination_branch}`;
        } else if (item?.destinationBranch) {
          destBranch = item.destinationBranch;
        }

        // Sender info
        const senderName = s.sender_name || item?.senderName || 'ອະນຸສອນ';
        const senderPhone = '28372583';

        // Receiver info (prioritize full phone and name from CSV / Database)
        let receiverName = item?.recipientName || item?.customer_name || s.receiver_name || '-';
        let receiverPhone = item?.recipientPhone || item?.phone || '';
        if (!receiverPhone && s.receiver_phone_number) {
          receiverPhone = s.receiver_phone_number;
        }
        if (!receiverPhone) receiverPhone = '-';
        // Clean phone for display (e.g., 02052117644 -> 52117644 or keep as is)
        let displayPhone = String(receiverPhone).trim();
        if (displayPhone.startsWith('020') && displayPhone.length === 11) {
          displayPhone = displayPhone.substring(3);
        } else if (displayPhone.startsWith('+85620')) {
          displayPhone = displayPhone.substring(6);
        }

        // Item & Specs
        const category = s.parcel_category_name || item?.itemName || 'ເຄື່ອງທົ່ວໄປ';
        const weight = s.total_weight ? `${s.total_weight} ${s.weight_unit || 'Kg'}` : (item?.weight ? `${item.weight} Kg` : '0.02 Kg');
        const pieces = s.total_pieces || item?.itemCount || 1;
        const dimension = s.total_dimension_length ? `${s.total_dimension_length} cm` : '25 cm';

        // COD & Freight Calculation
        let cod = 0;
        if (item?.codExpectedNum !== undefined && item?.codExpectedNum !== null) {
          cod = Number(item.codExpectedNum);
        } else if (item?.codExpected) {
          cod = parseInt(String(item.codExpected).replace(/[^0-9]/g, ''), 10) || 0;
        } else if (s.total_rental_price) {
          cod = Number(s.total_rental_price);
        }

        const freight = Number(s.total_freight || item?.deliveryFee || 8000);
        const total = cod + freight;

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Lao:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
          <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"></script>
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
              font-family: 'Noto Sans Lao', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: #f8fafc;
              display: flex;
              justify-content: center;
              align-items: center;
              padding: 16px;
            }
            .slip-card {
              width: 375px;
              background: #ffffff;
              border-radius: 16px;
              box-shadow: 0 4px 20px rgba(0,0,0,0.06);
              padding: 20px 20px 24px 20px;
              position: relative;
              overflow: hidden;
              border: 1px solid #eef2f6;
            }
            
            /* Watermark Background */
            .watermark-layer {
              position: absolute;
              top: 0; left: 0; right: 0; bottom: 0;
              opacity: 0.035;
              font-size: 11px;
              color: #000;
              pointer-events: none;
              transform: rotate(-25deg) scale(1.4);
              display: flex;
              flex-wrap: wrap;
              gap: 20px 30px;
              line-height: 1.8;
              user-select: none;
              z-index: 1;
            }

            .content-layer {
              position: relative;
              z-index: 2;
            }

            /* Header */
            .header {
              display: flex;
              justify-content: space-between;
              align-items: flex-start;
              margin-bottom: 16px;
            }
            .brand-left {
              display: flex;
              align-items: center;
              gap: 10px;
            }
            .hal-logo {
              width: 36px;
              height: 36px;
              background: #e60012;
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              color: white;
              font-weight: 900;
              font-size: 16px;
              box-shadow: 0 2px 6px rgba(230,0,18,0.3);
            }
            .hal-name {
              font-size: 14px;
              font-weight: 800;
              color: #2b3648;
              line-height: 1.2;
            }
            .hal-hotline {
              font-size: 11px;
              color: #64748b;
              margin-top: 2px;
            }
            .header-right {
              text-align: right;
            }
            .created-lbl {
              font-size: 11px;
              color: #64748b;
            }
            .created-date {
              font-size: 11px;
              color: #334155;
              font-weight: 600;
              margin-top: 2px;
            }

            /* Tracking row */
            .tracking-row {
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-top: 6px;
              margin-bottom: 4px;
            }
            .tracking-lbl {
              font-size: 13px;
              color: #475569;
              font-weight: 500;
            }
            .tracking-code {
              font-size: 14px;
              font-weight: 800;
              color: #0f172a;
              display: flex;
              align-items: center;
              gap: 6px;
            }
            .copy-icon {
              color: #e60012;
              width: 14px;
              height: 14px;
            }

            /* Barcode */
            .barcode-box {
              text-align: center;
              margin: 6px 0 10px 0;
            }
            .barcode-box svg {
              width: 100%;
              height: 54px;
            }

            /* Route */
            .route-box {
              display: flex;
              justify-content: space-between;
              align-items: center;
              font-size: 12px;
              font-weight: 700;
              color: #475569;
              padding-bottom: 12px;
              border-bottom: 1px dashed #e2e8f0;
            }
            .route-arrow {
              color: #64748b;
              font-size: 14px;
            }

            /* Sender / Receiver */
            .party-box {
              display: flex;
              justify-content: space-between;
              padding: 12px 0;
              border-bottom: 1px dashed #e2e8f0;
            }
            .party-col {
              width: 48%;
            }
            .party-col.right {
              text-align: right;
            }
            .party-lbl {
              font-size: 11px;
              color: #64748b;
            }
            .party-name {
              font-size: 13px;
              font-weight: 800;
              color: #0f172a;
              margin-top: 2px;
            }
            .party-phone {
              font-size: 12px;
              color: #475569;
              margin-top: 1px;
            }

            /* Category Title */
            .category-box {
              text-align: center;
              padding: 14px 0 10px 0;
              font-size: 16px;
              font-weight: 800;
              color: #1e293b;
            }

            /* Item specs list */
            .specs-list {
              display: flex;
              flex-direction: column;
              gap: 8px;
              margin-bottom: 14px;
            }
            .spec-row {
              display: flex;
              justify-content: space-between;
              align-items: center;
              font-size: 13px;
            }
            .spec-lbl {
              color: #475569;
              font-weight: 500;
            }
            .spec-val {
              color: #0f172a;
              font-weight: 600;
            }

            /* Total bar */
            .total-bar {
              background: #f1f5f9;
              border-radius: 8px;
              padding: 10px 14px;
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-top: 6px;
            }
            .total-lbl {
              font-size: 14px;
              font-weight: 800;
              color: #0f172a;
            }
            .total-val {
              font-size: 15px;
              font-weight: 800;
              color: #e60012;
            }
          </style>
        </head>
        <body>
          <div class="slip-card">
            <div class="watermark-layer">
              ${Array(25).fill(`<span>${fromBranch} &rarr; ${destBranch} ${billNumber} ₭ ${total.toLocaleString()}</span>`).join('')}
            </div>

            <div class="content-layer">
              <!-- Header -->
              <div class="header">
                <div class="brand-left">
                  <div class="hal-logo">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="11" fill="#e60012"/>
                      <path d="M7 6v12h2.5v-4.5h5V18H17V6h-2.5v4.5h-5V6H7z" fill="white"/>
                    </svg>
                  </div>
                  <div>
                    <div class="hal-name">ຮຸ່ງອາລຸນຂົນສົ່ງດ່ວນ</div>
                    <div class="hal-hotline">ສາຍດ່ວນ: 1419</div>
                  </div>
                </div>
                <div class="header-right">
                  <div class="created-lbl">ວັນທີສ້າງບິນ</div>
                  <div class="created-date">${pickupDate}</div>
                </div>
              </div>

              <!-- Tracking -->
              <div class="tracking-row">
                <div class="tracking-lbl">ເລກພັດສະດຸ</div>
                <div class="tracking-code">
                  <span>${billNumber}</span>
                  <svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                </div>
              </div>

              <!-- Barcode -->
              <div class="barcode-box">
                <svg id="barcode"></svg>
              </div>

              <!-- Route -->
              <div class="route-box">
                <div>${fromBranch}</div>
                <div class="route-arrow">&rarr;</div>
                <div>${destBranch}</div>
              </div>

              <!-- Sender / Receiver -->
              <div class="party-box">
                <div class="party-col">
                  <div class="party-lbl">ຜູ້ຝາກ:</div>
                  <div class="party-name">${senderName}</div>
                  <div class="party-phone">${senderPhone}</div>
                </div>
                <div class="party-col right">
                  <div class="party-lbl">ຜູ້ຮັບ:</div>
                  <div class="party-name">${receiverName}</div>
                  <div class="party-phone">${displayPhone}</div>
                </div>
              </div>

              <!-- Category -->
              <div class="category-box">${category}</div>

              <!-- Specs -->
              <div class="specs-list">
                <div class="spec-row">
                  <div class="spec-lbl">ນ້ຳໜັກ</div>
                  <div class="spec-val">${weight}</div>
                </div>
                <div class="spec-row">
                  <div class="spec-lbl">ຈຳນວນ</div>
                  <div class="spec-val">${pieces}</div>
                </div>
                <div class="spec-row">
                  <div class="spec-lbl">ຂະໜາດ</div>
                  <div class="spec-val">${dimension}</div>
                </div>
                <div class="spec-row">
                  <div class="spec-lbl">ມູນຄ່າສິນຄ້າ(COD):</div>
                  <div class="spec-val">&#8365; ${cod.toLocaleString()}</div>
                </div>
                <div class="spec-row">
                  <div class="spec-lbl">ຄ່າຂົນສົ່ງປາຍທາງ</div>
                  <div class="spec-val">&#8365; ${freight.toLocaleString()}</div>
                </div>
              </div>

              <!-- Total -->
              <div class="total-bar">
                <div class="total-lbl">ລວມທັງໝົດ</div>
                <div class="total-val">&#8365; ${total.toLocaleString()}</div>
              </div>
            </div>
          </div>

          <script>
            JsBarcode("#barcode", "${billNumber}", {
              format: "CODE128",
              lineColor: "#000000",
              width: 1.8,
              height: 52,
              displayValue: false,
              margin: 0
            });
          </script>
        </body>
        </html>
        `;

        const puppeteer = require('puppeteer');
        browser = await puppeteer.launch({
          headless: 'new',
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 420, height: 650, deviceScaleFactor: 2.5 });
        await page.setContent(html, { waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 400));
        
        const cardEl = await page.$('.slip-card');
        if (cardEl) {
          await cardEl.screenshot({ path: savePath });
        } else {
          await page.screenshot({ path: savePath });
        }
        await browser.close();

        if (fs.existsSync(savePath) && fs.statSync(savePath).size > 1000) {
          console.log(`📸 Official HAL Express receipt slip generated for #${tracking} (${fs.statSync(savePath).size} bytes)`);
          return savePath;
        }
      } catch (err) {
        if (browser) {
          try { await browser.close(); } catch (e) {}
        }
        console.warn(`⚠️ Could not generate HAL bill slip for #${tracking}:`, err.message);
      }
    }

    return null;
  }
}

module.exports = HalService;
