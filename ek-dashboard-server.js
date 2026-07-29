/* =============================================================================
   EARL KENDRICK DASHBOARD  ·  daily data service  ·  built by NXRD

   What changed in this version
   ----------------------------
   1. WEEKLY. The service now builds a "weeks" array as well as "months", so the
      Monthly / Weekly switch on the dashboard runs on live figures instead of
      the arrays hardcoded in the HTML. Twelve completed Monday to Sunday weeks
      by default.
   2. SEARCH TERMS PER PERIOD. Search Console rows are now pulled for each month
      and each week and attached to that period as searchTerms, which is what the
      dashboard's Top search terms table and its movement arrows expect. A top
      level searchTerms is still sent as a fallback.
   3. CREDENTIALS THAT WORK ON RENDER. Render has no durable disk, so a path in
      GOOGLE_APPLICATION_CREDENTIALS pointing at a file that is not in the repo
      will always fail, silently, and both Google pulls die. Set
      GOOGLE_CREDENTIALS_JSON instead, holding the whole service account key.
   4. DIAGNOSTICS. Failed pulls used to vanish into console.error, so the feed
      looked healthy while serving nothing. There is now a _diag block on the
      payload and a /api/diagnostics route that says plainly what worked, what
      failed and why.
   5. GBP PER PERIOD. gbpByPeriod passes through from manual.json so the Google
      Business tab follows the period switch. Google Business Profile has no
      automated pull here, that data is entered by hand.

   Endpoints
   ---------
     GET  /api/ek-dashboard.json   the daily feed the dashboard reads on load
     GET  /api/diagnostics         what the last refresh actually managed
     POST /api/refresh             force a rebuild without redeploying
     GET  /api/events              shared events array
     PUT  /api/events              save the whole events array
     GET  /api/linkedin            shared LinkedIn posting board
     PUT  /api/linkedin            save the whole board
     GET  /api/ek-advocacy.json    legacy published advocacy board
     GET  /api/status              shared store health
     GET  /health                  liveness

   Setup
   -----
   1. npm i express cors node-cron @google-analytics/data googleapis pg
   2. A Google service account with Viewer on the GA4 property and access on the
      Search Console property.
   3. Environment variables on Render:

        GOOGLE_CREDENTIALS_JSON = the entire contents of the service account
                                  key file, pasted as one value. Base64 of the
                                  same file also works if the raw JSON is awkward
                                  to paste.
        GA4_PROPERTY_ID   = 381171366
        GSC_SITE_URL      = https://earlkendrick.com/
        DATABASE_URL      = Postgres connection string, for events and LinkedIn
        PORT              = 3000

      Optional:
        WEEKS_BACK             = 12    how many completed weeks to build
        MONTHS_BACK            = 12    how many completed months to build
        LINKEDIN_ACCESS_TOKEN  = 60 day org token
        LINKEDIN_ORG_URN       = urn:li:organization:12345
        LINKEDIN_API_VERSION   = 202605
        REFRESH_TOKEN          = a secret, required on POST /api/refresh if set

   A note on completed periods
   ---------------------------
   Only completed weeks and completed months are built. A part finished period
   reads on the trend line as a collapse in traffic, which is worse than not
   showing it at all. So on a Wednesday the newest week is the one that ended
   the previous Sunday.

   A note on Search Console lag
   ----------------------------
   Search Console data settles two to three days behind. The most recent
   completed week can therefore be slightly light on clicks on the day it first
   appears, and will fill in over the following couple of refreshes.
   ============================================================================= */

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const { google } = require('googleapis');

/* Render runs in UTC. GA4 reports in the property's own timezone, which for
   Earl Kendrick is UK time, so without this the first and last hours of every
   month and week land in the wrong period. Set TZ in the Render environment to
   override. This must happen before any Date is created. */
process.env.TZ = process.env.TZ || 'Europe/London';

const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID || '381171366';
const GSC_SITE_URL    = process.env.GSC_SITE_URL    || 'https://earlkendrick.com/';
const PORT            = process.env.PORT || 3000;
const WEEKS_BACK      = Math.max(2, +(process.env.WEEKS_BACK || 12));
const MONTHS_BACK     = Math.max(2, +(process.env.MONTHS_BACK || 12));
const REFRESH_TOKEN   = process.env.REFRESH_TOKEN || '';
const INCLUDE_CURRENT_MONTH = process.env.INCLUDE_CURRENT_MONTH !== 'false';
const GSC_ROWS        = Math.max(5, +(process.env.GSC_ROWS || 25));
// Search Console publishes two to three days behind. Any period ending inside
// that window is incomplete and is flagged rather than quietly under reported.
const GSC_LAG_DAYS    = Math.max(0, +(process.env.GSC_LAG_DAYS || 3));

// LinkedIn (optional). Leave the token blank and the manual figures are used.
const LI_TOKEN   = process.env.LINKEDIN_ACCESS_TOKEN || '';
const LI_ORG_URN = process.env.LINKEDIN_ORG_URN || '';
const LI_VERSION = process.env.LINKEDIN_API_VERSION || '202605';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MON3   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// The six channel labels the dashboard reads. renderActions looks up
// sources["Email"] and sources["Paid search"] by name, so every period is
// normalised to carry all six even when a channel had no sessions.
const CANONICAL_SOURCES = ['Organic search','Direct','Referral','Social','Email','Paid search','Other'];

/* ---------------------------------------------------------------------------
   CREDENTIALS
   Reads the whole service account key from GOOGLE_CREDENTIALS_JSON, as raw
   JSON or base64. Falls back to application default credentials, which is what
   GOOGLE_APPLICATION_CREDENTIALS uses, so an existing local setup still works.
   --------------------------------------------------------------------------- */
function readCredentials(){
  const raw = (process.env.GOOGLE_CREDENTIALS_JSON || '').trim();
  if (!raw) return null;
  try {
    const txt = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const creds = JSON.parse(txt);
    // Render stores the value as a single line, so the key's newlines arrive
    // escaped. Put them back or the JWT signing fails with an opaque error.
    if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
    return creds;
  } catch (e) {
    console.error('GOOGLE_CREDENTIALS_JSON could not be parsed:', e.message);
    return null;
  }
}

const CREDS = readCredentials();
const analytics = CREDS
  ? new BetaAnalyticsDataClient({ credentials: CREDS, projectId: CREDS.project_id })
  : new BetaAnalyticsDataClient();

function gscClient(){
  const opts = { scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] };
  if (CREDS) opts.credentials = CREDS;
  return google.webmasters({ version: 'v3', auth: new google.auth.GoogleAuth(opts) });
}

/* ---------------------------------------------------------------------------
   SHARED STORE (Postgres)
   Unchanged from the previous version. Events and the LinkedIn board each live
   in one JSON row. Last write wins.
   --------------------------------------------------------------------------- */
const DATABASE_URL = process.env.DATABASE_URL || '';
let eventsPool = null;

if (DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    eventsPool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    eventsPool.query(
      `CREATE TABLE IF NOT EXISTS ek_events (
         id   integer PRIMARY KEY DEFAULT 1,
         data jsonb   NOT NULL DEFAULT '[]'::jsonb
       )`
    ).then(() => console.log('ek_events table ready'))
     .catch(err => console.error('ek_events table error:', err.message));
    eventsPool.query(
      `CREATE TABLE IF NOT EXISTS ek_linkedin (
         id   integer PRIMARY KEY DEFAULT 1,
         data jsonb   NOT NULL DEFAULT '[]'::jsonb
       )`
    ).then(() => console.log('ek_linkedin table ready'))
     .catch(err => console.error('ek_linkedin table error:', err.message));
    // The last good payload, so a cold start serves real figures immediately
    // instead of an empty object.
    eventsPool.query(
      `CREATE TABLE IF NOT EXISTS ek_cache (
         id   integer PRIMARY KEY DEFAULT 1,
         data jsonb   NOT NULL DEFAULT '{}'::jsonb,
         saved_at timestamptz NOT NULL DEFAULT now()
       )`
    ).then(() => console.log('ek_cache table ready'))
     .catch(err => console.error('ek_cache table error:', err.message));
    // Content plan, video library and competitor captures
    eventsPool.query(
      `CREATE TABLE IF NOT EXISTS ek_store (
         key  text PRIMARY KEY,
         data jsonb NOT NULL DEFAULT '[]'::jsonb,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`
    ).then(() => console.log('ek_store table ready'))
     .catch(err => console.error('ek_store table error:', err.message));
  } catch (e) {
    console.error('pg not available, /api/events and /api/linkedin disabled (run: npm i pg):', e.message);
    eventsPool = null;
  }
} else {
  console.warn('DATABASE_URL not set: /api/events and /api/linkedin disabled, those tabs stay local per device.');
}

/* ---------------------------------------------------------------------------
   DATE HELPERS
   --------------------------------------------------------------------------- */
const pad2 = n => String(n).padStart(2, '0');
const iso  = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

function startOfDay(d){ const x = new Date(d); x.setHours(0,0,0,0); return x; }
function addDays(d, n){ const x = new Date(d); x.setDate(x.getDate() + n); return x; }

// Monday of the week containing d
function mondayOf(d){
  const x = startOfDay(d);
  const back = (x.getDay() + 6) % 7;
  return addDays(x, -back);
}

// ISO week number, so keys read as 2026-W29 and match what the dashboard shows
function isoWeekKey(monday){
  const t = new Date(Date.UTC(monday.getFullYear(), monday.getMonth(), monday.getDate()));
  t.setUTCDate(t.getUTCDate() + 3);                        // Thursday decides the year
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((t - firstThu) / 604800000);
  return t.getUTCFullYear() + '-W' + pad2(week);
}

// "13 to 19 Jul 2026", "29 Jun to 5 Jul 2026", "29 Dec 2025 to 4 Jan 2026"
function weekLabel(start, end){
  const sameYear  = start.getFullYear() === end.getFullYear();
  const sameMonth = sameYear && start.getMonth() === end.getMonth();
  if (sameMonth) return `${start.getDate()} to ${end.getDate()} ${MON3[end.getMonth()]} ${end.getFullYear()}`;
  if (sameYear)  return `${start.getDate()} ${MON3[start.getMonth()]} to ${end.getDate()} ${MON3[end.getMonth()]} ${end.getFullYear()}`;
  return `${start.getDate()} ${MON3[start.getMonth()]} ${start.getFullYear()} to ${end.getDate()} ${MON3[end.getMonth()]} ${end.getFullYear()}`;
}

// The completed weeks, oldest first, newest last, matching the dashboard order
function buildWeekPeriods(today, count){
  const thisMonday = mondayOf(today);
  const out = [];
  for (let i = count; i >= 1; i--) {
    const start = addDays(thisMonday, -7 * i);
    const end   = addDays(start, 6);
    out.push({
      key:   isoWeekKey(start),
      label: weekLabel(start, end),
      short: `${start.getDate()} ${MON3[start.getMonth()]}`,
      start: iso(start),
      end:   iso(end)
    });
  }
  return out;
}

/* The completed months, oldest first, newest last, and then the month in
   progress so the dashboard is never a month behind. Late in July the old
   version had nothing newer than June on it, which reads as a dashboard that
   has stopped working. The current month is marked partial and carries the
   number of days counted so far, so it is never compared as a full month. */
function buildMonthPeriods(today, count){
  const out = [];
  for (let i = count; i >= 1; i--) {
    const first = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const last  = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    out.push({
      key:   `${first.getFullYear()}-${pad2(first.getMonth() + 1)}`,
      label: `${MONTHS[first.getMonth()]} ${first.getFullYear()}`,
      short: MON3[first.getMonth()],
      start: iso(first),
      end:   iso(last),
      daysInPeriod: last.getDate()
    });
  }
  if (INCLUDE_CURRENT_MONTH) {
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const last  = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    const upto  = addDays(today, -1);                     // yesterday, today is incomplete
    if (upto >= first) {
      out.push({
        key:   `${first.getFullYear()}-${pad2(first.getMonth() + 1)}`,
        label: `${MONTHS[first.getMonth()]} ${first.getFullYear()}`,
        short: MON3[first.getMonth()],
        start: iso(first),
        end:   iso(upto),
        partial: true,
        daysElapsed: upto.getDate(),
        daysInPeriod: last.getDate()
      });
    }
  }
  return out;
}

// Small concurrency limiter so a year of periods does not fire every request at
// Google at once and trip a quota.
async function mapLimit(items, limit, fn){
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------------------------------------------------------------------
   GA4
   One report for the period totals and one for sessions by channel. Users are
   requested per period rather than summed from daily rows, because totalUsers
   counts unique people and does not add up across days.
   --------------------------------------------------------------------------- */
function channelLabel(g){
  /* The previous version folded Paid Social, Display and Cross-network into
     Paid search. That inflated the paid search figure and hid social ad
     traffic completely, which is why the channel split never matched GA4.
     Paid social now sits with social, and anything that is neither search
     nor a named channel goes to Other rather than being misfiled. */
  const m = {
    'Organic Search':'Organic search', 'Direct':'Direct',
    'Referral':'Referral', 'Affiliates':'Referral',
    'Organic Social':'Social', 'Paid Social':'Social', 'Social':'Social', 'Organic Video':'Social',
    'Email':'Email', 'SMS':'Email', 'Mobile Push Notifications':'Email',
    'Paid Search':'Paid search',
    'Display':'Other', 'Cross-network':'Other', 'Paid Other':'Other',
    'Paid Video':'Other', 'Paid Shopping':'Other', 'Organic Shopping':'Other',
    'Audio':'Other', 'Unassigned':'Other'
  };
  return m[g] || 'Other';
}

async function ga4Period(period){
  const property = `properties/${GA4_PROPERTY_ID}`;
  const dateRanges = [{ startDate: period.start, endDate: period.end }];

  /* activeUsers is what the GA4 reports show by default, so this is the figure
     that has to match when anyone checks the dashboard against Analytics.
     totalUsers is carried alongside it for reference. averageSessionDuration
     was being reported as engaged time, which is a different measure and never
     agreed with GA4. Engaged time is userEngagementDuration over activeUsers,
     the same as Average engagement time per active user in the GA4 screens. */
  const [totals] = await analytics.runReport({
    property,
    dateRanges,
    metrics: [
      { name: 'activeUsers' }, { name: 'totalUsers' },
      { name: 'userEngagementDuration' }, { name: 'sessions' },
      { name: 'engagedSessions' }, { name: 'averageSessionDuration' }
    ]
  });

  const [byChannel] = await analytics.runReport({
    property,
    dateRanges,
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }]
  });

  const row = (totals.rows || [])[0];
  const mv = i => row ? (+row.metricValues[i].value || 0) : 0;
  const activeUsers    = Math.round(mv(0));
  const totalUsers     = Math.round(mv(1));
  const engagementTot  = mv(2);
  const sessions       = Math.round(mv(3));
  const engagedSess    = Math.round(mv(4));
  const avgSessionSec  = Math.round(mv(5));

  const users = activeUsers || totalUsers;
  const engagementSec = activeUsers ? Math.round(engagementTot / activeUsers) : 0;

  const sources = {};
  CANONICAL_SOURCES.forEach(k => { sources[k] = 0; });
  (byChannel.rows || []).forEach(r => {
    const label = channelLabel(r.dimensionValues[0].value);
    const sessions = Math.round(+r.metricValues[0].value);
    sources[label] = (sources[label] || 0) + sessions;
  });

  return {
    key: period.key,
    label: period.label,
    short: period.short,
    users,                        // activeUsers, the GA4 default
    totalUsers,
    engagementSec,                // average engagement time per active user
    avgSessionSec,
    sessions,                     // the dashboard checks this against the channel split
    engagedSessions: engagedSess,
    engagementRate: sessions ? +(engagedSess / sessions * 100).toFixed(1) : 0,
    partial: !!period.partial,
    daysElapsed: period.daysElapsed || null,
    daysInPeriod: period.daysInPeriod || null,
    linkedinFollowers: 0,        // filled from the manual overlay and the live count
    sources
  };
}

/* ---------------------------------------------------------------------------
   SEARCH CONSOLE, per period
   --------------------------------------------------------------------------- */
async function gscPeriod(webmasters, period, rowLimit){
  const res = await webmasters.searchanalytics.query({
    siteUrl: GSC_SITE_URL,
    requestBody: {
      startDate: period.start,
      endDate: period.end,
      dimensions: ['query'],
      rowLimit: rowLimit || GSC_ROWS
    }
  });
  return (res.data.rows || [])
    .map(r => ({
      term: r.keys[0],
      clicks: Math.round(r.clicks),
      impressions: Math.round(r.impressions || 0),
      ctr: +(((r.ctr || 0) * 100).toFixed(2)),
      // Google already returns position as the average weighted by impressions,
      // so it is used as given rather than averaged again.
      position: +r.position.toFixed(1)
    }))
    .sort((a, b) => b.clicks - a.clicks);
}

// True when a period runs close enough to today that Search Console has not
// finished publishing it.
function gscIncomplete(period, today){
  const end = new Date(period.end + 'T00:00:00');
  return Math.round((startOfDay(today) - end) / 86400000) < GSC_LAG_DAYS;
}

/* ---------------------------------------------------------------------------
   LINKEDIN, follower count only
   --------------------------------------------------------------------------- */
async function pullLinkedInFollowers(){
  if (!LI_TOKEN || !LI_ORG_URN) return null;
  const urn = encodeURIComponent(LI_ORG_URN);
  const res = await fetch('https://api.linkedin.com/rest/networkSizes/' + urn + '?edgeType=CompanyFollowedByMember', {
    headers: {
      Authorization: 'Bearer ' + LI_TOKEN,
      'LinkedIn-Version': LI_VERSION,
      'X-Restli-Protocol-Version': '2.0.0'
    }
  });
  if (!res.ok) throw new Error('LinkedIn networkSizes -> ' + res.status + ' ' + (await res.text()));
  const data = await res.json();
  return data.firstDegreeSize != null ? data.firstDegreeSize : null;
}

/* ---------------------------------------------------------------------------
   FOLLOWER FILL
   The dashboard reads linkedinFollowers off every period for the KPI, its
   change chip and its sparkline. A zero would show as a collapse and break the
   percentage maths, so any period with no figure of its own carries forward the
   last one known. The newest period takes the live count when a token is set.
   --------------------------------------------------------------------------- */
function fillFollowers(periods, explicitByKey, monthByKey, live){
  let last = null;
  periods.forEach(p => {
    let v = explicitByKey[p.key];
    if (v == null && monthByKey) v = monthByKey[p.key.slice(0, 7)];   // a week inherits its month
    if (v == null) v = last;
    if (v != null) { p.linkedinFollowers = v; last = v; }
  });
  // Anything before the first known figure is still null, so back fill it with
  // the earliest figure rather than leaving a zero on the chart.
  const firstKnown = periods.find(p => p.linkedinFollowers)?.linkedinFollowers;
  if (firstKnown) periods.forEach(p => { if (!p.linkedinFollowers) p.linkedinFollowers = firstKnown; });
  if (live != null && periods.length) periods[periods.length - 1].linkedinFollowers = live;
}

/* ---------------------------------------------------------------------------
   MANUAL OVERLAY
   --------------------------------------------------------------------------- */
function readManual(){
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'manual.json'), 'utf8')); }
  catch (e) { console.error('manual.json could not be read:', e.message); return {}; }
}

/* ---------------------------------------------------------------------------
   BUILD
   --------------------------------------------------------------------------- */
let diag = {
  lastRun: null,
  credentials: CREDS ? 'GOOGLE_CREDENTIALS_JSON' : (process.env.GOOGLE_APPLICATION_CREDENTIALS ? 'GOOGLE_APPLICATION_CREDENTIALS' : 'none set'),
  ga4:      { ok: false, months: 0, weeks: 0, error: null },
  gsc:      { ok: false, periodsWithTerms: 0, error: null },
  linkedin: { ok: false, followers: null, error: null },
  manual:   { gbpByPeriod: 0, keys: [] }
};

async function buildData(){
  const today = startOfDay(new Date());
  const manual = readManual();

  const monthPeriods = buildMonthPeriods(today, MONTHS_BACK);
  const weekPeriods  = buildWeekPeriods(today, WEEKS_BACK);
  const allPeriods   = monthPeriods.concat(weekPeriods);

  // ---- GA4 ----
  let months = [], weeks = [];
  try {
    const rows = await mapLimit(allPeriods, 4, p => ga4Period(p));
    months = rows.slice(0, monthPeriods.length);
    weeks  = rows.slice(monthPeriods.length);
    diag.ga4 = { ok: true, months: months.length, weeks: weeks.length, error: null };
  } catch (e) {
    months = []; weeks = [];
    diag.ga4 = { ok: false, months: 0, weeks: 0, error: e.message };
    console.error('GA4 pull failed:', e.message);
  }

  // ---- Search Console, attached to each period ----
  let latestTerms = [];
  try {
    const webmasters = gscClient();
    const byPeriod = await mapLimit(allPeriods, 3, p => gscPeriod(webmasters, p, GSC_ROWS));
    const termsByKey = {};
    allPeriods.forEach((p, i) => { termsByKey[p.key] = byPeriod[i] || []; });

    let withTerms = 0;
    const periodByKey = {};
    allPeriods.forEach(p => { periodByKey[p.key] = p; });
    months.concat(weeks).forEach(p => {
      const t = termsByKey[p.key];
      if (t && t.length) { p.searchTerms = t; withTerms++; }
      const src = periodByKey[p.key];
      if (src && gscIncomplete(src, today)) p.searchPartial = true;
    });

    // Top level fallback, used by the dashboard only for a period that carries
    // none of its own. The newest completed week is the most representative.
    const newestWeekKey = weekPeriods.length ? weekPeriods[weekPeriods.length - 1].key : null;
    latestTerms = (newestWeekKey && termsByKey[newestWeekKey] && termsByKey[newestWeekKey].length)
      ? termsByKey[newestWeekKey]
      : (termsByKey[allPeriods[allPeriods.length - 1].key] || []);

    diag.gsc = { ok: true, periodsWithTerms: withTerms, error: null };
  } catch (e) {
    diag.gsc = { ok: false, periodsWithTerms: 0, error: e.message };
    console.error('GSC pull failed:', e.message);
  }

  // ---- LinkedIn followers ----
  let liFollowers = null;
  try {
    liFollowers = await pullLinkedInFollowers();
    diag.linkedin = { ok: liFollowers != null, followers: liFollowers, error: liFollowers == null ? 'no token set, manual figures in use' : null };
  } catch (e) {
    diag.linkedin = { ok: false, followers: null, error: e.message };
    console.error('LinkedIn pull failed:', e.message);
  }

  const byMonth = manual.linkedinFollowersByMonth || {};
  const byWeek  = manual.linkedinFollowersByWeek  || {};
  fillFollowers(months, byMonth, null,    liFollowers);
  fillFollowers(weeks,  byWeek,  byMonth, liFollowers);

  // ---- Assemble ----
  const lastUpdated = `${today.getDate()} ${MON3[today.getMonth()]} ${today.getFullYear()}`;
  const out = { lastUpdated, generatedAt: new Date().toISOString() };

  // Only include automated keys when there is real data behind them, so a failed
  // pull never wipes the figures already written into the dashboard file.
  if (months.length) out.months = months;
  if (weeks.length)  out.weeks  = weeks;
  if (latestTerms.length) out.searchTerms = latestTerms;

  // Hand authored sections. "linkedin" is deliberately not in this list: the
  // front end owns DASHBOARD.linkedin, the advocacy seed and the best practice
  // cards, and the dashboard merge replaces a whole object rather than deep
  // merging, so sending one from here would wipe them.
  ['blogs','gbp','gbpByPeriod','competitors','competitorOpps','competitorIdeas','shareOfVoice','websiteReview','ideas']
    .forEach(k => { if (manual[k] != null) out[k] = manual[k]; });

  diag.manual = {
    gbpByPeriod: manual.gbpByPeriod ? Object.keys(manual.gbpByPeriod).length : 0,
    keys: Object.keys(out).filter(k => k !== 'lastUpdated' && k !== '_diag')
  };
  diag.lastRun = new Date().toISOString();

  // Carried on the payload so a glance at the JSON says whether it is real.
  out._diag = {
    builtAt: diag.lastRun,
    ga4: diag.ga4.ok ? `${diag.ga4.months} months, ${diag.ga4.weeks} weeks` : 'FAILED: ' + diag.ga4.error,
    gsc: diag.gsc.ok ? `${diag.gsc.periodsWithTerms} periods with terms` : 'FAILED: ' + diag.gsc.error,
    linkedin: diag.linkedin.ok ? diag.linkedin.followers : diag.linkedin.error
  };

  return out;
}

/* ---------------------------------------------------------------------------
   CACHE AND SCHEDULE
   --------------------------------------------------------------------------- */
/* ---------------------------------------------------------------------------
   This is where the dashboard was losing its figures.

   The cache used to live only in memory and was empty until the first build
   finished. Render puts a free service to sleep after a quarter of an hour
   idle, so almost every visit woke a cold process, and for the minute or two
   the rebuild took, /api/ek-dashboard.json answered 200 with an object holding
   no months and no weeks. The dashboard merged nothing, fell back to the
   placeholder figures written into the HTML, and showed them as though they
   were real. Nothing looked broken, the numbers were simply invented.

   The last good payload is now written to Postgres and read back on boot, so a
   cold start serves real figures straight away and refreshes behind the scenes.
   --------------------------------------------------------------------------- */
let cache = { lastUpdated: 'never', _diag: { builtAt: null, ga4: 'not run yet' } };
let cacheLoaded = false;
let refreshing = false;

function cacheHasData(c){ return !!(c && ((c.months && c.months.length) || (c.weeks && c.weeks.length))); }

async function loadCache(){
  if (!eventsPool) return false;
  try {
    const { rows } = await eventsPool.query('SELECT data, saved_at FROM ek_cache WHERE id = 1');
    if (rows.length && cacheHasData(rows[0].data)) {
      cache = rows[0].data;
      cache._servedFrom = 'saved payload from ' + new Date(rows[0].saved_at).toISOString();
      console.log('Cache restored from the database,', (cache.months || []).length, 'months');
      return true;
    }
  } catch (e) {
    console.error('Cache could not be restored:', e.message);
  }
  return false;
}

async function saveCache(c){
  if (!eventsPool || !cacheHasData(c)) return;
  try {
    await eventsPool.query(
      `INSERT INTO ek_cache (id, data, saved_at) VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, saved_at = now()`,
      [JSON.stringify(c)]
    );
  } catch (e) {
    console.error('Cache could not be saved:', e.message);
  }
}

async function refresh(){
  if (refreshing) return cache;
  refreshing = true;
  try {
    const next = await buildData();
    // Never replace a good cache with an empty one. If a refresh comes back with
    // no periods but the last one had some, keep what is already being served.
    if (!cacheHasData(next) && cacheHasData(cache)) {
      console.error('Refresh produced no periods, keeping the previous cache');
      cache = Object.assign({}, cache, { _diag: next._diag });
    } else {
      cache = next;
      delete cache._servedFrom;
      await saveCache(cache);
    }
    console.log('Refreshed', cache.lastUpdated, JSON.stringify(cache._diag));
  } catch (e) {
    console.error('Refresh failed:', e.message);
  } finally {
    refreshing = false;
  }
  return cache;
}

// Serve the saved payload first, then rebuild in the background.
(async () => {
  await loadCache();
  cacheLoaded = true;
  refresh();
})();

cron.schedule('30 6 * * *', refresh);   // every day at 06:30 UK time

/* A sleeping service is the reason a cold start ever showed placeholder
   figures. Pinging itself every ten minutes keeps it awake on Render's free
   plan. Set SELF_URL to the service address to switch this on, or leave it
   blank if the service is on a paid plan that does not sleep. */
const SELF_URL = process.env.SELF_URL || '';
if (SELF_URL) {
  setInterval(() => {
    fetch(SELF_URL.replace(/\/$/, '') + '/health').catch(() => {});
  }, 10 * 60 * 1000);
}

/* ---------------------------------------------------------------------------
   SERVE
   --------------------------------------------------------------------------- */
const app = express();
app.use(cors());

app.get('/api/ek-dashboard.json', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  // An empty payload is now said out loud rather than being sent as if it were
  // a normal answer, so the dashboard can flag it instead of quietly showing
  // the placeholder figures held in its own file.
  if (!cacheHasData(cache)) {
    if (!refreshing) refresh();
    return res.status(503).json({
      error: 'no data built yet',
      building: true,
      restored: cacheLoaded,
      _diag: cache._diag || null
    });
  }
  res.json(cache);
});

// What the last refresh actually managed. Open this first whenever a tab looks
// stale: it will name the failure rather than leaving you guessing.
app.get('/api/diagnostics', (_req, res) => {
  res.json({
    ...diag,
    servingPeriods: { months: (cache.months || []).length, weeks: (cache.weeks || []).length },
    newestWeek: cache.weeks && cache.weeks.length ? cache.weeks[cache.weeks.length - 1].label : null,
    newestMonth: cache.months && cache.months.length ? cache.months[cache.months.length - 1].label : null,
    config: { GA4_PROPERTY_ID, GSC_SITE_URL, WEEKS_BACK, MONTHS_BACK, database: !!eventsPool }
  });
});

// Force a rebuild without a redeploy. If REFRESH_TOKEN is set it must be sent
// as ?token= or the request is refused.
app.post('/api/refresh', async (req, res) => {
  if (REFRESH_TOKEN && req.query.token !== REFRESH_TOKEN) return res.status(403).json({ ok: false });
  const out = await refresh();
  res.json({ ok: true, lastUpdated: out.lastUpdated, diag: out._diag });
});

// Legacy published advocacy board, read live from manual.json.
app.get('/api/ek-advocacy.json', (_req, res) => {
  const manual = readManual();
  res.json(Array.isArray(manual.advocacyPublished) ? manual.advocacyPublished : []);
});

// ---- Shared events (Events tab) --------------------------------------------
app.get('/api/events', async (_req, res) => {
  if (!eventsPool) return res.json([]);
  try {
    const { rows } = await eventsPool.query('SELECT data FROM ek_events WHERE id = 1');
    res.json(rows[0] ? rows[0].data : []);
  } catch (e) {
    console.error('GET /api/events', e.message);
    res.status(500).json([]);
  }
});

app.put('/api/events', express.json({ limit: '1mb' }), async (req, res) => {
  if (!eventsPool) return res.status(503).json({ ok: false, error: 'no database configured' });
  try {
    const data = Array.isArray(req.body) ? req.body : [];
    await eventsPool.query(
      `INSERT INTO ek_events (id, data) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [JSON.stringify(data)]
    );
    res.json({ ok: true, count: data.length });
  } catch (e) {
    console.error('PUT /api/events', e.message);
    res.status(500).json({ ok: false });
  }
});

// ---- Shared LinkedIn board (LinkedIn tab) ----------------------------------
app.get('/api/linkedin', async (_req, res) => {
  if (!eventsPool) return res.json([]);
  try {
    const { rows } = await eventsPool.query('SELECT data FROM ek_linkedin WHERE id = 1');
    res.json(rows[0] ? rows[0].data : []);
  } catch (e) {
    console.error('GET /api/linkedin', e.message);
    res.status(500).json([]);
  }
});

app.put('/api/linkedin', express.json({ limit: '2mb' }), async (req, res) => {
  if (!eventsPool) return res.status(503).json({ ok: false, error: 'no database configured' });
  try {
    const data = Array.isArray(req.body) ? req.body : [];
    await eventsPool.query(
      `INSERT INTO ek_linkedin (id, data) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [JSON.stringify(data)]
    );
    res.json({ ok: true, count: data.length });
  } catch (e) {
    console.error('PUT /api/linkedin', e.message);
    res.status(500).json({ ok: false });
  }
});

// ---- Status: quick health readout for the shared stores ---------------------
// ---- Content plan, video library, competitor captures --------------------
// Same shape as events: GET returns the array, PUT saves the whole array.
['content', 'videos', 'competitors'].forEach(name => {
  app.get('/api/' + name, async (_req, res) => {
    if (!eventsPool) return res.json([]);
    try {
      const { rows } = await eventsPool.query('SELECT data FROM ek_store WHERE key = $1', [name]);
      res.set('Cache-Control', 'no-store');
      res.json(rows.length ? rows[0].data : []);
    } catch (e) {
      console.error('GET /api/' + name, e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.put('/api/' + name, express.json({ limit: '8mb' }), async (req, res) => {
    if (!eventsPool) return res.status(503).json({ ok: false, error: 'no database configured' });
    if (!Array.isArray(req.body)) return res.status(400).json({ ok: false, error: 'expected an array' });
    try {
      await eventsPool.query(
        `INSERT INTO ek_store (key, data, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [name, JSON.stringify(req.body)]
      );
      res.json({ ok: true, count: req.body.length });
    } catch (e) {
      console.error('PUT /api/' + name, e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });
});

app.get('/api/status', async (_req, res) => {
  const out = {
    db: !!eventsPool,
    events: null,
    linkedin: null,
    servingRealData: cacheHasData(cache),
    servedFrom: cache._servedFrom || 'built in this process',
    generatedAt: cache.generatedAt || null,
    months: (cache.months || []).length,
    weeks: (cache.weeks || []).length
  };
  if (eventsPool) {
    try {
      const e = await eventsPool.query(`SELECT COALESCE(jsonb_array_length(data),0) AS n FROM ek_events WHERE id = 1`);
      out.events = e.rows[0] ? e.rows[0].n : 0;
    } catch (err) { out.events = 'error: ' + err.message; }
    try {
      const l = await eventsPool.query(`SELECT COALESCE(jsonb_array_length(data),0) AS n FROM ek_linkedin WHERE id = 1`);
      out.linkedin = l.rows[0] ? l.rows[0].n : 0;
    } catch (err) { out.linkedin = 'error: ' + err.message; }
  }
  res.json(out);
});

app.get('/health', (_req, res) => res.send('ok'));

// Row counts for the three newer boards, handy when a tab looks empty
app.get('/api/status/boards', async (_req, res) => {
  if (!eventsPool) return res.json({ db: false });
  const out = { db: true };
  for (const k of ['content', 'videos', 'competitors']) {
    try {
      const r = await eventsPool.query(
        `SELECT COALESCE(jsonb_array_length(data), 0) AS n, updated_at FROM ek_store WHERE key = $1`, [k]);
      out[k] = r.rows.length ? { count: r.rows[0].n, updatedAt: r.rows[0].updated_at } : { count: 0, updatedAt: null };
    } catch (e) { out[k] = { error: e.message }; }
  }
  res.json(out);
});
app.listen(PORT, () => console.log('EK dashboard data service on :' + PORT));
