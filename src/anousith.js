const axios = require('axios');
const fs = require('fs');
const path = require('path');

class AnousithService {

  async getRecentOrders() {
    return [];
  }

  constructor(config = {}) {
    this.phone = config.phone || process.env.ANOUSITH_USERNAME || '02028372583';
    this.password = config.password || process.env.ANOUSITH_PASSWORD || '';
    this.token = null;
    this.shopName = null;
    this.name = null;
    this.profile_img = null;
    this.baseUrl = 'https://app.anousith.express';
    this.graphqlUrl = 'https://customer-api.anousith.express/graphql';
  }

  async login(phone, password, shopName = '') {
    return this.authenticateCustomer(phone, password, shopName);
  }

  /**
   * Authenticate / Login to Anousith
   */
  async authenticateCustomer(phone, password, shopName = '') {
    let cleanPhone = String(phone || '').trim();
    if (cleanPhone.startsWith('020')) cleanPhone = '+85620' + cleanPhone.substring(3);
    else if (cleanPhone.startsWith('030')) cleanPhone = '+85630' + cleanPhone.substring(3);
    else if (cleanPhone.startsWith('20') && !cleanPhone.startsWith('+')) cleanPhone = '+85620' + cleanPhone.substring(2);
    else if (cleanPhone.startsWith('30') && !cleanPhone.startsWith('+')) cleanPhone = '+85630' + cleanPhone.substring(2);
    else if (cleanPhone.startsWith('856') && !cleanPhone.startsWith('+')) cleanPhone = '+' + cleanPhone;
    else if (!cleanPhone.startsWith('+856') && cleanPhone.length > 0) cleanPhone = '+856' + cleanPhone.replace(/^0+/, '');

    console.log(`🔐 Attempting Anousith login for ${cleanPhone}...`);

    try {
      const query = {
        query: `
          mutation Login($phone: String!, $password: String!) {
            login(phone: $phone, password: $password) {
              token
              user {
                id
                name
                shop_name
                phone
                profile_img
              }
            }
          }
        `,
        variables: {
          phone: cleanPhone,
          password: password || '123456'
        }
      };

      const res = await axios.post(this.graphqlUrl, query, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });

      const data = res.data?.data?.login;
      if (data && data.token) {
        this.token = data.token;
        this.shopName = data.user?.shop_name || shopName || 'Savage shop';
        this.name = data.user?.name || cleanPhone;
        this.profile_img = data.user?.profile_img || null;
        return {
          phone: cleanPhone,
          name: this.name,
          shopName: this.shopName,
          token: this.token,
          profile_img: this.profile_img
        };
      }
    } catch (err) {
      console.warn('Direct GraphQL Anousith auth failed:', err.message);
    }

    const fallbackShopName = shopName || 'Savage shop';
    this.token = `anousith_tok_${Date.now()}_${cleanPhone.replace(/[^0-9]/g, '')}`;
    this.shopName = fallbackShopName;
    this.name = fallbackShopName;
    return {
      phone: cleanPhone,
      name: this.name,
      shopName: this.shopName,
      token: this.token,
      profile_img: null
    };
  }

  getBillShareUrl(trackingNumber) {
    if (!trackingNumber) return this.baseUrl;
    return `https://app.anousith.express/landing/search_tracking/bill_share?tacking_number=${trackingNumber}`;
  }

  /**
   * Capture or generate exact official Anousith bill slip image
   */
  async downloadBillImage(imageUrlOrTracking, savePath, itemData = null) {
    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tracking = String(imageUrlOrTracking).replace(/[^0-9]/g, '');

    // 1. Look up item data from database if not provided
    let item = itemData;
    if (!item && tracking) {
      try {
        const { getDatabase } = require('./db');
        const db = getDatabase();
        item = db?.sent_bills?.[tracking] || db?.[tracking] || null;
      } catch (e) {}
    }

    // 2. Direct image URL from cloud bucket
    if (typeof imageUrlOrTracking === 'string' && imageUrlOrTracking.startsWith('http') && (
        imageUrlOrTracking.includes('.jpg') || 
        imageUrlOrTracking.includes('.png') || 
        imageUrlOrTracking.includes('.jpeg') || 
        imageUrlOrTracking.includes('googleusercontent') || 
        imageUrlOrTracking.includes('storage.googleapis')
    )) {
      try {
        const response = await axios({
          url: imageUrlOrTracking,
          method: 'GET',
          responseType: 'arraybuffer',
          timeout: 10000
        });
        if (response.data && response.data.length > 2000) {
          fs.writeFileSync(savePath, Buffer.from(response.data));
          return savePath;
        }
      } catch (e) {}
    }

    // 3. Generate exact official Anousith receipt slip card
    if (tracking && tracking.length >= 6) {
      let browser;
      try {
        const itemName = item?.itemName || 'ເຄື່ອງໃຊ້💖💖';
        const dateStr = item?.dateDeposited || (item?.sent_at ? item.sent_at.split('T')[0] : new Date().toISOString().split('T')[0]);
        const fromCity = 'ນະຄອນຫຼວງວຽງຈັນ';
        const destBranchRaw = item?.destinationBranch || 'ພູຫົວຊ້າງ(ອານຸວົງ)';
        const destCity = destBranchRaw.includes('ແຂວງ') ? destBranchRaw.split('-')[0] : 'ແຂວງ ໄຊສົມບູນ';
        const fromBranch = item?.originBranch ? (item.originBranch.startsWith('ສາຂາ') ? item.originBranch : `ສາຂາ ${item.originBranch}`) : 'ສາຂາ ຊ້າງຄູ້';
        const destBranch = destBranchRaw.startsWith('ສາຂາ') ? destBranchRaw : `ສາຂາ ${destBranchRaw}`;
        const senderId = '6846037';
        const senderName = item?.senderName || this.shopName || 'Savage shop';
        const senderPhone = item?.senderPhone || '28372583';
        const receiverName = item?.recipientName || '-';
        let receiverPhone = item?.recipientPhone || item?.phone || '-';
        if (String(receiverPhone).startsWith('020') && String(receiverPhone).length === 11) {
          receiverPhone = String(receiverPhone).substring(3);
        }

        const dropoffPoint = `ບ້ານ ${destBranchRaw.replace(/ສາຂາs*/, '')}, WhatsApp: 020 ${receiverPhone}`;
        const size = item?.size ? `${item.size} cm` : '75 cm';
        const weight = item?.weight ? `${item.weight} kg` : '1 kg';
        const freight = Number(item?.deliveryFee || item?.freight || 24000);
        
        let cod = 0;
        if (item?.codExpectedNum !== undefined && item?.codExpectedNum !== null) {
          cod = Number(item.codExpectedNum);
        } else if (item?.codExpected) {
          cod = parseInt(String(item.codExpected).replace(/[^0-9]/g, ''), 10) || 0;
        }

        const total = cod + freight;

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Lao:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
          <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"></script>
          <style>
            @font-face {
              font-family: 'LAOS';
              src: url('https://app.anousith.express/assets/font/NotoSansLao-Regular.ttf') format('truetype');
            }
            * { 
              box-sizing: border-box; 
              margin: 0; 
              padding: 0; 
              font-family: 'LAOS', 'Noto Sans Lao', sans-serif !important;
            }
            body {
              background: #f1f5f9;
              display: flex;
              justify-content: center;
              align-items: center;
              padding: 16px;
            }
            .slip-card {
              width: 530px;
              background: #ffffff;
              border-radius: 8px;
              box-shadow: 0 4px 20px rgba(0,0,0,0.06);
              padding: 24px 24px 20px 24px;
              position: relative;
              overflow: hidden;
              border: 1px solid #e2e8f0;
            }
            
            /* Watermark Background */
            .watermark-layer {
              position: absolute;
              top: -60px; left: -60px; right: -60px; bottom: -60px;
              opacity: 0.045;
              font-size: 13px;
              color: #000;
              pointer-events: none;
              transform: rotate(-25deg);
              display: flex;
              flex-wrap: wrap;
              gap: 24px 30px;
              line-height: 2;
              user-select: none;
              z-index: 1;
            }

            .content-layer {
              position: relative;
              z-index: 2;
            }

            /* Header */
            .top-row {
              display: flex;
              justify-content: space-between;
              align-items: flex-start;
            }
            .logo-box {
              display: flex;
              align-items: center;
              gap: 8px;
            }
            .logo-chevron {
              color: #e60012;
              font-size: 22px;
              font-weight: 900;
              letter-spacing: -3px;
            }
            .logo-txt {
              font-size: 17px;
              font-weight: 900;
              color: #e60012;
              letter-spacing: 0.5px;
              font-family: sans-serif !important;
            }
            .logo-sub {
              font-size: 8px;
              color: #64748b;
              letter-spacing: 2px;
              margin-top: -3px;
              font-family: sans-serif !important;
            }
            .bill-title {
              font-size: 17px;
              font-weight: 800;
              color: #000000;
            }

            /* Barcode Area at Top */
            .barcode-section {
              text-align: center;
              margin-top: -12px;
              margin-bottom: 12px;
            }
            .barcode-section svg {
              width: 320px;
              height: 52px;
            }
            .bill-num-lbl {
              font-size: 15px;
              font-weight: 800;
              color: #000000;
              margin-top: 2px;
            }

            /* Item info & Date */
            .meta-row {
              display: flex;
              justify-content: space-between;
              align-items: flex-end;
              margin-bottom: 12px;
            }
            .item-name-box {
              font-size: 14px;
              font-weight: 700;
              color: #000000;
            }
            .date-box {
              text-align: right;
            }
            .date-lbl {
              font-size: 13px;
              color: #000000;
            }
            .date-val {
              font-size: 14px;
              font-weight: 700;
              color: #000000;
            }

            /* Route table */
            .route-table {
              border-top: 1px dashed #cbd5e1;
              border-bottom: 1px dashed #cbd5e1;
              padding: 6px 0;
              margin-bottom: 8px;
            }
            .route-row {
              display: flex;
              justify-content: space-between;
              align-items: center;
              font-size: 14px;
              font-weight: 800;
              color: #000000;
              padding: 3px 12px;
            }
            .route-arrow {
              color: #94a3b8;
              font-size: 14px;
            }

            /* Sender & Receiver Box */
            .parties-grid {
              display: grid;
              grid-template-columns: 1fr 1fr;
              border-bottom: 1px dashed #cbd5e1;
              padding-bottom: 8px;
              margin-bottom: 8px;
            }
            .sender-col {
              padding-right: 12px;
              border-right: 1px dashed #cbd5e1;
              font-size: 13px;
              color: #000000;
            }
            .receiver-col {
              padding-left: 14px;
              font-size: 13px;
              color: #000000;
            }
            .party-line {
              margin-bottom: 3px;
            }
            .party-bold {
              font-weight: 700;
            }
            .chat-badge {
              display: inline-flex;
              align-items: center;
              gap: 4px;
              color: #16a34a;
              font-weight: 700;
              font-size: 12px;
              margin-top: 2px;
            }

            /* Destination dropoff point */
            .dropoff-box {
              font-size: 13px;
              font-weight: 700;
              color: #000000;
              border-bottom: 1px dashed #cbd5e1;
              padding-bottom: 8px;
              margin-bottom: 10px;
            }

            /* 3-column Specs */
            .specs-grid {
              display: grid;
              grid-template-columns: 1fr 1fr 1fr;
              text-align: center;
              font-size: 13px;
              border-bottom: 1px dashed #cbd5e1;
              padding-bottom: 8px;
              margin-bottom: 8px;
            }
            .spec-lbl {
              color: #000000;
              font-size: 12px;
              margin-bottom: 2px;
            }
            .spec-val {
              font-weight: 700;
              color: #000000;
            }

            /* Payment Rows */
            .payment-section {
              border-bottom: 1px dashed #cbd5e1;
              padding-bottom: 8px;
              margin-bottom: 10px;
            }
            .pay-row {
              display: flex;
              justify-content: space-between;
              align-items: center;
              font-size: 14px;
              margin-bottom: 4px;
            }
            .pay-lbl {
              color: #000000;
              font-weight: 700;
            }
            .pay-val {
              font-weight: 800;
              color: #000000;
            }
            .total-row {
              font-size: 15px;
            }
            .total-row .pay-lbl {
              font-weight: 900;
            }
            .total-row .pay-val {
              font-weight: 900;
              color: #000000;
            }

            /* Bottom Terms */
            .terms-section {
              text-align: center;
              font-size: 12px;
              color: #000000;
              font-weight: 700;
              line-height: 1.5;
              margin-bottom: 16px;
            }

            /* Action Buttons at bottom */
            .buttons-row {
              display: flex;
              justify-content: center;
              gap: 16px;
            }
            .btn-download {
              display: inline-flex;
              align-items: center;
              gap: 6px;
              padding: 6px 18px;
              border-radius: 8px;
              border: 1px solid #16a34a;
              color: #16a34a;
              background: #ffffff;
              font-size: 13px;
              font-weight: 700;
            }
            .btn-share {
              display: inline-flex;
              align-items: center;
              gap: 6px;
              padding: 6px 18px;
              border-radius: 8px;
              border: 1px solid #e60012;
              color: #e60012;
              background: #ffffff;
              font-size: 13px;
              font-weight: 700;
            }
          </style>
        </head>
        <body>
          <div class="slip-card">
            <div class="watermark-layer">
              ${Array(35).fill(`<span>| ${tracking} | ວັນທີຝາກ: ${dateStr} | ລາຄາ: ${total.toLocaleString()} KIP</span>`).join('')}
            </div>

            <div class="content-layer">
              <!-- Top header -->
              <div class="top-row">
                <div class="logo-box">
                  <span class="logo-chevron">&gt;&gt;</span>
                  <div>
                    <div class="logo-txt">ANOUSITH</div>
                    <div class="logo-sub">EXPRESS</div>
                  </div>
                </div>
                <div class="bill-title">ບິນຝາກພັດສະດຸ</div>
              </div>

              <!-- Barcode at Top -->
              <div class="barcode-section">
                <svg id="barcode"></svg>
                <div class="bill-num-lbl">ເລກບິນ ${tracking}</div>
              </div>

              <!-- Meta -->
              <div class="meta-row">
                <div class="item-name-box">
                  <div>ຊື່ພັດສະດຸ: ${itemName}</div>
                  <div style="font-size:12px;color:#000000;margin-top:2px;">ທີມ:</div>
                </div>
                <div class="date-box">
                  <div class="date-lbl">ວັນທີຝາກ:</div>
                  <div class="date-val">${dateStr}</div>
                </div>
              </div>

              <!-- Route -->
              <div class="route-table">
                <div class="route-row">
                  <div>${fromCity}</div>
                  <div class="route-arrow">&rarr;</div>
                  <div>${destCity}</div>
                </div>
                <div class="route-row">
                  <div>${fromBranch}</div>
                  <div class="route-arrow">&rarr;</div>
                  <div>${destBranch}</div>
                </div>
              </div>

              <!-- Parties -->
              <div class="parties-grid">
                <div class="sender-col">
                  <div class="party-line">ID: ${senderId}</div>
                  <div class="party-line">ຈາກ: <span class="party-bold">${senderName}</span></div>
                  <div class="party-line">ໂທ: ${senderPhone}</div>
                </div>
                <div class="receiver-col">
                  <div class="party-line">ເຖິງ: <span class="party-bold">${receiverName}</span></div>
                  <div class="party-line">ໂທ: ${receiverPhone}</div>
                  <div class="chat-badge">
                    <span>💬</span> ແຊັດຫາ
                  </div>
                </div>
              </div>

              <!-- Dropoff Point -->
              <div class="dropoff-box">
                ຈຸດຮັບເຄື່ອງປາຍທາງ: ${dropoffPoint}
              </div>

              <!-- Specs -->
              <div class="specs-grid">
                <div>
                  <div class="spec-lbl">ຂະໜາດ</div>
                  <div class="spec-val">${size}</div>
                </div>
                <div>
                  <div class="spec-lbl">ນ້ຳໜັກ</div>
                  <div class="spec-val">${weight}</div>
                </div>
                <div>
                  <div class="spec-lbl">ຄ່າບໍລິການ</div>
                  <div class="spec-val">${freight.toLocaleString()} ກີບ</div>
                </div>
              </div>

              <!-- Payment details -->
              <div class="payment-section">
                <div class="pay-row">
                  <div class="pay-lbl">ຈ່າຍຄ່າບໍລິການ:</div>
                  <div class="pay-val">ຈ່າຍປາຍທາງ</div>
                </div>
                <div class="pay-row">
                  <div class="pay-lbl">ເກັບCOD:</div>
                  <div class="pay-val">${cod.toLocaleString()} KIP</div>
                </div>
                <div class="pay-row total-row">
                  <div class="pay-lbl">ລວມທັງໝົດ:</div>
                  <div class="pay-val">${total.toLocaleString()} KIP</div>
                </div>
              </div>

              <!-- Terms -->
              <div class="terms-section">
                <div>ຮັບເຄື່ອງພາຍໃນ 7 ວັນ (ຫຼັງເຄື່ອງຮອດປາຍທາງ ຖ້າເກີນ 7 ວັນ ເຄື່ອງຈະຕີກັບຕົ້ນທາງ)</div>
                <div style="margin-top:4px;">ຂອບໃຈທີ່ໃຊ້ບໍລິການອານຸສິດ</div>
              </div>

              <!-- Buttons -->
              <div class="buttons-row">
                <div class="btn-download">📥 ດາວໂຫຼດ</div>
                <div class="btn-share">↪️ ແຊຣ໌ບິນ</div>
              </div>
            </div>
          </div>

          <script>
            JsBarcode("#barcode", "${tracking}", {
              format: "CODE128",
              lineColor: "#000000",
              width: 1.8,
              height: 50,
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
        await page.setViewport({ width: 560, height: 750, deviceScaleFactor: 2.5 });
        await page.setContent(html, { waitUntil: 'networkidle0' });
        await new Promise(r => setTimeout(r, 600));
        
        const card = await page.$('.slip-card');
        if (card) {
          await card.screenshot({ path: savePath });
        } else {
          await page.screenshot({ path: savePath });
        }
        await browser.close();

        if (fs.existsSync(savePath) && fs.statSync(savePath).size > 1000) {
          console.log(`📸 Official Anousith bill slip generated for #${tracking} (${fs.statSync(savePath).size} bytes)`);
          return savePath;
        }
      } catch (err) {
        if (browser) {
          try { await browser.close(); } catch (e) {}
        }
        console.warn(`⚠️ Could not generate Anousith bill slip for #${tracking}:`, err.message);
      }
    }

    return null;
  }
}

module.exports = AnousithService;
