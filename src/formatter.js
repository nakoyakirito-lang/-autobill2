/**
 * Utility to format Lao telephone numbers to WhatsApp JID format (e.g., 85620XXXXXXXX@s.whatsapp.net)
 */
function formatLaoPhoneToWhatsAppJid(phone) {
  if (!phone) return null;

  // Clean non-digit characters
  let clean = phone.toString().trim().replace(/[^\d+]/g, '');

  // Remove leading '+' if present
  if (clean.startsWith('+')) {
    clean = clean.substring(1);
  }

  // Handle various Lao phone formats:
  // 1. Starts with 856: e.g. 8562099999999 or 856309999999
  if (clean.startsWith('856')) {
    return `${clean}@s.whatsapp.net`;
  }

  // 2. Starts with 020 (8 digits after 020) -> 85620XXXXXXXX
  if (clean.startsWith('020')) {
    return `85620${clean.substring(3)}@s.whatsapp.net`;
  }

  // 3. Starts with 030 -> 85630XXXXXXX
  if (clean.startsWith('030')) {
    return `85630${clean.substring(3)}@s.whatsapp.net`;
  }

  // 4. Starts with 20 (8 digits after 20) -> 85620XXXXXXXX
  if (clean.startsWith('20') && clean.length === 10) {
    return `856${clean}@s.whatsapp.net`;
  }

  // 5. Starts with 30 -> 85630XXXXXXX
  if (clean.startsWith('30') && (clean.length === 9 || clean.length === 10)) {
    return `856${clean}@s.whatsapp.net`;
  }

  // 6. 8 digits directly (assumed 20)
  if (clean.length === 8) {
    return `85620${clean}@s.whatsapp.net`;
  }

  if (clean.length >= 8) {
    return `856${clean}@s.whatsapp.net`;
  }

  return null;
}

module.exports = {
  formatLaoPhoneToWhatsAppJid
};
