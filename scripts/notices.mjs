// Relève les notices d'intentions de vote publiées par la Commission des sondages.
// Écrit notices-commission.json (numéro, titre, adresse), que la rédaction quotidienne compare aux sondages saisis.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ORIGIN = "https://www.commission-des-sondages.fr";
const OUTPUT = "notices-commission.json";
const MIN_LINKS = 50;
const IS_VOTING_INTENTION = /^pres\b.*(\biv\b|presitrack|barom[eè]tre.*[eé]lection)/i;

const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

async function resolvePdf(path) {
  const res = await fetch(`${ORIGIN}${path}`, { method: "HEAD", redirect: "manual" });
  const location = res.headers.get("location");
  if (res.status < 300 || res.status >= 400 || !location) throw new Error(`Redirection absente pour ${path} (HTTP ${res.status})`);
  const url = new URL(location, ORIGIN);
  if (url.hostname.replace(/^www\./, "") !== "commission-des-sondages.fr" || !url.pathname.endsWith(".pdf")) throw new Error(`Adresse inattendue : ${url}`);
  return `${ORIGIN}${url.pathname}`;
}

const page = await fetch(`${ORIGIN}/notices/`);
if (!page.ok) throw new Error(`Page des notices : HTTP ${page.status}`);
const html = await page.text();
const links = [...html.matchAll(/href="(\/notices\/medias\/fichiers\/add\/\d+)"[^>]*>([^<]+)</g)].map((m) => ({ path: m[1], text: decode(m[2]) }));
if (links.length < MIN_LINKS) throw new Error(`Seulement ${links.length} notices lues : structure de la page à vérifier`);

const known = new Map(existsSync(OUTPUT) ? JSON.parse(readFileSync(OUTPUT, "utf8")).notices.map((n) => [n.number, n]) : []);
const notices = [];
for (const { path, text } of links) {
  const match = text.match(/^(\d+)\s+(.+)$/);
  if (!match || !IS_VOTING_INTENTION.test(match[2])) continue;
  const number = Number(match[1]);
  const title = match[2];
  notices.push({ number, title, url: known.get(number)?.url ?? (await resolvePdf(path)) });
}
notices.sort((a, b) => b.number - a.number);
writeFileSync(OUTPUT, `${JSON.stringify({ source: `${ORIGIN}/notices/`, notices }, null, 2)}\n`);
const added = notices.filter((n) => !known.has(n.number));
console.log(`${links.length} notices lues, ${notices.length} d'intentions de vote, ${added.length} nouvelle(s)${added.length ? ` : ${added.map((n) => n.number).join(", ")}` : ""}`);
