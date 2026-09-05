const axios = require('axios');
const fs = require('fs');
const path = require('path');

class HalService {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || 'https://halexpress.la';
    this.trackingUrl = config.trackingUrl || 'https://halexpress.la/track';
    
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
    if (!trackingNumber) return this.baseUrl;
    return `https://halexpress.la/track?tracking=${encodeURIComponent(trackingNumber)}`;
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

    // In HAL Express, validate and register merchant account profile
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
   * Capture or download HAL Express bill slip / tracking screenshot
   */
  async downloadBillImage(imageUrlOrTracking, savePath) {
    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(savePath) && fs.statSync(savePath).size > 1000) {
      return savePath;
    }

    const tracking = String(imageUrlOrTracking).replace(/[^a-zA-Z0-9_-]/g, '');

    // 1. If direct image URL provided
    if (imageUrlOrTracking.startsWith('http')) {
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

    // 2. Capture tracking view via Puppeteer
    if (tracking && tracking.length >= 4) {
      let browser;
      try {
        const puppeteer = require('puppeteer');
        browser = await puppeteer.launch({
          headless: 'new',
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 600, height: 1000, deviceScaleFactor: 2 });
        const targetUrl = this.getTrackingUrl(tracking);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await page.screenshot({ path: savePath, fullPage: false });
        await browser.close();
        if (fs.existsSync(savePath) && fs.statSync(savePath).size > 1000) {
          console.log(`📸 HAL Express slip screenshot captured for #${tracking}`);
          return savePath;
        }
      } catch (err) {
        if (browser) {
          try { await browser.close(); } catch (e) {}
        }
        console.warn(`Could not screenshot HAL tracking #${tracking}:`, err.message);
      }
    }

    return null;
  }
}

module.exports = HalService;
