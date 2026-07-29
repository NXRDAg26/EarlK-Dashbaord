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

/* LinkedIn.
   LINKEDIN_ACCESS_TOKEN lasts 60 days. Set LINKEDIN_REFRESH_TOKEN, along with
   the client id and secret, and the service renews it on its own and writes the
   new one to the database, so the figures do not quietly go stale two months
   after setup. Leave the token blank and the manual figures are used instead. */
let   LI_TOKEN    = process.env.LINKEDIN_ACCESS_TOKEN || '';
const LI_REFRESH  = process.env.LINKEDIN_REFRESH_TOKEN || '';
let   LI_SAVED_REFRESH = '';   // set when the connect page has been used
const LI_CLIENT   = process.env.LINKEDIN_CLIENT_ID || '';
const LI_SECRET   = process.env.LINKEDIN_CLIENT_SECRET || '';
/* The organisation can be given as the full URN, as the bare id, or as the
   company page URL copied out of the address bar. All three are accepted and
   normalised, because pasting the admin URL is the obvious thing to do and it
   should not quietly fail. */
function normaliseOrgUrn(raw){
  const v = (raw || '').trim();
  if (!v) return '';
  if (/^urn:li:organization:\d+$/.test(v)) return v;
  const m = v.match(/(?:company|organization)\/(\d+)/) || v.match(/^(\d+)$/);
  if (m) return 'urn:li:organization:' + m[1];
  console.error('LINKEDIN_ORG_URN could not be read: ' + v);
  return '';
}
const LI_ORG_URN  = normaliseOrgUrn(process.env.LINKEDIN_ORG_URN);
const LI_VERSION  = process.env.LINKEDIN_API_VERSION || '202606';

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
    _range: { start: period.start, end: period.end },
    partial: !!period.partial,
    daysElapsed: period.daysElapsed || null,
    daysInPeriod: period.daysInPeriod || null,
    linkedinFollowers: 0,        // filled from the manual overlay and the live count
    sources
  };
}

/* ---------------------------------------------------------------------------
   NEWS ARTICLES, live from GA4
   ---------------------------------------------------------------------------
   The article table was a hand written list in manual.json, so the view counts
   only moved when someone edited the file. This reads the news pages straight
   out of GA4. Publication dates are not something Analytics knows, so those are
   still taken from manual.json where they exist, matched on the URL.
   --------------------------------------------------------------------------- */
const BLOG_SITE   = (process.env.BLOG_SITE || 'https://earlkendrick.com').replace(/\/$/, '');
const BLOG_DAYS   = Math.max(7, +(process.env.BLOG_DAYS || 90));
const BLOG_LIMIT  = Math.max(3, +(process.env.BLOG_LIMIT || 12));

const pathOf = u => {
  try { return new URL(u).pathname.replace(/\/$/, '') || '/'; }
  catch (e) { return (u || '').replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, ''); }
};
const dateLabel = d => d.getDate() + ' ' + MON3[d.getMonth()] + ' ' + d.getFullYear();
const decodeHtml = t => (t || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
  .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/&#8217;|&rsquo;|&#039;|&apos;/g, "'").replace(/&#8216;|&lsquo;/g, "'")
  .replace(/&#8220;|&ldquo;|&#8221;|&rdquo;|&quot;/g, '"')
  .replace(/&#8211;|&ndash;/g, '-').replace(/&#8212;|&mdash;/g, '-')
  .trim();

async function grab(url, asText){
  const res = await fetch(url, { headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; EK-dashboard/1.3; +https://earlkendrick.com)',
    'Accept': asText ? 'application/xml,text/xml,*/*' : 'application/json'
  }, redirect: 'follow' });
  if (!res.ok) throw new Error(res.status);
  return asText ? res.text() : res.json();
}

/* ---------------------------------------------------------------------------
   FINDING THE ARTICLES
   ---------------------------------------------------------------------------
   The blogs sit on root level slugs, so there is no path pattern GA4 can be
   filtered on and the list of article URLs has to come from the site itself.
   Asking WordPress for its posts is the first choice because it gives real
   titles and publication dates, but the REST route can be switched off, the
   articles can be a custom post type rather than plain posts, and the site may
   answer on www rather than the bare domain. So several routes are tried in
   turn and the first that answers is used. Whichever one worked is reported in
   the diagnostics, so a future failure names itself.
   --------------------------------------------------------------------------- */
async function listArticles(manual){
  const out = {};
  const tried = [];
  const hosts = [BLOG_SITE];
  if (/^https:\/\/(?!www\.)/.test(BLOG_SITE)) hosts.push(BLOG_SITE.replace('https://', 'https://www.'));
  else hosts.push(BLOG_SITE.replace('https://www.', 'https://'));

  const addPost = (link, title, dateStr) => {
    const path = pathOf(link);
    if (!path || path === '/') return;
    const d = dateStr ? new Date(dateStr) : null;
    out[path] = { title: decodeHtml(title), url: link, date: (d && !isNaN(d)) ? dateLabel(d) : '' };
  };

  // 1 and 2. The WordPress REST API, asking first which post types are public
  for (const host of hosts) {
    if (Object.keys(out).length) break;
    let bases = ['posts'];
    try {
      const types = await grab(host + '/wp-json/wp/v2/types', false);
      const found = Object.values(types || {})
        .map(t => t && t.rest_base)
        .filter(b => b && !['pages', 'media', 'blocks', 'menu-items', 'navigation', 'templates', 'template-parts', 'wp_template', 'wp_navigation'].includes(b));
      if (found.length) bases = [...new Set(found)];
      tried.push(host + ' types: ' + bases.join(', '));
    } catch (e) { tried.push(host + ' types failed (' + e.message + ')'); }

    for (const base of bases) {
      try {
        const posts = await grab(host + '/wp-json/wp/v2/' + base + '?per_page=100&orderby=date&order=desc&_fields=title,date,link', false);
        if (Array.isArray(posts) && posts.length) {
          posts.forEach(pst => addPost(pst.link, pst.title && pst.title.rendered, pst.date));
          tried.push(host + '/' + base + ': ' + posts.length);
        }
      } catch (e) { tried.push(host + '/' + base + ' failed (' + e.message + ')'); }
    }
  }

  // 3. The sitemap, if the REST API is closed. Only the post sitemaps are read,
  //    so ordinary pages such as contact and about are left out.
  if (!Object.keys(out).length) {
    for (const host of hosts) {
      if (Object.keys(out).length) break;
      for (const root of ['/wp-sitemap.xml', '/sitemap_index.xml', '/sitemap.xml']) {
        try {
          const xml = await grab(host + root, true);
          let maps = (xml.match(/<loc>([^<]+)<\/loc>/g) || []).map(m => m.replace(/<\/?loc>/g, ''));
          const postMaps = maps.filter(u => /posts-post|post-sitemap|posts?-1|news|insight|blog/i.test(u));
          const use = postMaps.length ? postMaps : (/<url>/.test(xml) ? [host + root] : []);
          for (const m of use.slice(0, 6)) {
            const sub = m === host + root ? xml : await grab(m, true);
            const blocks = sub.match(/<url>[\s\S]*?<\/url>/g) || [];
            blocks.forEach(b => {
              const loc = (b.match(/<loc>([^<]+)<\/loc>/) || [])[1];
              const mod = (b.match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1];
              if (loc) addPost(loc, '', mod);
            });
          }
          if (Object.keys(out).length) { tried.push(host + root + ': ' + Object.keys(out).length + ' urls'); break; }
        } catch (e) { tried.push(host + root + ' failed (' + e.message + ')'); }
      }
    }
  }

  // 4. Anything named by hand always counts, and its title and date win, since
  //    a person wrote them.
  (manual.blogs || []).forEach(b => {
    const path = pathOf(b.url || '');
    if (!path) return;
    out[path] = Object.assign({}, out[path] || {}, { title: b.title || (out[path] && out[path].title) || '', url: b.url, date: b.date || (out[path] && out[path].date) || '' });
  });

  return { map: out, tried };
}

async function ga4Blogs(today, manual){
  const found = await listArticles(manual);
  const articles = found.map;
  const howMany = Object.keys(articles).length;

  const start = iso(addDays(today, -BLOG_DAYS));
  const end   = iso(addDays(today, -1));
  const [rep] = await analytics.runReport({
    property: `properties/${GA4_PROPERTY_ID}`,
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: 'pagePath' }, { name: 'pageTitle' }],
    metrics: [{ name: 'screenPageViews' }, { name: 'userEngagementDuration' }, { name: 'activeUsers' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 500
  });

  const rows = [];
  (rep.rows || []).forEach(r => {
    const path = r.dimensionValues[0].value.replace(/[?#].*$/, '').replace(/\/$/, '');
    const art = articles[path];
    if (!art) return;
    const views  = Math.round(+r.metricValues[0].value || 0);
    const engTot = +r.metricValues[1].value || 0;
    const users  = +r.metricValues[2].value || 0;
    // A title from the site is better than one from the browser tab, which
    // carries the site name on the end.
    const fromGa = (r.dimensionValues[1].value || '').split('|')[0].split(' - ')[0].trim();
    rows.push({
      title: art.title || fromGa || path,
      date: art.date || '',
      views,
      avgTimeSec: users ? Math.round(engTot / users) : 0,
      url: art.url || (BLOG_SITE + path + '/')
    });
  });

  // Same article on two paths, for example with and without a trailing slash
  const merged = {};
  rows.forEach(r => {
    const k = r.url;
    if (merged[k]) { merged[k].views += r.views; }
    else merged[k] = r;
  });
  const list = Object.values(merged).sort((a, b) => b.views - a.views).slice(0, BLOG_LIMIT);

  return { rows: list, sources: found.tried, articleCount: howMany };
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
   TOKEN STORE
   Access and refresh tokens are kept in the database rather than in an
   environment variable, so authorising once survives every later redeploy.
   --------------------------------------------------------------------------- */
async function storeGet(key){
  if (!eventsPool) return null;
  try {
    const { rows } = await eventsPool.query('SELECT data, updated_at FROM ek_store WHERE key = $1', [key]);
    return rows.length ? Object.assign({}, rows[0].data, { _updatedAt: rows[0].updated_at }) : null;
  } catch (e) { return null; }
}
async function storePut(key, obj){
  if (!eventsPool) return false;
  try {
    await eventsPool.query(
      `INSERT INTO ek_store (key, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [key, JSON.stringify(obj)]
    );
    return true;
  } catch (e) { console.error('Could not save ' + key + ':', e.message); return false; }
}

/* ---------------------------------------------------------------------------
   GOOGLE BUSINESS PROFILE
   ---------------------------------------------------------------------------
   The Business Profile APIs will not accept a service account or an API key.
   They are user owned data, so they need OAuth against a Google account that
   manages the listing, with the business.manage scope. On top of that, a new
   Cloud project is given zero quota until Google approves a written access
   request, so the calls return 403 until that lands.

   All of it is built and ready. Authorise at /connect and the moment the quota
   is granted the figures start arriving with no further work.
   --------------------------------------------------------------------------- */
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const PUBLIC_URL           = (process.env.PUBLIC_URL || process.env.SELF_URL || '').replace(/\/$/, '');
const GBP_LOCATION_ID      = process.env.GBP_LOCATION_ID || '';        // digits only, no "locations/"
const GBP_SCOPE            = 'https://www.googleapis.com/auth/business.manage';

const GBP_METRICS = [
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
  'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
  'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'WEBSITE_CLICKS',
  'CALL_CLICKS',
  'BUSINESS_DIRECTION_REQUESTS',
  'BUSINESS_CONVERSATIONS'
];
// Which of the above are views of the listing, and which are actions taken on it
const GBP_VIEW_METRICS = GBP_METRICS.filter(m => m.startsWith('BUSINESS_IMPRESSIONS'));
const GBP_ACTION_LABEL = {
  WEBSITE_CLICKS: 'Website clicks',
  BUSINESS_DIRECTION_REQUESTS: 'Direction requests',
  CALL_CLICKS: 'Calls',
  BUSINESS_CONVERSATIONS: 'Messages'
};

async function googleAccessToken(){
  const saved = await storeGet('google_token');
  if (!saved || !saved.refresh_token) return null;
  // Reuse an access token that has not expired yet
  if (saved.access_token && saved.expires_at && Date.now() < saved.expires_at - 60000) return saved.access_token;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return null;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: saved.refresh_token,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET
    })
  });
  if (!res.ok) { console.error('Google token refresh failed:', res.status, await res.text()); return null; }
  const d = await res.json();
  if (!d.access_token) return null;
  await storePut('google_token', {
    refresh_token: saved.refresh_token,
    access_token: d.access_token,
    expires_at: Date.now() + (d.expires_in || 3600) * 1000
  });
  return d.access_token;
}

async function gApi(url, token){
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const text = await res.text();
  if (!res.ok) {
    let hint = '';
    if (res.status === 403 && /quota|PERMISSION_DENIED/i.test(text)) {
      hint = ' (this is the access request gate: the project has no quota until Google approves the form at support.google.com/business/contact/api_default)';
    }
    throw new Error(res.status + ' ' + text.slice(0, 300) + hint);
  }
  try { return JSON.parse(text); } catch (e) { return {}; }
}

/* Earl Kendrick has offices in several cities, each with its own listing, so
   reporting only the first one found would understate the whole picture badly.
   Every listing the authorised account manages is read and the figures added
   together, with the star rating weighted by how many reviews each listing has.

   Set GBP_LOCATION_ID to a single id, or to several separated by commas, to
   report on only those. Leave it blank and everything is included. */
async function gbpResolveLocations(token){
  if (GBP_LOCATION_ID) {
    const ids = GBP_LOCATION_ID.split(',').map(x => x.trim().replace(/^locations\//, '')).filter(Boolean);
    return ids.map(id => ({ id, name: null, account: null }));
  }

  const accts = await gApi('https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20', token);
  const list = accts.accounts || [];
  if (!list.length) throw new Error('the authorised Google account manages no Business Profile accounts');

  const out = [];
  for (const acct of list) {
    let pageToken = '';
    for (let page = 0; page < 5; page++) {
      const url = 'https://mybusinessbusinessinformation.googleapis.com/v1/' + acct.name +
        '/locations?readMask=name,title,storefrontAddress&pageSize=100' + (pageToken ? '&pageToken=' + pageToken : '');
      let d;
      try { d = await gApi(url, token); }
      catch (e) { console.error('Locations on ' + acct.name + ' could not be read:', e.message); break; }
      (d.locations || []).forEach(loc => {
        const city = loc.storefrontAddress && (loc.storefrontAddress.locality || '');
        out.push({
          id: loc.name.replace(/^locations\//, ''),
          name: [loc.title, city].filter(Boolean).join(', ') || loc.name,
          account: acct.name
        });
      });
      pageToken = d.nextPageToken || '';
      if (!pageToken) break;
    }
  }
  if (!out.length) throw new Error('no listings found on the authorised account');
  return out;
}

function dateParams(prefix, isoDate){
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${prefix}.year=${y}&${prefix}.month=${m}&${prefix}.day=${d}`;
}

async function gbpDaily(token, locationId, startISO, endISO){
  const url = 'https://businessprofileperformance.googleapis.com/v1/locations/' + locationId +
    ':fetchMultiDailyMetricsTimeSeries?' +
    GBP_METRICS.map(m => 'dailyMetrics=' + m).join('&') + '&' +
    dateParams('dailyRange.start_date', startISO) + '&' +
    dateParams('dailyRange.end_date', endISO);

  const d = await gApi(url, token);
  const byDay = {};                                   // "2026-07-14" -> { metric: value }
  (d.multiDailyMetricTimeSeries || []).forEach(group => {
    (group.dailyMetricTimeSeries || []).forEach(series => {
      const metric = series.dailyMetric;
      const points = (series.timeSeries && series.timeSeries.datedValues) || [];
      points.forEach(pt => {
        const dt = pt.date || {};
        if (!dt.year) return;
        const key = dt.year + '-' + pad2(dt.month) + '-' + pad2(dt.day);
        (byDay[key] = byDay[key] || {})[metric] = (byDay[key][metric] || 0) + (+pt.value || 0);
      });
    });
  });
  return byDay;
}

// Reviews and the star rating still only come from the older v4 endpoint
async function gbpReviews(token, account, locationId){
  if (!account) return null;
  const d = await gApi('https://mybusiness.googleapis.com/v4/' + account + '/locations/' + locationId + '/reviews?pageSize=1', token);
  return {
    reviews: d.totalReviewCount != null ? d.totalReviewCount : null,
    rating: d.averageRating != null ? +(+d.averageRating).toFixed(1) : null
  };
}

/* Rolls the daily figures up into the same period keys the rest of the
   dashboard uses, in the shape the Google Business tab already reads. */
async function pullGbp(months, weeks){
  const out = { ok: false, error: null, byPeriod: {}, location: null };
  const token = await googleAccessToken();
  if (!token) { out.error = 'not connected, authorise at /connect'; return out; }

  let locs;
  try { locs = await gbpResolveLocations(token); }
  catch (e) { out.error = e.message; return out; }
  out.location = locs.length === 1
    ? (locs[0].name || locs[0].id)
    : locs.length + ' listings: ' + locs.map(l => l.name || l.id).join(', ');
  out.locations = locs.length;

  const all = months.concat(weeks);
  if (!all.length) { out.error = 'no periods to report on'; return out; }
  const start = all.map(p => p._range.start).sort()[0];
  const end   = all.map(p => p._range.end).sort().slice(-1)[0];

  // Daily figures from every listing, added together
  const byDay = {};
  const failures = [];
  for (const loc of locs) {
    try {
      const one = await gbpDaily(token, loc.id, start, end);
      Object.keys(one).forEach(day => {
        const dst = byDay[day] || (byDay[day] = {});
        Object.keys(one[day]).forEach(m => { dst[m] = (dst[m] || 0) + one[day][m]; });
      });
    } catch (e) { failures.push((loc.name || loc.id) + ': ' + e.message); }
  }
  if (!Object.keys(byDay).length) {
    out.error = failures.length ? failures[0] : 'no performance data returned for any listing';
    return out;
  }
  if (failures.length) out.partial = failures;

  // Reviews across every listing, with the rating weighted by review count
  let reviews = { reviews: null, rating: null };
  let totalReviews = 0, weighted = 0, gotAny = false;
  for (const loc of locs) {
    try {
      const r = await gbpReviews(token, loc.account, loc.id);
      if (r && r.reviews != null) {
        gotAny = true;
        totalReviews += r.reviews;
        if (r.rating != null) weighted += r.rating * r.reviews;
      }
    } catch (e) { console.error('GBP reviews unavailable for ' + (loc.name || loc.id) + ':', e.message); }
  }
  if (gotAny) reviews = { reviews: totalReviews, rating: totalReviews ? +(weighted / totalReviews).toFixed(1) : null };

  all.forEach(p => {
    const bucket = { views: 0, interactions: 0, breakdown: {} };
    Object.values(GBP_ACTION_LABEL).forEach(l => { bucket.breakdown[l] = 0; });
    for (let t = new Date(p._range.start + 'T00:00:00Z').getTime();
         t <= new Date(p._range.end + 'T00:00:00Z').getTime(); t += 86400000) {
      const day = byDay[new Date(t).toISOString().slice(0, 10)];
      if (!day) continue;
      GBP_VIEW_METRICS.forEach(m => { bucket.views += day[m] || 0; });
      Object.keys(GBP_ACTION_LABEL).forEach(m => {
        const v = day[m] || 0;
        bucket.interactions += v;
        bucket.breakdown[GBP_ACTION_LABEL[m]] += v;
      });
    }
    if (reviews.reviews != null) bucket.reviews = reviews.reviews;
    if (reviews.rating != null)  bucket.rating = reviews.rating;
    out.byPeriod[p.key] = bucket;
  });

  out.ok = Object.keys(out.byPeriod).length > 0;
  return out;
}

/* ---------------------------------------------------------------------------
   LINKEDIN, live
   ---------------------------------------------------------------------------
   Three calls against the Community Management API:

     organizationalEntityFollowerStatistics   lifetime count and gains per period
     organizationalEntityShareStatistics      impressions, clicks and engagement
     organizationPageStatistics               page views

   The page needs rw_organization_admin and r_organization_social on an app
   with Community Management API access, and the token must belong to a page
   admin. Without any of that the manual figures in manual.json are used and
   the dashboard labels them as typed in rather than measured.

   Follower history is rebuilt by taking the lifetime count and subtracting the
   gains of every later period, which gives a real month by month series rather
   than the last known figure carried forward.
   --------------------------------------------------------------------------- */
const LI_BASE = 'https://api.linkedin.com/rest/';

async function refreshLinkedInToken(){
  if ((!LI_REFRESH && !LI_SAVED_REFRESH) || !LI_CLIENT || !LI_SECRET) return false;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: LI_SAVED_REFRESH || LI_REFRESH,
    client_id: LI_CLIENT,
    client_secret: LI_SECRET
  });
  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) { console.error('LinkedIn token refresh failed:', res.status, await res.text()); return false; }
  const data = await res.json();
  if (!data.access_token) return false;
  LI_TOKEN = data.access_token;
  console.log('LinkedIn access token renewed');
  if (eventsPool) {
    try {
      await eventsPool.query(
        `INSERT INTO ek_store (key, data, updated_at) VALUES ('linkedin_token', $1::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [JSON.stringify({ access_token: LI_TOKEN, renewedAt: new Date().toISOString() })]
      );
    } catch (e) { console.error('Renewed LinkedIn token could not be saved:', e.message); }
  }
  return true;
}

// Read back a token renewed on an earlier run, so a redeploy does not go back
// to an environment variable that has since expired.
async function loadSavedLinkedInToken(){
  if (!eventsPool) return;
  try {
    const { rows } = await eventsPool.query(`SELECT data, updated_at FROM ek_store WHERE key = 'linkedin_token'`);
    if (rows.length && rows[0].data && rows[0].data.access_token) {
      const savedAt = new Date(rows[0].updated_at).getTime();
      // Only trust it if it is newer than 55 days, otherwise let the refresh run
      if (Date.now() - savedAt < 55 * 86400000) LI_TOKEN = rows[0].data.access_token;
      if (rows[0].data.refresh_token) LI_SAVED_REFRESH = rows[0].data.refresh_token;
    }
  } catch (e) { /* table may not exist yet on a first run */ }
}

async function liGet(path, attempt){
  const res = await fetch(LI_BASE + path, {
    headers: {
      Authorization: 'Bearer ' + LI_TOKEN,
      'LinkedIn-Version': LI_VERSION,
      'X-Restli-Protocol-Version': '2.0.0'
    }
  });
  if (res.status === 401 && !attempt) {
    const ok = await refreshLinkedInToken();
    if (ok) return liGet(path, 1);
  }
  if (!res.ok) throw new Error('LinkedIn ' + path.split('?')[0] + ' -> ' + res.status + ' ' + (await res.text()).slice(0, 300));
  return res.json();
}

const ms = d => new Date(d + 'T00:00:00Z').getTime();
function timeIntervals(startISO, endISO, granularity){
  // The end is exclusive in practice, so push it a day on to include the last day
  const end = new Date(ms(endISO) + 86400000).getTime();
  return `timeIntervals=(timeRange:(start:${ms(startISO)},end:${end}),timeGranularityType:${granularity})`;
}
function monthKeyFromMs(t){
  const d = new Date(t);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1);
}

// Lifetime follower count. Falls back to the older networkSizes endpoint,
// which is still served, if the statistics call is not permitted.
async function liLifetimeFollowers(urn){
  try {
    const d = await liGet('organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=' + encodeURIComponent(urn));
    const el = (d.elements || [])[0];
    const t = el && el.totalFollowerCounts;
    if (t) return (t.organicFollowerCount || 0) + (t.paidFollowerCount || 0);
  } catch (e) {
    console.error('Follower statistics unavailable, trying networkSizes:', e.message);
  }
  const n = await liGet('../v2/networkSizes/' + encodeURIComponent(urn) + '?edgeType=CompanyFollowedByMember');
  return n.firstDegreeSize != null ? n.firstDegreeSize : null;
}

// Follower gains bucketed by period key
async function liFollowerGains(urn, startISO, endISO, granularity, keyOf){
  const d = await liGet('organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=' +
    encodeURIComponent(urn) + '&' + timeIntervals(startISO, endISO, granularity));
  const out = {};
  (d.elements || []).forEach(el => {
    const g = el.followerGains || {};
    const gain = (g.organicFollowerGain || 0) + (g.paidFollowerGain || 0);
    const k = keyOf(el.timeRange && el.timeRange.start);
    if (k) out[k] = (out[k] || 0) + gain;
  });
  return out;
}

// Impressions, clicks, reactions and engagement, bucketed by period key
async function liShareStats(urn, startISO, endISO, granularity, keyOf){
  const d = await liGet('organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=' +
    encodeURIComponent(urn) + '&' + timeIntervals(startISO, endISO, granularity));
  const out = {};
  (d.elements || []).forEach(el => {
    const t = el.totalShareStatistics || {};
    const k = keyOf(el.timeRange && el.timeRange.start);
    if (!k) return;
    const b = out[k] || (out[k] = { impressions: 0, uniqueImpressions: 0, clicks: 0, reactions: 0, comments: 0, shares: 0 });
    b.impressions       += t.impressionCount || 0;
    b.uniqueImpressions += t.uniqueImpressionsCount || 0;
    b.clicks            += t.clickCount || 0;
    b.reactions         += t.likeCount || 0;
    b.comments          += t.commentCount || 0;
    b.shares            += t.shareCount || 0;
  });
  Object.values(out).forEach(b => {
    const acts = b.clicks + b.reactions + b.comments + b.shares;
    b.engagementRate = b.impressions ? +(acts / b.impressions * 100).toFixed(2) : 0;
  });
  return out;
}

// Page views, bucketed by period key
async function liPageViews(urn, startISO, endISO, granularity, keyOf){
  const d = await liGet('organizationPageStatistics?q=organization&organization=' +
    encodeURIComponent(urn) + '&' + timeIntervals(startISO, endISO, granularity));
  const out = {};
  (d.elements || []).forEach(el => {
    const k = keyOf(el.timeRange && el.timeRange.start);
    if (!k) return;
    const v = el.totalPageStatistics && el.totalPageStatistics.views;
    let views = 0;
    if (v) Object.values(v).forEach(x => { if (x && typeof x.pageViews === 'number') views += x.pageViews; });
    out[k] = (out[k] || 0) + views;
  });
  return out;
}

/* Pulls everything and writes it onto the periods. Anything that fails is
   reported in the diagnostics and simply leaves that figure to the manual
   overlay, rather than zeroing it. */
async function pullLinkedIn(months, weeks){
  const result = { ok: false, followers: null, error: null, detail: {} };
  await loadSavedLinkedInToken();

  if (!LI_TOKEN || !LI_ORG_URN) {
    result.error = !LI_ORG_URN
      ? 'LINKEDIN_ORG_URN is not set, manual figures in use'
      : 'not connected, authorise at /connect';
    return result;
  }

  // Lifetime count first. If this fails nothing else will work either.
  try {
    result.followers = await liLifetimeFollowers(LI_ORG_URN);
    result.ok = result.followers != null;
  } catch (e) {
    result.error = e.message;
    return result;
  }

  const monthKeys = months.map(m => m.key);
  const weekByDay = {};                       // day key -> week key
  weeks.forEach(w => {
    const src = w._range || null;
    if (!src) return;
    for (let t = ms(src.start); t <= ms(src.end); t += 86400000) {
      weekByDay[new Date(t).toISOString().slice(0, 10)] = w.key;
    }
  });
  const dayToWeek = t => weekByDay[new Date(t).toISOString().slice(0, 10)] || null;

  const mStart = months.length ? months[0]._range.start : null;
  const mEnd   = months.length ? months[months.length - 1]._range.end : null;
  const wStart = weeks.length ? weeks[0]._range.start : null;
  const wEnd   = weeks.length ? weeks[weeks.length - 1]._range.end : null;

  // Follower gains
  try {
    const gm = mStart ? await liFollowerGains(LI_ORG_URN, mStart, mEnd, 'MONTH', monthKeyFromMs) : {};
    const gw = wStart ? await liFollowerGains(LI_ORG_URN, wStart, wEnd, 'DAY', dayToWeek) : {};
    months.forEach(p => { if (gm[p.key] != null) p.linkedinFollowerGain = gm[p.key]; });
    weeks.forEach(p  => { if (gw[p.key] != null) p.linkedinFollowerGain = gw[p.key]; });

    // Rebuild the follower series backwards from the lifetime count
    const back = list => {
      let running = result.followers;
      for (let i = list.length - 1; i >= 0; i--) {
        list[i].linkedinFollowers = running;
        running -= (list[i].linkedinFollowerGain || 0);
      }
    };
    if (result.followers != null) { back(months); back(weeks); }
    result.detail.gains = Object.keys(gm).length + ' months, ' + Object.keys(gw).length + ' weeks';
  } catch (e) {
    result.detail.gains = 'FAILED: ' + e.message;
    console.error('LinkedIn follower gains failed:', e.message);
  }

  // Share statistics
  try {
    const sm = mStart ? await liShareStats(LI_ORG_URN, mStart, mEnd, 'MONTH', monthKeyFromMs) : {};
    const sw = wStart ? await liShareStats(LI_ORG_URN, wStart, wEnd, 'DAY', dayToWeek) : {};
    const apply = (list, map) => list.forEach(p => {
      const b = map[p.key]; if (!b) return;
      p.linkedinImpressions = b.impressions;
      p.linkedinUniqueImpressions = b.uniqueImpressions;
      p.linkedinClicks = b.clicks;
      p.linkedinReactions = b.reactions;
      p.linkedinComments = b.comments;
      p.linkedinShares = b.shares;
      p.linkedinEngagementRate = b.engagementRate;
    });
    apply(months, sm); apply(weeks, sw);
    result.detail.shares = Object.keys(sm).length + ' months, ' + Object.keys(sw).length + ' weeks';
  } catch (e) {
    result.detail.shares = 'FAILED: ' + e.message;
    console.error('LinkedIn share statistics failed:', e.message);
  }

  // Page views
  try {
    const pm = mStart ? await liPageViews(LI_ORG_URN, mStart, mEnd, 'MONTH', monthKeyFromMs) : {};
    const pw = wStart ? await liPageViews(LI_ORG_URN, wStart, wEnd, 'DAY', dayToWeek) : {};
    months.forEach(p => { if (pm[p.key] != null) p.linkedinPageViews = pm[p.key]; });
    weeks.forEach(p  => { if (pw[p.key] != null) p.linkedinPageViews = pw[p.key]; });
    result.detail.pageViews = Object.keys(pm).length + ' months, ' + Object.keys(pw).length + ' weeks';
  } catch (e) {
    result.detail.pageViews = 'FAILED: ' + e.message;
    console.error('LinkedIn page statistics failed:', e.message);
  }

  return result;
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
  blogs:    { ok: false, count: 0, articlesFound: 0, howLooked: [], error: null },
  gbp:      { ok: false, periods: 0, listings: 0, location: null, partial: null, error: null },
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

  // ---- LinkedIn ----
  let li = { ok: false, followers: null, error: 'not attempted', detail: {} };
  try {
    li = await pullLinkedIn(months, weeks);
    diag.linkedin = { ok: li.ok, followers: li.followers, error: li.error, detail: li.detail };
  } catch (e) {
    diag.linkedin = { ok: false, followers: null, error: e.message, detail: {} };
    console.error('LinkedIn pull failed:', e.message);
  }

  /* When the API is not connected, or only partly, the hand written figures in
     manual.json fill the gaps. Any period the API answered for is left alone. */
  const byMonth = manual.linkedinFollowersByMonth || {};
  const byWeek  = manual.linkedinFollowersByWeek  || {};
  if (!li.ok) {
    fillFollowers(months, byMonth, null,    li.followers);
    fillFollowers(weeks,  byWeek,  byMonth, li.followers);
  } else {
    // Only back fill periods the API had nothing for
    const gap = list => list.some(p => !p.linkedinFollowers);
    if (gap(months)) fillFollowers(months, byMonth, null,    null);
    if (gap(weeks))  fillFollowers(weeks,  byWeek,  byMonth, null);
  }

  /* Counts typed into the dashboard itself, on the shared board. They fill any
     period the API did not answer for, which is what keeps the followers KPI
     moving while the Community Management access request is still with
     LinkedIn. A measured figure always wins over a typed one. */
  if (!li.ok) {
    try {
      const typed = await storeGet('followers');
      const list = (typed && Array.isArray(typed.entries) ? typed.entries : [])
        .filter(e => e && e.date && e.count != null)
        .sort((a, b) => a.date < b.date ? -1 : 1);
      if (list.length) {
        const atOrBefore = endISO => {
          let v = null;
          list.forEach(e => { if (e.date <= endISO) v = +e.count; });
          return v;
        };
        months.concat(weeks).forEach(p => {
          const v = atOrBefore(p._range.end);
          if (v != null) { p.linkedinFollowers = v; p.linkedinFollowersTyped = true; }
        });
        // Anything earlier than the first entry takes that first figure
        const first = +list[0].count;
        months.concat(weeks).forEach(p => { if (!p.linkedinFollowers) p.linkedinFollowers = first; });
        diag.linkedin.typedEntries = list.length;
      }
    } catch (e) { console.error('Typed follower counts could not be read:', e.message); }
  }

  // Mark each period so the dashboard can say which figures were measured
  const liLive = !!li.ok;
  months.concat(weeks).forEach(p => { p.linkedinLive = liLive && p.linkedinImpressions != null; });

  // ---- Google Business Profile ----
  let gbp = { ok: false, error: 'not attempted', byPeriod: {}, location: null };
  try {
    gbp = await pullGbp(months, weeks);
    diag.gbp = { ok: gbp.ok, periods: Object.keys(gbp.byPeriod).length, listings: gbp.locations || 0, location: gbp.location, partial: gbp.partial || null, error: gbp.error };
  } catch (e) {
    diag.gbp = { ok: false, periods: 0, location: null, error: e.message };
    console.error('Google Business pull failed:', e.message);
  }

  // ---- News articles ----
  let blogs = null;
  try {
    const b = await ga4Blogs(today, manual);
    blogs = b.rows;
    diag.blogs = {
      ok: !!(blogs && blogs.length),
      count: blogs ? blogs.length : 0,
      articlesFound: b.articleCount,
      howLooked: b.sources,
      error: blogs && blogs.length ? null
        : (b.articleCount ? 'article URLs were found but none of them had views in GA4' : 'no article URLs could be found, see howLooked')
    };
  } catch (e) {
    blogs = null;
    diag.blogs = { ok: false, count: 0, articlesFound: 0, howLooked: [], error: e.message };
    console.error('Article views pull failed:', e.message);
  }

  // ---- Assemble ----
  const lastUpdated = `${today.getDate()} ${MON3[today.getMonth()]} ${today.getFullYear()}`;
  const out = { lastUpdated, generatedAt: new Date().toISOString() };

  // Only include automated keys when there is real data behind them, so a failed
  // pull never wipes the figures already written into the dashboard file.
  months.concat(weeks).forEach(p => { delete p._range; });

  if (months.length) out.months = months;
  if (weeks.length)  out.weeks  = weeks;
  if (latestTerms.length) out.searchTerms = latestTerms;
  if (blogs && blogs.length) out.blogs = blogs;          // live, overrides the manual list below
  if (gbp.ok) {
    out.gbpByPeriod = gbp.byPeriod;                      // live, overrides the manual list below
    const newest = months.length ? months[months.length - 1].key : null;
    const n = newest && gbp.byPeriod[newest];
    if (n) out.gbp = { interactions: n.interactions, monthlyViews: n.views, reviews: n.reviews, rating: n.rating, breakdown: n.breakdown };
    out.gbpLive = true;
  }
  out.linkedinLive = !!(li && li.ok);
  if (li && li.followers != null) out.linkedinFollowersNow = li.followers;

  // Hand authored sections. "linkedin" is deliberately not in this list: the
  // front end owns DASHBOARD.linkedin, the advocacy seed and the best practice
  // cards, and the dashboard merge replaces a whole object rather than deep
  // merging, so sending one from here would wipe them.
  ['blogs','gbp','gbpByPeriod','competitors','competitorOpps','competitorIdeas','shareOfVoice','websiteReview','ideas']
    .forEach(k => {
      if (k === 'blogs' && out.blogs) return;            // the live list wins
      if ((k === 'gbp' || k === 'gbpByPeriod') && gbp.ok) return;
      const v = manual[k];
      if (v == null) return;
      // An empty array or object from manual.json used to be sent as though it
      // were real. The dashboard then ignored it and kept its own placeholder,
      // which is how the article table stayed frozen. Empty means say nothing.
      if (Array.isArray(v) && !v.length) return;
      if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) return;
      out[k] = v;
    });

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
    blogs: diag.blogs.ok ? `${diag.blogs.count} articles` : 'FAILED: ' + diag.blogs.error,
    gbp: diag.gbp.ok ? `${diag.gbp.periods} periods across ${diag.gbp.listings} listing${diag.gbp.listings===1?'':'s'}` : 'not live: ' + diag.gbp.error,
    linkedin: diag.linkedin.ok
      ? `${diag.linkedin.followers} followers, ` + JSON.stringify(diag.linkedin.detail || {})
      : diag.linkedin.error
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
const SELF_URL = process.env.SELF_URL || PUBLIC_URL || '';
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
    config: {
      GA4_PROPERTY_ID, GSC_SITE_URL, WEEKS_BACK, MONTHS_BACK,
      database: !!eventsPool,
      publicUrl: PUBLIC_URL || 'NOT SET',
      linkedinOrg: LI_ORG_URN || 'NOT SET or could not be read',
      googleOauth: GOOGLE_CLIENT_ID ? 'configured' : 'NOT SET'
    }
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
['content', 'videos', 'competitors', 'followers'].forEach(name => {
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

/* ---------------------------------------------------------------------------
   CONNECT
   One page with a button for each account. Authorise once and the refresh
   token is stored in the database, so it survives every redeploy.
   --------------------------------------------------------------------------- */
/* The scopes asked for. If the app has different products approved, override
   with LINKEDIN_SCOPES rather than editing this file. Asking for a scope the
   app has not been granted is the usual reason LinkedIn shows its own generic
   error page before the sign in even starts. */
const LI_SCOPES = process.env.LINKEDIN_SCOPES || 'r_organization_social,rw_organization_admin';
const redirectUri = which => (PUBLIC_URL || '') + '/auth/' + which + '/callback';

function page(title, body){
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
 body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#F4F7FA;color:#132234;margin:0;padding:40px 20px}
 .w{max-width:660px;margin:0 auto}
 h1{font-size:23px;letter-spacing:-.02em;margin:0 0 6px}
 .sub{color:#4C5A6A;margin:0 0 28px;font-size:14px}
 .card{background:#fff;border:1px solid #E3EAF2;border-radius:16px;padding:22px;margin-bottom:16px}
 .card h2{font-size:16px;margin:0 0 4px}
 .state{display:inline-block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;padding:3px 9px;border-radius:7px;margin-bottom:10px}
 .on{background:rgba(23,158,94,.1);color:#137a49;border:1px solid rgba(23,158,94,.35)}
 .off{background:rgba(210,72,59,.08);color:#D2483B;border:1px solid rgba(210,72,59,.3)}
 p{margin:0 0 12px;font-size:13.6px;color:#4C5A6A}
 a.btn{display:inline-block;background:#00A7E0;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-size:14px;font-weight:600}
 a.btn.grey{background:#EEF3F8;color:#132234;border:1px solid #E3EAF2}
 code{background:#EEF3F8;padding:2px 6px;border-radius:5px;font-size:12.5px;word-break:break-all}
 ol{font-size:13.6px;color:#4C5A6A;padding-left:20px} li{margin-bottom:7px}
</style><div class="w">${body}</div>`;
}

app.get('/connect', async (_req, res) => {
  const g = await storeGet('google_token');
  const l = await storeGet('linkedin_token');
  const ready = PUBLIC_URL ? '' : '<p style="color:#D2483B"><b>Set PUBLIC_URL first</b> in the Render environment, to this service address, or the sign in cannot come back here.</p>';

  res.send(page('Connect the dashboard accounts', `
    <h1>Connect the dashboard accounts</h1>
    <p class="sub">Authorise once for each. The tokens are stored in the database and renewed automatically, so this does not need doing again.</p>
    ${ready}

    <div class="card">
      <span class="state ${l ? 'on' : 'off'}">${l ? 'Connected' : 'Not connected'}</span>
      <h2>LinkedIn company page</h2>
      <p>Follower count, follower gains, impressions, clicks, engagement rate and page views. Needs an app with Community Management API access, and you must sign in as a super admin of the page.</p>
      ${l ? `<p>Authorised ${new Date(l._updatedAt).toLocaleString('en-GB')}.</p>` : ''}
      ${LI_CLIENT ? `<a class="btn ${l ? 'grey' : ''}" href="/auth/linkedin">${l ? 'Reconnect LinkedIn' : 'Connect LinkedIn'}</a>`
                  : '<p style="color:#D2483B">Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET in Render first.</p>'}
      <p style="margin-top:14px">Redirect URL to paste into the LinkedIn app: <code>${redirectUri('linkedin')}</code></p>
    </div>

    <div class="card">
      <span class="state ${g ? 'on' : 'off'}">${g ? 'Connected' : 'Not connected'}</span>
      <h2>Google Business Profile</h2>
      <p>Listing views, website clicks, direction requests, calls, messages, review count and star rating. Sign in as the owner of the listing, not a manager.</p>
      ${g ? `<p>Authorised ${new Date(g._updatedAt).toLocaleString('en-GB')}.</p>` : ''}
      ${GOOGLE_CLIENT_ID ? `<a class="btn ${g ? 'grey' : ''}" href="/auth/google">${g ? 'Reconnect Google' : 'Connect Google'}</a>`
                         : '<p style="color:#D2483B">Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in Render first.</p>'}
      <p style="margin-top:14px">Redirect URL to paste into the Google OAuth client: <code>${redirectUri('google')}</code></p>
      <p><b>Authorising is not enough on its own.</b> Google gives a new Cloud project no quota for these APIs until a written request is approved, so the calls answer 403 until then. Submit the form at <code>support.google.com/business/contact/api_default</code> signed in as the listing owner, with the Cloud project number and the use case. It usually takes one to two weeks. Everything here is already built, so the figures start arriving on their own the moment the quota is granted.</p>
    </div>

    <div class="card">
      <h2>Check it is working</h2>
      <ol>
        <li><a href="/api/diagnostics">/api/diagnostics</a> names any pull that failed and why</li>
        <li><a href="/api/status">/api/status</a> says whether real figures are being served</li>
        <li>POST to <code>/api/refresh</code> to rebuild straight away rather than waiting for the morning run</li>
      </ol>
    </div>`));
});

app.get('/auth/google', (_req, res) => {
  if (!GOOGLE_CLIENT_ID || !PUBLIC_URL) return res.status(400).send(page('Not configured', '<h1>Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and PUBLIC_URL first.</h1>'));
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri('google'),
    response_type: 'code',
    scope: GBP_SCOPE,
    access_type: 'offline',
    prompt: 'consent'                       // force a refresh token, every time
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    const err = String(req.query.error || '');
    const why = /access_denied/i.test(err)
        ? 'The sign in was cancelled, or the account used does not manage the listing. Sign in as the owner of the Business Profile.'
      : /redirect_uri_mismatch/i.test(err)
        ? 'The redirect URL does not match the one on the OAuth client in Google Cloud. It must be exactly ' + redirectUri('google')
      : 'Google refused the request. Check the OAuth client and consent screen are set up on the same Cloud project as the Business Profile APIs.';
    return res.status(400).send(page('Not authorised',
      '<h1>Google did not complete the sign in</h1><p>' + why + '</p>' +
      (err ? '<p>It reported: <code>' + err + '</code></p>' : '') +
      '<a class="btn grey" href="/connect">Back to connections</a>'));
  }
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri('google'), grant_type: 'authorization_code'
      })
    });
    const d = await r.json();
    if (!d.refresh_token) throw new Error('no refresh token returned: ' + JSON.stringify(d).slice(0, 300));
    await storePut('google_token', {
      refresh_token: d.refresh_token,
      access_token: d.access_token || null,
      expires_at: Date.now() + (d.expires_in || 3600) * 1000
    });
    refresh();
    res.send(page('Google connected', '<h1>Google Business Profile connected</h1><p>The dashboard is rebuilding now. If the quota request has not been approved yet the Google Business figures will still show as not live, and will start on their own once it is.</p><a class="btn" href="/connect">Back to connections</a>'));
  } catch (e) {
    res.status(500).send(page('Failed', '<h1>Could not complete the Google sign in</h1><p><code>' + e.message + '</code></p><a class="btn grey" href="/connect">Try again</a>'));
  }
});

function linkedinAuthUrl(){
  return 'https://www.linkedin.com/oauth/v2/authorization?' + new URLSearchParams({
    response_type: 'code',
    client_id: LI_CLIENT,
    redirect_uri: redirectUri('linkedin'),
    scope: LI_SCOPES,
    state: 'ek' + Date.now()
  });
}

/* LinkedIn shows its own "something went wrong" page, with no explanation, if
   any part of the request does not match the app. It never reaches this server,
   so there is nothing to log. This page shows exactly what is about to be sent
   so it can be checked against the app settings first. */
app.get('/auth/linkedin', (req, res) => {
  if (!LI_CLIENT || !PUBLIC_URL) return res.status(400).send(page('Not configured', '<h1>Set LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET and PUBLIC_URL first.</h1><a class="btn grey" href="/connect">Back</a>'));
  if (req.query.go === '1') return res.redirect(linkedinAuthUrl());

  res.send(page('Check before signing in', `
    <h1>Check these three things first</h1>
    <p class="sub">If any one of them does not match the app, LinkedIn shows a page saying something went wrong and gives no reason. Comparing them here takes a moment and saves a lot of guessing.</p>

    <div class="card">
      <h2>1. Redirect URL</h2>
      <p>Open the app at <b>linkedin.com/developers/apps</b>, go to the <b>Auth</b> tab, and check that Authorised redirect URLs contains this, character for character, with no trailing slash:</p>
      <p><code>${redirectUri('linkedin')}</code></p>
    </div>

    <div class="card">
      <h2>2. Client ID</h2>
      <p>On the same Auth tab, the Client ID should end with:</p>
      <p><code>...${String(LI_CLIENT).slice(-6)}</code></p>
      <p>If it does not, the value in Render belongs to a different app.</p>
    </div>

    <div class="card">
      <h2>3. Approved products</h2>
      <p>These permissions are about to be asked for:</p>
      <p><code>${LI_SCOPES.split(',').join('</code> <code>')}</code></p>
      <p>Open the <b>Products</b> tab. Community Management API must show <b>Approved</b>. If it says Pending, LinkedIn has not finished reviewing the access request and the sign in cannot work yet, whatever else is set correctly. That is the most common cause by a distance.</p>
      <p>If the app has been approved for different permissions from the two above, set <code>LINKEDIN_SCOPES</code> in Render to the ones it actually has, comma separated, rather than editing any code.</p>
    </div>

    <div class="card">
      <h2>Ready</h2>
      <p>Sign in as a <b>super admin</b> of the Earl Kendrick page. A manager account is refused.</p>
      <a class="btn" href="/auth/linkedin?go=1">Continue to LinkedIn</a>
      <a class="btn grey" href="/connect" style="margin-left:8px">Back</a>
    </div>`));
});

app.get('/auth/linkedin/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    const err = String(req.query.error || '');
    const why = /unauthorized_scope/i.test(err)
        ? 'The app has not been granted these permissions. Community Management API is almost certainly still Pending on the Products tab, so LinkedIn will not issue a token yet.'
      : /redirect_uri|invalid_request/i.test(err)
        ? 'The redirect URL does not match the one registered on the app. It has to be identical, including https and any trailing slash.'
      : /user_cancelled|access_denied/i.test(err)
        ? 'The sign in was cancelled, or the account used is not a super admin of the page.'
      : 'LinkedIn refused the request without saying why. Work through the three checks on the previous page.';
    return res.status(400).send(page('Not authorised',
      '<h1>LinkedIn did not complete the sign in</h1><p>' + why + '</p>' +
      (err ? '<p>It reported: <code>' + err + ' ' + (req.query.error_description || '') + '</code></p>' : '') +
      '<a class="btn grey" href="/auth/linkedin">Back to the checks</a>'));
  }
  try {
    const r = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code,
        redirect_uri: redirectUri('linkedin'),
        client_id: LI_CLIENT, client_secret: LI_SECRET
      })
    });
    const d = await r.json();
    if (!d.access_token) throw new Error(JSON.stringify(d).slice(0, 300));
    LI_TOKEN = d.access_token;
    await storePut('linkedin_token', {
      access_token: d.access_token,
      refresh_token: d.refresh_token || null,
      renewedAt: new Date().toISOString()
    });
    refresh();
    res.send(page('LinkedIn connected', '<h1>LinkedIn connected</h1><p>The dashboard is rebuilding now. Open the LinkedIn tab in a minute and the company page figures should be there.</p>' +
      (d.refresh_token ? '' : '<p><b>Note.</b> LinkedIn did not return a refresh token, which means the app does not have that turned on. The access token will expire in 60 days and will need reconnecting here.</p>') +
      '<a class="btn" href="/connect">Back to connections</a>'));
  } catch (e) {
    res.status(500).send(page('Failed', '<h1>Could not complete the LinkedIn sign in</h1><p><code>' + e.message + '</code></p><a class="btn grey" href="/connect">Try again</a>'));
  }
});

app.get('/health', (_req, res) => res.send('ok'));

// Row counts for the three newer boards, handy when a tab looks empty
app.get('/api/status/boards', async (_req, res) => {
  if (!eventsPool) return res.json({ db: false });
  const out = { db: true };
  for (const k of ['content', 'videos', 'competitors', 'followers']) {
    try {
      const r = await eventsPool.query(
        `SELECT COALESCE(jsonb_array_length(data), 0) AS n, updated_at FROM ek_store WHERE key = $1`, [k]);
      out[k] = r.rows.length ? { count: r.rows[0].n, updatedAt: r.rows[0].updated_at } : { count: 0, updatedAt: null };
    } catch (e) { out[k] = { error: e.message }; }
  }
  res.json(out);
});
app.listen(PORT, () => console.log('EK dashboard data service on :' + PORT));
