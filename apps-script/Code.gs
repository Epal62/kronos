/**
 * KRONOS – Rappels Slack automatiques (Google Apps Script)
 * -----------------------------------------------------------------
 * Toutes les 5 minutes, lit les créneaux de rattrapage dans Firestore
 * et poste un rappel Slack X minutes avant le début (X et l'URL du
 * webhook sont réglés dans Kronos > Paramètres).
 *
 * Installation : voir README (section « Rappels Slack »).
 *   1. Renseigner PROJECT_ID ci-dessous.
 *   2. Exécuter testKronos() une fois (autorisations + vérification).
 *   3. Exécuter installTrigger() une fois (déclenchement toutes les 5 min).
 *
 * Le compte Google qui exécute ce script doit être Propriétaire ou
 * Éditeur du projet Firebase (l'accès passe par les droits Google Cloud,
 * pas par la connexion de l'appli).
 */

const PROJECT_ID = 'kronos-c3c4f';   // ← ID du projet Firebase (Paramètres du projet > ID du projet)
const TZ = 'Europe/Paris';
const COLL = 'kronos_rattrapages';

/* ================= Point d'entrée (déclenché toutes les 5 min) ================= */
function checkReminders() {
  const settings = getSettings_();
  if (!settings.reminderOn) return log_('Rappels désactivés dans Kronos.');
  if (!settings.slackWebhook) return log_('Aucun webhook Slack renseigné dans Kronos.');
  const minutes = Number(settings.reminderMin) || 75;

  const now = new Date();
  const due = getUpcoming_().filter(r => {
    if (r.status !== 'prevu' || r.reminderSentAt) return false;
    const start = startOf_(r);
    if (!start) return false;
    const remindAt = new Date(start.getTime() - minutes * 60000);
    return now >= remindAt && now < start;           // fenêtre : de X min avant jusqu'au début
  });
  if (!due.length) return log_('Aucun rappel à envoyer.');

  // Un message par créneau (plusieurs élèves peuvent partager le même créneau)
  const groups = {};
  due.forEach(r => { const g = r.group || r.id; (groups[g] = groups[g] || []).push(r); });

  Object.keys(groups).forEach(g => {
    const list = groups[g];
    const left = Math.max(5, Math.round((startOf_(list[0]) - now) / 60000 / 5) * 5);   // minutes réellement restantes
    const code = postSlack_(settings.slackWebhook, reminderMessage_(list, left));
    if (code === 200) {
      const stamp = new Date().toISOString();
      list.forEach(r => markSent_(r.id, stamp));
      log_('Rappel envoyé : ' + list.map(r => r.studentName).join(', '));
    } else {
      log_('Échec Slack (code ' + code + ') pour le créneau ' + g);
    }
  });
}

/* ================= Message Slack ================= */
function reminderMessage_(list, minutes) {
  const r = list[0];
  const jour = Utilities.formatDate(startOf_(r), TZ, 'dd/MM/yyyy');
  const h = Math.floor(minutes / 60), m = minutes % 60;
  const delai = h ? h + ' h' + (m ? ' ' + ('0' + m).slice(-2) : '') : m + ' min';
  const eleves = list.map(x => '• ' + x.studentName + ' (' + x.classe + ')').join('\n');
  return {
    text: '⏰ Rappel : rattrapage à ' + r.start + ' (dans ' + delai + ')',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '⏰ Rappel : rattrapage dans ' + delai } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: '*Quand*\n' + jour + ', ' + r.start + '–' + r.end },
        { type: 'mrkdwn', text: '*Où*\n' + (r.lieu || '—') },
        { type: 'mrkdwn', text: '*Encadrant*\n' + (r.encadrant || '—') },
        { type: 'mrkdwn', text: '*Motif*\n' + (r.motif || "Rattrapage d'heures") } ] },
      { type: 'section', text: { type: 'mrkdwn', text: '*Élève' + (list.length > 1 ? 's' : '') + ' (' + list.length + ')*\n' + eleves } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Rappel automatique Kronos' }] }
    ]
  };
}

function postSlack_(url, payload) {
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  return res.getResponseCode();
}

/* ================= Firestore (API REST) ================= */
function base_() {
  return 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents';
}
function fs_(method, path, body) {
  const res = UrlFetchApp.fetch(path.indexOf('http') === 0 ? path : base_() + path, {
    method: method, contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'x-goog-user-project': PROJECT_ID },
    payload: body ? JSON.stringify(body) : undefined, muteHttpExceptions: true
  });
  const code = res.getResponseCode(), txt = res.getContentText();
  if (code >= 300) throw new Error('Firestore ' + code + ' : ' + txt);
  return JSON.parse(txt || '{}');
}
function getSettings_() {
  try { return decode_(fs_('get', '/kronos_meta/settings').fields || {}); }
  catch (e) { if (String(e).indexOf('404') > -1) return {}; throw e; }
}
/** Créneaux d'aujourd'hui et de demain (le filtre fin se fait en JS). */
function getUpcoming_() {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const tomorrow = Utilities.formatDate(new Date(Date.now() + 864e5), TZ, 'yyyy-MM-dd');
  const res = fs_('post', ':runQuery', { structuredQuery: {
    from: [{ collectionId: COLL }],
    where: { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: today } } },
      { fieldFilter: { field: { fieldPath: 'date' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: tomorrow } } } ] } }
  } });
  return (res || []).filter(x => x.document).map(x => {
    const d = decode_(x.document.fields || {});
    d.id = d.id || x.document.name.split('/').pop();
    return d;
  });
}
function markSent_(id, stamp) {
  fs_('patch', '/' + COLL + '/' + encodeURIComponent(id) + '?updateMask.fieldPaths=reminderSentAt',
      { fields: { reminderSentAt: { stringValue: stamp } } });
}
function decode_(fields) {
  const out = {};
  Object.keys(fields).forEach(k => out[k] = val_(fields[k]));
  return out;
}
function val_(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return decode_(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(val_);
  return null;
}

/* ================= Utilitaires ================= */
function startOf_(r) {
  if (!r.date || !r.start) return null;
  return Utilities.parseDate(r.date + ' ' + r.start, TZ, 'yyyy-MM-dd HH:mm');
}
function log_(msg) { console.log(msg); }

/* ================= À exécuter à la main ================= */
/** Vérifie l'accès Firestore et Slack, et affiche les prochains créneaux (n'envoie rien). */
function testKronos() {
  const s = getSettings_();
  log_('Paramètres Kronos lus ✔  rappel ' + (s.reminderOn ? 'activé' : 'désactivé') +
       ', ' + (s.reminderMin || 75) + ' min avant, webhook ' + (s.slackWebhook ? 'renseigné' : 'MANQUANT'));
  const list = getUpcoming_();
  log_(list.length + ' créneau(x) aujourd\'hui/demain :');
  list.forEach(r => log_('  ' + r.date + ' ' + r.start + ' – ' + r.studentName + ' [' + r.status + ']' + (r.reminderSentAt ? ' (rappel déjà envoyé)' : '')));
}
/** Envoie un message de test sur le canal Slack. */
function testSlack() {
  const s = getSettings_();
  if (!s.slackWebhook) throw new Error('Aucun webhook dans Kronos > Paramètres');
  log_('Code Slack : ' + postSlack_(s.slackWebhook, { text: '👋 Test du script de rappels Kronos : OK.' }));
}
/** Crée (ou recrée) le déclenchement automatique toutes les 5 minutes. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkReminders').timeBased().everyMinutes(5).create();
  log_('Déclencheur installé : checkReminders toutes les 5 minutes.');
}
/** Arrête les rappels automatiques. */
function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  log_('Déclencheurs supprimés.');
}
