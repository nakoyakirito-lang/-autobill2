const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { parseUniversalLogisticsFile } = require('./csv_parser');
const { isBillSent, upsertBill } = require('./db');

const PROCESSED_DB_PATH = path.join(__dirname, '..', 'data', 'processed_files.json');
const DEFAULT_AUTO_IMPORT_DIR = path.join(__dirname, '..', 'auto_import');
const USER_DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');

class FolderWatcher {
  constructor() {
    this.enabled = true;
    this.watchers = [];
    this.pollInterval = null;
    this.recentImports = [];
    this.processingLock = new Set();
    this.processedCache = this.loadProcessedFiles();

    // Ensure auto_import directory exists
    if (!fs.existsSync(DEFAULT_AUTO_IMPORT_DIR)) {
      try {
        fs.mkdirSync(DEFAULT_AUTO_IMPORT_DIR, { recursive: true });
      } catch (e) {
        console.error('Could not create auto_import directory:', e.message);
      }
    }
  }

  loadProcessedFiles() {
    try {
      if (fs.existsSync(PROCESSED_DB_PATH)) {
        const raw = fs.readFileSync(PROCESSED_DB_PATH, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {
      console.error('Error loading processed_files.json:', e.message);
    }
    return {};
  }

  saveProcessedFiles() {
    try {
      const dataDir = path.dirname(PROCESSED_DB_PATH);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(PROCESSED_DB_PATH, JSON.stringify(this.processedCache, null, 2), 'utf8');
    } catch (e) {
      console.error('Error saving processed_files.json:', e.message);
    }
  }

  getWatchedFolders() {
    const folders = [
      {
        path: DEFAULT_AUTO_IMPORT_DIR,
        name: 'ໂຟນເດີໂຄງການ (auto_import)',
        exists: fs.existsSync(DEFAULT_AUTO_IMPORT_DIR),
        isProject: true
      }
    ];

    if (fs.existsSync(USER_DOWNLOADS_DIR)) {
      folders.push({
        path: USER_DOWNLOADS_DIR,
        name: 'ໂຟນເດີ Downloads ຂອງເຄື່ອງ',
        exists: true,
        isDownloads: true
      });
    }

    return folders;
  }

  getFileFingerprint(filePath) {
    try {
      const stats = fs.statSync(filePath);
      return `${filePath}_${stats.size}_${stats.mtimeMs}`;
    } catch (e) {
      return null;
    }
  }

  isSupportedFile(fileName) {
    if (!fileName) return false;
    const lower = fileName.toLowerCase();
    // Ignore temporary / partial / hidden files
    if (fileName.startsWith('~$') || fileName.startsWith('.') || lower.endsWith('.tmp') || lower.endsWith('.crdownload') || lower.endsWith('.part') || lower.endsWith('.download')) {
      return false;
    }
    return lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.csv');
  }

  async isFileReady(filePath, retries = 3, delayMs = 600) {
    for (let i = 0; i < retries; i++) {
      try {
        const stats1 = fs.statSync(filePath);
        if (stats1.size === 0) {
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        await new Promise(r => setTimeout(r, delayMs));
        const stats2 = fs.statSync(filePath);
        if (stats1.size === stats2.size && stats1.mtimeMs === stats2.mtimeMs) {
          // Attempt read access test
          const fd = fs.openSync(filePath, 'r');
          fs.closeSync(fd);
          return true;
        }
      } catch (err) {
        // File is still locked or being written
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    return false;
  }

  async processFile(filePath) {
    if (!this.enabled) return null;
    if (this.processingLock.has(filePath)) return null;

    const fileName = path.basename(filePath);
    if (!this.isSupportedFile(fileName)) return null;

    const fingerprint = this.getFileFingerprint(filePath);
    if (!fingerprint) return null;

    // Check if already processed
    if (this.processedCache[fingerprint]) {
      return null;
    }

    this.processingLock.add(filePath);

    try {
      const ready = await this.isFileReady(filePath);
      if (!ready) {
        this.processingLock.delete(filePath);
        return null;
      }

      console.log(`🔍 [Auto-Import] Examining file: ${fileName}...`);
      const parsedItems = parseUniversalLogisticsFile(filePath);

      if (!parsedItems || parsedItems.length === 0) {
        // Not a carrier report or no tracking numbers found
        this.processedCache[fingerprint] = {
          fileName,
          filePath,
          total: 0,
          status: 'skipped_no_parcels',
          processedAt: new Date().toISOString()
        };
        this.saveProcessedFiles();
        this.processingLock.delete(filePath);
        return null;
      }

      console.log(`📥 [Auto-Import] Found ${parsedItems.length} parcels in ${fileName}. Upserting to database...`);

      let newCount = 0;
      let updatedCount = 0;
      let carrierName = parsedItems[0]?.carrier || 'Anousith Express';

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
          settlementStatus: item.settlementStatus || '',
          rawStatus: item.rawStatus || '',
          destinationBranch: item.destinationBranch || '-',
          originBranch: item.originBranch || '-',
          dateDeposited: item.dateDeposited || '',
          carrier: item.carrier || carrierName,
          sentVia: exists ? 'Auto-Import Update' : 'Auto-Import',
          billUrl: item.billUrl
        });
      }

      const importRecord = {
        id: `import_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        fileName,
        filePath,
        total: parsedItems.length,
        newCount,
        updatedCount,
        carrier: carrierName,
        status: 'success',
        processedAt: new Date().toISOString()
      };

      this.processedCache[fingerprint] = importRecord;
      this.saveProcessedFiles();

      // Keep recent 30 notifications in memory
      this.recentImports.unshift(importRecord);
      if (this.recentImports.length > 30) {
        this.recentImports.pop();
      }

      console.log(`✅ [Auto-Import Success] ${fileName}: ${parsedItems.length} bills (+${newCount} new, ${updatedCount} updated)`);
      return importRecord;
    } catch (err) {
      console.error(`❌ [Auto-Import Error] Failed to process ${fileName}:`, err.message);
      return null;
    } finally {
      this.processingLock.delete(filePath);
    }
  }

  async scanAllFolders() {
    if (!this.enabled) return [];
    const folders = this.getWatchedFolders();
    const results = [];

    for (const folder of folders) {
      if (!folder.exists) continue;
      try {
        const files = fs.readdirSync(folder.path);
        for (const file of files) {
          if (this.isSupportedFile(file)) {
            const fullPath = path.join(folder.path, file);
            const res = await this.processFile(fullPath);
            if (res) {
              results.push(res);
            }
          }
        }
      } catch (err) {
        console.error(`Error scanning folder ${folder.path}:`, err.message);
      }
    }
    return results;
  }

  init() {
    console.log('⚡ Initializing Auto-Import Folder Watcher...');
    const folders = this.getWatchedFolders();

    for (const folder of folders) {
      if (!folder.exists) continue;
      try {
        const watcher = fs.watch(folder.path, { persistent: false }, async (eventType, filename) => {
          if (!filename) return;
          if (this.isSupportedFile(filename)) {
            const fullPath = path.join(folder.path, filename);
            // Wait 1.2s debounce after trigger
            setTimeout(async () => {
              if (fs.existsSync(fullPath)) {
                await this.processFile(fullPath);
              }
            }, 1200);
          }
        });
        watcher.on('error', (err) => {
          console.error(`Watcher error for ${folder.path}:`, err.message);
        });
        this.watchers.push(watcher);
        console.log(`   📁 Watching folder: ${folder.path} (${folder.name})`);
      } catch (err) {
        console.error(`Could not watch folder ${folder.path}:`, err.message);
      }
    }

    // Run initial scan right away
    setTimeout(() => {
      this.scanAllFolders();
    }, 2000);

    // Periodic sweep every 6 seconds as a robust fallback
    this.pollInterval = setInterval(() => {
      this.scanAllFolders();
    }, 6000);
  }

  getStatus() {
    return {
      enabled: this.enabled,
      watchedFolders: this.getWatchedFolders(),
      recentImports: this.recentImports,
      totalProcessedFiles: Object.keys(this.processedCache).length
    };
  }

  toggle(enabledState = null) {
    if (enabledState !== null) {
      this.enabled = Boolean(enabledState);
    } else {
      this.enabled = !this.enabled;
    }
    return this.getStatus();
  }

  stop() {
    this.watchers.forEach(w => {
      try { w.close(); } catch (e) {}
    });
    this.watchers = [];
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}

const folderWatcher = new FolderWatcher();

module.exports = folderWatcher;
