// opale-monitoring — HTTP / content / response-time / SSL checks for client
// sites, with anti-flapping email alerts. Runs from GitHub Actions every
// 10 minutes (.github/workflows/monitor.yml) or locally with `pnpm monitor`.
// State, incident history, badge and the README status table are rewritten
// only when something significant changes, so the workflow only commits then.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:tls";
import { load } from "js-yaml";
import nodemailer from "nodemailer";

const CONFIG_FILE = "config/sites.yml";
const STATE_FILE = "status/state.json";
const INCIDENTS_FILE = "status/incidents.json";
const BADGE_FILE = "status/badge.svg";
const README_FILE = "README.md";

// Anti-flapping: a site is declared DOWN (and alerted) on the 2nd consecutive
// failed run, i.e. after ~20 minutes of confirmed failure with a 10-min cron.
const FAILS_BEFORE_ALERT = 2;
const FETCH_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 5_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 opale-monitoring";

interface PageSpec {
  path: string;
  expect?: string;
}

interface SiteConfig {
  name: string;
  domain: string;
  alert_email: string;
  expect?: string;
  pages: Array<string | PageSpec>;
  max_response_time_ms?: number;
}

interface Config {
  defaults?: { max_response_time_ms?: number; ssl_warn_days?: number };
  sites: SiteConfig[];
}

interface SiteState {
  status: "up" | "down";
  consecutiveFails: number;
  alerted: boolean;
  downSince: string | null;
  sslWarned: boolean;
  sslDaysLeft: number | null;
  lastCheck: string;
  lastResponseMs: number | null;
  lastReasons: string[];
}

interface Incident {
  site: string;
  type: "outage" | "ssl";
  started: string;
  ended: string | null;
  durationMin: number | null;
  reasons: string[];
}

interface Email {
  to: string;
  subject: string;
  text: string;
  onSent: () => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const frDate = (iso: string) =>
  new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

// ---------------------------------------------------------------- checks ---

interface PageResult {
  ok: boolean;
  reason: string | null;
  ms: number;
}

async function fetchPage(url: string, expect: string | undefined, maxMs: number): Promise<PageResult> {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
      },
    });
    const body = await res.text();
    const ms = Date.now() - start;
    if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}`, ms };
    if (expect !== undefined && !body.includes(expect)) {
      return { ok: false, reason: `chaîne témoin « ${expect} » absente`, ms };
    }
    if (ms > maxMs) return { ok: false, reason: `réponse en ${ms} ms (seuil ${maxMs} ms)`, ms };
    return { ok: true, reason: null, ms };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `injoignable (${message})`, ms: Date.now() - start };
  }
}

function checkSsl(host: string): Promise<{ daysLeft: number | null; error: string | null }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: { daysLeft: number | null; error: string | null }) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    const socket = connect({ host, port: 443, servername: host, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) return finish({ daysLeft: null, error: "certificat illisible" });
      const daysLeft = Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86_400_000);
      finish({ daysLeft, error: null });
    });
    socket.on("error", (err) => finish({ daysLeft: null, error: err.message }));
    socket.on("timeout", () => {
      socket.destroy();
      finish({ daysLeft: null, error: "timeout TLS" });
    });
  });
}

interface SiteResult {
  cfg: SiteConfig;
  reasons: string[];
  avgMs: number | null;
  sslDaysLeft: number | null;
  sslError: string | null;
}

async function checkSite(cfg: SiteConfig, maxMs: number): Promise<SiteResult> {
  const reasons: string[] = [];
  const times: number[] = [];
  for (const page of cfg.pages) {
    const spec: PageSpec = typeof page === "string" ? { path: page } : page;
    const expect = spec.expect ?? cfg.expect;
    const url = `https://${cfg.domain}${spec.path}`;
    let result = await fetchPage(url, expect, maxMs);
    if (!result.ok) {
      // One retry inside the run to absorb transient runner hiccups; the real
      // anti-flapping (2 consecutive runs) happens across runs via the state.
      await sleep(RETRY_DELAY_MS);
      result = await fetchPage(url, expect, maxMs);
    }
    times.push(result.ms);
    if (!result.ok) reasons.push(`GET ${spec.path} : ${result.reason}`);
  }
  const ssl = await checkSsl(cfg.domain);
  const avgMs = times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
  return { cfg, reasons, avgMs, sslDaysLeft: ssl.daysLeft, sslError: ssl.error };
}

// ------------------------------------------------------------- incidents ---

function openIncident(incidents: Incident[], site: string, type: Incident["type"], started: string, reasons: string[]): void {
  if (incidents.some((i) => i.site === site && i.type === type && i.ended === null)) return;
  incidents.unshift({ site, type, started, ended: null, durationMin: null, reasons });
}

function closeIncident(incidents: Incident[], site: string, type: Incident["type"], ended: string): void {
  const incident = incidents.find((i) => i.site === site && i.type === type && i.ended === null);
  if (!incident) return;
  incident.ended = ended;
  incident.durationMin = Math.max(1, Math.round((Date.parse(ended) - Date.parse(incident.started)) / 60_000));
}

// ---------------------------------------------------------------- output ---

function badgeSvg(up: number, total: number): string {
  const label = "uptime";
  const value = total === 0 ? "no data" : `${up}/${total} OK`;
  const color = up === total ? "#2ea44f" : up === 0 ? "#d73a49" : "#e36209";
  const labelWidth = 7 * label.length + 14;
  const valueWidth = 7 * value.length + 14;
  const width = labelWidth + valueWidth;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${label}: ${value}">
  <rect width="${labelWidth}" height="20" rx="3" fill="#555"/>
  <rect x="${labelWidth}" width="${valueWidth}" height="20" rx="3" fill="${color}"/>
  <rect x="${labelWidth}" width="3" height="20" fill="${color}"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${value}</text>
  </g>
</svg>
`;
}

function readmeTable(states: Record<string, SiteState>, sites: SiteConfig[], now: string): string {
  const rows = sites.map((site) => {
    const s = states[site.domain];
    const status = s.status === "up" ? "🟢 UP" : "🔴 DOWN";
    const ms = s.lastResponseMs === null ? "—" : `${s.lastResponseMs} ms`;
    const ssl = s.sslDaysLeft === null ? "—" : `${s.sslDaysLeft} j${s.sslWarned ? " ⚠️" : ""}`;
    return `| [${site.name}](https://${site.domain}) | ${status} | ${ms} | ${ssl} | ${site.pages.length} |`;
  });
  return [
    "| Site | Statut | Réponse (moy.) | SSL restant | Pages surveillées |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    `_Dernière mise à jour : ${frDate(now)} (Europe/Paris) — mis à jour uniquement quand l'état change._`,
  ].join("\n");
}

function updateReadme(table: string): void {
  const readme = readFileSync(README_FILE, "utf8");
  const updated = readme.replace(
    /<!-- STATUS:START -->[\s\S]*<!-- STATUS:END -->/,
    `<!-- STATUS:START -->\n${table}\n<!-- STATUS:END -->`,
  );
  writeFileSync(README_FILE, updated);
}

// The workflow commits only when this fingerprint changes: status transitions,
// fail-counter moves, alert/SSL flags, new or closed incidents, and the SSL
// countdown crossing a 7-day bucket. Volatile fields (timestamps, response
// times) are deliberately excluded to keep the git history readable.
function fingerprint(states: Record<string, SiteState>, incidents: Incident[]): string {
  const sites = Object.keys(states)
    .sort()
    .map((domain) => {
      const s = states[domain];
      return [
        domain,
        s.status,
        s.consecutiveFails,
        s.alerted,
        s.sslWarned,
        s.sslDaysLeft === null ? -1 : Math.floor(s.sslDaysLeft / 7),
      ];
    });
  return JSON.stringify({
    sites,
    incidents: incidents.length,
    open: incidents.filter((i) => i.ended === null).length,
  });
}

// ---------------------------------------------------------------- emails ---

function smtpConfig() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return {
    host: SMTP_HOST,
    port: Number(SMTP_PORT ?? 587),
    user: SMTP_USER,
    pass: SMTP_PASS,
    from: MAIL_FROM ?? SMTP_USER,
  };
}

async function sendEmails(emails: Email[]): Promise<{ sent: number; failed: number; skipped: number }> {
  if (emails.length === 0) return { sent: 0, failed: 0, skipped: 0 };
  const smtp = smtpConfig();
  if (smtp === null) {
    console.error(
      `✖ ${emails.length} alerte(s) auraient dû partir mais SMTP n'est pas configuré ` +
        "(secrets SMTP_HOST / SMTP_USER / SMTP_PASS) — le run échoue pour vous notifier via GitHub.",
    );
    return { sent: 0, failed: 0, skipped: emails.length };
  }
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });
  let sent = 0;
  let failed = 0;
  for (const email of emails) {
    try {
      await transporter.sendMail({
        from: `"opale-monitoring" <${smtp.from}>`,
        to: email.to,
        subject: email.subject,
        text: email.text,
      });
      email.onSent();
      sent += 1;
      console.log(`  ✉ envoyé : ${email.subject} → ${email.to}`);
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✖ échec d'envoi « ${email.subject} » : ${message}`);
    }
  }
  return { sent, failed, skipped: 0 };
}

// ------------------------------------------------------------------ main ---

function freshState(now: string): SiteState {
  return {
    status: "up",
    consecutiveFails: 0,
    alerted: false,
    downSince: null,
    sslWarned: false,
    sslDaysLeft: null,
    lastCheck: now,
    lastResponseMs: null,
    lastReasons: [],
  };
}

async function main(): Promise<number> {
  const cfg = load(readFileSync(CONFIG_FILE, "utf8")) as Config;
  if (!cfg || !Array.isArray(cfg.sites) || cfg.sites.length === 0) {
    throw new Error(`${CONFIG_FILE} : aucune entrée « sites »`);
  }
  for (const site of cfg.sites) {
    if (!site.domain || !site.alert_email || !Array.isArray(site.pages) || site.pages.length === 0) {
      throw new Error(`${CONFIG_FILE} : entrée invalide (name, domain, alert_email et pages requis) : ${JSON.stringify(site)}`);
    }
  }
  const defaultMaxMs = cfg.defaults?.max_response_time_ms ?? 8000;
  const sslWarnDays = cfg.defaults?.ssl_warn_days ?? 21;

  const oldStates = readJson<Record<string, SiteState>>(STATE_FILE, {});
  const incidents = readJson<Incident[]>(INCIDENTS_FILE, []);
  const oldFingerprint = fingerprint(oldStates, incidents);

  const now = new Date().toISOString();
  const results = await Promise.all(cfg.sites.map((site) => checkSite(site, site.max_response_time_ms ?? defaultMaxMs)));

  const states: Record<string, SiteState> = {};
  const emails: Email[] = [];

  for (const { cfg: site, reasons, avgMs, sslDaysLeft, sslError } of results) {
    const prev = oldStates[site.domain] ?? freshState(now);
    const next: SiteState = { ...prev, lastCheck: now, lastResponseMs: avgMs, sslDaysLeft, lastReasons: reasons };
    states[site.domain] = next;

    const failed = reasons.length > 0;
    if (failed) {
      next.consecutiveFails = prev.consecutiveFails + 1;
      if (next.consecutiveFails >= FAILS_BEFORE_ALERT && next.status === "up") {
        next.status = "down";
        next.downSince = now;
        openIncident(incidents, site.domain, "outage", now, reasons);
      }
      if (next.status === "down" && !next.alerted) {
        emails.push({
          to: site.alert_email,
          subject: `🔴 ${site.name} est DOWN`,
          text: [
            `${site.name} (https://${site.domain}) est en échec depuis ${next.consecutiveFails} contrôles consécutifs.`,
            "",
            "Problèmes détectés :",
            ...reasons.map((reason) => `  - ${reason}`),
            "",
            `Début de l'incident : ${frDate(next.downSince ?? now)} (Europe/Paris)`,
            "Un email de rétablissement suivra quand le site répondra de nouveau.",
            "",
            "— opale-monitoring",
          ].join("\n"),
          onSent: () => {
            next.alerted = true;
          },
        });
      }
      console.log(
        `✖ ${site.domain} — ÉCHEC (${next.consecutiveFails} consécutif(s))` +
          `${next.status === "down" ? " [DOWN]" : ""} — ${reasons.join(" ; ")}`,
      );
    } else {
      if (next.status === "down") {
        next.status = "up";
        closeIncident(incidents, site.domain, "outage", now);
        const downMin = next.downSince
          ? Math.max(1, Math.round((Date.parse(now) - Date.parse(next.downSince)) / 60_000))
          : null;
        if (next.alerted) {
          const lines = [
            `${site.name} (https://${site.domain}) répond de nouveau normalement.`,
            "",
          ];
          if (downMin !== null) lines.push(`Durée de l'incident : ~${downMin} min.`);
          lines.push(`Rétablissement constaté : ${frDate(now)} (Europe/Paris)`, "", "— opale-monitoring");
          emails.push({
            to: site.alert_email,
            subject: `🟢 ${site.name} est rétabli`,
            text: lines.join("\n"),
            onSent: () => {},
          });
        }
        next.alerted = false;
        next.downSince = null;
      }
      next.consecutiveFails = 0;
      const sslLabel = sslDaysLeft === null ? "ssl:?" : `ssl:${sslDaysLeft}j`;
      console.log(`✔ ${site.domain} — OK ${avgMs} ms, ${sslLabel}`);
    }

    // SSL expiry is deterministic (not flaky), so it alerts on the first run
    // that crosses the threshold, once. A probe error is only a soft warning:
    // if TLS were really broken, the page checks above would already fail.
    if (sslError !== null) {
      console.warn(`  ⚠ ${site.domain} : certificat SSL non vérifiable (${sslError})`);
    } else if (sslDaysLeft !== null) {
      if (sslDaysLeft < sslWarnDays && !next.sslWarned) {
        openIncident(incidents, site.domain, "ssl", now, [
          `certificat SSL : expiration dans ${sslDaysLeft} j (seuil ${sslWarnDays} j)`,
        ]);
        emails.push({
          to: site.alert_email,
          subject: `⚠️ Certificat SSL de ${site.name} : expiration dans ${sslDaysLeft} jours`,
          text: [
            `Le certificat SSL de ${site.name} (https://${site.domain}) expire dans ${sslDaysLeft} jours.`,
            "",
            `Seuil d'alerte : ${sslWarnDays} jours. Pensez à vérifier le renouvellement automatique.`,
            "Un email de confirmation suivra quand le certificat sera renouvelé.",
            "",
            "— opale-monitoring",
          ].join("\n"),
          onSent: () => {
            next.sslWarned = true;
          },
        });
      } else if (sslDaysLeft >= sslWarnDays && next.sslWarned) {
        // Good news is best effort: reset the flag even if the email fails.
        next.sslWarned = false;
        closeIncident(incidents, site.domain, "ssl", now);
        emails.push({
          to: site.alert_email,
          subject: `✅ Certificat SSL de ${site.name} renouvelé (${sslDaysLeft} j restants)`,
          text: [
            `Le certificat SSL de ${site.name} (https://${site.domain}) a été renouvelé : ${sslDaysLeft} jours restants.`,
            "",
            "— opale-monitoring",
          ].join("\n"),
          onSent: () => {},
        });
      }
    }
  }

  const mailReport = await sendEmails(emails);

  const newFingerprint = fingerprint(states, incidents);
  if (newFingerprint !== oldFingerprint) {
    mkdirSync("status", { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(states, null, 2) + "\n");
    writeFileSync(INCIDENTS_FILE, JSON.stringify(incidents, null, 2) + "\n");
    const up = Object.values(states).filter((s) => s.status === "up").length;
    writeFileSync(BADGE_FILE, badgeSvg(up, Object.keys(states).length));
    updateReadme(readmeTable(states, cfg.sites, now));
    console.log("Changement d'état → status/ et README mis à jour (commit par le workflow).");
  } else {
    console.log("Aucun changement significatif → rien à commiter.");
  }

  const total = Object.keys(states).length;
  const down = Object.values(states).filter((s) => s.status === "down").length;
  const open = incidents.filter((i) => i.ended === null).length;
  console.log(`Bilan : ${total - down}/${total} sites OK, ${open} incident(s) ouvert(s), ${mailReport.sent} email(s) envoyé(s).`);

  return mailReport.skipped > 0 || mailReport.failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
