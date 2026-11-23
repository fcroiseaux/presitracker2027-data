// Relève les notices d'intentions de vote publiées par la Commission des sondages.
// Écrit notices-commission.json : numéro, titre, adresse et métadonnées factuelles (institut, commanditaires,
// dates de terrain, échantillons), sans le texte ni les scores, pour que la rédaction rattache chaque notice.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGIN = "https://www.commission-des-sondages.fr";
const OUTPUT = "notices-commission.json";
const MIN_LINKS = 50;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const IS_VOTING_INTENTION = /^pres\b.*(\biv\b|presitrack|barom[eè]tre.*[eé]lection)/i;
const INSTITUTES = [
  [/toluna|harris/i, "Toluna Harris Interactive"],
  [/ifop/i, "Ifop"],
  [/opinion ?way|presitrack/i, "OpinionWay"],
  [/elabe/i, "Elabe"],
  [/ipsos/i, "Ipsos bva"],
  [/cluster ?17/i, "Cluster17"],
  [/yougov/i, "YouGov"],
  [/odoxa/i, "Odoxa"],
  [/verian/i, "Verian"],
  [/\bcsa\b/i, "CSA"],
];
const MONTHS = { janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12 };
const MONTH = Object.keys(MONTHS).join("|");

const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const iso = (y, m, d) => `${y}-${String(MONTHS[m.toLowerCase()]).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const count = (s) => Number(s.replace(/\s/g, ""));

export function parseFieldwork(text) {
  const t = text.replace(/\((?:[^()]|\([^()]*\))*\)/g, " ").replace(/1\s*er/g, "1").replace(/\s+/g, " ");
  const cross = t.match(new RegExp(`(?:du|les?)\\s+(\\d{1,2})\\s+(${MONTH})(?:\\s+à partir de \\d{1,2}\\s?h\\d{0,2})?\\s+(?:au|et)\\s+(\\d{1,2})\\s+(${MONTH})\\s+(20\\d\\d)`, "i"));
  if (cross) return { fieldworkStart: iso(cross[5], cross[2], cross[1]), fieldworkEnd: iso(cross[5], cross[4], cross[3]) };
  const same = t.match(new RegExp(`(?:du|les?)\\s+(\\d{1,2})\\s+(?:au|et)\\s+(\\d{1,2})\\s+(${MONTH})\\s+(20\\d\\d)`, "i"));
  if (same) return { fieldworkStart: iso(same[4], same[3], same[1]), fieldworkEnd: iso(same[4], same[3], same[2]) };
  return { fieldworkStart: null, fieldworkEnd: null };
}

export function parseSamples(text) {
  const t = text.replace(/\s+/g, " ");
  const N = "(\\d{1,2}[  ]?\\d{3}|\\d{3})";
  const registered =
    t.match(new RegExp(`[ée]chantillon de ${N} personnes inscrites`, "i")) ??
    t.match(new RegExp(`(?:dont|parmi lesquels) ${N} (?:personnes )?inscrit`, "i")) ??
    t.match(new RegExp(`${N} personnes inscrites`, "i"));
  const total =
    t.match(new RegExp(`(?:issu|extrait) d.un [ée]chantillon(?: de)? ${N}`, "i")) ??
    t.match(new RegExp(`repr[ée]sentatif de ${N} Fran`, "i")) ??
    t.match(new RegExp(`[ée]chantillon de ${N} personnes,? repr[ée]sentatif`, "i")) ??
    t.match(new RegExp(`[ée]chantillon de ${N} Fran[çc]ais`, "i")) ??
    t.match(new RegExp(`${N} personnes repr[ée]sentatives`, "i"));
  return { sampleRegistered: registered ? count(registered[1]) : null, sampleTotal: total ? count(total[1]) : null };
}

export function parseSponsors(text) {
  const t = text.replace(/[ \t]+/g, " ");
  const m =
    t.match(/acheteur du sondage ?: ?([^\n]+)/i) ??
    t.match(/commanditaires?(?: du sondage|\(s\)| ?:) ?:? ?([^\n]+)/i) ??
    t.match(/[ÉE]tude \S* ?r[ée]alis[ée]e? (?:par [^\n]*? )?pour ([^\n]+?)(?: aupr[èe]s|\n ?[a-zé]|$)/im) ??
    t.match(/Enqu[êe]te r[ée]alis[ée]e pour (?:le journal )?([^\n]+?) et publi/i);
  if (!m) return [];
  return m[1]
    .replace(/\s+/g, " ")
    .replace(new RegExp(`\\s+(?:${MONTH})\\s+20\\d\\d.*$`, "i"), "")
    .split(/\s*(?:,|\/|&|\bet\b)\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && s.length < 40);
}

async function readMeta(url, title) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 4).toString() !== "%PDF") throw new Error("PDF invalide");
  const dir = mkdtempSync(join(tmpdir(), "notice-"));
  try {
    const file = join(dir, "n.pdf");
    writeFileSync(file, bytes);
    // Selon la mise en page, le texte en colonnes ou le texte brut donne la lecture correcte.
    const extract = (mode) => execFileSync("pdftotext", ["-f", "1", "-l", "8", ...mode, file, "-"], { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 }).slice(0, 9000);
    const layout = extract(["-layout"]);
    const plain = extract([]);
    const fieldwork = parseFieldwork(layout);
    const samples = parseSamples(layout);
    const plainSamples = parseSamples(plain);
    return {
      institute: INSTITUTES.find(([re]) => re.test(title))?.[1] ?? null,
      sponsors: parseSponsors(layout),
      ...(fieldwork.fieldworkEnd ? fieldwork : parseFieldwork(plain)),
      sampleRegistered: samples.sampleRegistered ?? plainSamples.sampleRegistered,
      sampleTotal: samples.sampleTotal ?? plainSamples.sampleTotal,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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
let unread = 0;
for (const { path, text } of links) {
  const match = text.match(/^(\d+)\s+(.+)$/);
  if (!match || !IS_VOTING_INTENTION.test(match[2])) continue;
  const number = Number(match[1]);
  const title = match[2];
  const previous = known.get(number);
  const url = previous?.url ?? (await resolvePdf(path));
  let meta = previous && "fieldworkEnd" in previous ? { institute: previous.institute, sponsors: previous.sponsors, fieldworkStart: previous.fieldworkStart, fieldworkEnd: previous.fieldworkEnd, sampleRegistered: previous.sampleRegistered, sampleTotal: previous.sampleTotal } : null;
  if (!meta) {
    try {
      meta = await readMeta(url, title);
    } catch (error) {
      unread += 1;
      console.warn(`Notice ${number} non lue : ${error.message}`);
      meta = {};
    }
  }
  notices.push({ number, title, url, ...meta });
}
notices.sort((a, b) => b.number - a.number);
writeFileSync(OUTPUT, `${JSON.stringify({ source: `${ORIGIN}/notices/`, notices }, null, 2)}\n`);
const added = notices.filter((n) => !known.has(n.number));
const incomplete = notices.filter((n) => !n.fieldworkEnd || !n.institute).map((n) => n.number);
console.log(`${links.length} notices lues, ${notices.length} d'intentions de vote, ${added.length} nouvelle(s)${added.length ? ` : ${added.map((n) => n.number).join(", ")}` : ""} ; ${unread} PDF non lu(s) ; métadonnées incomplètes : ${incomplete.join(", ") || "aucune"}`);
