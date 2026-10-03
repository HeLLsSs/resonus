/**
 * Reporting a problem from inside the app: what goes into the report, and the
 * two ways out of it, a GitHub issue or an email.
 *
 * Pure on purpose. Everything that leaves the phone goes through `redact`
 * first, and a rule like "never the server address" is only worth something
 * if it can be tested without a phone: the issues on this repository are
 * public, and a crash trace is exactly where a stream URL with its token in it
 * ends up.
 */

/** Where "Send by email" writes to. */
export const REPORT_EMAIL = 'LSmiler@live.fr';

const REPO_URL = 'https://github.com/HeLLsSs/resonus';

/**
 * GitHub turns away a new-issue link somewhere past 8000 characters, and what
 * it does then is a bare error page with the report lost. The body gets what
 * the whole link may have once the address and a title at its longest (70
 * characters, each one encoded as long as one can be) are taken out.
 */
export const ISSUE_URL_MAX = 7500;
export const ISSUE_BODY_MAX = ISSUE_URL_MAX - 1000;
/** An email has no such limit, but a mail app handed a megabyte link may. */
export const MAIL_BODY_MAX = 20_000;

export interface ReportInput {
  /** What the person wrote. */
  text: string;
  /** `1.8.3 (95)`: the version and the versionCode. */
  version: string;
  /** Android version and phone model, one line. */
  device: string;
  /** `navidrome`, `subsonic`...: the kind of server, never where it is. */
  serverType?: string;
  /** Crash entries, newest first, as `crashEntries` reads them. */
  crashLog: string[];
  /** The car module's log, oldest line first, as `recentCarAutoLog` gives it. */
  carLog: string;
  /**
   * Things that must not appear anywhere, matched as they are: the username,
   * the server addresses. The patterns below catch what looks like a secret;
   * this catches what IS one, wherever it was written, the person's own text
   * included.
   */
  secrets?: string[];
}

export interface Report {
  title: string;
  body: string;
}

/** A link counts every character as it is encoded, so budgets do too. */
const size = (s: string) => encodeURIComponent(s).length;

/**
 * The longest start of `s` that fits in `budget` once encoded, marked as cut.
 * By code point, since half of an emoji is a character `encodeURIComponent`
 * throws on.
 */
function cut(s: string, budget: number): string {
  if (size(s) <= budget) return s;
  const chars = Array.from(s);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(`${chars.slice(0, mid).join('')}…`) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${chars.slice(0, lo).join('')}…` : '';
}

/**
 * Takes the items in order for as long as they fit, then as much of the next
 * one as still does: the newest crash, cut, is worth more than no crash.
 */
function take(items: string[], budget: number, separator: string): string[] {
  const kept: string[] = [];
  let left = budget;
  for (const item of items) {
    const cost = size(item) + (kept.length ? size(separator) : 0);
    if (cost <= left) {
      kept.push(item);
      left -= cost;
      continue;
    }
    const rest = cut(item, left - (kept.length ? size(separator) : 0));
    if (rest) kept.push(rest);
    break;
  }
  return kept;
}

/** A titled block of log text, or nothing when none of it fits. */
function section(title: string, items: string[], budget: number, separator: string): string {
  if (items.length === 0) {
    const none = `\n\n### ${title}\nnone`;
    return size(none) <= budget ? none : '';
  }
  const open = `\n\n### ${title}\n\`\`\`\n`;
  const close = '\n```';
  const kept = take(items, budget - size(open + close), separator);
  return kept.length ? open + kept.join(separator) + close : '';
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Takes out anything that leads back to the server or into the account.
 *
 * - The given secrets, and the host part of any of them that is an address.
 * - The host of every address, credentials and port included: the path after
 *   it says which call failed, the host only says whose server it was.
 * - The values of the query parameters Subsonic signs with (`u`, `t`, `s`,
 *   `p`) and of anything named like a key or a token, in an address or not.
 * - Cookie and Authorization headers, and bearer tokens.
 * - Bare IPv4 addresses, which is how a server on the home network is reached.
 */
export function redact(text: string, secrets: string[] = []): string {
  const literal = secrets
    .flatMap((s) => {
      const host = s.replace(/^[a-z][\w+.-]*:\/\//i, '').split(/[/?#]/)[0];
      return [s, host, host.replace(/:\d+$/, '')];
    })
    .filter((s) => s.trim().length >= 3)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of new Set(literal)) out = out.replace(new RegExp(escape(s), 'gi'), '<redacted>');
  return out
    .replace(/\b((?:set-)?cookie|authorization)(\s*[:=]\s*)[^\n]*/gi, '$1$2<redacted>')
    .replace(/\b(bearer|basic)\s+[\w\-.~+/=]+/gi, '$1 <redacted>')
    .replace(/\b([a-z][\w+.-]*):\/\/[^\s/?#"'<>]+/gi, '$1://<host>')
    .replace(
      /\b(u|t|s|p|apikey|api_key|token|access_token|password|salt|username)=[^&#\s"'<>]*/gi,
      '$1=<redacted>',
    )
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<host>');
}

/**
 * The report itself: what the person wrote, the phone and the app, then the
 * newest crashes and the car's last lines, newest first. `maxLength` is what
 * the body may weigh once encoded into a link; the text and the environment
 * come first, the text with half of it at most, and the crashes get half of
 * what is left when there is a car log to share it with.
 */
export function buildReport(input: ReportInput, maxLength: number): Report {
  const clean = (s: string) => redact(s, input.secrets);
  const text = clean(input.text.trim());
  const firstLine = Array.from(text.split('\n')[0].trim());
  const title = firstLine.length
    ? firstLine.length > 70
      ? `${firstLine.slice(0, 69).join('')}…`
      : firstLine.join('')
    : 'Problem report';
  const environment = [
    '### Environment',
    `- App: ${clean(input.version)}`,
    `- Device: ${clean(input.device)}`,
    `- Server: ${clean(input.serverType || 'none')}`,
  ].join('\n');
  const tail = `\n\n${environment}`;
  // Half at most, or a pasted wall of text would leave no room for the logs.
  let body = cut(text || '(no description)', Math.floor(maxLength / 2)) + tail;
  const carLines = clean(input.carLog).split('\n').filter((l) => l.trim()).reverse();
  const left = maxLength - size(body);
  body += section(
    'Crashes (newest first)',
    input.crashLog.map(clean),
    carLines.length ? Math.floor(left / 2) : left,
    '\n\n',
  );
  body += section('Android Auto (newest first)', carLines, maxLength - size(body), '\n');
  return { title, body };
}

export function issueUrl({ title, body }: Report): string {
  return `${REPO_URL}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=bug`;
}

export function mailtoUrl({ title, body }: Report): string {
  return `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
