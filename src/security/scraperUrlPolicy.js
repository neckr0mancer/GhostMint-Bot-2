// Single canonical scraper-destination policy (Model 2 phase-1 finding SEC-001). Both the
// validation layer and the social adapters classify through here -- duplicated string checks
// drifted once already and accepted bracketed IPv6 literals, because WHATWG URL.hostname keeps
// the brackets ([::1]) and net.isIP('[::1]') returns 0.
const net = require('node:net');
const dnsPromises = require('node:dns').promises;
const { URL } = require('node:url');

// Expands an IPv6 address to its 8 lowercase hextets (no '::' shorthand, no IPv6 brackets).
// Returns null for anything that is not valid IPv6.
function expandIPv6(address) {
  let head = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!head.includes(':')) return null;
  // Embedded IPv4 tail (::ffff:127.0.0.1) becomes two hextets.
  let v4 = null;
  if (head.includes('.')) {
    const lastColon = head.lastIndexOf(':');
    v4 = head.slice(lastColon + 1);
    head = head.slice(0, lastColon + 1) + '0:0';
    const parts = v4.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    v4 = ((parts[0] << 8) | parts[1]).toString(16) + ':' + ((parts[2] << 8) | parts[3]).toString(16);
    head = head.endsWith(':') ? head + v4 : head + v4;
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 0 : left.length + right.length !== 8) return null;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map(g => g.padStart(4, '0'));
}

function ipv4IsPrivate(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true; // unparseable = treat private
  if (o[0] === 0 || o[0] === 10 || o[0] === 127) return true; // this-network, private, loopback
  if (o[0] === 169 && o[1] === 254) return true; // link-local incl. cloud metadata
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
  if (o[0] === 198 && o[1] >= 18 && o[1] <= 19) return true; // benchmarking (RFC 2544)
  if (o[0] === 224 || o[0] >= 240) return true; // multicast + reserved + broadcast
  return false;
}

// Classifies any address form a URL hostname can carry: bracketed/bare IPv6, IPv4 in decimal,
// hex, or octal notation, IPv4-mapped IPv6, and plain hostnames. True = must not be fetched.
function isPrivateScraperHostname(hostname) {
  let h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); // strip brackets + trailing dot (FQDN form)
  if (!h) return true;

  // Whole-address decimal/hex forms: 2130706433, 0x7f000001.
  if (/^\d+$/.test(h)) {
    const n = Number(h);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      h = `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
    }
  } else if (/^0x[0-9a-f]+$/.test(h)) {
    const n = Number.parseInt(h, 16);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      h = `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
    }
  }
  // Mixed-radix dotted forms (0x7f.0.0.1, 0177.0.0.1): normalise each label.
  if (h.includes('.') && h.split('.').every(part => part !== '')) {
    h = h.split('.').map(part => {
      if (/^0x[0-9a-f]+$/i.test(part)) return String(Number.parseInt(part, 16));
      if (/^0[0-7]+$/.test(part)) return String(Number.parseInt(part, 8));
      return part;
    }).join('.');
  }

  const ipVersion = net.isIP(h);
  if (ipVersion === 4) return ipv4IsPrivate(h);
  if (ipVersion === 6) {
    const groups = expandIPv6(h);
    if (!groups) return true; // unparseable IPv6 = treat private
    const first = groups[0];
    if (groups.every(g => g === '0000')) return true; // :: unspecified
    if (groups.slice(0, 5).every(g => g === '0000') && groups[5] === 'ffff') {
      // IPv4-mapped ::ffff:a.b.c.d -- classify the embedded v4.
      const bytes = [Number.parseInt(groups[6].slice(0, 2), 16), Number.parseInt(groups[6].slice(2), 16),
        Number.parseInt(groups[7].slice(0, 2), 16), Number.parseInt(groups[7].slice(2), 16)];
      return ipv4IsPrivate(bytes.join('.'));
    }
    if (groups.slice(0, 7).every(g => g === '0000') && groups[7] === '0001') return true; // ::1 loopback
    if (first.startsWith('0080') && /^0080/.test(first) === false && first === 'fe80') return true; // link-local (fe80::/10 covers fe80-febf)
    if (first >= 'fe80' && first <= 'febf') return true; // link-local
    if (first >= 'fc00' && first <= 'fdff') return true; // unique local
    if (first >= 'ff00' && first <= 'ffff') return true; // multicast
    if (first >= 'fec0' && first <= 'feff') return true; // site-local (deprecated but still reserved)
    // IPv4-compatible ::a.b.c.d (not mapped) — the embedded v4 is the real destination
    if (groups.slice(0, 6).every(g => g === '0000')) {
      const bytes = [Number.parseInt(groups[6].slice(0, 2), 16), Number.parseInt(groups[6].slice(2), 16),
        Number.parseInt(groups[7].slice(0, 2), 16), Number.parseInt(groups[7].slice(2), 16)];
      if (bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
      return ipv4IsPrivate(bytes.join('.'));
    }
    return false;
  }

  // Hostname forms.
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h === 'metadata.google.internal') return true;
  return false;
}

// Poll-time gate: validates the URL, rejects private hostnames, then resolves DNS and rejects any
// resolved address that is not public -- closing the validate-then-rebind gap for the one request
// this adapter is about to make. Redirects are separately disabled by the caller.
async function assertPublicScraperDestination(sourceUrl, { lookup = (host, opts) => dnsPromises.lookup(host, opts) } = {}) {
  let parsed;
  try { parsed = new URL(sourceUrl); } catch { throw new Error('scraper sourceUrl must be a valid HTTP or HTTPS URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('scraper sourceUrl must be an HTTP or HTTPS URL');
  if (isPrivateScraperHostname(parsed.hostname)) throw new Error('scraper sourceUrl must not target a private or internal address');
  let resolved;
  try { resolved = await lookup(parsed.hostname, { all: true }); }
  catch { throw new Error('scraper sourceUrl DNS resolution failed — failing closed rather than authorizing an unverifiable destination'); }
  if (!resolved || !resolved.length) throw new Error('scraper sourceUrl DNS resolution returned no addresses');
  if (resolved.some(entry => isPrivateScraperHostname(entry.address))) {
    throw new Error('scraper sourceUrl resolves to a private or internal address');
  }
  return parsed;
}

module.exports = { expandIPv6, isPrivateScraperHostname, assertPublicScraperDestination };
