// ============================================================
// Innovation Grid — API Worker
// Auth endpoints:
//   POST /register           { fullName, email, password, role, companyId?, companyName? }
//   GET  /verify-email        ?token=...
//   POST /login               { email, password }
//   POST /forgot-password     { email }
//   POST /reset-password      { token, newPassword }
//   POST /invite-employee     { companyId, email, fullName, role, invitedByName }
//   POST /accept-invite       { token, password }
//   POST /change-password     { userId, currentPassword, newPassword }
// Data endpoints:
//   GET  /ideas?companyId=X            POST /ideas            PATCH /ideas/:id
//   GET  /challenges?companyId=X       POST /challenges
//   GET  /solutions?challengeId=X      POST /solutions
//   GET  /projects?companyId=X         POST /projects         PATCH /projects/:id
//   GET  /company/:id                  PATCH /company/:id
//
// Required secrets (set in Cloudflare dashboard → Worker → Settings → Variables):
//   AIRTABLE_TOKEN       — Airtable personal access token (data.records:read/write scope)
//   AIRTABLE_BASE_ID     — appw3rCN8sLlvFtsA (Innovation Grid Platform base)
//   BREVO_API_KEY        — Brevo transactional email API key
//   BREVO_SENDER_EMAIL   — info@innovationraces.com
//   SITE_URL             — e.g. https://<org>.github.io/<repo>
// ============================================================

const USERS_TABLE = 'Users';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  return crypto.randomUUID().replace(/-/g, '');
}

// ---------- Airtable helpers ----------
async function airtableFind(env, table, formula) {
  const url = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
  const data = await res.json();
  return data.records && data.records[0] ? data.records[0] : null;
}

async function airtableList(env, table, formula, sort) {
  let url = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}?pageSize=100`;
  if (formula) url += `&filterByFormula=${encodeURIComponent(formula)}`;
  if (sort) url += `&sort[0][field]=${encodeURIComponent(sort.field)}&sort[0][direction]=${sort.direction || 'desc'}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
  const data = await res.json();
  return data.records || [];
}

async function airtableGet(env, table, recordId) {
  const url = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${recordId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
  if (!res.ok) return null;
  return res.json();
}

async function airtableCreate(env, table, fields) {
  const url = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  return res.json();
}

async function airtableUpdate(env, table, recordId, fields) {
  const url = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${recordId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  return res.json();
}

async function airtableDelete(env, table, recordId) {
  const url = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${recordId}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` },
  });
  return res.json();
}

// ---------- Brevo email helper ----------
async function sendEmail(env, { to, subject, html }) {
  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender: { email: env.BREVO_SENDER_EMAIL, name: 'Innovation Grid' },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
}

// ---------- Data: Ideas ----------
async function handleListIdeas(req, env) {
  const url = new URL(req.url);
  const companyId = url.searchParams.get('companyId');
  const ownerId = url.searchParams.get('ownerId');
  let formula = '';
  if (companyId) formula = `FIND("${companyId}", ARRAYJOIN({Company}))`;
  if (ownerId) formula = `FIND("${ownerId}", ARRAYJOIN({Owner}))`;
  const records = await airtableList(env, 'Ideas', formula, { field: 'Title' });
  return json({ records: records.map((r) => ({ id: r.id, ...r.fields })) });
}

async function handleCreateIdea(req, env) {
  const { title, description, visibility, companyId, ownerId, department } = await req.json();
  if (!title) return json({ error: 'بيانات ناقصة' }, 400);
  const fields = {
    'Title': title,
    'Description': description || '',
    'Status': 'Submitted',
    'Visibility': visibility || 'Private',
  };
  if (companyId) fields['Company'] = [companyId];
  if (ownerId) fields['Owner'] = [ownerId];
  if (department) fields['Department'] = department;
  const record = await airtableCreate(env, 'Ideas', fields);
  return json({ success: true, id: record.id });
}

async function handleUpdateIdea(req, env, id) {
  const body = await req.json();
  const fields = {};
  if (body.status) fields['Status'] = body.status;
  if (body.title) fields['Title'] = body.title;
  if (body.description) fields['Description'] = body.description;
  await airtableUpdate(env, 'Ideas', id, fields);
  return json({ success: true });
}

// ---------- Data: Challenges ----------
async function handleListChallenges(req, env) {
  const url = new URL(req.url);
  const companyId = url.searchParams.get('companyId');
  const formula = companyId ? `FIND("${companyId}", ARRAYJOIN({Company}))` : '';
  const records = await airtableList(env, 'Challenges', formula, { field: 'Start Date' });
  return json({ records: records.map((r) => ({ id: r.id, ...r.fields })) });
}

async function handleCreateChallenge(req, env) {
  const { title, problemDescription, prize, startDate, endDate, companyId } = await req.json();
  if (!title || !companyId) return json({ error: 'بيانات ناقصة' }, 400);
  const record = await airtableCreate(env, 'Challenges', {
    'Title': title,
    'Problem Description': problemDescription || '',
    'Prize': prize || '',
    'Start Date': startDate || null,
    'End Date': endDate || null,
    'Status': 'Open',
    'Company': [companyId],
  });
  return json({ success: true, id: record.id });
}

// ---------- Data: Solutions ----------
async function handleListSolutions(req, env) {
  const url = new URL(req.url);
  const challengeId = url.searchParams.get('challengeId');
  const formula = challengeId ? `FIND("${challengeId}", ARRAYJOIN({Challenge}))` : '';
  const records = await airtableList(env, 'Solutions', formula);
  return json({ records: records.map((r) => ({ id: r.id, ...r.fields })) });
}

async function handleCreateSolution(req, env) {
  const { title, description, challengeId, submittedByUserId } = await req.json();
  if (!title || !challengeId) return json({ error: 'بيانات ناقصة' }, 400);
  const fields = {
    'Title': title,
    'Description': description || '',
    'Status': 'Submitted',
    'Challenge': [challengeId],
  };
  if (submittedByUserId) fields['Submitted By'] = [submittedByUserId];
  const record = await airtableCreate(env, 'Solutions', fields);
  return json({ success: true, id: record.id });
}

// ---------- Data: Projects ----------
async function handleListProjects(req, env) {
  const url = new URL(req.url);
  const companyId = url.searchParams.get('companyId');
  const formula = companyId ? `FIND("${companyId}", ARRAYJOIN({Company}))` : '';
  const records = await airtableList(env, 'Projects', formula);
  return json({ records: records.map((r) => ({ id: r.id, ...r.fields })) });
}

async function handleCreateProject(req, env) {
  const { name, companyId, sourceIdeaId, sourceSolutionId, budget } = await req.json();
  if (!name || !companyId) return json({ error: 'بيانات ناقصة' }, 400);
  const fields = {
    'Project Name': name,
    'Status': 'Planning',
    'Progress %': 0,
    'Company': [companyId],
  };
  if (budget) fields['Budget'] = Number(budget);
  if (sourceIdeaId) fields['Source Idea'] = [sourceIdeaId];
  if (sourceSolutionId) fields['Source Solution'] = [sourceSolutionId];
  const record = await airtableCreate(env, 'Projects', fields);
  return json({ success: true, id: record.id });
}

async function handleUpdateProject(req, env, id) {
  const body = await req.json();
  const fields = {};
  if (body.status) fields['Status'] = body.status;
  if (body.progress !== undefined) fields['Progress %'] = Number(body.progress);
  await airtableUpdate(env, 'Projects', id, fields);
  return json({ success: true });
}

// ---------- Data: Company ----------
async function handleGetCompany(env, id) {
  const record = await airtableGet(env, 'Companies', id);
  if (!record) return json({ error: 'الشركة غير موجودة' }, 404);
  return json({ id: record.id, ...record.fields });
}

async function handleUpdateCompany(req, env, id) {
  const body = await req.json();
  const fieldMap = {
    companyName: 'Company Name',
    sector: 'Sector',
    companySize: 'Company Size',
    introVideoUrl: 'Intro Video URL',
    contactEmail: 'Contact Email',
    contactFacebook: 'Contact Facebook URL',
    contactWhatsapp: 'Contact WhatsApp URL',
    contactInstagram: 'Contact Instagram URL',
    contactX: 'Contact X URL',
    contactThreads: 'Contact Threads URL',
    contactLinkedin: 'Contact LinkedIn URL',
  };
  const fields = {};
  Object.keys(fieldMap).forEach((k) => {
    if (body[k] !== undefined) fields[fieldMap[k]] = body[k];
  });
  await airtableUpdate(env, 'Companies', id, fields);
  return json({ success: true });
}

// ---------- Data: Users (team listing) ----------
async function handleListUsers(req, env) {
  const url = new URL(req.url);
  const companyId = url.searchParams.get('companyId');
  if (!companyId) return json({ records: [] });
  const formula = `FIND("${companyId}", ARRAYJOIN({Company}))`;
  const records = await airtableList(env, USERS_TABLE, formula, { field: 'Full Name', direction: 'asc' });
  return json({
    records: records.map((r) => ({
      id: r.id,
      fullName: r.fields['Full Name'],
      email: r.fields['Email'],
      role: r.fields['Role'],
      emailVerified: r.fields['Email Verified'],
      inviteStatus: r.fields['Invite Status'],
    })),
  });
}

async function handleUpdateUserRole(req, env, id) {
  const { role } = await req.json();
  if (!role) return json({ error: 'بيانات ناقصة' }, 400);
  await airtableUpdate(env, USERS_TABLE, id, { 'Role': role });
  return json({ success: true });
}

async function handleDeleteUser(env, id) {
  await airtableDelete(env, USERS_TABLE, id);
  return json({ success: true });
}

// ---------- Route handlers ----------

async function handleRegister(req, env) {
  const { fullName, email, password, role, companyId, companyName } = await req.json();
  if (!fullName || !email || !password) return json({ error: 'بيانات ناقصة' }, 400);

  const existing = await airtableFind(env, USERS_TABLE, `{Email} = "${email}"`);
  if (existing) return json({ error: 'البريد الإلكتروني مسجل بالفعل' }, 409);

  let linkedCompanyId = companyId || null;
  let finalRole = role || 'Community User';

  if (companyName && !companyId) {
    const company = await airtableCreate(env, 'Companies', {
      'Company Name': companyName,
      'Plan': 'Free',
      'Subscription Status': 'Trial',
    });
    linkedCompanyId = company.id;
    finalRole = 'Company Admin';
  }

  const passwordHash = await sha256(password);
  const verificationToken = randomToken();

  const fields = {
    'Full Name': fullName,
    'Email': email,
    'Password Hash': passwordHash,
    'Role': finalRole,
    'Email Verified': false,
    'Verification Token': verificationToken,
  };
  if (linkedCompanyId) fields['Company'] = [linkedCompanyId];

  await airtableCreate(env, USERS_TABLE, fields);

  const verifyUrl = `${env.SITE_URL}/verify-email.html?token=${verificationToken}`;
  await sendEmail(env, {
    to: email,
    subject: 'أكّد بريدك الإلكتروني — Innovation Grid',
    html: `<p>مرحبًا ${fullName}،</p><p>اضغط على الرابط ده عشان تأكّد بريدك الإلكتروني:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
  });

  return json({ success: true });
}

async function handleVerifyEmail(req, env) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  if (!token) return json({ error: 'رمز غير صالح' }, 400);

  const user = await airtableFind(env, USERS_TABLE, `{Verification Token} = "${token}"`);
  if (!user) return json({ error: 'رابط التأكيد غير صالح أو منتهي' }, 400);

  await airtableUpdate(env, USERS_TABLE, user.id, {
    'Email Verified': true,
    'Verification Token': '',
  });

  return json({ success: true });
}

async function handleLogin(req, env) {
  const { email, password } = await req.json();
  if (!email || !password) return json({ error: 'بيانات ناقصة' }, 400);

  const user = await airtableFind(env, USERS_TABLE, `{Email} = "${email}"`);
  if (!user) return json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' }, 401);

  const passwordHash = await sha256(password);
  if (user.fields['Password Hash'] !== passwordHash) {
    return json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' }, 401);
  }
  if (!user.fields['Email Verified']) {
    return json({ error: 'لازم تأكّدي بريدك الإلكتروني الأول' }, 403);
  }

  return json({
    success: true,
    user: {
      id: user.id,
      fullName: user.fields['Full Name'],
      email: user.fields['Email'],
      role: user.fields['Role'],
      companyId: (user.fields['Company'] && user.fields['Company'][0]) || null,
    },
  });
}

async function handleForgotPassword(req, env) {
  const { email } = await req.json();
  if (!email) return json({ error: 'بيانات ناقصة' }, 400);

  const user = await airtableFind(env, USERS_TABLE, `{Email} = "${email}"`);
  // Always return success even if not found, to avoid leaking which emails are registered
  if (!user) return json({ success: true });

  const resetToken = randomToken();
  const expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  await airtableUpdate(env, USERS_TABLE, user.id, {
    'Reset Token': resetToken,
    'Reset Token Expiry': expiry,
  });

  const resetUrl = `${env.SITE_URL}/reset-password.html?token=${resetToken}`;
  await sendEmail(env, {
    to: email,
    subject: 'استرجاع كلمة المرور — Innovation Grid',
    html: `<p>مرحبًا،</p><p>اضغط على الرابط ده عشان تعملي كلمة مرور جديدة (صالح لمدة 30 دقيقة):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>لو مطلبتيش الاسترجاع ده، تجاهلي الإيميل.</p>`,
  });

  return json({ success: true });
}

async function handleResetPassword(req, env) {
  const { token, newPassword } = await req.json();
  if (!token || !newPassword) return json({ error: 'بيانات ناقصة' }, 400);

  const user = await airtableFind(env, USERS_TABLE, `{Reset Token} = "${token}"`);
  if (!user) return json({ error: 'الرابط غير صالح' }, 400);

  const expiry = user.fields['Reset Token Expiry'];
  if (!expiry || new Date(expiry) < new Date()) {
    return json({ error: 'انتهت صلاحية الرابط، اطلبي رابط جديد' }, 400);
  }

  const passwordHash = await sha256(newPassword);
  await airtableUpdate(env, USERS_TABLE, user.id, {
    'Password Hash': passwordHash,
    'Reset Token': '',
    'Reset Token Expiry': null,
  });

  return json({ success: true });
}

async function handleInviteEmployee(req, env) {
  const { companyId, email, fullName, role, invitedByName } = await req.json();
  if (!companyId || !email || !fullName) return json({ error: 'بيانات ناقصة' }, 400);

  const existing = await airtableFind(env, USERS_TABLE, `{Email} = "${email}"`);
  if (existing) return json({ error: 'البريد الإلكتروني مسجل بالفعل' }, 409);

  const inviteToken = randomToken();
  await airtableCreate(env, USERS_TABLE, {
    'Full Name': fullName,
    'Email': email,
    'Role': role || 'Employee',
    'Company': [companyId],
    'Email Verified': false,
    'Invite Status': 'Invited',
    'Invite Token': inviteToken,
  });

  const acceptUrl = `${env.SITE_URL}/accept-invite.html?token=${inviteToken}`;
  await sendEmail(env, {
    to: email,
    subject: `دعوة للانضمام لمنصة Innovation Grid`,
    html: `<p>مرحبًا ${fullName}،</p><p>${invitedByName || 'مديرك'} دعاك للانضمام لمساحة شركتكم على Innovation Grid.</p><p>اضغط على الرابط ده عشان تعملي كلمة مرور وتفعّلي حسابك:</p><p><a href="${acceptUrl}">${acceptUrl}</a></p>`,
  });

  return json({ success: true });
}

async function handleChangePassword(req, env) {
  const { userId, currentPassword, newPassword } = await req.json();
  if (!userId || !currentPassword || !newPassword) return json({ error: 'بيانات ناقصة' }, 400);

  const user = await airtableGet(env, USERS_TABLE, userId);
  if (!user) return json({ error: 'المستخدم غير موجود' }, 404);

  const currentHash = await sha256(currentPassword);
  if (user.fields['Password Hash'] !== currentHash) {
    return json({ error: 'كلمة المرور الحالية غير صحيحة' }, 401);
  }

  const newHash = await sha256(newPassword);
  await airtableUpdate(env, USERS_TABLE, userId, { 'Password Hash': newHash });
  return json({ success: true });
}

async function handleAcceptInvite(req, env) {
  const { token, password } = await req.json();
  if (!token || !password) return json({ error: 'بيانات ناقصة' }, 400);

  const user = await airtableFind(env, USERS_TABLE, `{Invite Token} = "${token}"`);
  if (!user) return json({ error: 'رابط الدعوة غير صالح' }, 400);

  const passwordHash = await sha256(password);
  await airtableUpdate(env, USERS_TABLE, user.id, {
    'Password Hash': passwordHash,
    'Email Verified': true,
    'Invite Status': 'Accepted',
    'Invite Token': '',
  });

  return json({ success: true });
}

// ---------- Router ----------
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // e.g. ['ideas', 'recXXXX']
    try {
      if (url.pathname === '/register' && request.method === 'POST') return handleRegister(request, env);
      if (url.pathname === '/verify-email' && request.method === 'GET') return handleVerifyEmail(request, env);
      if (url.pathname === '/login' && request.method === 'POST') return handleLogin(request, env);
      if (url.pathname === '/forgot-password' && request.method === 'POST') return handleForgotPassword(request, env);
      if (url.pathname === '/reset-password' && request.method === 'POST') return handleResetPassword(request, env);
      if (url.pathname === '/invite-employee' && request.method === 'POST') return handleInviteEmployee(request, env);
      if (url.pathname === '/accept-invite' && request.method === 'POST') return handleAcceptInvite(request, env);
      if (url.pathname === '/change-password' && request.method === 'POST') return handleChangePassword(request, env);

      if (parts[0] === 'ideas') {
        if (parts.length === 1 && request.method === 'GET') return handleListIdeas(request, env);
        if (parts.length === 1 && request.method === 'POST') return handleCreateIdea(request, env);
        if (parts.length === 2 && request.method === 'PATCH') return handleUpdateIdea(request, env, parts[1]);
      }
      if (parts[0] === 'challenges') {
        if (parts.length === 1 && request.method === 'GET') return handleListChallenges(request, env);
        if (parts.length === 1 && request.method === 'POST') return handleCreateChallenge(request, env);
      }
      if (parts[0] === 'solutions') {
        if (parts.length === 1 && request.method === 'GET') return handleListSolutions(request, env);
        if (parts.length === 1 && request.method === 'POST') return handleCreateSolution(request, env);
      }
      if (parts[0] === 'projects') {
        if (parts.length === 1 && request.method === 'GET') return handleListProjects(request, env);
        if (parts.length === 1 && request.method === 'POST') return handleCreateProject(request, env);
        if (parts.length === 2 && request.method === 'PATCH') return handleUpdateProject(request, env, parts[1]);
      }
      if (parts[0] === 'company' && parts.length === 2) {
        if (request.method === 'GET') return handleGetCompany(env, parts[1]);
        if (request.method === 'PATCH') return handleUpdateCompany(request, env, parts[1]);
      }
      if (parts[0] === 'users') {
        if (parts.length === 1 && request.method === 'GET') return handleListUsers(request, env);
        if (parts.length === 2 && request.method === 'PATCH') return handleUpdateUserRole(request, env, parts[1]);
        if (parts.length === 2 && request.method === 'DELETE') return handleDeleteUser(env, parts[1]);
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: 'خطأ في الخادم', detail: String(err) }, 500);
    }
  },
};
