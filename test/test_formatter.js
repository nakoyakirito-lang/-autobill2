const assert = require('assert');
const { formatLaoPhoneToWhatsAppJid } = require('../src/formatter');
const { isBillSent, markBillSent, getDatabase } = require('../src/db');

console.log('🧪 Testing Lao Phone Formatter...');

// Test various formats
assert.strictEqual(formatLaoPhoneToWhatsAppJid('02055552709'), '8562055552709@s.whatsapp.net');
assert.strictEqual(formatLaoPhoneToWhatsAppJid('0309999999'), '856309999999@s.whatsapp.net');
assert.strictEqual(formatLaoPhoneToWhatsAppJid('+8562099851762'), '8562099851762@s.whatsapp.net');
assert.strictEqual(formatLaoPhoneToWhatsAppJid('2099851762'), '8562099851762@s.whatsapp.net');
assert.strictEqual(formatLaoPhoneToWhatsAppJid('020 5417-5718'), '8562054175718@s.whatsapp.net');

console.log('✅ Formatter tests passed!');

console.log('🧪 Testing DB operations...');
const testTracking = 'TEST_' + Date.now();
assert.strictEqual(isBillSent(testTracking), false);
markBillSent(testTracking, { test: true });
assert.strictEqual(isBillSent(testTracking), true);

console.log('✅ DB tests passed!');
console.log('🎉 All unit tests passed successfully!');
