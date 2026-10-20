#!/usr/bin/env node
// Validateur du fichier de données PresiTracker2027 (docs/format-donnees.md).
// Usage : node data/validate.mjs <fichier.json> [--previous <ancien.json>]
// Vérifie le schéma JSON (data/schema.json), les règles d'intégrité non exprimables
// en schéma et, avec --previous, les règles de stabilité entre deux versions.
// Code de sortie : 0 si aucune erreur (les avertissements n'échouent pas), 1 sinon.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const THEME_ORDER = ['eco', 'ent', 'fis', 'fin', 'ret', 'edu', 'san', 'def', 'eur', 'etr', 'imm', 'sec', 'ecol', 'inst', 'num', 'log', 'agr'];

const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where} : ${msg}`);
const warn = (where, msg) => warnings.push(`${where} : ${msg}`);

function usage(code) {
  console.error('Usage : node data/validate.mjs <fichier.json> [--previous <ancien.json>]');
  process.exit(code);
}

function parseArgs(argv) {
  const args = { file: null, previous: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--previous') {
      args.previous = argv[++i];
      if (!args.previous) usage(1);
    } else if (a === '--help' || a === '-h') {
      usage(0);
    } else if (!args.file) {
      args.file = a;
    } else {
      usage(1);
    }
  }
  if (!args.file) usage(1);
  return args;
}

function loadJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    console.error(`ERREUR : impossible de lire ${label} « ${path} » (${e.code || e.message}).`);
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`ERREUR : ${label} « ${path} » n'est pas un JSON valide (${e.message}).`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- schéma

function checkSchema(data) {
  const here = dirname(fileURLToPath(import.meta.url));
  const schema = loadJson(join(here, 'schema.json'), 'le schéma');
  // strictRequired désactivé : le « anyOf required » des sondages (noticeUrl ou reportUrl) est voulu.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (validate(data)) return true;
  for (const e of validate.errors) {
    const extra = e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : '';
    err(`schéma ${e.instancePath || '/'}`, `${e.message}${extra}`);
  }
  return false;
}

// ------------------------------------------------------------- intégrité

const normName = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function checkIntegrity(data) {
  const sources = data.sources;
  const today = data.updatedAt.slice(0, 10);
  const usedSources = new Set();
  const refSources = (where, ids) => {
    for (const id of ids || []) {
      usedSources.add(id);
      if (!Object.hasOwn(sources, id)) err(where, `source « ${id} » absente de sources`);
    }
  };

  // Unicité globale des identifiants.
  const seen = new Map();
  const claim = (id, where) => {
    if (seen.has(id)) err(where, `identifiant « ${id} » déjà utilisé par ${seen.get(id)}`);
    else seen.set(id, where);
  };
  for (const id of Object.keys(sources)) claim(id, `sources.${id}`);

  // Sources : dates futures.
  for (const [id, s] of Object.entries(sources)) {
    if (s.date && s.date > today) warn(`sources.${id}`, `date ${s.date} postérieure à updatedAt (${today})`);
  }

  // Élection.
  const el = data.election;
  refSources('election', el.sourceIds);
  if (!(el.round1 < el.round2)) err('election', 'round1 doit précéder round2');
  if (!(el.round1Overseas <= el.round1 && el.round2Overseas <= el.round2)) err('election', 'les tours outre-mer ne peuvent être postérieurs aux tours métropolitains');

  // Thèmes et sous-thèmes.
  const themeKeys = data.themes.map((t) => t.key);
  if (themeKeys.join(',') !== THEME_ORDER.join(',')) err('themes', `ordre ou ensemble des clés attendu : ${THEME_ORDER.join(', ')} ; reçu : ${themeKeys.join(', ')}`);
  const subthemeOf = new Map();
  for (const t of data.themes) {
    claim(t.key, `themes.${t.key}`);
    for (const st of t.subthemes) {
      claim(st.key, `themes.${t.key}.subthemes.${st.key}`);
      if (!st.key.startsWith(`${t.key}-`)) err(`themes.${t.key}.subthemes.${st.key}`, `la clé doit commencer par « ${t.key}- »`);
      subthemeOf.set(st.key, t.key);
    }
  }

  // Candidats et mesures.
  const candidateIds = new Set();
  const measureOwner = new Map();
  for (const c of data.candidates) {
    const cw = `candidates.${c.id}`;
    claim(c.id, cw);
    candidateIds.add(c.id);
    refSources(`${cw}.statusSourceIds`, c.statusSourceIds);
    // sortName : nom de famille normalisé, particule éventuellement omise (« de Villepin » → « villepin »).
    const ln = normName(c.lastName).replace(/ /g, '');
    const sn = c.sortName.replace(/[ '-]/g, '');
    if (sn !== ln && !(ln.endsWith(sn) && /^(de|du|des|d)$/.test(ln.slice(0, ln.length - sn.length)))) warn(cw, `sortName « ${c.sortName} » ne correspond pas au nom « ${c.lastName} »`);
    let prev = '';
    c.statusHistory.forEach((h, i) => {
      refSources(`${cw}.statusHistory[${i}]`, h.sourceIds);
      if (h.date < prev) err(`${cw}.statusHistory[${i}]`, `non trié par date (${h.date} après ${prev})`);
      prev = h.date;
    });
    const last = c.statusHistory[c.statusHistory.length - 1];
    if (last.status !== c.status) err(cw, `status « ${c.status} » différent du dernier statusHistory « ${last.status} »`);
    if (last.date !== c.statusDate) err(cw, `statusDate ${c.statusDate} différente de la date du dernier statusHistory ${last.date}`);
    if (c.statusDate > today) err(cw, `statusDate ${c.statusDate} postérieure à updatedAt`);
    // Parrainages : triés, sans date future ; les décomptes officiels ne baissent pas, aucune promesse après le premier.
    let sp = '';
    let lastOfficial = -1;
    (c.sponsorships || []).forEach((s, i) => {
      const pw = `${cw}.sponsorships[${i}]`;
      refSources(pw, s.sourceIds);
      if (s.date < sp) err(pw, `non trié par date (${s.date} après ${sp})`);
      if (s.date > today) err(pw, `date ${s.date} postérieure à updatedAt`);
      sp = s.date;
      if (s.kind === 'officiel') {
        if (s.count < lastOfficial) err(pw, `décompte officiel en baisse (${lastOfficial} → ${s.count})`);
        lastOfficial = s.count;
        if (!s.sourceIds.some((id) => data.sources[id]?.kind === 'officiel')) err(pw, 'un décompte officiel cite une source « officiel » (Conseil constitutionnel)');
      } else if (lastOfficial >= 0) err(pw, 'promesse annoncée après un décompte officiel : seul le décompte officiel est suivi');
    });

    for (const m of c.measures) {
      const mw = `${cw}.measures.${m.id}`;
      claim(m.id, mw);
      measureOwner.set(m.id, c.id);
      const prefix = `${c.id}-${m.themeKey}-`;
      if (!m.id.startsWith(prefix) || m.id.length === prefix.length) err(mw, `l'identifiant doit avoir la forme « ${prefix}<slug> »`);
      if (!subthemeOf.has(m.subthemeKey)) err(mw, `subthemeKey « ${m.subthemeKey} » inconnu`);
      else if (subthemeOf.get(m.subthemeKey) !== m.themeKey) err(mw, `subthemeKey « ${m.subthemeKey} » n'appartient pas au thème « ${m.themeKey} »`);
      refSources(`${mw}.sourceIds`, m.sourceIds);

      const h = m.history;
      if (h[0].type !== 'ajout') err(mw, `le premier élément de history doit être « ajout » (reçu « ${h[0].type} »)`);
      if (h.filter((x) => x.type === 'ajout').length > 1) err(mw, 'history contient plusieurs entrées « ajout »');
      let p = '';
      h.forEach((x, i) => {
        refSources(`${mw}.history[${i}]`, x.sourceIds);
        if (x.date < p) err(`${mw}.history[${i}]`, `history non trié par date (${x.date} après ${p})`);
        if (x.date > today) err(`${mw}.history[${i}]`, `date ${x.date} postérieure à updatedAt`);
        p = x.date;
      });
      if (m.firstSeen !== h[0].date) err(mw, `firstSeen ${m.firstSeen} différent de la date de l'ajout ${h[0].date}`);
      if (m.lastChanged !== h[h.length - 1].date) err(mw, `lastChanged ${m.lastChanged} différent de la date de la dernière entrée de history ${h[h.length - 1].date}`);
      const lastType = h[h.length - 1].type;
      const hasAbandon = h.some((x) => x.type === 'abandon');
      if (m.status === 'abandonnee' && !hasAbandon) err(mw, 'status « abandonnee » sans entrée « abandon » dans history');
      if (m.status === 'active' && lastType === 'abandon') err(mw, 'status « active » alors que la dernière entrée de history est un abandon');
      // Les sources de l'historique doivent figurer dans sourceIds de la mesure.
      const ms = new Set(m.sourceIds);
      for (const x of h) for (const s of x.sourceIds) if (!ms.has(s)) warn(mw, `source « ${s} » citée dans history mais absente de sourceIds`);
    }
  }

  // Questionnaire.
  const q = data.questionnaire;
  const perTheme = new Map(THEME_ORDER.map((k) => [k, { total: 0, core: 0 }]));
  let pos = 0;
  let neg = 0;
  for (const qu of q.questions) {
    const qw = `questionnaire.${qu.id}`;
    claim(qu.id, qw);
    const pt = perTheme.get(qu.themeKey);
    pt.total += 1;
    if (qu.core) pt.core += 1;
    refSources(`${qw}.contextSourceIds`, qu.contextSourceIds);
    for (const [cid, st] of Object.entries(qu.stances)) {
      const sw = `${qw}.stances.${cid}`;
      if (!candidateIds.has(cid)) err(sw, `candidat « ${cid} » inconnu`);
      for (const mid of st.measureIds || []) {
        if (!measureOwner.has(mid)) err(sw, `mesure « ${mid} » inconnue`);
        else if (measureOwner.get(mid) !== cid) err(sw, `la mesure « ${mid} » appartient à « ${measureOwner.get(mid)} », pas à « ${cid} »`);
      }
      refSources(`${sw}.sourceIds`, st.sourceIds);
      if (st.value > 0) pos += 1;
      if (st.value < 0) neg += 1;
    }
  }
  for (const [k, v] of perTheme) {
    if (v.total !== 2) err(`questionnaire`, `le thème « ${k} » compte ${v.total} question(s) au lieu de 2`);
    if (v.core !== 1) err(`questionnaire`, `le thème « ${k} » compte ${v.core} question(s) core au lieu de 1`);
  }

  // Sondages.
  for (const p of data.polls) {
    const pw = `polls.${p.id}`;
    claim(p.id, pw);
    if (p.fieldworkStart > p.fieldworkEnd) err(pw, 'fieldworkStart postérieur à fieldworkEnd');
    if (p.fieldworkEnd > p.publishedAt) err(pw, 'fieldworkEnd postérieur à publishedAt');
    if (p.publishedAt > today) err(pw, 'publishedAt postérieur à updatedAt');
    if (!p.noticeUrl) warn(pw, 'pas de noticeUrl (notice de la Commission des sondages)');
    const hids = new Set();
    for (const h of p.hypotheses) {
      const hw = `${pw}.${h.id}`;
      if (hids.has(h.id)) err(hw, 'identifiant d\'hypothèse en double dans l\'enquête');
      hids.add(h.id);
      if (p.round === 2 && h.results.length !== 2) err(hw, `un duel de second tour doit avoir 2 résultats (reçu ${h.results.length})`);
      const cids = new Set();
      let sum = 0;
      for (const r of h.results) {
        sum += r.value;
        if (r.candidateId) {
          if (!candidateIds.has(r.candidateId)) err(hw, `candidateId « ${r.candidateId} » inconnu`);
          if (cids.has(r.candidateId)) err(hw, `candidat « ${r.candidateId} » présent deux fois`);
          cids.add(r.candidateId);
        }
      }
      // Tolérance d'arrondi : 0,5 point par résultat publié.
      if (sum > 100 + 0.5 * h.results.length) warn(hw, `somme des résultats ${sum} supérieure à 100 au-delà des arrondis`);
    }
  }

  // Agenda.
  for (const a of data.agenda) {
    claim(a.id, `agenda.${a.id}`);
    refSources(`agenda.${a.id}`, a.sourceIds);
  }

  // Vie de la campagne : candidats connus, citation obligatoire pour une déclaration, pas de date future.
  for (const e of data.campaignEvents) {
    const ew = `campaignEvents.${e.id}`;
    claim(e.id, ew);
    refSources(ew, e.sourceIds);
    for (const cid of e.candidateIds) if (!candidateIds.has(cid)) err(ew, `candidateId « ${cid} » inconnu`);
    if (e.date > today) err(ew, `date ${e.date} postérieure à updatedAt`);
    if (e.type === 'declaration' && !e.quote) err(ew, 'une déclaration doit citer les propos (quote)');
    if ((e.type === 'ralliement' || e.type === 'alliance') && e.candidateIds.length < 2 && !/parti|formation|mouvement/i.test(e.text)) {
      warn(ew, `${e.type} sans second candidat : préciser dans le texte la formation concernée`);
    }
  }

  // Journal éditorial : du plus récent au plus ancien.
  for (let i = 1; i < data.editorialLog.length; i++) {
    if (data.editorialLog[i].date > data.editorialLog[i - 1].date) err(`editorialLog[${i}]`, 'le journal doit être trié du plus récent au plus ancien');
  }
  if (data.editorialLog[0].date > today) err('editorialLog[0]', 'date postérieure à updatedAt');

  // Sources inutilisées.
  const unused = Object.keys(sources).filter((id) => !usedSources.has(id));
  if (unused.length) warn('sources', `${unused.length} source(s) jamais référencée(s) : ${unused.slice(0, 10).join(', ')}${unused.length > 10 ? '…' : ''}`);

  return { candidateIds, measureOwner, stanceBalance: { pos, neg } };
}

// ------------------------------------------------------------- stabilité

function index(arr) {
  return new Map(arr.map((x) => [x.id, x]));
}

function checkStability(data, prev) {
  const today = data.updatedAt.slice(0, 10);
  if (prev.updatedAt && data.updatedAt < prev.updatedAt) err('stabilité', `updatedAt ${data.updatedAt} antérieur à celui de la version précédente ${prev.updatedAt}`);

  // Candidats : jamais supprimés, même personne.
  const cNew = index(data.candidates);
  for (const pc of prev.candidates || []) {
    const nc = cNew.get(pc.id);
    const w = `stabilité candidates.${pc.id}`;
    if (!nc) {
      err(w, 'candidat supprimé : un candidat ne disparaît jamais (utiliser le statut « retire »)');
      continue;
    }
    const before = normName(`${pc.firstName} ${pc.lastName}`);
    const after = normName(`${nc.firstName} ${nc.lastName}`);
    if (before !== after) err(w, `identifiant réutilisé pour une autre personne (« ${pc.firstName} ${pc.lastName} » devenu « ${nc.firstName} ${nc.lastName} »)`);
    else if (`${pc.firstName} ${pc.lastName}` !== `${nc.firstName} ${nc.lastName}`) warn(w, `graphie du nom modifiée (« ${pc.firstName} ${pc.lastName} » → « ${nc.firstName} ${nc.lastName} »)`);
    const ph = pc.statusHistory || [];
    const nh = nc.statusHistory || [];
    for (let i = 0; i < ph.length; i++) {
      if (!nh[i] || nh[i].date !== ph[i].date || nh[i].status !== ph[i].status) {
        warn(w, `statusHistory[${i}] modifié ou supprimé : l'historique de statut ne devrait que s'allonger`);
        break;
      }
    }
    // Parrainages : les relevés publiés sont conservés.
    const pspon = Array.isArray(pc.sponsorships) ? pc.sponsorships : [];
    const nspon = nc.sponsorships || [];
    for (let i = 0; i < pspon.length; i++) {
      const n = nspon[i];
      if (!n || n.date !== pspon[i].date || n.count !== pspon[i].count || n.kind !== pspon[i].kind) {
        warn(w, `sponsorships[${i}] modifié ou supprimé : le suivi des parrainages ne devrait que s'allonger`);
        break;
      }
    }
    if (pc.status !== nc.status && !(nh.length > ph.length)) warn(w, `statut passé de « ${pc.status} » à « ${nc.status} » sans nouvelle entrée statusHistory`);

    // Mesures.
    const mNew = index(nc.measures);
    for (const pm of pc.measures || []) {
      const mw = `stabilité ${pm.id}`;
      const nm = mNew.get(pm.id);
      if (!nm) {
        warn(mw, 'mesure supprimée : elle sera enregistrée comme « correction » (erreur de saisie corrigée). Pour une renonciation du candidat, utiliser status « abandonnee » et une entrée « abandon »');
        continue;
      }
      if (pm.themeKey !== nm.themeKey) err(mw, `identifiant réutilisé dans un autre thème (« ${pm.themeKey} » → « ${nm.themeKey} »)`);
      if (pm.firstSeen !== nm.firstSeen) err(mw, `firstSeen modifié (${pm.firstSeen} → ${nm.firstSeen})`);
      const ph2 = pm.history || [];
      for (let i = 0; i < ph2.length; i++) {
        if (!nm.history[i] || JSON.stringify(nm.history[i]) !== JSON.stringify(ph2[i])) {
          err(mw, `history[${i}] modifié ou supprimé : l'historique d'une mesure ne fait que s'allonger`);
          break;
        }
      }
      const added = nm.history.slice(ph2.length);
      const changedText = pm.title !== nm.title || pm.detail !== nm.detail;
      if (changedText && !added.some((x) => x.type === 'modification' && x.date === today)) {
        warn(mw, `title ou detail modifié sans entrée history « modification » datée du ${today} (le backend l'enregistrera comme différence détectée)`);
      }
      if (pm.status !== nm.status && !added.some((x) => (nm.status === 'abandonnee' ? x.type === 'abandon' : true))) {
        warn(mw, `status passé de « ${pm.status} » à « ${nm.status} » sans nouvelle entrée history`);
      }
    }
  }

  // Questions : même identifiant = même affirmation.
  const qNew = index(data.questionnaire.questions);
  let statementChanged = false;
  for (const pq of prev.questionnaire?.questions || []) {
    const nq = qNew.get(pq.id);
    const w = `stabilité ${pq.id}`;
    if (!nq) {
      warn(w, 'question retirée du questionnaire (l\'identifiant ne doit jamais être réutilisé)');
      continue;
    }
    if (pq.themeKey !== nq.themeKey) err(w, `identifiant réutilisé dans un autre thème (« ${pq.themeKey} » → « ${nq.themeKey} »)`);
    if (pq.statement !== nq.statement) {
      statementChanged = true;
      warn(w, 'énoncé modifié : si le sens change, créer une nouvelle question avec un nouvel identifiant');
    }
  }
  const qAddedOrRemoved = data.questionnaire.questions.length !== (prev.questionnaire?.questions || []).length
    || data.questionnaire.questions.some((q) => !(prev.questionnaire?.questions || []).some((p) => p.id === q.id));
  if ((statementChanged || qAddedOrRemoved) && data.questionnaire.version === prev.questionnaire?.version) {
    err('stabilité questionnaire', 'questions ajoutées, retirées ou reformulées sans changement de questionnaire.version');
  }

  // Sources : même identifiant = même document.
  for (const [id, ps] of Object.entries(prev.sources || {})) {
    const ns = data.sources[id];
    const w = `stabilité sources.${id}`;
    if (!ns) {
      warn(w, 'source supprimée');
      continue;
    }
    if (ps.url !== ns.url) err(w, `identifiant réutilisé pour une autre URL (${ps.url} → ${ns.url})`);
    if (ps.date && ns.date && ps.date !== ns.date) warn(w, `date modifiée (${ps.date} → ${ns.date})`);
  }

  // Sondages.
  const pNew = index(data.polls);
  for (const pp of prev.polls || []) {
    const np = pNew.get(pp.id);
    const w = `stabilité polls.${pp.id}`;
    if (!np) {
      warn(w, 'sondage supprimé');
      continue;
    }
    if (pp.institute !== np.institute || pp.fieldworkEnd !== np.fieldworkEnd || pp.round !== np.round) err(w, 'identifiant réutilisé pour une autre enquête (institut, fin de terrain ou tour différent)');
  }

  // Agenda.
  const aNew = index(data.agenda);
  for (const pa of prev.agenda || []) {
    const na = aNew.get(pa.id);
    if (!na) warn(`stabilité agenda.${pa.id}`, 'échéance supprimée');
    else if (pa.kind !== na.kind) warn(`stabilité agenda.${pa.id}`, `nature modifiée (« ${pa.kind} » → « ${na.kind} »)`);
  }

  // Vie de la campagne : un événement publié n'est ni supprimé ni requalifié.
  const eNew = index(data.campaignEvents);
  for (const pe of prev.campaignEvents || []) {
    const ne = eNew.get(pe.id);
    if (!ne) warn(`stabilité campaignEvents.${pe.id}`, 'événement supprimé');
    else if (pe.type !== ne.type || pe.date !== ne.date) warn(`stabilité campaignEvents.${pe.id}`, `type ou date modifiés (${pe.type} ${pe.date} → ${ne.type} ${ne.date})`);
  }

  // Journal : les entrées précédentes sont conservées.
  const prevLog = prev.editorialLog || [];
  const newLog = data.editorialLog;
  const tail = newLog.slice(newLog.length - prevLog.length);
  if (JSON.stringify(tail) !== JSON.stringify(prevLog)) warn('stabilité editorialLog', 'les entrées précédentes du journal ont été modifiées ou supprimées');
  if (!newLog.some((e) => e.date === today)) warn('stabilité editorialLog', `aucune entrée datée du ${today}`);
}

// ------------------------------------------------------------------ main

function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = loadJson(args.file, 'le fichier');
  console.log(`Validation de ${args.file}${args.previous ? ` (version précédente : ${args.previous})` : ''}`);

  const schemaOk = checkSchema(data);
  let stats = null;
  if (schemaOk) {
    stats = checkIntegrity(data);
    if (args.previous) {
      const prev = loadJson(args.previous, 'la version précédente');
      checkStability(data, prev);
    }
  } else {
    console.log('Le schéma n\'est pas respecté : les contrôles d\'intégrité et de stabilité ne sont pas exécutés.');
  }

  if (warnings.length) {
    console.log(`\nAvertissements (${warnings.length}) :`);
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }
  if (errors.length) {
    console.log(`\nErreurs (${errors.length}) :`);
    for (const e of errors) console.log(`  ✗ ${e}`);
  }

  if (stats) {
    const nm = data.candidates.reduce((n, c) => n + c.measures.length, 0);
    const ns = data.questionnaire.questions.reduce((n, q) => n + Object.keys(q.stances).length, 0);
    console.log(`\nContenu : ${data.candidates.length} candidats, ${nm} mesures, ${Object.keys(data.sources).length} sources, ${data.questionnaire.questions.length} questions (${ns} positions renseignées), ${data.polls.length} sondages, ${data.agenda.length} échéances, ${data.campaignEvents.length} événements de campagne, ${data.candidates.filter((c) => c.sponsorships).length} candidats avec un suivi des parrainages.`);
  }
  if (errors.length) {
    console.log(`\nÉCHEC : ${errors.length} erreur(s), ${warnings.length} avertissement(s).`);
    process.exit(1);
  }
  console.log(`\nOK : aucune erreur, ${warnings.length} avertissement(s).`);
}

main();
