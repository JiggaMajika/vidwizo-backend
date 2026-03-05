const API_BASE = import.meta.env.VITE_API_URL || '';

// Auth token management
let authToken: string | null = localStorage.getItem('vidwizo_token');

function setToken(token: string | null) {
  authToken = token;
  if (token) localStorage.setItem('vidwizo_token', token);
  else localStorage.removeItem('vidwizo_token');
}

function authHeaders(): Record<string, string> {
  return authToken ? { 'Authorization': `Bearer ${authToken}` } : {};
}

// ── Auth ──
export async function register(email: string, password: string, name: string) {
  const res = await fetch(`${API_BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ email, password, name })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Registration failed');
  setToken(data.token);
  return data;
}

export async function login(email: string, password: string) {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Login failed');
  setToken(data.token);
  return data;
}

export async function googleAuth(idToken: string) {
  const res = await fetch(`${API_BASE}/api/auth/google`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: idToken })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Google auth failed');
  setToken(data.token);
  return data;
}

export async function getMe() {
  const res = await fetch(`${API_BASE}/api/auth/me`, { headers: authHeaders() });
  if (!res.ok) { setToken(null); throw new Error('Not authenticated'); }
  return res.json();
}

export function logout() { setToken(null); }
export function isLoggedIn() { return !!authToken; }

// ── BYOK Keys ──
export async function listKeys() {
  const res = await fetch(`${API_BASE}/api/keys`, { headers: authHeaders() });
  if (!res.ok) throw new Error('Failed to fetch keys');
  return res.json();
}

export async function addKey(provider: string, apiKey: string, label: string) {
  const res = await fetch(`${API_BASE}/api/keys`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ provider, apiKey, label })
  });
  if (!res.ok) throw new Error('Failed to add key');
  return res.json();
}

export async function deleteKey(keyId: string) {
  const res = await fetch(`${API_BASE}/api/keys/${keyId}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) throw new Error('Failed to delete key');
  return res.json();
}

export async function testKey(provider: string, apiKey: string) {
  const res = await fetch(`${API_BASE}/api/keys/test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ provider, apiKey })
  });
  return res.json();
}

// ── Models ──
export async function getModels() {
  const res = await fetch(`${API_BASE}/api/models`, { headers: authHeaders() });
  return res.json();
}

// ── Plans & Payments ──
export async function getPlans() {
  const res = await fetch(`${API_BASE}/api/plans`);
  return res.json();
}

export async function subscribe(plan: string, gateway: string) {
  const res = await fetch(`${API_BASE}/api/subscribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ plan, gateway })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || 'Subscription failed');
  return data;
}

export async function getSubscription() {
  const res = await fetch(`${API_BASE}/api/subscription`, { headers: authHeaders() });
  return res.json();
}

// ── Video APIs (existing, now with auth) ──
export async function uploadVideo(file: File) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: form, headers: authHeaders() });
  if (!res.ok) throw new Error('Upload failed');
  return res.json();
}

export async function trimVideo(fileId: string, ext: string, startTime: string, endTime: string) {
  const form = new FormData();
  form.append('fileId', fileId);
  form.append('ext', ext);
  form.append('startTime', startTime);
  form.append('endTime', endTime);
  const res = await fetch(`${API_BASE}/api/trim`, { method: 'POST', body: form, headers: authHeaders() });
  if (!res.ok) throw new Error('Trim failed');
  return res.json();
}

export async function cutSnippets(fileId: string, ext: string, snippets: { start: string; end: string }[]) {
  const form = new FormData();
  form.append('fileId', fileId);
  form.append('ext', ext);
  form.append('snippets', JSON.stringify(snippets));
  const res = await fetch(`${API_BASE}/api/cut-snippets`, { method: 'POST', body: form, headers: authHeaders() });
  if (!res.ok) throw new Error('Snippet cut failed');
  return res.json();
}

export async function compressVideo(fileId: string, ext: string, options: any) {
  const form = new FormData();
  form.append('fileId', fileId);
  form.append('ext', ext);
  Object.entries(options).forEach(([k, v]) => form.append(k, String(v)));
  const res = await fetch(`${API_BASE}/api/compress`, { method: 'POST', body: form, headers: authHeaders() });
  if (!res.ok) throw new Error('Compression failed');
  return res.json();
}

export async function generateCaptions(fileId: string, ext: string, model?: string) {
  const form = new FormData();
  form.append('fileId', fileId);
  form.append('ext', ext);
  if (model) form.append('model', model);
  const res = await fetch(`${API_BASE}/api/captions`, { method: 'POST', body: form, headers: authHeaders() });
  if (!res.ok) throw new Error('Caption generation failed');
  return res.json();
}

export async function translateCaptions(segments: any[], targetLang: string, model?: string) {
  const form = new FormData();
  form.append('segments', JSON.stringify(segments));
  form.append('targetLang', targetLang);
  if (model) form.append('model', model);
  const res = await fetch(`${API_BASE}/api/translate`, { method: 'POST', body: form, headers: authHeaders() });
  if (!res.ok) throw new Error('Translation failed');
  return res.json();
}

export function getDownloadUrl(outputId: string) {
  return `${API_BASE}/api/download/${outputId}`;
}

export async function exportSrt(segments: any[], language: string) {
  const form = new FormData();
  form.append('segments', JSON.stringify(segments));
  form.append('language', language);
  const res = await fetch(`${API_BASE}/api/export-srt`, { method: 'POST', body: form, headers: authHeaders() });
  if (!res.ok) throw new Error('SRT export failed');
  return res.blob();
}

// ── YouTuber features ──
export async function removeSilence(fileId: string, ext: string, threshold: string, minDuration: number) {
  const form = new FormData();
  form.append('fileId', fileId);
  form.append('ext', ext);
  form.append('silenceThresh', threshold);
  form.append('minSilenceDuration', String(minDuration));
  const res = await fetch(`${API_BASE}/api/remove-silence`, { method: 'POST', body: form, headers: authHeaders() });
  if (!res.ok) throw new Error('Silence removal failed');
  return res.json();
}

export async function burnSubtitles(fileId: string, ext: string, options: any) {
  const form = new FormData();
  form.append('fileId', fileId);
  form.append('ext', ext);
  Object.entries(options).forEach(([k, v]) => {
    if (v !== undefined && v !== null) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  });
  const res = await fetch(`${API_BASE}/api/burn-subtitles`, { method: 'POST', body: form, headers: authHeaders() });
  if (!res.ok) throw new Error('Subtitle burn failed');
  return res.json();
}

export async function generateHighlights(fileId: string, ext: string, targetDuration: number, sensitivity: number) {
  const form = new FormData();
  form.append('fileId', fileId);
  form.append('ext', ext);
  form.append('targetDuration', String(targetDuration));
  form.append('sensitivity', String(sensitivity));
  const res = await fetch(`${API_BASE}/api/highlights`, { method: 'POST', body: form, headers: authHeaders() });
  if (!res.ok) throw new Error('Highlight generation failed');
  return res.json();
}
