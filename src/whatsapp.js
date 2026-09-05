const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

class WhatsAppBot {
  constructor() {
    this.sock = null;
    this.isConnected = false;
    this.lastQr = null;
    this.lastQrDataUrl = null;
    this.authDir = path.join(__dirname, '..', 'auth_info_baileys');
  }

  async start() {
    console.log('🚀 Initializing WhatsApp connection...');

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version = [2, 3000, 1015901307];
    try {
      const v = await Promise.race([
        fetchLatestBaileysVersion(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Version fetch timeout')), 4000))
      ]);
      if (v?.version) version = v.version;
    } catch (e) {
      console.log('ℹ️ Using standard WhatsApp version');
    }
    console.log(`Using WA version v${version.join('.')}`);

    this.sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: ['Anousith Auto Bill Bot', 'Chrome', '1.0.0']
    });

    // Save credentials whenever updated
    this.sock.ev.on('creds.update', saveCreds);

    // Connection update (QR code, connection state)
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.lastQr = qr;
        try {
          this.lastQrDataUrl = await QRCode.toDataURL(qr);
        } catch (e) {
          console.error('Error creating QR data URL:', e);
        }

        console.log('\n📲 ---------------------------------------------');
        console.log('📲 ກະລຸນາສະແກນ QR Code ນີ້ດ້ວຍ WhatsApp ໃນມືຖື:');
        console.log('📲 ---------------------------------------------\n');
        qrcode.generate(qr, { small: true });
        console.log('\n👉 ເປີດ WhatsApp > Settings (ຫຼື 3 ຈຸດ) > Linked Devices > Link a Device\n');
      }

      if (connection === 'close') {
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('⚠️ WhatsApp connection closed. Reconnecting:', shouldReconnect);
        this.isConnected = false;
        if (shouldReconnect) {
          setTimeout(() => this.start(), 5000);
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp Bot connected successfully!');
        this.isConnected = true;
        this.lastQr = null;
        this.lastQrDataUrl = null;
      }
    });

    return this.sock;
  }

  /**
   * Send a text message to a WhatsApp JID (e.g. 85620XXXXXXXX@s.whatsapp.net)
   */
  
  /**
   * Wait for active connection if currently reconnecting
   */
  async waitForConnection(timeoutMs = 15000) {
    if (this.isConnected && this.sock) return true;
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (this.isConnected && this.sock) return true;
      await new Promise(r => setTimeout(r, 500));
    }
    return this.isConnected && Boolean(this.sock);
  }

  async sendMessage(jid, text) {
    if (!this.sock || !this.isConnected) {
      throw new Error('WhatsApp bot is not connected yet');
    }
    return await this.sock.sendMessage(jid, { text });
  }

  /**
   * Send a bill image with an optional caption
   */
  async sendBillImage(jid, imagePathOrBuffer, caption = '') {
    if (!this.sock || !this.isConnected) {
      throw new Error('WhatsApp bot is not connected yet');
    }

    let imagePayload;
    if (typeof imagePathOrBuffer === 'string') {
      imagePayload = fs.readFileSync(imagePathOrBuffer);
    } else {
      imagePayload = imagePathOrBuffer;
    }

    return await this.sock.sendMessage(jid, {
      image: imagePayload,
      caption: caption,
      mimetype: 'image/jpeg'
    });
  }

  /**
   * Check if a JID is registered on WhatsApp
   */
  async checkOnWhatsApp(jid) {
    if (!this.sock || !this.isConnected) {
      throw new Error('WhatsApp bot is not connected yet');
    }
    try {
      const cleanJid = jid.replace('@s.whatsapp.net', '');
      const results = await this.sock.onWhatsApp(cleanJid);
      if (results && results.length > 0 && results[0].exists) {
        return { exists: true, jid: results[0].jid };
      }
      return { exists: false, reason: 'ເບີໂທນີ້ຍັງບໍ່ໄດ້ລົງທະບຽນ WhatsApp' };
    } catch (e) {
      // If check fails or not supported, return true to attempt direct send
      return { exists: true, jid };
    }
  }
}

module.exports = WhatsAppBot;
