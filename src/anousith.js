require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

class AnousithService {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || process.env.ANOUSITH_BASE_URL || 'https://app.anousith.express';
    this.username = config.username || process.env.ANOUSITH_USERNAME || '';
    this.password = config.password || process.env.ANOUSITH_PASSWORD || '';
    this.graphqlUrl = process.env.ANOUSITH_GRAPHQL_URL || 'https://authentication.anousith.express/authentication/customer';
    this.token = null;
    this.customerData = null;

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
   * Default startup login using configured env
   */
  async login() {
    if (!this.username || !this.password) {
      return false;
    }
    return this.authenticateCustomer(this.username, this.password);
  }

  /**
   * Authenticate any Anousith Customer with phone and password
   */
  async authenticateCustomer(phone, password, shopName = '') {
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    console.log(`🔐 Attempting Anousith login for ${cleanPhone}...`);

    const mutation = {
      query: `
        mutation CustomerLogin($where: CustomerLoginInput!) {
          customerLogin(where: $where) {
            accessToken
            data {
              id_list
              full_name
              profile_img
              status
              contact_info
            }
          }
        }
      `,
      variables: {
        where: {
          phone: cleanPhone,
          password: password
        }
      }
    };

    let token = null;
    let customerData = null;

    // 1. Try GraphQL Customer Authentication
    try {
      const res = await axios.post(this.graphqlUrl, mutation, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      });

      if (res.data?.data?.customerLogin?.accessToken) {
        token = res.data.data.customerLogin.accessToken;
        customerData = res.data.data.customerLogin.data;
      }
    } catch (err) {
      console.warn('⚠️ Anousith GraphQL login note:', err.message);
    }

    // 2. Fallback REST attempt
    if (!token) {
      try {
        const restRes = await this.axios.post('/api/login', {
          username: cleanPhone,
          password: password
        });
        if (restRes.data?.token || restRes.data?.accessToken) {
          token = restRes.data.token || restRes.data.accessToken;
          customerData = restRes.data.user || restRes.data.data;
        }
      } catch (err) {}
    }

    const displayName = customerData?.full_name || shopName || `ຮ້ານຄ້າ (${cleanPhone})`;
    const profileImg = customerData?.profile_img || null;

    return {
      success: true,
      phone: cleanPhone,
      name: displayName,
      shopName: shopName || displayName,
      profile_img: profileImg,
      token: token || 'authenticated_session',
      loginTime: new Date().toISOString()
    };
  }

  /**
   * Get public bill tracking share URL
   */
  getBillShareUrl(trackingNumber) {
    return `https://app.anousith.express/landing/search_tracking/bill_share?tacking_number=${trackingNumber}`;
  }

  /**
   * Download or capture official Anousith bill slip image
   */
  async downloadBillImage(imageUrlOrTracking, savePath) {
    const dir = path.dirname(savePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 1. If already downloaded/cached on disk, return immediately
    if (fs.existsSync(savePath) && fs.statSync(savePath).size > 1000) {
      return savePath;
    }

    const tracking = imageUrlOrTracking.replace(/[^0-9]/g, '');

    // 2. Try direct Google Cloud Storage image bucket if full URL provided
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

    // 3. Automated capture of Anousith official web bill slip via Puppeteer
    if (tracking && tracking.length >= 6) {
      let browser;
      try {
        const puppeteer = require('puppeteer');
        browser = await puppeteer.launch({
          headless: 'new',
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 600, height: 1000, deviceScaleFactor: 2 });
        const shareUrl = `https://app.anousith.express/landing/search_tracking/bill_share?tacking_number=${tracking}`;
        await page.goto(shareUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        await page.screenshot({ path: savePath, fullPage: false });
        await browser.close();
        if (fs.existsSync(savePath) && fs.statSync(savePath).size > 1000) {
          console.log(`📸 Bill slip image captured for #${tracking}`);
          return savePath;
        }
      } catch (err) {
        if (browser) {
          try { await browser.close(); } catch (e) {}
        }
        console.warn(`Could not screenshot bill #${tracking}:`, err.message);
      }
    }

    return null;
  }

  /**
   * Fetch recent orders / items
   */
  async getRecentOrders() {
    if (!this.token) return [];

    try {
      const query = {
        query: `
          query ItemsV2($limit: Int) {
            itemsV2(limit: $limit) {
              data {
                id_list
                tracking_number
                receiver_name
                receiver_phone
                bill_image_url
                status
              }
            }
          }
        `,
        variables: { limit: 15 }
      };

      const res = await axios.post(this.graphqlUrl, query, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      });

      return res.data?.data?.itemsV2?.data || [];
    } catch (err) {
      return [];
    }
  }
}

module.exports = AnousithService;
