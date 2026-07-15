/* =============================================================================
   EARL KENDRICK DASHBOARD  ·  daily data service  ·  built by NXRD

   What this does
   --------------
   Once a day it pulls the automatable figures from Google, and the current
   LinkedIn follower count, merges in the parts that are entered by hand, and
   serves one JSON file the dashboard reads on load. Point the dashboard's
   DASHBOARD_DATA_URL at:

       https://YOUR-RENDER-APP.onrender.com/api/ek-dashboard.json

   Automated here:   website visitors, sessions by channel, average time on
                     site (GA4), top search terms (Search Console), and the
                     LinkedIn follower total on the latest month.
   Overlaid by hand: Google Business Profile, competitors, ideas, the website
                     review, and the LinkedIn advocacy board. Keep those in
                     manual.json and edit when needed.

   Shared events
   -------------
   The dashboard's Events tab reads and writes a single shared list, so you and
   the PA see and edit the same events from anywhere. It is served here at:

       GET  /api/events   returns the events array
       PUT  /api/events   saves the events array (body = the whole array)

   Events are stored in Postgres (Render has no durable disk, so a file would
   not survive a restart). Point the dashboard's EVENTS_API at:

       https://YOUR-RENDER-APP.onrender.com/api/events

   If DATABASE_URL is not set the service still runs; the events routes simply
   report no store, and the dashboard falls back to a per device local copy.

   Shared LinkedIn board (NEW)
   ---------------------------
   The dashboard's LinkedIn tab now logs each person's posts by hand (title,
   date, likes, comments, reposts) and shows who is on track for one post a
   week. That board is shared the same way as events, stored in Postgres, so
   several people see and update the same figures:

       GET  /api/linkedin   returns the people-with-posts array
       PUT  /api/linkedin   saves the array (body = the whole array)

   Point the dashboard's LINKEDIN_API at:

       https://YOUR-RENDER-APP.onrender.com/api/linkedin

   Like events, if DATABASE_URL is not set the routes report no store and the
   dashboard falls back to a per device copy. This is separate from the daily
   feed below, which still does NOT emit a "linkedin" object.

   Important: how LinkedIn is wired on this dashboard
   --------------------------------------------------
   The front end shows only one LinkedIn number from the daily feed: the
   follower KPI, which reads months[].linkedinFollowers. So the daily feed's
   single LinkedIn job is to keep that current. Historical months come from
   manual.linkedinFollowersByMonth; the newest month is overwritten with the
   live count when a token is set.

   The daily feed deliberately does NOT emit a "linkedin" object. The front end
   owns DASHBOARD.linkedin (the advocacy seed list and the best practice cards),
   and the dashboard's merge replaces a whole object rather than deep merging, so
   sending one from the feed would wipe those. The manual posting board is now
   served at /api/linkedin above. The older /api/ek-advocacy.json route is kept
   for reference but the new LinkedIn tab uses /api/linkedin instead.

   Setup
   -----
   1. npm init -y
   2. npm i express cors node-cron @google-analytics/data googleapis pg
      (no extra package for LinkedIn: fetch is built into Node 18 and above)
   3. Google service account with Viewer on the GA4 property and access on the
      Search Console property; download its JSON key.
   4. Environment variables (Render dashboard or a .env):
        GOOGLE_APPLICATION_CREDENTIALS = ./service-account.json
        GA4_PROPERTY_ID   = 123456789
        GSC_SITE_URL      = https://earlkendrick.com/
        PORT              = 3000
      Shared events and the shared LinkedIn board (edited by you and the PA):
        DATABASE_URL      = your Postgres connection string (Render Postgres provides this)
      LinkedIn follower count (optional, leave blank to stay on manual figures):
        LINKEDIN_ACCESS_TOKEN = your 60 day org access token
        LINKEDIN_ORG_URN      = urn:li:organization:12345
        LINKEDIN_API_VERSION  = 202605
   5. node ek-dashboard-server.js

   Note on the LinkedIn token
   --------------------------
   LinkedIn organisation tokens last about 60 days and Render has no durable
   disk, so refresh the token in the Render environment every couple of months.
   Until a token is set the follower figures come entirely from manual.json.
   ============================================================================= */

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const { google } = require('googleapis');

const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID || '381171366';
const GSC_SITE_URL    = process.env.GSC_SITE_URL    || 'https://earlkendrick.com/';
const PORT            = process.env.PORT || 3000;

// LinkedIn (optional). Leave the token blank and the manual figures are used.
const LI_TOKEN   = process.env.LINKEDIN_ACCESS_TOKEN || '';
const LI_ORG_URN = process.env.LINKEDIN_ORG_URN || '';        // urn:li:organization:12345
const LI_VERSION = process.env.LINKEDIN_API_VERSION || '202605';

const analytics = new BetaAnalyticsDataClient();          // uses GOOGLE_APPLICATION_CREDENTIALS
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ---- Shared store (Postgres) -----------------------------------------------
// Optional: if DATABASE_URL is not set, the events and linkedin routes report
// no store and the dashboard keeps those tabs locally per device. Each shared
// list lives in one JSON row, which is plenty for a small team. Last write wins.
// One pool serves both the events table and the linkedin table.
const DATABASE_URL = process.env.DATABASE_URL || '';
let eventsPool = null;

if (DATABASE_URL) {
  try {
    // Loaded here, not at the top, so the app still deploys if pg is not
    // installed or no database is set. Run: npm i pg
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
  } catch (e) {
    console.error('pg not available, /api/events and /api/linkedin disabled (run: npm i pg):', e.message);
    eventsPool = null;
  }
} else {
  console.warn('DATABASE_URL not set: /api/events and /api/linkedin disabled, those tabs stay local per device.');
}

// Map GA4 default channel groups to the labels the dashboard expects
function channelLabel(g){
  const m = {
    'Organic Search':'Organic search', 'Direct':'Direct', 'Referral':'Referral',
    'Organic Social':'Social', 'Social':'Social', 'Email':'Email',
    'Paid Search':'Paid search', 'Paid Social':'Paid search'
  };
  return m[g] || g;
}

// ---- GA4: last 6 months of users, avg time, and sessions by channel ----------
async function pullGA4(){
  const propertyId = `properties/${GA4_PROPERTY_ID}`;

  const [totals] = await analytics.runReport({
    property: propertyId,
    dateRanges: [{ startDate: '182daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'yearMonth' }],
    metrics: [{ name: 'totalUsers' }, { name: 'averageSessionDuration' }],
    orderBys: [{ dimension: { dimensionName: 'yearMonth' } }]
  });

  const [byChannel] = await analytics.runReport({
    property: propertyId,
    dateRanges: [{ startDate: '182daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'yearMonth' }, { name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }]
  });

  const byKey = {};
  (totals.rows || []).forEach(r => {
    const ym = r.dimensionValues[0].value;            // e.g. 202606
    const y = +ym.slice(0,4), mo = +ym.slice(4,6);
    byKey[ym] = {
      key: `${y}-${String(mo).padStart(2,'0')}`,
      label: `${MONTHS[mo-1]} ${y}`,
      users: Math.round(+r.metricValues[0].value),
      engagementSec: Math.round(+r.metricValues[1].value),
      linkedinFollowers: 0,                             // filled from manual overlay + live count
      sources: {}
    };
  });
  (byChannel.rows || []).forEach(r => {
    const ym = r.dimensionValues[0].value;
    const label = channelLabel(r.dimensionValues[1].value);
    const sessions = Math.round(+r.metricValues[0].value);
    if (!byKey[ym]) return;
    byKey[ym].sources[label] = (byKey[ym].sources[label] || 0) + sessions;
  });

  return Object.keys(byKey).sort().map(k => byKey[k]); // oldest first
}

// ---- Search Console: top queries -------------------------------------------
async function pullGSC(){
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] });
  const webmasters = google.webmasters({ version: 'v3', auth });
  const end = new Date();
  const start = new Date(); start.setDate(start.getDate() - 30);
  const iso = d => d.toISOString().slice(0,10);

  const res = await webmasters.searchanalytics.query({
    siteUrl: GSC_SITE_URL,
    requestBody: { startDate: iso(start), endDate: iso(end), dimensions: ['query'], rowLimit: 12 }
  });
  return (res.data.rows || []).map(r => ({
    term: r.keys[0],
    clicks: Math.round(r.clicks),
    position: +r.position.toFixed(1)
  })).sort((a,b) => b.clicks - a.clicks);
}

// ---- LinkedIn: current follower count only ---------------------------------
// Returns the follower total, or null when no token is set so the manual
// figures stand. Requires the r_organization_social or r_organization_followers
// scope, granted after Marketing Developer Platform approval.
// orgUrn looks like urn:li:organization:12345
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

// ---- Manual overlay ---------------------------------------------------------
function readManual(){
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'manual.json'), 'utf8')); }
  catch { return {}; }
}

// ---- Build the merged payload ----------------------------------------------
async function buildData(){
  const manual = readManual();
  let months = [], searchTerms = [], liFollowers = null;
  try { months = await pullGA4(); } catch (e) { console.error('GA4 pull failed:', e.message); }
  try { searchTerms = await pullGSC(); } catch (e) { console.error('GSC pull failed:', e.message); }
  try { liFollowers = await pullLinkedInFollowers(); } catch (e) { console.error('LinkedIn pull failed:', e.message); }

  // Historical follower totals from the manual overlay
  const followersByKey = (manual.linkedinFollowersByMonth || {});
  months.forEach(m => { if (followersByKey[m.key] != null) m.linkedinFollowers = followersByKey[m.key]; });

  // Live follower count overwrites the newest month, so the KPI self updates
  if (liFollowers != null && months.length) {
    months[months.length - 1].linkedinFollowers = liFollowers;
  }

  const today = new Date();
  const lastUpdated = `${today.getDate()} ${MONTHS[today.getMonth()].slice(0,3)} ${today.getFullYear()}`;

  // Only include automated keys when we actually got data, so a failed pull
  // never wipes the figures already written into the dashboard file.
  const out = { lastUpdated };
  if (months.length) out.months = months;
  if (searchTerms.length) out.searchTerms = searchTerms;

  // Pass the hand authored sections straight through. Note: "linkedin" is NOT
  // in this list on purpose. The front end owns DASHBOARD.linkedin (advocacy
  // seed and best practice), and the dashboard merge would replace that whole
  // object, so this service must never send one. The manual posting board is
  // served separately at /api/linkedin below.
  ['blogs','gbp','competitors','competitorOpps','competitorIdeas','shareOfVoice','websiteReview','ideas']
    .forEach(k => { if (manual[k] != null) out[k] = manual[k]; });

  return out;
}

// ---- Cache + schedule -------------------------------------------------------
let cache = { lastUpdated: 'never', months: [] };
async function refresh(){
  try { cache = await buildData(); console.log('Refreshed', cache.lastUpdated); }
  catch (e) { console.error('Refresh failed:', e.message); }
}
refresh();                              // on boot
cron.schedule('30 6 * * *', refresh);   // every day at 06:30 server time

// ---- Serve ------------------------------------------------------------------
const app = express();
app.use(cors());                        // lets the dashboard on nx-rd.com read it (covers /api/events and /api/linkedin too)

app.get('/api/ek-dashboard.json', (_req, res) => res.json(cache));

// Published LinkedIn advocacy board (legacy). The old advocacy scorer used
// ADVOCACY_DATA_URL pointing here. The new LinkedIn tab uses /api/linkedin
// instead, but this route is left in place so nothing that still reads it
// breaks. Reads live from manual.json under "advocacyPublished".
app.get('/api/ek-advocacy.json', (_req, res) => {
  const manual = readManual();
  res.json(Array.isArray(manual.advocacyPublished) ? manual.advocacyPublished : []);
});

// ---- Shared events (Events tab) --------------------------------------------
// GET returns the shared events array; PUT saves the whole array. The dashboard
// posts the full list on every add, edit or delete, and polls GET to pick up
// the other person's changes. Last write wins.
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
// Same pattern as events, on the same pool but its own table. GET returns the
// people-with-posts array; PUT saves the whole array. The dashboard posts the
// full list on every add, edit or delete, and polls GET to pick up other
// people's changes. Last write wins. Limit is a little higher than events
// because posts accumulate over time.
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
// Open https://YOUR-RENDER-APP.onrender.com/api/status in a browser.
//   { "db": true,  "events": 3, "linkedin": 2 }  -> database connected, both saving
//   { "db": false, ... }                          -> DATABASE_URL is not set on this
//                                                     service, so nothing is shared.
//                                                     Add it and redeploy.
// A number is how many records are stored. If linkedin stays 0 after you add a
// person in the dashboard, the save is not reaching this service.
app.get('/api/status', async (_req, res) => {
  const out = { db: !!eventsPool, events: null, linkedin: null };
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
app.listen(PORT, () => console.log('EK dashboard data service on :' + PORT));
