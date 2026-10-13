/* server/module/user_listen_report.js 只需要 net.isIP。 */
const isIPv4 = (value) => {
  const parts = String(value).split('.');
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d*)$/.test(part) && Number(part) <= 255);
};

const isIPv6 = (value) => {
  const text = String(value);
  if (!text.includes(':') || /[^0-9a-f:.]/i.test(text)) return false;
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    if (lastColon < 0 || !isIPv4(text.slice(lastColon + 1))) return false;
  }
  const parts = text.split('::');
  if (parts.length > 2) return false;
  const count = (part) => (part ? part.split(':').filter(Boolean).length : 0);
  const groups = count(parts[0]) + count(parts[1]);
  return parts.length === 2 ? groups < 8 : groups === 8;
};

module.exports = { isIP: (value) => (isIPv4(value) ? 4 : isIPv6(value) ? 6 : 0) };
module.exports.__esModule = true;
