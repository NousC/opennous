// Data for the Marketing Nous demo workspace. Edit here to reshape the demo.
// Story: a Nous GTM team selling the context graph into 15 known companies.
// Buyer = the GTM engineer / RevOps / founder already running 6-7 tools.

// ── ICP scorecard ────────────────────────────────────────────────────────────
// Score = sum of firing weights, clamped 0-100. Features come from a person's
// own claims + their company's inherited signal.* claims + engagement.
// NOTE: score = logistic squash of the summed weights: 100/(1+exp(-raw/8)).
// raw 0 → 50, raw 8 → 73, raw 16 → 88. So weights are small integers, and
// non-ICP roles need NEGATIVE detractors to fall below the 50 midpoint.
export const SCORECARD = [
  { key: 'title_icp', label: 'ICP title (GTM eng / RevOps / growth)', weight: 4,
    rule: { feature: 'job_title', op: 'contains_any',
      value: ['gtm engineer', 'growth engineer', 'revenue operations', 'revops', 'sales operations', 'sales ops',
              'head of growth', 'head of revenue', 'head of gtm', 'head of sales', 'developer gtm', 'gtm lead'] } },
  { key: 'seniority_leader', label: 'Decision-level seniority', weight: 4,
    rule: { feature: 'seniority', op: 'in', value: ['head', 'vp', 'director', 'founder', 'lead'] } },
  { key: 'seniority_manager', label: 'Manager seniority', weight: 1,
    rule: { feature: 'seniority', op: 'in', value: ['manager'] } },
  { key: 'seniority_ic', label: 'Individual contributor', weight: -1,
    rule: { feature: 'seniority', op: 'in', value: ['ic'] } },
  { key: 'dept_gtm', label: 'GTM department', weight: 2,
    rule: { feature: 'department', op: 'in', value: ['gtm', 'revops', 'sales', 'growth'] } },
  { key: 'stack_complexity', label: 'Complex GTM stack (6+ tools)', weight: 5,
    rule: { feature: 'signal.stack_complexity', op: 'scaled' } },
  { key: 'outbound_motion', label: 'Active outbound motion', weight: 2,
    rule: { feature: 'signal.outbound_motion', op: 'scaled' } },
  { key: 'engagement', label: 'Engaged back with us', weight: 4,
    rule: { feature: 'signal.engagement', op: 'scaled' } },
  { key: 'size_fit', label: 'Company size fit (<5k)', weight: 1,
    rule: { feature: 'employee_count', op: '<=', value: 5000 } },
  { key: 'dept_non_gtm', label: 'Non-GTM role (marketing / design / recruiting)', weight: -11,
    rule: { feature: 'department', op: 'in', value: ['marketing', 'design', 'recruiting', 'talent', 'hr', 'people', 'finance'] } },
];

// ── companies ────────────────────────────────────────────────────────────────
const C = (key, name, domain, industry, employee_count, sig, extra = {}) =>
  ({ key, name, domain, industry, employee_count,
     signals: { stack_complexity: sig[0], outbound_motion: sig[1] },
     location: extra.location, revenue_range: extra.rev,
     tech_stack: extra.stack, keywords: extra.kw, description: extra.desc });

export const COMPANIES = [
  C('acme', 'Acme', 'acme.com', 'B2B SaaS', 600, [9, 8], { location: 'San Francisco, CA', rev: '$25M-$50M',
    stack: ['Salesforce', 'Apollo', 'Clay', 'Instantly', 'Gong', 'Outreach'], kw: ['outbound', 'sales tech', 'gtm'],
    desc: 'Series B B2B SaaS running a heavy multi-tool outbound motion.' }),
  C('notion', 'Notion', 'notion.so', 'Productivity Software', 800, [8, 7], { location: 'San Francisco, CA', stack: ['Salesforce', 'Clay', 'Outreach', 'Common Room'] }),
  C('cursor', 'Cursor', 'cursor.com', 'Developer Tools', 150, [7, 6], { location: 'San Francisco, CA', stack: ['HubSpot', 'Apollo', 'n8n'] }),
  C('linear', 'Linear', 'linear.app', 'Developer Tools', 200, [7, 6], { location: 'Remote', stack: ['HubSpot', 'Clay', 'Instantly'] }),
  C('ramp', 'Ramp', 'ramp.com', 'Fintech', 1500, [9, 9], { location: 'New York, NY', stack: ['Salesforce', 'Apollo', 'Clay', 'Outreach', 'Gong', 'LinkedIn Sales Nav'] }),
  C('vercel', 'Vercel', 'vercel.com', 'Developer Tools', 600, [8, 7], { location: 'San Francisco, CA', stack: ['Salesforce', 'Clay', 'Apollo', 'Common Room'] }),
  C('retool', 'Retool', 'retool.com', 'Developer Tools', 500, [8, 7], { location: 'San Francisco, CA', stack: ['Salesforce', 'Apollo', 'Outreach'] }),
  C('clay', 'Clay', 'clay.com', 'GTM Software', 150, [9, 8], { location: 'New York, NY', stack: ['HubSpot', 'Clay', 'Apollo', 'Smartlead'] }),
  C('rippling', 'Rippling', 'rippling.com', 'HR / Fintech', 3000, [9, 9], { location: 'San Francisco, CA', stack: ['Salesforce', 'Outreach', 'Apollo', 'Gong', 'ZoomInfo'] }),
  C('mercury', 'Mercury', 'mercury.com', 'Fintech', 800, [7, 6], { location: 'San Francisco, CA', stack: ['HubSpot', 'Clay', 'Apollo'] }),
  C('webflow', 'Webflow', 'webflow.com', 'Web Software', 600, [6, 5], { location: 'San Francisco, CA', stack: ['Salesforce', 'Apollo'] }),
  C('deel', 'Deel', 'deel.com', 'HR / Fintech', 4000, [9, 9], { location: 'Remote', stack: ['Salesforce', 'Outreach', 'Apollo', 'Clay', 'Gong', 'ZoomInfo'] }),
  C('amplitude', 'Amplitude', 'amplitude.com', 'Analytics Software', 800, [8, 7], { location: 'San Francisco, CA', stack: ['Salesforce', 'Clay', 'Outreach'] }),
  C('framer', 'Framer', 'framer.com', 'Design Software', 200, [6, 5], { location: 'Amsterdam, NL', stack: ['HubSpot', 'Apollo'] }),
  C('replit', 'Replit', 'replit.com', 'Developer Tools', 150, [7, 6], { location: 'San Francisco, CA', stack: ['HubSpot', 'Apollo', 'n8n'] }),
];

// ── contact helper ───────────────────────────────────────────────────────────
const ctx = (o) => ({ tool: o.tool, pain: o.pain, voice: o.voice || '', emailVoice: o.emailVoice || '',
  segment: o.segment || 'GTM', topic: o.topic || 'the context layer', postTheme: o.postTheme });

// ── contacts ─────────────────────────────────────────────────────────────────
export const CONTACTS = [
  // ===== ACME — the hero account (4 stakeholders, multi-meeting) ==============
  {
    companyKey: 'acme', first: 'Dana', last: 'Rivera', email: 'dana.rivera@acme.com',
    title: 'Head of GTM Engineering', seniority: 'head', department: 'gtm',
    linkedin: 'https://www.linkedin.com/in/dana-rivera-gtm', phone: '+1 415 555 0142',
    stage: 'evaluating', dealStage: 'Engaged', dealValue: 12000, depth: 'deep', engagement: 9, icp: '90-95',
    summary: 'Dana Rivera leads GTM Engineering at Acme and is the champion for a context-graph evaluation. She owns the outbound tooling stack (Salesforce, Apollo, Clay, Instantly, Gong) and is frustrated that no system holds one resolved view of an account across all of it. Actively running a technical evaluation and pulling in her VP RevOps for budget.',
    ctx: ctx({ tool: 'Clay and Apollo', pain: 'account context living in six different tools with no single source of truth',
      voice: "We rebuild the same account picture by hand before every call. It's exhausting.",
      emailVoice: 'Thursday afternoon is open on my side.', segment: 'Series B outbound', topic: 'unifying account context',
      postTheme: 'Your CRM is a filing cabinet, not a memory' }),
    meetings: [
      { d: 40, title: 'Acme x Nous — discovery', summary: 'Dana Rivera: walked through Acme\'s outbound stack and where account context breaks. Bennet Glinder: showed the context graph resolving identity across Salesforce, Apollo and Clay.',
        transcript: '———— Transcript ————\n\nBennet Glinder: So paint me the picture. What does a rep at Acme actually touch before a call?\nDana Rivera: Honestly? Salesforce for the record, Apollo for the email, Clay for enrichment, Gong for the call notes, Instantly for the sequence. Five tabs, and none of them agree on who the account even is.\nDana Rivera: Every rep rebuilds the same context by hand. We call it the pre-call tax.\nBennet Glinder: And when someone leaves, that context walks out the door.\nDana Rivera: Exactly. That\'s the part that scares me. It all lives in people\'s heads and their inboxes.\nBennet Glinder: That\'s the whole reason the graph exists — one resolved record per account that every tool and agent reads from.\nDana Rivera: Okay, that\'s the thing I\'ve been trying to build internally for a year and failing.' },
      { d: 22, title: 'Acme x Nous — technical deep-dive', summary: 'Dana Rivera + Priya Nair: reviewed identity resolution and the MCP interface. Discussed how their agents would read from the graph.',
        transcript: '———— Transcript ————\n\nDana Rivera: Priya\'s our builder, she\'ll tear this apart.\nPriya Nair: My worry is identity resolution. We have accounts with five contacts and three of them are half-filled Apollo records.\nBennet Glinder: That\'s the core of it — entity resolution across every source, so those five records collapse into one account with one timeline.\nPriya Nair: And I can query that from an agent? Not a UI?\nBennet Glinder: Over MCP, yes. The agent calls get_context and gets the resolved record.\nPriya Nair: Okay. That\'s actually the piece Clay doesn\'t give us. Clay builds the list, it doesn\'t remember anything.\nDana Rivera: That\'s the line I\'m taking to Marcus.' },
      { d: 8, title: 'Acme x Nous — buyer alignment (Marcus)', summary: 'Marcus Chen joined to discuss commercials, security, and rollout. Dana positioned it as removing the pre-call tax across the team.',
        transcript: '———— Transcript ————\n\nMarcus Chen: Dana tells me this replaces a project we\'ve had stalled for three quarters.\nDana Rivera: It replaces the project and the six months of eng time we don\'t have.\nMarcus Chen: My question is switching cost. We\'re mid-quarter, campaigns are live.\nBennet Glinder: The graph reads from your existing tools, it doesn\'t replace them. Nothing about the live campaigns changes.\nMarcus Chen: And security — where does the data sit?\nBennet Glinder: Self-hostable, or our cloud with a signed DPA. Your call.\nMarcus Chen: Alright. Send me the security overview and a number for 15 seats and I\'ll take it to the VP.' },
    ],
    intel: [
      { text: 'Acme runs its outbound motion across six disconnected tools (Salesforce, Apollo, Clay, Instantly, Gong, Outreach) with no single resolved view of an account.', category: 'status_quo' },
      { text: 'Dana Rivera calls the manual pre-call context rebuild the "pre-call tax" and wants to eliminate it across the whole team.', category: 'pain' },
      { text: 'Dana Rivera is the champion and owns the GTM tooling stack, but budget over $10k needs VP RevOps sign-off from Marcus Chen.', category: 'authority' },
      { text: 'Acme tried to build an internal unified-account layer for roughly a year and could not ship it with available engineering time.', category: 'goal' },
      { text: 'Dana Rivera strongly prefers tools exposed over an API/MCP that her agents can call directly, not another no-code UI.', category: 'preference' },
      { text: 'Acme is evaluating this quarter, driven by a stalled internal project and a mid-quarter budget review.', category: 'timeline' },
      { text: 'Dana Rivera sees Clay as list-building only and specifically wants the persistent memory layer Clay does not provide.', category: 'competitor' },
    ],
  },
  {
    companyKey: 'acme', first: 'Marcus', last: 'Chen', email: 'marcus.chen@acme.com',
    title: 'VP Revenue Operations', seniority: 'vp', department: 'revops',
    linkedin: 'https://www.linkedin.com/in/marcus-chen-revops', phone: '+1 415 555 0177',
    stage: 'evaluating', dealStage: 'Engaged', depth: 'mid', engagement: 7, icp: '85-90',
    summary: 'Marcus Chen is VP RevOps at Acme and the economic buyer on the context-graph deal Dana is championing. Focused on switching cost, security, and rollout across 15 seats.',
    ctx: ctx({ tool: 'Salesforce', pain: 'reps rebuilding account context by hand and no clean handoff when people leave',
      voice: 'My concern is always switching cost mid-quarter, but the manual work is real.',
      emailVoice: 'Loop me in on the security doc.', segment: 'RevOps', topic: 'rollout and commercials',
      postTheme: 'The real cost of tool sprawl is the context you lose between them' }),
    intel: [
      { text: 'Marcus Chen is the economic buyer and holds final sign-off on GTM tooling spend above $10k at Acme.', category: 'authority' },
      { text: 'Marcus Chen\'s primary objection is switching cost during a live mid-quarter campaign period.', category: 'objection' },
      { text: 'Marcus Chen requires a security overview and a signed DPA before approving; open to self-hosting.', category: 'objection' },
      { text: 'Acme is sizing a 15-seat rollout for the GTM and RevOps teams.', category: 'budget' },
    ],
  },
  {
    companyKey: 'acme', first: 'Priya', last: 'Nair', email: 'priya.nair@acme.com',
    title: 'Growth Engineer', seniority: 'senior', department: 'growth',
    linkedin: 'https://www.linkedin.com/in/priya-nair-growth', stage: 'engaged', depth: 'mid', engagement: 7, icp: '72-80',
    ctx: ctx({ tool: 'Clay and n8n', pain: 'stitching enrichment and identity resolution together by hand in Clay',
      voice: 'Clay builds the list but it forgets everything the moment the table refreshes.',
      emailVoice: 'Happy to test the MCP endpoint.', segment: 'growth eng', topic: 'the API surface',
      postTheme: 'Identity resolution is the unsexy moat in GTM' }),
    intel: [
      { text: 'Priya Nair is the hands-on evaluator/builder at Acme and validates technical fit before Dana commits.', category: 'authority' },
      { text: 'Priya Nair sees identity resolution across half-filled Apollo records as the specific gap Clay cannot close.', category: 'pain' },
      { text: 'Priya Nair wants to query the resolved account record from an agent over MCP rather than through a UI.', category: 'preference' },
    ],
  },
  {
    companyKey: 'acme', first: 'Tom', last: 'Ellis', email: 'tom.ellis@acme.com',
    title: 'Marketing Designer', seniority: 'ic', department: 'design',
    linkedin: 'https://www.linkedin.com/in/tom-ellis-design', stage: 'connected', depth: 'shallow', engagement: 3, icp: '30-40',
    ctx: ctx({ tool: 'Figma', pain: 'campaign assets being out of sync with what sales actually sends',
      voice: 'I mostly do the brand side, not really the data stuff.',
      segment: 'brand', topic: 'brand', postTheme: 'Good GTM design starts with knowing the account' }),
    intel: [
      { text: 'Tom Ellis works on brand and campaign design at Acme and is not part of the GTM tooling decision.', category: 'authority' },
    ],
  },

  // ===== NOTION =============================================================
  {
    companyKey: 'notion', first: 'Sofia', last: 'Almeida', email: 'sofia.almeida@notion.so',
    title: 'Head of Sales Operations', seniority: 'head', department: 'sales',
    linkedin: 'https://www.linkedin.com/in/sofia-almeida-salesops', stage: 'evaluating', dealStage: 'Engaged', depth: 'deep', engagement: 8, icp: '82-88',
    summary: 'Sofia Almeida runs Sales Ops at Notion and is evaluating a context layer to unify a stack that spans Salesforce, Clay, Outreach and Common Room. Wants agents to act on one resolved record.',
    ctx: ctx({ tool: 'Salesforce and Common Room', pain: 'community signals in Common Room never making it into the account record sales works from',
      voice: 'We have signals everywhere and context nowhere.',
      emailVoice: 'Next Tuesday works.', segment: 'PLG-to-sales', topic: 'unifying signals',
      postTheme: 'Your CRM is a filing cabinet, not a memory' }),
    meetings: [
      { d: 34, title: 'Notion x Nous — discovery', summary: 'Sofia Almeida: described the gap between product/community signals and the sales record. Bennet Glinder: showed signals flowing into one resolved account.',
        transcript: '———— Transcript ————\n\nSofia Almeida: Our problem isn\'t data, it\'s that the data never meets. Common Room knows they\'re active, Salesforce doesn\'t.\nBennet Glinder: So the rep works a cold record on an account that\'s actually on fire.\nSofia Almeida: Constantly. And by the time it syncs, the moment\'s gone.\nBennet Glinder: The graph is the join. Every signal lands on the one resolved account, and the agent reads that.\nSofia Almeida: If that\'s real, it\'s the thing I\'ve been asking three vendors for.' },
    ],
    intel: [
      { text: 'Notion\'s community and product signals in Common Room never reach the account record sales works from in Salesforce.', category: 'pain' },
      { text: 'Sofia Almeida wants product-qualified and community signals to land on one resolved account the sales agent reads.', category: 'goal' },
      { text: 'Sofia Almeida has asked three other vendors for a unified signal layer and been disappointed.', category: 'competitor' },
      { text: 'Notion runs a PLG-to-sales motion where timing on active accounts is the main lever.', category: 'status_quo' },
    ],
  },
  {
    companyKey: 'notion', first: 'Ravi', last: 'Kapoor', email: 'ravi.kapoor@notion.so',
    title: 'RevOps Manager', seniority: 'manager', department: 'revops',
    linkedin: 'https://www.linkedin.com/in/ravi-kapoor-revops', stage: 'engaged', depth: 'mid', engagement: 6, icp: '70-76',
    ctx: ctx({ tool: 'Salesforce', pain: 'manual data hygiene and dedupe eating a day a week',
      voice: 'Half my week is reconciling duplicate accounts by hand.',
      emailVoice: 'Send a time.', segment: 'RevOps', topic: 'identity resolution',
      postTheme: 'Identity resolution is the unsexy moat in GTM' }),
    intel: [
      { text: 'Ravi Kapoor spends roughly a day a week manually reconciling duplicate accounts in Salesforce.', category: 'pain' },
      { text: 'Ravi Kapoor reports to Sofia Almeida and supports the evaluation on the data-hygiene side.', category: 'relationship' },
    ],
  },
  {
    companyKey: 'notion', first: 'Felix', last: 'Braun', email: 'felix.braun@notion.so',
    title: 'Technical Recruiter', seniority: 'ic', department: 'recruiting',
    linkedin: 'https://www.linkedin.com/in/felix-braun-recruiting', stage: 'connected', depth: 'tof', engagement: 2, icp: '25-35',
    ctx: ctx({ tool: 'LinkedIn Recruiter', pain: 'sourcing, unrelated to GTM tooling',
      voice: 'I think you might want someone on the sales side, not me.',
      segment: 'talent', topic: 'recruiting', postTheme: 'Hiring GTM engineers is the new arms race' }),
    intel: [
      { text: 'Felix Braun is a technical recruiter at Notion and is not involved in GTM tooling decisions.', category: 'authority' },
    ],
  },

  // ===== CURSOR (founder-led, hot) ==========================================
  {
    companyKey: 'cursor', first: 'Ben', last: 'Whitaker', email: 'ben@cursor.com',
    title: 'Co-founder / GTM Lead', seniority: 'founder', department: 'gtm',
    linkedin: 'https://www.linkedin.com/in/ben-whitaker', phone: '+1 415 555 0190',
    stage: 'evaluating', dealStage: 'Engaged', depth: 'deep', engagement: 9, icp: '88-92',
    summary: 'Ben Whitaker co-founded Cursor and personally runs GTM. Building an agent-driven outbound motion and wants the context graph as the memory layer his agents read from. Fast-moving, technical, decision maker.',
    ctx: ctx({ tool: 'HubSpot, Apollo and a pile of n8n workflows', pain: 'his outbound agents having no shared memory of an account between runs',
      voice: 'My agents are goldfish. Every run they start from zero.',
      emailVoice: 'I\'m around all week, just pick a slot.', segment: 'agent-native', topic: 'agent memory',
      postTheme: 'The context window is not your memory' }),
    meetings: [
      { d: 30, title: 'Cursor x Nous — working session', summary: 'Ben Whitaker: walked through his n8n agent stack and where memory breaks. Bennet Glinder: mapped get_context / record into his loop.',
        transcript: '———— Transcript ————\n\nBen Whitaker: I\'ve got maybe twelve n8n workflows doing outbound. They all hit the same accounts and none of them know what the others did.\nBennet Glinder: So the account gets four cold intros in a week.\nBen Whitaker: It\'s embarrassing. I need one memory they all write to and read from.\nBennet Glinder: That\'s record and get_context. Every agent writes what it learned, the next one starts from truth.\nBen Whitaker: Yeah. That\'s the missing primitive. Can I self-host it today?\nBennet Glinder: Yes, it\'s open source, MCP server, running in ten minutes.\nBen Whitaker: Then let\'s just do it.' },
    ],
    intel: [
      { text: 'Cursor runs roughly a dozen n8n outbound workflows that hit the same accounts with no shared memory between them.', category: 'status_quo' },
      { text: 'Ben Whitaker\'s core pain is that his outbound agents have no persistent memory of an account between runs ("my agents are goldfish").', category: 'pain' },
      { text: 'Ben Whitaker is a founder and the sole decision maker on GTM tooling at Cursor; moves fast.', category: 'authority' },
      { text: 'Ben Whitaker wants a single memory primitive every agent writes to and reads from over MCP, and intends to self-host.', category: 'goal' },
      { text: 'Ben Whitaker prefers open-source, self-hostable infrastructure he can stand up himself in minutes.', category: 'preference' },
    ],
  },

  // ===== RAMP ===============================================================
  {
    companyKey: 'ramp', first: 'Alexis', last: 'Moreau', email: 'alexis.moreau@ramp.com',
    title: 'RevOps Lead', seniority: 'lead', department: 'revops',
    linkedin: 'https://www.linkedin.com/in/alexis-moreau-revops', phone: '+1 212 555 0133',
    stage: 'evaluating', dealStage: 'Engaged', depth: 'deep', engagement: 8, icp: '84-89',
    summary: 'Alexis Moreau leads RevOps at Ramp, running one of the most aggressive outbound motions in fintech across a seven-tool stack. Evaluating a context layer to stop reps and agents from working stale, fragmented account data.',
    ctx: ctx({ tool: 'Salesforce, Apollo, Clay and Outreach', pain: 'a seven-tool stack where the account record is never current or complete',
      voice: 'We spend more on tools than most teams spend on headcount, and still nobody trusts the record.',
      emailVoice: 'Thursday or Friday both work.', segment: 'high-velocity outbound', topic: 'a trusted account record',
      postTheme: 'You bought seven tools and still don\'t have one view of the account' }),
    meetings: [
      { d: 26, title: 'Ramp x Nous — discovery', summary: 'Alexis Moreau: detailed the seven-tool stack and trust problem. Bennet Glinder: showed one resolved record with provenance per fact.',
        transcript: '———— Transcript ————\n\nAlexis Moreau: We have seven tools and I still can\'t answer "what\'s the state of this account" in one place.\nBennet Glinder: Because every tool has a slice and none of them has the whole.\nAlexis Moreau: Right, and the reps stopped trusting the CRM a year ago. They keep their own notes.\nBennet Glinder: So the real record is in a hundred private docs.\nAlexis Moreau: Which is a disaster for a team our size. If we could make one record everyone trusts, that alone is worth it.' },
    ],
    intel: [
      { text: 'Ramp runs a seven-tool GTM stack and no single system holds a current, complete account record.', category: 'status_quo' },
      { text: 'Ramp\'s reps stopped trusting the CRM and keep their own private notes, fragmenting the real account record.', category: 'pain' },
      { text: 'Alexis Moreau\'s goal is one account record the whole team trusts, with provenance on each fact.', category: 'goal' },
      { text: 'Alexis Moreau leads RevOps and drives GTM tooling selection at Ramp.', category: 'authority' },
    ],
  },
  {
    companyKey: 'ramp', first: 'Chloe', last: 'Bennett', email: 'chloe.bennett@ramp.com',
    title: 'SDR Manager', seniority: 'manager', department: 'sales',
    linkedin: 'https://www.linkedin.com/in/chloe-bennett-sdr', stage: 'engaged', depth: 'shallow', engagement: 5, icp: '62-70',
    ctx: ctx({ tool: 'Outreach and Apollo', pain: 'her SDRs personalizing from scratch because context is scattered',
      voice: 'My reps open six tabs to write one good first line.',
      emailVoice: 'Give me a couple of times.', segment: 'SDR', topic: 'personalization at scale',
      postTheme: 'Personalization dies at scale without shared context' }),
    intel: [
      { text: 'Chloe Bennett\'s SDRs open six tools to assemble the context for a single personalized opener.', category: 'pain' },
      { text: 'Chloe Bennett manages the SDR team under Alexis Moreau and is a supporting voice in the evaluation.', category: 'relationship' },
    ],
  },

  // ===== LINEAR =============================================================
  {
    companyKey: 'linear', first: 'Elena', last: 'Fischer', email: 'elena.fischer@linear.app',
    title: 'Head of Growth', seniority: 'head', department: 'growth',
    linkedin: 'https://www.linkedin.com/in/elena-fischer-growth', stage: 'engaged', dealStage: 'Engaged', depth: 'mid', engagement: 7, icp: '80-85',
    ctx: ctx({ tool: 'HubSpot and Clay', pain: 'growth experiments that can\'t reuse what sales already learned about an account',
      voice: 'Growth and sales are learning the same accounts twice.',
      emailVoice: 'Wednesday afternoon.', segment: 'growth', topic: 'shared account context',
      postTheme: 'Growth and sales should share one memory of the account' }),
    meetings: [
      { d: 32, title: 'Linear x Nous — intro call', summary: 'Elena Fischer: growth and sales duplicating account learning. Bennet Glinder: one shared record across both motions.',
        transcript: '———— Transcript ————\n\nElena Fischer: Growth runs an experiment, learns something about an account, and sales never sees it. Then sales learns it again.\nBennet Glinder: One account, two teams, zero shared memory.\nElena Fischer: Exactly. It\'s wasteful and it looks bad to the customer.\nBennet Glinder: The graph is the shared memory — both motions write to and read from the same record.\nElena Fischer: That would genuinely change how we hand off.' },
    ],
    intel: [
      { text: 'Linear\'s growth and sales teams independently re-learn the same accounts because context is not shared.', category: 'pain' },
      { text: 'Elena Fischer wants one shared account record spanning both growth experiments and sales.', category: 'goal' },
      { text: 'Elena Fischer heads Growth at Linear and owns the growth tooling decision.', category: 'authority' },
    ],
  },
  {
    companyKey: 'linear', first: 'Jonas', last: 'Weber', email: 'jonas.weber@linear.app',
    title: 'Sales Engineer', seniority: 'ic', department: 'sales',
    linkedin: 'https://www.linkedin.com/in/jonas-weber-se', stage: 'engaged', depth: 'shallow', engagement: 5, icp: '66-72',
    ctx: ctx({ tool: 'HubSpot', pain: 'prepping technical demos without a full picture of the account\'s stack',
      voice: 'I walk into demos half-blind on their stack.',
      emailVoice: 'Any time next week.', segment: 'sales eng', topic: 'account context for demos',
      postTheme: 'A great demo starts with knowing their stack' }),
    intel: [
      { text: 'Jonas Weber preps technical demos without a consolidated view of the prospect\'s existing stack.', category: 'pain' },
    ],
  },

  // ===== VERCEL =============================================================
  {
    companyKey: 'vercel', first: 'Daniel', last: 'Okafor', email: 'daniel.okafor@vercel.com',
    title: 'GTM Engineer', seniority: 'senior', department: 'gtm',
    linkedin: 'https://www.linkedin.com/in/daniel-okafor-gtm', stage: 'evaluating', dealStage: 'Engaged', depth: 'mid', engagement: 8, icp: '84-90',
    summary: 'Daniel Okafor is a GTM Engineer at Vercel who came inbound after a post. Building internal GTM automations and wants a context graph as the shared substrate.',
    ctx: ctx({ tool: 'Salesforce, Clay and Common Room', pain: 'building the same account-context plumbing over and over for each new automation',
      voice: 'I keep rebuilding the same account-context layer for every workflow.',
      emailVoice: 'Ping me a slot.', segment: 'GTM eng', topic: 'a reusable context substrate',
      postTheme: 'Stop rebuilding the context layer for every workflow' }),
    meetings: [
      { d: 28, title: 'Vercel x Nous — build review', summary: 'Daniel Okafor: showed his internal GTM automations. Bennet Glinder: positioned the graph as the reusable substrate under all of them.',
        transcript: '———— Transcript ————\n\nDaniel Okafor: Every automation I build needs the same thing first — resolve the account, pull its context. I write that plumbing every time.\nBennet Glinder: And it drifts, so each workflow has a slightly different idea of the account.\nDaniel Okafor: Yes! That\'s the subtle killer. There\'s no canonical account.\nBennet Glinder: That\'s what the graph is — the canonical, resolved account every workflow reads.\nDaniel Okafor: Okay, that\'s a day-one install for me.' },
    ],
    intel: [
      { text: 'Daniel Okafor rebuilds the same account-resolution-and-context plumbing for every new GTM automation at Vercel.', category: 'pain' },
      { text: 'Daniel Okafor wants one canonical, resolved account record every internal workflow reads from.', category: 'goal' },
      { text: 'Daniel Okafor came inbound from a LinkedIn post and is a hands-on GTM engineer / likely champion.', category: 'authority' },
    ],
  },
  {
    companyKey: 'vercel', first: 'Priyanka', last: 'Shah', email: 'priyanka.shah@vercel.com',
    title: 'Growth Engineer', seniority: 'senior', department: 'growth',
    linkedin: 'https://www.linkedin.com/in/priyanka-shah-growth', stage: 'engaged', depth: 'shallow', engagement: 5, icp: '77-82',
    ctx: ctx({ tool: 'Clay', pain: 'enrichment credits burned re-resolving the same accounts',
      voice: 'We re-enrich the same accounts monthly because nothing persists.',
      emailVoice: 'Sure, send a time.', segment: 'growth eng', topic: 'persistent enrichment',
      postTheme: 'You are paying to enrich the same account every month' }),
    intel: [
      { text: 'Priyanka Shah burns Clay enrichment credits re-resolving the same accounts because nothing persists between runs.', category: 'pain' },
    ],
  },

  // ===== RETOOL =============================================================
  {
    companyKey: 'retool', first: 'Hannah', last: 'Schmidt', email: 'hannah.schmidt@retool.com',
    title: 'Head of Revenue', seniority: 'head', department: 'sales',
    linkedin: 'https://www.linkedin.com/in/hannah-schmidt-revenue', stage: 'engaged', dealStage: 'Engaged', depth: 'mid', engagement: 6, icp: '78-83',
    ctx: ctx({ tool: 'Salesforce, Apollo and Outreach', pain: 'no reliable answer to "what is the state of this account" for forecasting',
      voice: 'I can\'t forecast on a record nobody trusts.',
      emailVoice: 'Tuesday morning works.', segment: 'revenue', topic: 'account truth for forecasting',
      postTheme: 'Forecasting is fiction if the account record is stale' }),
    meetings: [
      { d: 30, title: 'Retool x Nous — intro', summary: 'Hannah Schmidt: forecasting on untrusted records. Bennet Glinder: resolved record with freshness as forecasting input.',
        transcript: '———— Transcript ————\n\nHannah Schmidt: Every forecast call I\'m arguing about whether the data is even real.\nBennet Glinder: Because the record is stitched from tools that disagree.\nHannah Schmidt: And half of it is three weeks old. I need to know what\'s actually current.\nBennet Glinder: The graph carries freshness per fact — you can see what\'s current versus decayed.\nHannah Schmidt: That\'s the part my forecasting actually needs.' },
    ],
    intel: [
      { text: 'Retool cannot get a trusted "state of the account" answer, which undermines revenue forecasting.', category: 'pain' },
      { text: 'Hannah Schmidt heads Revenue at Retool and wants account truth she can forecast on.', category: 'goal' },
    ],
  },

  // ===== CLAY (peer / meta) =================================================
  {
    companyKey: 'clay', first: 'Liam', last: 'Novak', email: 'liam.novak@clay.com',
    title: 'Growth Engineer', seniority: 'senior', department: 'growth',
    linkedin: 'https://www.linkedin.com/in/liam-novak-growth', stage: 'engaged', depth: 'mid', engagement: 7, icp: '80-85',
    ctx: ctx({ tool: 'Clay (internally, on themselves)', pain: 'even the Clay team lacks a persistent memory layer under their own tables',
      voice: 'We build the enrichment, but we still don\'t have a memory under it.',
      emailVoice: 'Curious, send a time.', segment: 'GTM tooling', topic: 'the memory layer under enrichment',
      postTheme: 'Enrichment without memory is just a fresh coat of paint' }),
    meetings: [
      { d: 30, title: 'Clay x Nous — peer chat', summary: 'Liam Novak: even Clay lacks a persistent context layer internally. Discussed the graph as complementary to enrichment.',
        transcript: '———— Transcript ————\n\nLiam Novak: Funny enough, we use Clay on ourselves and still hit the memory problem.\nBennet Glinder: Enrichment fills the table, but the table forgets.\nLiam Novak: Right. The graph sits under it and remembers. They\'re not the same layer.\nBennet Glinder: Exactly — Clay builds, the graph remembers.\nLiam Novak: I actually want to try this on our own outbound.' },
    ],
    intel: [
      { text: 'Even Clay\'s own growth team lacks a persistent memory layer beneath their enrichment tables.', category: 'pain' },
      { text: 'Liam Novak views the context graph as complementary to enrichment ("Clay builds, the graph remembers"), not competitive.', category: 'preference' },
    ],
  },

  // ===== RIPPLING (shallow) =================================================
  {
    companyKey: 'rippling', first: 'Grace', last: 'Lin', email: 'grace.lin@rippling.com',
    title: 'Sales Operations Manager', seniority: 'manager', department: 'sales',
    linkedin: 'https://www.linkedin.com/in/grace-lin-salesops', stage: 'engaged', depth: 'shallow', engagement: 5, icp: '72-78',
    ctx: ctx({ tool: 'Salesforce, ZoomInfo and Outreach', pain: 'a large stack where account context is siloed by team',
      voice: 'Context is siloed by team here, nobody sees the whole account.',
      emailVoice: 'Send options.', segment: 'enterprise ops', topic: 'cross-team account context',
      postTheme: 'At scale, account context fragments by team' }),
    intel: [
      { text: 'Rippling\'s account context is siloed by team across a large enterprise GTM stack.', category: 'status_quo' },
      { text: 'Grace Lin manages Sales Ops and is scoping whether a context layer fits their scale.', category: 'authority' },
    ],
  },

  // ===== MERCURY ============================================================
  {
    companyKey: 'mercury', first: 'Omar', last: 'Haddad', email: 'omar.haddad@mercury.com',
    title: 'Head of GTM', seniority: 'head', department: 'gtm',
    linkedin: 'https://www.linkedin.com/in/omar-haddad-gtm', stage: 'engaged', dealStage: 'Engaged', depth: 'mid', engagement: 7, icp: '83-88',
    ctx: ctx({ tool: 'HubSpot, Clay and Apollo', pain: 'agentic GTM plans blocked by having no shared context substrate',
      voice: 'I want an agentic GTM motion but there\'s no ground truth for the agents to stand on.',
      emailVoice: 'Thursday works.', segment: 'agentic GTM', topic: 'ground truth for agents',
      postTheme: 'Agentic GTM needs a ground truth, not a bigger prompt' }),
    meetings: [
      { d: 30, title: 'Mercury x Nous — vision call', summary: 'Omar Haddad: wants agentic GTM but lacks a shared substrate. Bennet Glinder: graph as the ground-truth layer under the agents.',
        transcript: '———— Transcript ————\n\nOmar Haddad: I\'m sold on agentic GTM in principle. The problem is my agents have nothing solid to stand on.\nBennet Glinder: So they hallucinate the account or start cold every time.\nOmar Haddad: Both. I need one ground truth they all share.\nBennet Glinder: That\'s the graph — the shared, resolved record every agent reads and writes.\nOmar Haddad: Then this is the layer I\'ve been missing.' },
    ],
    intel: [
      { text: 'Mercury wants an agentic GTM motion but has no shared context substrate for the agents to rely on.', category: 'goal' },
      { text: 'Omar Haddad heads GTM at Mercury and is the decision maker on this initiative.', category: 'authority' },
    ],
  },

  // ===== WEBFLOW (shallow, low) ============================================
  {
    companyKey: 'webflow', first: 'Isabella', last: 'Rossi', email: 'isabella.rossi@webflow.com',
    title: 'RevOps Analyst', seniority: 'ic', department: 'revops',
    linkedin: 'https://www.linkedin.com/in/isabella-rossi-revops', stage: 'connected', depth: 'shallow', engagement: 4, icp: '58-64',
    ctx: ctx({ tool: 'Salesforce', pain: 'reporting on data quality issues she can\'t fix at the source',
      voice: 'I flag the data problems but I can\'t fix them.',
      emailVoice: 'Maybe later this month.', segment: 'RevOps', topic: 'data quality',
      postTheme: 'Data quality is a source problem, not a report problem' }),
    intel: [
      { text: 'Isabella Rossi reports on Salesforce data-quality issues at Webflow but lacks authority to fix them at the source.', category: 'authority' },
    ],
  },

  // ===== DEEL (early, 2 stakeholders) ======================================
  {
    companyKey: 'deel', first: 'Nathan', last: 'Brooks', email: 'nathan.brooks@deel.com',
    title: 'Director of Sales Operations', seniority: 'director', department: 'sales',
    linkedin: 'https://www.linkedin.com/in/nathan-brooks-salesops', stage: 'engaged', depth: 'shallow', engagement: 5, icp: '79-84',
    ctx: ctx({ tool: 'Salesforce, Outreach and ZoomInfo', pain: 'a sprawling global stack with no unified account view across regions',
      voice: 'Every region runs its own tools and its own version of the account.',
      emailVoice: 'Let\'s find time next week.', segment: 'global ops', topic: 'unifying account context across regions',
      postTheme: 'Global GTM means the account fragments across regions' }),
    intel: [
      { text: 'Deel runs region-specific GTM stacks with no unified account view across regions.', category: 'status_quo' },
      { text: 'Nathan Brooks directs Sales Ops at Deel and is scoping a unification project.', category: 'authority' },
    ],
  },
  {
    companyKey: 'deel', first: 'Sara', last: 'Kim', email: 'sara.kim@deel.com',
    title: 'RevOps Manager', seniority: 'manager', department: 'revops',
    linkedin: 'https://www.linkedin.com/in/sara-kim-revops', stage: 'connected', depth: 'shallow', engagement: 4, icp: '68-74',
    ctx: ctx({ tool: 'Salesforce', pain: 'cross-region dedupe and ownership conflicts',
      voice: 'The same account exists three times with three owners.',
      emailVoice: 'Later works.', segment: 'RevOps', topic: 'dedupe and ownership',
      postTheme: 'One account, three owners, zero truth' }),
    intel: [
      { text: 'Sara Kim manages RevOps at Deel and deals with duplicate accounts owned by different regions.', category: 'pain' },
    ],
  },

  // ===== AMPLITUDE ==========================================================
  {
    companyKey: 'amplitude', first: 'Yuki', last: 'Tanaka', email: 'yuki.tanaka@amplitude.com',
    title: 'Growth Lead', seniority: 'lead', department: 'growth',
    linkedin: 'https://www.linkedin.com/in/yuki-tanaka-growth', stage: 'engaged', depth: 'shallow', engagement: 5, icp: '74-80',
    ctx: ctx({ tool: 'Salesforce and Clay', pain: 'product usage signals not reaching the account record for GTM',
      voice: 'We have world-class product data that never reaches sales.',
      emailVoice: 'Send a time.', segment: 'PLG', topic: 'usage signals into the record',
      postTheme: 'Your product data is wasted if GTM never sees it' }),
    intel: [
      { text: 'Amplitude\'s rich product-usage signals do not reach the account record GTM works from.', category: 'pain' },
      { text: 'Yuki Tanaka leads Growth and wants usage signals to land on the resolved account.', category: 'goal' },
    ],
  },

  // ===== FRAMER (top of funnel) ============================================
  {
    companyKey: 'framer', first: 'Lucas', last: 'Meyer', email: 'lucas@framer.com',
    title: 'Co-founder', seniority: 'founder', department: 'gtm',
    linkedin: 'https://www.linkedin.com/in/lucas-meyer', stage: 'connected', depth: 'tof', engagement: 4, icp: '70-76',
    ctx: ctx({ tool: 'HubSpot', pain: 'wearing the GTM hat himself with no system of record for context',
      voice: 'Right now the context is all in my head, which doesn\'t scale.',
      segment: 'founder-led', topic: 'a system of record for context',
      postTheme: 'Founder-led GTM runs on the founder\'s memory until it breaks' }),
    intel: [
      { text: 'Lucas Meyer runs founder-led GTM at Framer with account context held in his head, not any system.', category: 'status_quo' },
      { text: 'Lucas Meyer is a founder and would be the decision maker, but is not actively evaluating this quarter.', category: 'timeline' },
    ],
  },

  // ===== REPLIT =============================================================
  {
    companyKey: 'replit', first: 'Amara', last: 'Diallo', email: 'amara.diallo@replit.com',
    title: 'Head of Developer GTM', seniority: 'head', department: 'gtm',
    linkedin: 'https://www.linkedin.com/in/amara-diallo-devgtm', stage: 'engaged', dealStage: 'Engaged', depth: 'mid', engagement: 7, icp: '81-86',
    ctx: ctx({ tool: 'HubSpot, Apollo and n8n', pain: 'developer-signal context scattered across GitHub, community and CRM',
      voice: 'Developer intent lives in ten places and our record sees none of it.',
      emailVoice: 'Wednesday or Thursday.', segment: 'developer GTM', topic: 'developer-signal context',
      postTheme: 'Developer intent is everywhere except your CRM' }),
    meetings: [
      { d: 30, title: 'Replit x Nous — discovery', summary: 'Amara Diallo: developer signals scattered across sources. Bennet Glinder: graph resolving dev signals onto the account.',
        transcript: '———— Transcript ————\n\nAmara Diallo: Our best signal is developer behavior, and it\'s spread across GitHub, our community, and product. The CRM sees none of it.\nBennet Glinder: So the account looks quiet when it\'s actually active.\nAmara Diallo: Exactly the trap. I need those signals resolved onto one account.\nBennet Glinder: That\'s the graph — every signal source lands on the resolved record.\nAmara Diallo: That maps perfectly to how we want to sell.' },
    ],
    intel: [
      { text: 'Replit\'s strongest buying signals are developer behaviors scattered across GitHub, community and product, invisible to the CRM.', category: 'pain' },
      { text: 'Amara Diallo heads Developer GTM at Replit and wants developer signals resolved onto one account record.', category: 'goal' },
    ],
  },
];
