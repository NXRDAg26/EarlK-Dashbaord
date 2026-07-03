/* =============================================================================
   EARL KENDRICK DASHBOARD  ·  daily data service  ·  built by NXRD

   What this does
   --------------
   Once a day it pulls the automatable figures from Google and LinkedIn, merges
   in the parts that have to be entered by hand, and serves one JSON file that
   the dashboard reads on load. Point the dashboard's DASHBOARD_DATA_URL at:

       https://YOUR-RENDER-APP.onrender.com/api/ek-dashboard.json

   and everyone, including the client, always sees the latest daily data.

   Automated here:   website visitors, sessions by channel, average time on
                     site (GA4), top search terms (Search Console), and the
                     LinkedIn page numbers (followers, impressions, engagement).
   Overlaid by hand: LinkedIn advocacy and top posts, Google Business Profile,
                     competitors, ideas and the website review. Keep those in
                     manual.json (see manual.sample.json) and edit when needed.
                     Google Business Profile can be automated later via the
                     Business Profile Performance API using the same pattern.

   How the LinkedIn merge behaves
   ------------------------------
   The API supplies the numeric fields it can (followers, impressions,
   engagement rate). Your hand written fields in manual.json (advocacy, top
   posts, anything else) sit on top and are never overwritten. If no LinkedIn
   token is set, or the pull fails, the manual overlay stands on its own, so the
   dashboard never goes blank.

   Setup
   -----
   1. npm init -y
   2. npm i express cors node-cron @google-analytics/data googleapis
      (no extra package for LinkedIn: fetch is built into Node 18 and above)
   3. Create a Google Cloud service account, download its JSON key, and:
        - add the service account email as a Viewer on the GA4 property
        - add it as a user on the Search Console property
   4. Set environment variables (in Render dashboard or a .env):
        GOOGLE_APPLICATION_CREDENTIALS = ./service-account.json   (path to key)
        GA4_PROPERTY_ID   = 123456789            (numbers only)
        GSC_SITE_URL      = https://earlkendrick.com/   (or sc-domain:earlkendrick.com)
        PORT              = 3000
      For the LinkedIn page numbers (optional, leave blank to stay manual):
        LINKEDIN_ACCESS_TOKEN = your 60 day org access token
        LINKEDIN_ORG_URN      = urn:li:organization:12345
        LINKEDIN_API_VERSION  = 202605           (optional, defaults below)
   5. node ek-dashboard-server.js   (Render start command)

   Note on the LinkedIn token
   --------------------------
   LinkedIn organisation tokens last about 60 days and Render has no durable
   disk, so refresh the token in the Render environment every couple of months.
   Until a token is set the LinkedIn numbers come entirely from manual.json.
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

// LinkedIn (optional). Leave the token blank and the manual overlay is used.
const LI_TOKEN   = process.env.LINKEDIN_ACCESS_TOKEN || '';
const LI_ORG_URN = process.env.LINKEDIN_ORG_URN || '';        // urn:li:organization:12345
const LI_VERSION = process.env.LINKEDIN_API_VERSION || '202605';

const analytics = new BetaAnalyticsDataClient();          // uses GOOGLE_APPLICATION_CREDENTIALS
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

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

  // Users and average session duration by month
  const [totals] = await analytics.runReport({
    property: propertyId,
    dateRanges: [{ startDate: '182daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'yearMonth' }],
    metrics: [{ name: 'totalUsers' }, { name: 'averageSessionDuration' }],
    orderBys: [{ dimension: { dimensionName: 'yearMonth' } }]
  });

  // Sessions by month and channel
  const [byChannel] = await analytics.runReport({
    property: propertyId,
    dateRanges: [{ startDate: '182daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'yearMonth' }, { name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }]
  });

  const byKey = {}; // "202606" -> month object
  (totals.rows || []).forEach(r => {
    const ym = r.dimensionValues[0].value;            // e.g. 202606
    const y = +ym.slice(0,4), mo = +ym.slice(4,6);
    byKey[ym] = {
      key: `${y}-${String(mo).padStart(2,'0')}`,
      label: `${MONTHS[mo-1]} ${y}`,
      users: Math.round(+r.metricValues[0].value),
      engagementSec: Math.round(+r.metricValues[1].value),
      linkedinFollowers: 0,                             // filled from manual overlay
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

// ---- LinkedIn: page level numbers ------------------------------------------
// Small GET helper with the mandatory version and protocol headers.
async function liGet(q){
  const res = await fetch('https://api.linkedin.com/rest' + q, {
    headers: {
      Authorization: 'Bearer ' + LI_TOKEN,
      'LinkedIn-Version': LI_VERSION,
      'X-Restli-Protocol-Version': '2.0.0'
    }
  });
  if (!res.ok) throw new Error('LinkedIn ' + q + ' -> ' + res.status + ' ' + (await res.text()));
  return res.json();
}

// Returns the numeric fields the API can supply, or null when no token is set
// so the manual overlay stands. Requires the r_organization_social and
// r_organization_followers scopes, granted after Marketing Developer Platform
// approval. orgUrn looks like urn:li:organization:12345
async function pullLinkedIn(){
  if (!LI_TOKEN || !LI_ORG_URN) return null;
  const urn = encodeURIComponent(LI_ORG_URN);

  const size  = await liGet(`/networkSizes/${urn}?edgeType=CompanyFollowedByMember`);
  const share = await liGet(`/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${urn}`);
  const s = (share.elements && share.elements[0] && share.elements[0].totalShareStatistics) || {};

  return {
    pageFollowers: size.firstDegreeSize != null ? size.firstDegreeSize : null,
    impressions: s.impressionCount != null ? s.impressionCount : null,
    clicks: s.clickCount != null ? s.clickCount : null,
    reactions: s.likeCount != null ? s.likeCount : null,
    comments: s.commentCount != null ? s.commentCount : null,
    shares: s.shareCount != null ? s.shareCount : null,
    engagementRate: s.engagement != null ? +(s.engagement * 100).toFixed(1) : null
  };
}

// ---- Manual overlay (things Google/LinkedIn cannot auto feed) ---------------
function readManual(){
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'manual.json'), 'utf8')); }
  catch { return {}; }
}

// ---- Build the merged payload ----------------------------------------------
async function buildData(){
  const manual = readManual();
  let months = [], searchTerms = [], linkedinAuto = null;
  try { months = await pullGA4(); } catch (e) { console.error('GA4 pull failed:', e.message); }
  try { searchTerms = await pullGSC(); } catch (e) { console.error('GSC pull failed:', e.message); }
  try { linkedinAuto = await pullLinkedIn(); } catch (e) { console.error('LinkedIn pull failed:', e.message); }

  // Merge LinkedIn follower totals from manual overlay onto the GA4 months
  const followersByKey = (manual.linkedinFollowersByMonth || {});
  months.forEach(m => { if (followersByKey[m.key] != null) m.linkedinFollowers = followersByKey[m.key]; });

  const today = new Date();
  const lastUpdated = `${today.getDate()} ${MONTHS[today.getMonth()].slice(0,3)} ${today.getFullYear()}`;

  // Only include automated keys when we actually got data, so a failed pull
  // never wipes the figures already written into the dashboard file.
  const out = { lastUpdated };
  if (months.length) out.months = months;
  if (searchTerms.length) out.searchTerms = searchTerms;

  // Everything else comes straight from the manual overlay
  ['blogs','gbp','competitors','competitorOpps','competitorIdeas','websiteReview','ideas','linkedin']
    .forEach(k => { if (manual[k] != null) out[k] = manual[k]; });

  // LinkedIn API numbers go on last, layered over the manual linkedin object so
  // hand written fields (advocacy, top posts) survive and only the numeric
  // fields the API returned are overwritten. Nulls are dropped so a missing
  // metric never blanks a value you entered by hand.
  if (linkedinAuto) {
    const clean = {};
    Object.keys(linkedinAuto).forEach(k => { if (linkedinAuto[k] != null) clean[k] = linkedinAuto[k]; });
    out.linkedin = Object.assign({}, out.linkedin || {}, clean);
  }

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
app.use(cors());                        // lets the dashboard on nx-rd.com read it
app.get('/api/ek-dashboard.json', (_req, res) => res.json(cache));
app.get('/health', (_req, res) => res.send('ok'));
app.listen(PORT, () => console.log('EK dashboard data service on :' + PORT));
