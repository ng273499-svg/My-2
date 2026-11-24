/**
 * JARVIS-X v1.3.0 — URL safety / SSRF guard.
 *
 * Research fetches arbitrary URLs suggested by a search provider. That makes
 * every one of them attacker-controlled, so the guard is the first thing that
 * runs and the last thing that a redirect is allowed to bypass.
 *
 * Defence layers:
 *   1. Scheme allow-list (http/https only — file:, ftp:, data:, javascript:
 *      and friends are refused).
 *   2. Credential-bearing URLs are refused (never send embedded secrets).
 *   3. Host allow/deny by *syntax*: localhost, single-label intranet names,
 *      .local/.internal/.lan suffixes and cloud metadata hostnames.
 *   4. Address allow/deny by *literal*: loopback, private, CGNAT, link-local,
 *      unique-local, multicast, reserved and documentation ranges for both
 *      IPv4 and IPv6 — including IPv4-mapped IPv6.
 *   5. DNS resolution check (rebinding mitigation): a hostname whose A/AAAA
 *      records point anywhere private is refused before the request is made.
 *      Node resolves again at connect time, so this is mitigation rather than
 *      a mathematical guarantee; the address-level checks above still apply to
 *      literal addresses, and redirects are re-validated hop by hop.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type UrlRejectionReason =
  | 'UNSUPPORTED_SCHEME'
  | 'MISSING_HOST'
  | 'CREDENTIALS_IN_URL'
  | 'URL_TOO_LONG'
  | 'MALFORMED_URL'
  | 'LOCALHOST'
  | 'LOOPBACK'
  | 'PRIVATE_ADDRESS'
  | 'LINK_LOCAL'
  | 'UNIQUE_LOCAL'
  | 'CLOUD_METADATA'
  | 'INTERNAL_SUFFIX'
  | 'UNSPECIFIED_ADDRESS'
  | 'MULTICAST'
  | 'DANGEROUS_PORT'
  | 'DNS_REBINDING_BLOCKED'
  | 'UNRESOLVABLE_HOST';

export interface UrlVerdict {
  safe: boolean;
  reason: UrlRejectionReason | null;
  detail: string;
  /** Normalized URL, present only when safe. */
  url: string | null;
}

export interface UrlGuardOptions {
  /** Extra hostnames to refuse (e.g. a denylist from config). */
  deniedHosts?: string[];
  /**
   * TEST-ONLY escape hatch. Allows loopback origins for an in-process fixture
   * server so the SSRF layer can be exercised end to end. Production code
   * never sets this, and it is never enabled from environment configuration.
   */
  testOnlyAllowedHosts?: string[];
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Ports that must never be reached from a research fetch. */
const DANGEROUS_PORTS = new Set([
  21, 22, 23, 25, 53, 110, 111, 135, 137, 138, 139, 143, 161, 389, 445, 465, 512,
  513, 514, 587, 631, 873, 993, 995, 1080, 1433, 1521, 2049, 2375, 2376, 3128,
  3268, 3306, 3389, 5432, 5672, 5900, 5984, 6379, 7001, 8000, 8008, 8080, 8443,
  8888, 9000, 9042, 9092, 9200, 9300, 11211, 15672, 27017, 27018,
]);

/** Hostnames that serve instance credentials. */
const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'metadata.azure.com',
]);

const INTERNAL_SUFFIXES = ['.local', '.internal', '.lan', '.home', '.corp', '.intranet', '.localhost'];

const MAX_URL_LENGTH = 2_048;

function reject(reason: UrlRejectionReason, detail: string): UrlVerdict {
  return { safe: false, reason, detail, url: null };
}

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

/** Classify a dotted-quad IPv4 address. Returns null when publicly routable. */
export function classifyAddress(address: string): UrlRejectionReason | null {
  const v4 = ipv4Parts(address);
  if (v4) {
    const [a, b, c] = v4;

    if (a === 0) return 'UNSPECIFIED_ADDRESS';
    if (a === 127) return 'LOOPBACK';

    // 169.254.0.0/16 link-local — includes AWS/GCP/Azure IMDS.
    if (a === 169 && b === 254) return 'CLOUD_METADATA';
    // Alibaba cloud metadata.
    if (a === 100 && b === 100 && c === 100) return 'CLOUD_METADATA';
    // AWS ECS task metadata.
    if (a === 169 && b === 254 && c === 170) return 'CLOUD_METADATA';

    if (a === 10) return 'PRIVATE_ADDRESS';
    if (a === 172 && b >= 16 && b <= 31) return 'PRIVATE_ADDRESS';
    if (a === 192 && b === 168) return 'PRIVATE_ADDRESS';
    // Carrier-grade NAT.
    if (a === 100 && b >= 64 && b <= 127) return 'PRIVATE_ADDRESS';
    // 192.0.0.0/24, 192.0.2.0/24 (TEST-NET-1), 198.18.0.0/15, 198.51.100.0/24,
    // 203.0.113.0/24 (TEST-NET-3), 240.0.0.0/4, 255.255.255.255.
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'PRIVATE_ADDRESS';
    if (a === 198 && (b === 18 || b === 19)) return 'PRIVATE_ADDRESS';
    if (a === 198 && b === 51 && c === 100) return 'PRIVATE_ADDRESS';
    if (a === 203 && b === 0 && c === 113) return 'PRIVATE_ADDRESS';
    if (a >= 224) return a >= 240 ? 'PRIVATE_ADDRESS' : 'MULTICAST';

    return null;
  }

  // IPv6 — isIP() === 6
  const lower = address.toLowerCase();

  // IPv4-mapped / IPv4-compatible forms: ::ffff:127.0.0.1
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped) return classifyAddress(mapped[1]);

  if (lower === '::1') return 'LOOPBACK';
  if (lower === '::') return 'UNSPECIFIED_ADDRESS';

  const collapsed = lower.split('%')[0];
  const groups = collapsed.split(':');
  const first = Number.parseInt(groups[0] || '0', 16);

  // AWS IMDS over IPv6.
  if (collapsed === 'fd00:ec2::254') return 'CLOUD_METADATA';

  if ((first & 0xfe00) === 0xfc00) return 'UNIQUE_LOCAL';
  if ((first & 0xffc0) === 0xfe80) return 'LINK_LOCAL';
  if ((first & 0xff00) === 0xff00) return 'MULTICAST';

  return null;
}

function isIpLiteral(hostname: string): boolean {
  // URL keeps IPv6 hostnames bracketed; classifyAddress expects bare form.
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return isIP(bare) !== 0;
}

/**
 * Synchronous structural inspection. No DNS, no network — safe to call on every
 * URL, on every redirect hop and from client-visible code paths.
 */
export function inspectUrl(rawUrl: string, options: UrlGuardOptions = {}): UrlVerdict {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return reject('MALFORMED_URL', 'The URL is empty.');
  }
  if (rawUrl.length > MAX_URL_LENGTH) {
    return reject('URL_TOO_LONG', `The URL exceeds ${MAX_URL_LENGTH} characters.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return reject('MALFORMED_URL', 'The URL could not be parsed.');
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return reject(
      'UNSUPPORTED_SCHEME',
      `Scheme "${parsed.protocol}" is not permitted. Only http and https are fetched.`
    );
  }
  if (parsed.username || parsed.password) {
    return reject('CREDENTIALS_IN_URL', 'URLs carrying embedded credentials are refused.');
  }
  if (!parsed.hostname) {
    return reject('MISSING_HOST', 'The URL has no hostname.');
  }

  const hostname = decodedHostname(parsed.hostname);
  const allowList = (options.testOnlyAllowedHosts ?? []).map((host) => host.toLowerCase());
  if (allowList.includes(hostname)) {
    return { safe: true, reason: null, detail: 'Test-only loopback origin (explicitly allow-listed).', url: parsed.toString() };
  }

  if ((options.deniedHosts ?? []).some((denied) => hostname === denied.toLowerCase())) {
    return reject('INTERNAL_SUFFIX', 'The host is on the configured deny list.');
  }

  // ---- Hostname syntax checks ----
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return reject('LOCALHOST', 'localhost is never fetched.');
  }
  if (METADATA_HOSTS.has(hostname) || hostname.includes('metadata.google')) {
    return reject('CLOUD_METADATA', 'Cloud metadata endpoints are blocked.');
  }
  if (INTERNAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return reject('INTERNAL_SUFFIX', 'Internal-only hostname suffixes are blocked.');
  }

  // ---- Address literal checks ----
  if (isIpLiteral(hostname)) {
    const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
    const verdict = classifyAddress(bare);
    if (verdict) {
      return reject(
        verdict,
        verdict === 'CLOUD_METADATA'
          ? 'Cloud metadata endpoints are blocked.'
          : `${bare} resolves to a non-public address range.`
      );
    }
  } else if (!hostname.includes('.')) {
    // A single-label hostname can only resolve on an internal network.
    return reject('INTERNAL_SUFFIX', 'Single-label (intranet) hostnames cannot be researched.');
  }

  // ---- Port checks ----
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  if (DANGEROUS_PORTS.has(port)) {
    return reject('DANGEROUS_PORT', `Port ${port} is not fetchable from research.`);
  }

  return { safe: true, reason: null, detail: 'URL passed structural validation.', url: parsed.toString() };
}

function decodedHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  // URL keeps IPv6 literals bracketed; callers compare unbracketed.
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
}

/**
 * Full check including DNS resolution (rebinding mitigation).
 *
 * A hostname that resolves to ANY private address is refused outright — a
 * partially-private answer set is a classic rebinding attack.
 */
export async function assertSafeUrl(rawUrl: string, options: UrlGuardOptions = {}): Promise<UrlVerdict> {
  const structural = inspectUrl(rawUrl, options);
  if (!structural.safe || !structural.url) return structural;

  let parsed: URL;
  try {
    parsed = new URL(structural.url);
  } catch {
    return reject('MALFORMED_URL', 'The URL could not be re-parsed.');
  }

  const hostname = decodedHostname(parsed.hostname);
  const allowList = (options.testOnlyAllowedHosts ?? []).map((host) => host.toLowerCase());
  if (allowList.includes(hostname)) return structural;
  if (isIpLiteral(hostname)) return structural; // already address-checked

  let addresses: string[];
  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    addresses = records.map((record) => record.address);
  } catch {
    return reject('UNRESOLVABLE_HOST', `The host "${hostname}" could not be resolved.`);
  }

  if (addresses.length === 0) {
    return reject('UNRESOLVABLE_HOST', `The host "${hostname}" returned no addresses.`);
  }

  for (const address of addresses) {
    const verdict = classifyAddress(address);
    if (verdict) {
      return reject(
        'DNS_REBINDING_BLOCKED',
        `"${hostname}" resolves to a non-public address (${verdict.toLowerCase().replace(/_/g, ' ')}).`
      );
    }
  }

  return structural;
}

/** Strip userinfo + query for logs and UI so no secret is echoed. */
export function sanitizeUrlForDisplay(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

/** Domain used for grouping/independence. Never throws. */
export function domainOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}
