/* ===========================================================================
   EK DASHBOARD EXTRAS, built by NXRD
   ---------------------------------------------------------------------------
   Two additions that sit beside ek-dashboard-server.js:

   1. WEEKLY LINKEDIN EMAIL
      Every Monday morning, a short email to the EK team and NXRD covering the
      company page posts published in the last seven days: reach, engagement
      per post, the best performer, and the people who engaged most.

   2. AI VISIBILITY, LIVE
      Search Console still offers no API for its Generative AI report, so that
      figure cannot be pulled automatically. Instead this runs a weekly prompt
      audit: a fixed set of questions EK's buyers actually ask, put to
      Perplexity, ChatGPT (with web search) and Gemini (grounded on Google
      Search). For each answer it records whether earlkendrick.com is cited as
      a source and whether Earl Kendrick is named, plus which domains and
      competitors the engines lean on instead. Same prompts every week, so the
      trend is like for like.

   Environment variables (Render)
   ------------------------------
   Email (any SMTP account, Google Workspace with an app password works):
     SMTP_HOST            smtp.gmail.com
     SMTP_PORT            465
     SMTP_USER            james@nx-rd.com
     SMTP_PASS            the app password, not the normal password
     MAIL_FROM            "NXRD <james@nx-rd.com>"     optional, defaults to SMTP_USER
     REPORT_TO            comma separated, defaults to chelsea@earlkendrick.com,james@nx-rd.com
     WEEKLY_EMAIL_CRON    defaults to 12 8 * * 1  (Mondays 08:12 UK time)
     WEEKLY_EMAIL_ENABLED set to true once a test send looks right. Until then
                          nothing goes to the client, only test sends to you.
     ADMIN_KEY            any long random string. Guards the preview, test send
                          and manual AI run endpoints. Those endpoints stay off
                          until it is set.

   AI visibility (each engine runs only if its key is set):
     PERPLEXITY_API_KEY   PERPLEXITY_MODEL  defaults to sonar
     OPENAI_API_KEY       OPENAI_MODEL      defaults to gpt-4.1-mini
     GEMINI_API_KEY       GEMINI_MODEL      defaults to gemini-2.5-flash
     AI_PROMPTS           optional JSON array of prompt strings, replaces the defaults
     AI_COMPETITORS       optional JSON array of competitor names to count mentions of
     AI_AUDIT_CRON        defaults to 12 7 * * 1  (Mondays 07:12, before the email)
   =========================================================================== */
'use strict';

const OWN_DOMAIN = 'earlkendrick.com';
const OWN_NAMES  = [/earl\s*kendrick/i];

const DEFAULT_PROMPTS = [
  'Who are the best building surveyors in London for a commercial property?',
  'Recommend a chartered building surveying firm for a planned maintenance programme in London',
  'Which UK consultancies do development monitoring for funders?',
  'Who should I use for a building condition survey on an office block in Manchester?',
  'Best firms for building pathology and defect diagnosis in the UK',
  'Who provides insurance reinstatement cost assessments for commercial buildings in the UK?',
  'Which consultants help with Building Safety Act compliance for high rise residential buildings?',
  'Recommend a fire safety and Building Safety Act consultant in London',
  'Who are good cost managers and quantity surveyors for refurbishment projects in Birmingham?',
  'Best building surveyors in Bristol for a residential block',
  'Which firms offer architectural design and interior design for commercial refurbishments in London?',
  'How do I choose a building surveyor for a dilapidations claim, and which firms are well regarded?'
];

const DEFAULT_COMPETITORS = [
  'Ridge', 'Watts', 'Malcolm Hollis', 'Innovus', 'Anstey Horne', 'Pellings',
  'Bennington Green', 'Hurst Peirce', 'Harris Associates', 'SRVO', 'Murray Burrell', 'Project and Co'
];

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = n => (n == null || isNaN(n)) ? '0' : Number(n).toLocaleString('en-GB');
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
const domainOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return String(u || '').replace(/^www\./, ''); } };

function parseJsonEnv(name, fallback){
  const raw = (process.env[name] || '').trim();
  if (!raw) return fallback;
  try { const v = JSON.parse(raw); return Array.isArray(v) && v.length ? v : fallback; }
  catch (e) { console.error(name + ' is not valid JSON, using defaults'); return fallback; }
}

// ISO week key, same format the dashboard uses (2026-W45)
function isoWeekKey(d){
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - y0) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + '-W' + String(wk).padStart(2, '0');
}

module.exports = function mountExtras(app, ctx){
  const { cron, liGet, getLinkedIn, loadLinkedInToken, storeGet, storePut, getCache, readManual, page } = ctx;
  const ADMIN_KEY = process.env.ADMIN_KEY || '';
  const EMAIL_ON  = process.env.WEEKLY_EMAIL_ENABLED === 'true';
  const REPORT_TO = (process.env.REPORT_TO || 'chelsea@earlkendrick.com,james@nx-rd.com')
    .split(',').map(s => s.trim()).filter(Boolean);

  const guard = (req, res) => {
    if (!ADMIN_KEY) { res.status(403).send('Set ADMIN_KEY in Render to use this endpoint.'); return false; }
    if ((req.query.key || req.get('x-admin-key')) !== ADMIN_KEY) { res.status(401).send('Wrong or missing key.'); return false; }
    return true;
  };

  /* =========================================================================
     AI VISIBILITY: weekly prompt audit
     ========================================================================= */
  const PROMPTS     = parseJsonEnv('AI_PROMPTS', DEFAULT_PROMPTS);
  const COMPETITORS = parseJsonEnv('AI_COMPETITORS', DEFAULT_COMPETITORS);

  async function postJson(url, headers, body, timeoutMs){
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || 90000);
    try {
      const res = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body), signal: ctl.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(res.status + ' ' + text.slice(0, 240));
      return JSON.parse(text);
    } finally { clearTimeout(t); }
  }

  // Each engine returns { text, sources: [url or domain] }
  const ENGINES = {
    perplexity: {
      label: 'Perplexity',
      on: () => !!process.env.PERPLEXITY_API_KEY,
      ask: async q => {
        const d = await postJson('https://api.perplexity.ai/chat/completions',
          { Authorization: 'Bearer ' + process.env.PERPLEXITY_API_KEY },
          { model: process.env.PERPLEXITY_MODEL || 'sonar', messages: [{ role: 'user', content: q }] });
        const text = (((d.choices || [])[0] || {}).message || {}).content || '';
        const sources = (d.citations || []).concat((d.search_results || []).map(r => r.url)).filter(Boolean);
        return { text, sources };
      }
    },
    chatgpt: {
      label: 'ChatGPT',
      on: () => !!process.env.OPENAI_API_KEY,
      ask: async q => {
        const d = await postJson('https://api.openai.com/v1/responses',
          { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
          { model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
            tools: [{ type: process.env.OPENAI_SEARCH_TOOL || 'web_search' }],
            input: q });
        let text = d.output_text || '';
        const sources = [];
        (d.output || []).forEach(o => (o.content || []).forEach(c => {
          if (c.text && !d.output_text) text += c.text;
          (c.annotations || []).forEach(a => { if (a.url) sources.push(a.url); });
        }));
        return { text, sources };
      }
    },
    gemini: {
      label: 'Gemini (Google)',
      on: () => !!process.env.GEMINI_API_KEY,
      ask: async q => {
        const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
        const d = await postJson(
          'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
          { 'x-goog-api-key': process.env.GEMINI_API_KEY },
          { contents: [{ role: 'user', parts: [{ text: q }] }], tools: [{ google_search: {} }] });
        const cand = (d.candidates || [])[0] || {};
        const text = ((cand.content || {}).parts || []).map(p => p.text || '').join('');
        // Grounding links are Google redirect URLs; the title carries the real domain
        const sources = ((cand.groundingMetadata || {}).groundingChunks || [])
          .map(c => c.web && (c.web.title || c.web.uri)).filter(Boolean);
        return { text, sources };
      }
    }
  };

  let auditRunning = false;

  async function runAudit(){
    if (auditRunning) return { ok: false, error: 'already running' };
    const engines = Object.keys(ENGINES).filter(k => ENGINES[k].on());
    if (!engines.length) return { ok: false, error: 'no AI engine keys set (PERPLEXITY_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY)' };
    auditRunning = true;
    const started = new Date();
    const run = { date: started.toISOString(), week: isoWeekKey(started), engines: {}, prompts: [], domains: {}, competitors: {} };
    try {
      for (const eng of engines) {
        const tally = { label: ENGINES[eng].label, asked: 0, cited: 0, mentioned: 0, errors: 0, lastError: null };
        // Sequential per engine keeps us well inside every rate limit
        for (const q of PROMPTS) {
          tally.asked++;
          try {
            const { text, sources } = await ENGINES[eng].ask(q);
            const domains = [...new Set(sources.map(domainOf).filter(Boolean))];
            const cited = domains.some(d => d === OWN_DOMAIN || d.endsWith('.' + OWN_DOMAIN));
            const named = OWN_NAMES.some(rx => rx.test(text));
            const mentioned = named || cited;
            if (named) run.ekNamed = (run.ekNamed || 0) + 1;   // like for like with competitor counts
            if (cited) tally.cited++;
            if (mentioned) tally.mentioned++;
            domains.forEach(d => { run.domains[d] = (run.domains[d] || 0) + 1; });
            COMPETITORS.forEach(c => {
              if (new RegExp('\\b' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(text)) {
                run.competitors[c] = (run.competitors[c] || 0) + 1;
              }
            });
            run.prompts.push({ engine: eng, prompt: q, cited, mentioned, sources: domains.slice(0, 8) });
          } catch (e) {
            tally.errors++;
            tally.lastError = e.message.slice(0, 200);
            run.prompts.push({ engine: eng, prompt: q, error: tally.lastError });
          }
        }
        tally.citationRate = pct(tally.cited, tally.asked - tally.errors);
        tally.mentionRate  = pct(tally.mentioned, tally.asked - tally.errors);
        run.engines[eng] = tally;
      }
      const totals = Object.values(run.engines).reduce((a, t) => {
        a.asked += t.asked - t.errors; a.cited += t.cited; a.mentioned += t.mentioned; return a;
      }, { asked: 0, cited: 0, mentioned: 0 });
      run.citationRate = pct(totals.cited, totals.asked);
      run.mentionRate  = pct(totals.mentioned, totals.asked);
      run.answers = totals.asked;
      run.ekMentions = totals.mentioned;
      run.durationSec = Math.round((Date.now() - started) / 1000);

      // Keep the last 52 runs, one per week, replacing a rerun in the same week
      const store = (await storeGet('ai_citations')) || {};
      let history = Array.isArray(store.history) ? store.history : [];
      history = history.filter(h => h.week !== run.week);
      history.push(run);
      history = history.slice(-52);
      await storePut('ai_citations', { history });
      console.log('AI audit done:', run.week, 'cited', run.citationRate + '%', 'mentioned', run.mentionRate + '%');
      return { ok: true, run };
    } catch (e) {
      console.error('AI audit failed:', e.message);
      return { ok: false, error: e.message };
    } finally {
      auditRunning = false;
    }
  }

  async function aiSummary(){
    const store = (await storeGet('ai_citations')) || {};
    const history = Array.isArray(store.history) ? store.history : [];
    const latest = history[history.length - 1] || null;
    const prev = history[history.length - 2] || null;
    const shareOfVoice = latest ? (() => {
      const counts = Object.assign({ 'Earl Kendrick': latest.ekNamed || 0 }, latest.competitors || {});
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return Object.entries(counts).sort((a, b) => b[1] - a[1])
        .map(([name, n]) => ({ name, mentions: n, share: pct(n, total), isEk: name === 'Earl Kendrick' }));
    })() : [];
    return {
      live: !!latest,
      engines: Object.keys(ENGINES).filter(k => ENGINES[k].on()).map(k => ENGINES[k].label),
      promptCount: PROMPTS.length,
      latest: latest && {
        date: latest.date, week: latest.week,
        citationRate: latest.citationRate, mentionRate: latest.mentionRate,
        answers: latest.answers, engines: latest.engines,
        topDomains: Object.entries(latest.domains || {}).sort((a, b) => b[1] - a[1]).slice(0, 12)
          .map(([domain, n]) => ({ domain, answers: n, isEk: domain.endsWith(OWN_DOMAIN) })),
        prompts: latest.prompts
      },
      change: latest && prev ? {
        citationRate: latest.citationRate - prev.citationRate,
        mentionRate: latest.mentionRate - prev.mentionRate
      } : null,
      shareOfVoice,
      trend: history.map(h => ({ week: h.week, date: h.date, citationRate: h.citationRate, mentionRate: h.mentionRate }))
    };
  }

  app.get('/api/ai-citations.json', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await aiSummary());
  });

  app.post('/api/ai-citations/run', async (req, res) => {
    if (!guard(req, res)) return;
    // Takes a few minutes, so answer straight away and run in the background
    runAudit();
    res.json({ ok: true, started: true, prompts: PROMPTS.length,
      engines: Object.keys(ENGINES).filter(k => ENGINES[k].on()) });
  });

  /* =========================================================================
     WEEKLY LINKEDIN EMAIL
     ========================================================================= */

  // Organisation names for engagers who are companies rather than people
  const orgNameCache = {};
  async function orgName(urn){
    if (orgNameCache[urn] !== undefined) return orgNameCache[urn];
    const id = urn.split(':').pop();
    try {
      const d = await liGet('organizations/' + id);
      orgNameCache[urn] = d.localizedName || null;
    } catch (e) { orgNameCache[urn] = null; }
    return orgNameCache[urn];
  }

  // Comments, asking LinkedIn to expand the commenter's name. If the app is not
  // allowed the expansion, fall back to the plain call and count them unnamed.
  async function postComments(postUrn){
    const base = 'socialActions/' + encodeURIComponent(postUrn) + '/comments?count=100';
    try {
      return (await liGet(base + '&projection=(elements*(*,actor~(localizedFirstName,localizedLastName,vanityName)))')).elements || [];
    } catch (e) {
      try { return (await liGet(base)).elements || []; } catch (e2) { return null; }
    }
  }
  async function postReactions(postUrn){
    try {
      return (await liGet('reactions/(entity:' + encodeURIComponent(postUrn) + ')?q=entity&count=100')).elements || [];
    } catch (e) { return null; }
  }

  async function postStats(orgUrn, urns){
    const shares = urns.filter(u => u.includes(':share:'));
    const ugc    = urns.filter(u => u.includes(':ugcPost:'));
    const q = 'organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=' + encodeURIComponent(orgUrn) +
      (shares.length ? '&shares=List(' + shares.map(encodeURIComponent).join(',') + ')' : '') +
      (ugc.length ? '&ugcPosts=List(' + ugc.map(encodeURIComponent).join(',') + ')' : '');
    const out = {};
    try {
      const d = await liGet(q);
      (d.elements || []).forEach(el => {
        const urn = el.share || el.ugcPost;
        const t = el.totalShareStatistics || {};
        out[urn] = {
          impressions: t.impressionCount || 0, clicks: t.clickCount || 0,
          reactions: t.likeCount || 0, comments: t.commentCount || 0, reposts: t.shareCount || 0,
          engagementRate: t.engagement != null ? +(t.engagement * 100).toFixed(1) : null
        };
      });
    } catch (e) { console.error('Post statistics unavailable:', e.message); }
    return out;
  }

  async function gatherLinkedInWeek(){
    if (loadLinkedInToken) await loadLinkedInToken();
    const li = getLinkedIn();
    const result = { ok: false, error: null, posts: [], engagers: [], unnamedEngagements: 0, engagerNote: null };
    if (!li.token || !li.org) { result.error = li.org ? 'LinkedIn is not connected yet (authorise at /connect)' : 'LINKEDIN_ORG_URN is not set'; return result; }

    const since = Date.now() - 7 * 86400000;
    let posts;
    try {
      const d = await liGet('posts?author=' + encodeURIComponent(li.org) + '&q=author&count=50&sortBy=LAST_MODIFIED');
      posts = (d.elements || []).filter(p => (p.publishedAt || p.createdAt || 0) >= since && p.lifecycleState !== 'DRAFT');
    } catch (e) { result.error = 'Could not list posts: ' + e.message; return result; }

    const stats = posts.length ? await postStats(li.org, posts.map(p => p.id)) : {};
    const people = {};       // urn -> { name, comments, reactions, isOrg }
    let commentsBlocked = false, reactionsBlocked = false;

    for (const p of posts) {
      const s = stats[p.id] || {};
      const text = (p.commentary || '').replace(/\s+/g, ' ').trim();
      const [comments, reactions] = await Promise.all([postComments(p.id), postReactions(p.id)]);
      if (comments === null) commentsBlocked = true;
      if (reactions === null) reactionsBlocked = true;

      (comments || []).forEach(c => {
        const urn = c.actor; if (!urn || urn === li.org) return;
        const a = c['actor~'] || {};
        const name = [a.localizedFirstName, a.localizedLastName].filter(Boolean).join(' ') || null;
        const rec = people[urn] || (people[urn] = { urn, name: null, vanity: null, comments: 0, reactions: 0, isOrg: urn.includes(':organization:') });
        rec.comments++;
        if (name) rec.name = name;
        if (a.vanityName) rec.vanity = a.vanityName;
      });
      (reactions || []).forEach(r => {
        const urn = (r.created && r.created.actor) || r.actor; if (!urn || urn === li.org) return;
        const rec = people[urn] || (people[urn] = { urn, name: null, vanity: null, comments: 0, reactions: 0, isOrg: urn.includes(':organization:') });
        rec.reactions++;
      });

      result.posts.push({
        urn: p.id,
        url: 'https://www.linkedin.com/feed/update/' + p.id + '/',
        date: new Date(p.publishedAt || p.createdAt).toISOString(),
        text: text.length > 140 ? text.slice(0, 137).replace(/\s+\S*$/, '') + '...' : text,
        impressions: s.impressions || 0, clicks: s.clicks || 0,
        reactions: s.reactions != null ? s.reactions : (reactions || []).length,
        comments: s.comments != null ? s.comments : (comments || []).length,
        reposts: s.reposts || 0,
        engagementRate: s.engagementRate != null ? s.engagementRate
          : (s.impressions ? +(((s.clicks || 0) + (s.reactions || 0) + (s.comments || 0) + (s.reposts || 0)) / s.impressions * 100).toFixed(1) : null)
      });
    }

    for (const rec of Object.values(people)) {
      if (rec.isOrg && !rec.name) rec.name = await orgName(rec.urn);
    }

    // Who to mark as EK team: names on the published advocacy board
    let team = [];
    try { team = (readManual().advocacyPublished || []).map(x => String(x.name || x.person || '').toLowerCase()).filter(Boolean); } catch (e) {}

    const all = Object.values(people);
    result.engagers = all.filter(r => r.name)
      .map(r => ({ name: r.name, comments: r.comments, reactions: r.reactions, score: r.comments * 3 + r.reactions,
                   isOrg: r.isOrg, isTeam: team.includes(r.name.toLowerCase()),
                   url: r.vanity ? 'https://www.linkedin.com/in/' + r.vanity : null }))
      .sort((a, b) => b.score - a.score).slice(0, 10);
    result.unnamedEngagements = all.filter(r => !r.name).reduce((a, r) => a + r.comments + r.reactions, 0);
    result.uniqueEngagers = all.length;
    if (commentsBlocked || reactionsBlocked) {
      result.engagerNote = 'LinkedIn did not allow the ' + [commentsBlocked && 'comments', reactionsBlocked && 'reactions'].filter(Boolean).join(' and ') +
        ' lookup. Add r_organization_social_feed to the app and to LINKEDIN_SCOPES, then reconnect at /connect.';
    }
    result.posts.sort((a, b) => b.impressions - a.impressions);
    result.ok = true;
    return result;
  }

  // Newest complete week and the one before, from the main dashboard feed
  function weekTotals(){
    const weeks = (getCache().weeks || []).slice();
    const thisKey = isoWeekKey(new Date());
    const done = weeks.filter(w => w.key !== thisKey);
    return { now: done[done.length - 1] || null, prev: done[done.length - 2] || null };
  }

  function chip(now, prev){
    if (now == null || prev == null || prev === 0) return '';
    const d = Math.round((now - prev) / prev * 100);
    if (!d) return '<span style="color:#6B7785;font-size:12px">level</span>';
    const up = d > 0;
    return `<span style="color:${up ? '#00A7E0' : '#D2483B'};font-size:12px;font-weight:600">${up ? '▲' : '▼'} ${Math.abs(d)}%</span>`;
  }

  function tile(label, value, sub){
    return `<td style="padding:6px;width:25%" valign="top"><div style="background:#F4F7FA;border-radius:12px;padding:14px 14px 12px">
      <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6B7785;font-weight:600">${label}</div>
      <div style="font-size:24px;font-weight:700;color:#0B1622;margin-top:4px">${value}</div>
      <div style="margin-top:2px;min-height:16px">${sub || ''}</div></div></td>`;
  }

  async function buildEmail(){
    const [li, ai] = await Promise.all([gatherLinkedInWeek(), aiSummary()]);
    const { now, prev } = weekTotals();
    const posts = li.posts || [];
    const top = posts[0] || null;
    const totalImpr = posts.reduce((a, p) => a + p.impressions, 0);
    const weekLabel = now ? now.label : 'the last seven days';

    const subject = posts.length
      ? `EK on LinkedIn this week: ${posts.length} post${posts.length === 1 ? '' : 's'}, ${fmt(totalImpr)} impressions`
      : 'EK on LinkedIn this week: no new posts';
    const preview = top
      ? `Top post reached ${fmt(top.impressions)} people. Here's who's been engaging.`
      : 'A quiet week on the page. A quick look at the numbers and what to post next.';

    const greet = posts.length
      ? `Here's your quick weekly round up of the Earl Kendrick LinkedIn page. ${posts.length === 1 ? 'One post went out' : posts.length + ' posts went out'} in the last seven days and between them they picked up ${fmt(totalImpr)} impressions.`
      : `No new posts went out on the Earl Kendrick page in the last seven days. Worth getting one or two scheduled this week, as reach drops off quickly when the page goes quiet.`;

    const kpis = now ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 6px"><tr>
      ${tile('Impressions', fmt(now.linkedinImpressions), chip(now.linkedinImpressions, prev && prev.linkedinImpressions))}
      ${tile('Engagement', (now.linkedinEngagementRate != null ? now.linkedinEngagementRate + '%' : 'n/a'), chip(now.linkedinEngagementRate, prev && prev.linkedinEngagementRate))}
      ${tile('New followers', fmt(now.linkedinFollowerGain), chip(now.linkedinFollowerGain, prev && prev.linkedinFollowerGain))}
      ${tile('Page views', fmt(now.linkedinPageViews), chip(now.linkedinPageViews, prev && prev.linkedinPageViews))}
    </tr></table><p style="margin:0 0 4px;font-size:12px;color:#6B7785">Page totals for ${esc(weekLabel)}, compared with the week before.</p>` : '';

    const topBlock = top ? `<div style="border:1px solid #CDEBF7;background:#F0FAFE;border-radius:14px;padding:16px 18px;margin:22px 0 8px">
      <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#00A7E0;font-weight:700">Post of the week</div>
      <div style="font-size:15px;color:#0B1622;margin:6px 0 10px;line-height:1.5">${esc(top.text) || 'Image or video post'}</div>
      <div style="font-size:13px;color:#3B4856">${fmt(top.impressions)} impressions · ${fmt(top.reactions)} reactions · ${fmt(top.comments)} comments · ${fmt(top.reposts)} reposts${top.engagementRate != null ? ' · ' + top.engagementRate + '% engagement' : ''}</div>
      <a href="${top.url}" style="display:inline-block;margin-top:12px;font-size:13px;color:#00A7E0;font-weight:600;text-decoration:none">View the post →</a></div>` : '';

    const rows = posts.map(p => `<tr>
      <td style="padding:10px 8px;border-bottom:1px solid #EEF2F6;font-size:13px;color:#0B1622;line-height:1.45">
        <a href="${p.url}" style="color:#0B1622;text-decoration:none">${esc(p.text) || 'Image or video post'}</a>
        <div style="color:#6B7785;font-size:11.5px;margin-top:2px">${new Date(p.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</div></td>
      <td align="right" style="padding:10px 8px;border-bottom:1px solid #EEF2F6;font-size:13px;white-space:nowrap">${fmt(p.impressions)}</td>
      <td align="right" style="padding:10px 8px;border-bottom:1px solid #EEF2F6;font-size:13px;white-space:nowrap">${fmt(p.reactions + p.comments + p.reposts)}</td>
      <td align="right" style="padding:10px 8px;border-bottom:1px solid #EEF2F6;font-size:13px;white-space:nowrap">${p.engagementRate != null ? p.engagementRate + '%' : ''}</td></tr>`).join('');
    const table = posts.length > 1 ? `<h3 style="font-size:15px;margin:26px 0 6px;color:#0B1622">Every post this week</h3>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
      <th align="left" style="font-size:11px;color:#6B7785;text-transform:uppercase;letter-spacing:.06em;padding:6px 8px">Post</th>
      <th align="right" style="font-size:11px;color:#6B7785;text-transform:uppercase;letter-spacing:.06em;padding:6px 8px">Impr.</th>
      <th align="right" style="font-size:11px;color:#6B7785;text-transform:uppercase;letter-spacing:.06em;padding:6px 8px">Eng.</th>
      <th align="right" style="font-size:11px;color:#6B7785;text-transform:uppercase;letter-spacing:.06em;padding:6px 8px">Rate</th></tr>${rows}</table>` : '';

    let people = '';
    if (li.ok && posts.length) {
      const list = (li.engagers || []).map((e, i) => `<tr>
        <td style="padding:8px;border-bottom:1px solid #EEF2F6;font-size:13.5px;color:#0B1622">
          <span style="display:inline-block;width:20px;color:#6B7785">${i + 1}</span>
          ${e.url ? `<a href="${e.url}" style="color:#0B1622;font-weight:600;text-decoration:none">${esc(e.name)}</a>` : `<b>${esc(e.name)}</b>`}
          ${e.isTeam ? '<span style="margin-left:6px;font-size:10.5px;background:#E6F6FC;color:#0086B3;border-radius:6px;padding:2px 6px;font-weight:600">EK TEAM</span>' : ''}
          ${e.isOrg ? '<span style="margin-left:6px;font-size:10.5px;background:#EEF2F6;color:#3B4856;border-radius:6px;padding:2px 6px;font-weight:600">COMPANY</span>' : ''}</td>
        <td align="right" style="padding:8px;border-bottom:1px solid #EEF2F6;font-size:12.5px;color:#3B4856;white-space:nowrap">${e.comments ? e.comments + ' comment' + (e.comments === 1 ? '' : 's') : ''}${e.comments && e.reactions ? ', ' : ''}${e.reactions ? e.reactions + ' reaction' + (e.reactions === 1 ? '' : 's') : ''}</td></tr>`).join('');
      people = `<h3 style="font-size:15px;margin:26px 0 4px;color:#0B1622">Who's been engaging</h3>
        <p style="margin:0 0 8px;font-size:13px;color:#3B4856">Comments count for more than reactions here, as they do with the algorithm. A quick thank you or a reply to these people keeps the conversation going and pushes the post further.</p>
        ${list ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${list}</table>` : ''}
        ${li.unnamedEngagements ? `<p style="margin:8px 0 0;font-size:12.5px;color:#6B7785">Plus ${fmt(li.unnamedEngagements)} reaction${li.unnamedEngagements === 1 ? '' : 's'} from members LinkedIn doesn't name through its API. You can see them on each post.</p>` : ''}
        ${li.engagerNote ? `<p style="margin:8px 0 0;font-size:12px;color:#6B7785">${esc(li.engagerNote)}</p>` : ''}`;
    }

    const aiLine = ai.latest ? `<div style="background:#F4F7FA;border-radius:12px;padding:14px 16px;margin:26px 0 0;font-size:13px;color:#3B4856;line-height:1.55">
      <b style="color:#0B1622">AI search check:</b> this week Earl Kendrick was named in ${ai.latest.mentionRate}% of ${ai.latest.answers} AI answers to buyer questions, and the website was cited as a source in ${ai.latest.citationRate}%${ai.change ? ` (${ai.change.citationRate >= 0 ? 'up' : 'down'} ${Math.abs(ai.change.citationRate)} points on last week)` : ''}.</div>` : '';

    const notConnected = !li.ok ? `<p style="background:#FFF6F5;border:1px solid #F3C9C4;border-radius:10px;padding:10px 12px;font-size:12.5px;color:#9A3A30">Post level detail is missing this week: ${esc(li.error)}.</p>` : '';

    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#EEF2F6;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0B1622">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all">${esc(preview)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</span>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#EEF2F6"><tr><td align="center" style="padding:24px 12px">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#fff;border-radius:18px;overflow:hidden">
<tr><td style="background:#0B1622;padding:20px 24px">
  <div style="color:#00A7E0;font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-weight:700">Earl Kendrick · Weekly LinkedIn</div>
  <div style="color:#fff;font-size:20px;font-weight:700;margin-top:4px">${esc(weekLabel)}</div></td></tr>
<tr><td style="padding:22px 24px 26px">
  <p style="margin:0 0 4px;font-size:14.5px;line-height:1.6">Hi Chelsea,</p>
  <p style="margin:0;font-size:14.5px;line-height:1.6">${greet}</p>
  ${notConnected}${kpis}${topBlock}${table}${people}${aiLine}
  <p style="margin:26px 0 0;font-size:14px;line-height:1.6">Full figures are on the dashboard as always. Any questions, just give me a shout.</p>
  <p style="margin:14px 0 0;font-size:14px;line-height:1.6">Cheers,<br>James<br><span style="color:#6B7785;font-size:12.5px">NXRD · 07855 400296</span></p>
</td></tr>
<tr><td style="background:#F4F7FA;padding:12px 24px;font-size:11px;color:#6B7785">Sent automatically every Monday by the NXRD reporting service. Figures from the LinkedIn Community Management API.</td></tr>
</table></td></tr></table></body></html>`;

    const textBody = [
      'Hi Chelsea,', '', greet.replace(/<[^>]+>/g, ''), '',
      top ? `Post of the week: ${top.text}\n${fmt(top.impressions)} impressions, ${top.reactions} reactions, ${top.comments} comments. ${top.url}` : '',
      '', (li.engagers || []).length ? "Who's been engaging:\n" + li.engagers.map((e, i) => `${i + 1}. ${e.name}${e.isTeam ? ' (EK team)' : ''}: ${e.comments} comments, ${e.reactions} reactions`).join('\n') : '',
      '', 'Cheers,', 'James', 'NXRD · 07855 400296'
    ].join('\n');

    return { subject, preview, html, text: textBody, linkedin: li };
  }

  let transport = null;
  function mailer(){
    if (transport) return transport;
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
    const nodemailer = require('nodemailer');
    const port = +(process.env.SMTP_PORT || 465);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    return transport;
  }

  async function sendWeekly(to, opts){
    const t = mailer();
    if (!t) return { ok: false, error: 'SMTP_HOST, SMTP_USER and SMTP_PASS are not all set' };
    const week = isoWeekKey(new Date());
    if (!opts || !opts.test) {
      const last = await storeGet('weekly_email_last');
      if (last && last.week === week) return { ok: false, skipped: true, error: 'already sent for ' + week };
    }
    const mail = await buildEmail();
    const info = await t.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: to.join(', '),
      replyTo: 'james@nx-rd.com',
      subject: (opts && opts.test ? '[Test] ' : '') + mail.subject,
      html: mail.html, text: mail.text
    });
    if (!opts || !opts.test) await storePut('weekly_email_last', { week, sentAt: new Date().toISOString(), to, subject: mail.subject });
    console.log('Weekly LinkedIn email sent to', to.join(', '), info.messageId);
    return { ok: true, to, subject: mail.subject, posts: mail.linkedin.posts.length };
  }

  app.get('/api/weekly-email/preview', async (req, res) => {
    if (!guard(req, res)) return;
    try {
      const m = await buildEmail();
      res.set('Cache-Control', 'no-store');
      if (req.query.format === 'json') return res.json({ subject: m.subject, preview: m.preview, linkedin: m.linkedin });
      res.send(m.html);
    } catch (e) { res.status(500).send('Could not build the email: ' + esc(e.message)); }
  });

  // Test send. Goes to ?to= only (defaults to james@nx-rd.com), never to the client.
  app.post('/api/weekly-email/send', async (req, res) => {
    if (!guard(req, res)) return;
    const to = String(req.query.to || 'james@nx-rd.com').split(',').map(s => s.trim()).filter(Boolean);
    try { res.json(await sendWeekly(to, { test: true })); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/weekly-email/status', async (_req, res) => {
    res.json({
      enabled: EMAIL_ON, smtpConfigured: !!mailer(), recipients: REPORT_TO,
      schedule: process.env.WEEKLY_EMAIL_CRON || '12 8 * * 1',
      lastSent: await storeGet('weekly_email_last')
    });
  });

  const tz = { timezone: 'Europe/London' };
  cron.schedule(process.env.AI_AUDIT_CRON || '12 7 * * 1', () => { runAudit(); }, tz);
  cron.schedule(process.env.WEEKLY_EMAIL_CRON || '12 8 * * 1', () => {
    if (!EMAIL_ON) return console.log('Weekly email skipped: WEEKLY_EMAIL_ENABLED is not true');
    sendWeekly(REPORT_TO).catch(e => console.error('Weekly email failed:', e.message));
  }, tz);

  /* Render can restart the service across a Monday morning and miss the cron.
     On boot, if it is Monday or Tuesday after the send time and this week's
     email has not gone, send it. The week guard stops a double send. */
  setTimeout(async () => {
    if (!EMAIL_ON) return;
    const now = new Date();
    const day = now.getDay();
    if ((day === 1 && now.getHours() >= 9) || day === 2) {
      const last = await storeGet('weekly_email_last');
      if (!last || last.week !== isoWeekKey(now)) {
        sendWeekly(REPORT_TO).catch(e => console.error('Catch up email failed:', e.message));
      }
    }
  }, 120000);

  return { runAudit, buildEmail, sendWeekly, aiSummary };
};
