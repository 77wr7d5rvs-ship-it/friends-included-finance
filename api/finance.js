import { google } from 'googleapis';

const salesPeople = ['Richard Darling', 'Anastasia Ferrari', 'Jean-Claude Bērziņš'];
const roles = {
  'Svetlana de Monte Carlo': 'manager',
  'Richard Darling': 'sales',
  'Anastasia Ferrari': 'sales',
  'Jean-Claude Bērziņš': 'sales',
  'Kevin von Whatever': 'expense'
};

const money = n => Math.round(Number(n) * 100) / 100;
const json = (res, status, data) => {
  res.status(status).setHeader('content-type', 'application/json').setHeader('access-control-allow-origin', '*').send(JSON.stringify(data));
};
const readBody = req => typeof req.body === 'object' && req.body !== null ? req.body : new Promise((resolve, reject) => {
  let text = '';
  req.on('data', chunk => { text += chunk; });
  req.on('end', () => { try { resolve(text ? JSON.parse(text) : {}); } catch { reject(new Error('Invalid JSON request.')); } });
});
const auth = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' });
async function db(path, options = {}) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase is not configured.');
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { ...options, headers: { ...auth(), ...(options.headers || {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(text || 'Database request failed.');
  return text ? JSON.parse(text) : null;
}
async function employee(name) {
  const rows = await db(`employees?name=eq.${encodeURIComponent(name)}&select=id,name,role,telegram_user_id,telegram_chat_id&limit=1`);
  if (!rows?.[0]) throw new Error('Employee record was not found.');
  return rows[0];
}
function validate(input, actor) {
  const sale = input.kind === 'sale';
  if (!roles[actor]) throw new Error('Choose a recognised employee.');
  if (!input.reference?.trim() || !input.description?.trim() || money(input.amount) <= 0) throw new Error('Reference, description and a positive amount are required.');
  if (sale) {
    if (roles[actor] !== 'sales') throw new Error('Only Richard, Anastasia and Jean-Claude may submit sales.');
    const split = (input.proposed_split || []).map(Number);
    if (!input.customer?.trim() || !['A', 'B'].includes(input.project) || split.length !== 3 || split.some(n => !Number.isInteger(n) || n < 0) || split.reduce((a, n) => a + n, 0) !== 100) throw new Error('Sales need customer, project and three whole-number commission shares totaling 100%.');
  } else {
    if (roles[actor] !== 'expense') throw new Error('Only Kevin may submit expenses.');
    if (!['Materials', 'Travel', 'Other'].includes(input.category) || !['A', 'B', 'Overhead'].includes(input.proposed_allocation)) throw new Error('Select a valid expense category and allocation.');
  }
}
function commission(amount, split) {
  const pool = Math.round(money(amount) * 10); // cents, 10% pool
  const result = []; let used = 0;
  split.forEach((share, index) => { const cents = index === 2 ? pool - used : Math.floor(pool * Number(share) / 100); used += cents; result.push(cents / 100); });
  return result; // remainder priority: Richard, then Anastasia, then Jean-Claude through truncation order
}
async function logAttempt(transactionId, channel, status, detail = '') {
  try { await db('delivery_attempts', { method: 'POST', body: JSON.stringify({ transaction_id: transactionId, channel, status, detail }) }); } catch { /* audit failure never blocks accounting */ }
}
async function telegram(chatId, text, transactionId) {
  if (!chatId || !process.env.TELEGRAM_BOT_TOKEN) return logAttempt(transactionId, 'telegram', 'pending', 'No linked chat or bot token.');
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }) });
  await logAttempt(transactionId, 'telegram', r.ok ? 'sent' : 'retry', r.ok ? '' : await r.text());
}
async function syncSheet(t) {
  if (!process.env.GOOGLE_SHEETS_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return logAttempt(t.id, 'sheets', 'pending', 'Sheets credentials are not configured.');
  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const client = new google.auth.JWT(credentials.client_email, null, credentials.private_key, ['https://www.googleapis.com/auth/spreadsheets']);
    const sheets = google.sheets({ version: 'v4', auth: client });
    const row = t.kind === 'sale'
      ? [t.reference, t.submitted_at, t.submitter_name, t.customer, t.project, t.description, t.amount, (t.proposed_split || []).join(' / '), (t.final_split || []).join(' / '), (t.final_split ? commission(t.amount, t.final_split) : []).join(' / '), t.status]
      : [t.reference, t.submitted_at, t.submitter_name, t.description, t.category, t.amount, t.proposed_allocation, t.final_allocation || '', t.status];
    const tab = t.kind === 'sale' ? 'Sales' : 'Expenses';
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.GOOGLE_SHEETS_ID, range: `${tab}!A:A` });
    const rowIndex = (existing.data.values || []).findIndex(value => value?.[0] === t.reference);
    if (rowIndex >= 0) await sheets.spreadsheets.values.update({ spreadsheetId: process.env.GOOGLE_SHEETS_ID, range: `${tab}!A${rowIndex + 1}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [row] } });
    else await sheets.spreadsheets.values.append({ spreadsheetId: process.env.GOOGLE_SHEETS_ID, range: `${tab}!A:${t.kind === 'sale' ? 'K' : 'I'}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [row] } });
    await db(`transactions?id=eq.${t.id}`, { method: 'PATCH', body: JSON.stringify({ sheet_status: 'synced' }) });
    await logAttempt(t.id, 'sheets', 'synced');
  } catch (error) { await db(`transactions?id=eq.${t.id}`, { method: 'PATCH', body: JSON.stringify({ sheet_status: 'retry' }) }); await logAttempt(t.id, 'sheets', 'retry', error.message); }
}
async function hydratedTransactions() {
  const rows = await db('transactions?select=*,employees(name,role,telegram_chat_id)&order=submitted_at.asc');
  return rows.map(t => ({ ...t, submitter_name: t.employees?.name || 'Unknown', submitter_role: t.employees?.role, submitter_chat_id: t.employees?.telegram_chat_id }));
}
function totals(records) {
  const projects = { A: { income: 0, commission: 0, expenses: 0 }, B: { income: 0, commission: 0, expenses: 0 } };
  const earned = [0, 0, 0]; let overhead = 0, awaiting = 0;
  for (const t of records) {
    if (t.kind === 'sale' && t.status === 'approved') { const c = commission(t.amount, t.final_split); projects[t.project].income += Number(t.amount); projects[t.project].commission += money(t.amount * .1); c.forEach((n, i) => earned[i] += n); }
    if (t.kind === 'expense') { if (['A', 'B'].includes(t.final_allocation)) projects[t.final_allocation].expenses += Number(t.amount); else if (t.final_allocation === 'Overhead') overhead += Number(t.amount); else awaiting += Number(t.amount); }
  }
  Object.values(projects).forEach(p => Object.keys(p).forEach(k => { p[k] = money(p[k]); }));
  const income = money(projects.A.income + projects.B.income), commissions = money(earned.reduce((a, b) => a + b, 0));
  return { projects, income, commission: commissions, overhead: money(overhead), awaiting: money(awaiting), companyResult: money(income - commissions - overhead - projects.A.expenses - projects.B.expenses - awaiting), earned: salesPeople.map((name, i) => ({ name, amount: money(earned[i]) })) };
}
async function createTransaction(input, actor, source = 'website', chatId = null) {
  validate(input, actor); const person = await employee(actor); const reference = input.reference.trim().toUpperCase();
  const sale = input.kind === 'sale', overhead = input.proposed_allocation === 'Overhead';
  const row = { reference, kind: input.kind, submitter_id: person.id, customer: sale ? input.customer.trim() : null, project: sale ? input.project : null, description: input.description.trim(), amount: money(input.amount), category: sale ? null : input.category, proposed_allocation: sale ? null : input.proposed_allocation, final_allocation: overhead ? 'Overhead' : null, proposed_split: sale ? input.proposed_split.map(Number) : null, status: sale ? 'pending' : overhead ? 'allocated' : 'awaiting_allocation', source, origin_chat_id: chatId };
  try { const [created] = await db('transactions', { method: 'POST', body: JSON.stringify(row) }); const t = { ...created, submitter_name: actor, submitter_chat_id: chatId }; syncSheet(t); telegram(chatId, `${reference} recorded. Status: ${t.status}.`, t.id); return t; } catch (error) { if (error.message.includes('duplicate key')) throw new Error('Duplicate reference rejected.'); throw error; }
}
async function decide(id, input) {
  if (input.actor !== 'Svetlana de Monte Carlo') throw new Error('Only Svetlana can approve or correct a record.');
  const records = await hydratedTransactions(); const t = records.find(x => x.id === id);
  if (!t) throw new Error('Record not found.'); if (!['pending', 'awaiting_allocation'].includes(t.status)) throw new Error('This record has already been decided; no duplicate decision was made.');
  const patch = { decided_at: new Date().toISOString() };
  if (t.kind === 'sale') { const split = (input.split || t.proposed_split).map(Number); if (split.length !== 3 || split.some(n => !Number.isInteger(n) || n < 0) || split.reduce((a, n) => a + n, 0) !== 100) throw new Error('Final commission shares must total 100%.'); patch.final_split = split; patch.status = 'approved'; }
  else { const allocation = input.allocation || t.proposed_allocation; if (!['A', 'B', 'Overhead'].includes(allocation)) throw new Error('Choose project A, B, or overhead.'); patch.final_allocation = allocation; patch.status = 'allocated'; }
  const [updated] = await db(`transactions?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) }); const full = { ...updated, submitter_name: t.submitter_name, submitter_chat_id: t.submitter_chat_id };
  syncSheet(full); telegram(t.submitter_chat_id, `${t.reference} was ${full.status}${full.kind === 'sale' ? ` with split ${full.final_split.join('/')}` : ` to ${full.final_allocation}`}.`, full.id); return full;
}
async function telegramWebhook(update) {
  const message = update.message; if (!message?.text) return;
  const id = message.from.id, chatId = message.chat.id; const staff = (await db(`employees?telegram_user_id=eq.${id}&select=name,role&limit=1`))[0];
  if (!staff) { await telegram(chatId, 'Your Telegram account is not linked. Ask Svetlana to link it in the manager area.', '00000000-0000-0000-0000-000000000000'); return; }
  const text = message.text.trim();
  if (text === '/start' || text === '/help') { await telegram(chatId, 'Friends Included Finance\nSales: /sale REF | Customer | Description | A/B | Amount | Richard/Anastasia/Jean-Claude split\nExpense: /expense REF | Description | Materials/Travel/Other | Amount | A/B/Overhead', '00000000-0000-0000-0000-000000000000'); return; }
  const [command, ...parts] = text.split('|').map(x => x.trim());
  try {
    if (command.toLowerCase().startsWith('/sale')) { const ref = command.split(/\s+/)[1]; await createTransaction({ kind: 'sale', reference: ref, customer: parts[0], description: parts[1], project: parts[2], amount: parts[3], proposed_split: (parts[4] || '').split('/').map(Number) }, staff.name, 'telegram', chatId); }
    else if (command.toLowerCase().startsWith('/expense')) { const ref = command.split(/\s+/)[1]; await createTransaction({ kind: 'expense', reference: ref, description: parts[0], category: parts[1], amount: parts[2], proposed_allocation: parts[3] }, staff.name, 'telegram', chatId); }
    else await telegram(chatId, 'Use /help for the required command formats.', '00000000-0000-0000-0000-000000000000');
  } catch (error) { await telegram(chatId, `Not recorded: ${error.message}`, '00000000-0000-0000-0000-000000000000'); }
}

export default async function handler(req, res) {
  try {
    const path = (req.url || '').split('?')[0];
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (path === '/api/health') return json(res, 200, { ok: true, integrations: { supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY), telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN), sheets: Boolean(process.env.GOOGLE_SHEETS_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON) } });
    if (path === '/api/state' && req.method === 'GET') { const records = await hydratedTransactions(); return json(res, 200, { records, totals: totals(records) }); }
    if (path === '/api/sync' && req.method === 'POST') { const records = await hydratedTransactions(); await Promise.all(records.map(syncSheet)); return json(res, 200, { ok: true, count: records.length }); }
    if (path === '/api/transactions' && req.method === 'POST') { const body = await readBody(req); const transaction = await createTransaction(body, body.actor); return json(res, 201, { transaction }); }
    const decision = path.match(/^\/api\/transactions\/([^/]+)\/decide$/);
    if (decision && req.method === 'POST') { const transaction = await decide(decision[1], await readBody(req)); return json(res, 200, { transaction }); }
    if (path === '/api/telegram/webhook' && req.method === 'POST') { await telegramWebhook(await readBody(req)); return json(res, 200, { ok: true }); }
    return json(res, 404, { error: 'Not found.' });
  } catch (error) { return json(res, 400, { error: error.message || 'Request failed.' }); }
}
