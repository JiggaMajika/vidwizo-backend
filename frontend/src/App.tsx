import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  uploadVideo,
  trimVideo,
  cutSnippets,
  compressVideo,
  generateCaptions,
  translateCaptions,
  getDownloadUrl,
  exportSrt,
  removeSilence,
  burnSubtitles,
  generateHighlights,
  login,
  register,
  googleAuth,
  getMe,
  logout as apiLogout,
  isLoggedIn,
  listKeys,
  addKey,
  deleteKey,
  testKey,
  getModels,
  getPlans,
  subscribe,
  getSubscription,
} from './api';

// ── Types ──────────────────────────────────────────────
interface VideoInfo {
  duration: number;
  size: number;
  format: string;
  bitrate: number;
  width: number;
  height: number;
  codec: string;
  fps: number;
}

interface UploadResult {
  fileId: string;
  filename: string;
  ext: string;
  info: VideoInfo;
}

interface Segment {
  id: number;
  start: number;
  end: number;
  text: string;
}

interface TranslationSet {
  language: string;
  segments: Segment[];
}

interface UserInfo {
  name: string;
  email: string;
  role: string;
  usage?: { used: number; limit: number };
}

interface ApiKey {
  id: string;
  provider: string;
  label: string;
  maskedKey: string;
}

interface ModelOption {
  id: string;
  name: string;
  provider: string;
  type: string;
  requiresByok: boolean;
}

interface Plan {
  id: string;
  name: string;
  price: number;
  features: string[];
  videoLimit: number;
}

interface SubscriptionInfo {
  plan: string;
  status: string;
  used: number;
  limit: number;
}

type Tab = 'trim' | 'snippets' | 'compress' | 'captions' | 'translate' | 'silence' | 'subtitles' | 'highlights';
type Page = 'editor' | 'login' | 'register' | 'settings' | 'pricing';
type SettingsTab = 'profile' | 'keys' | 'subscription';

// ── Helpers ────────────────────────────────────────────
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// ── Spinner ────────────────────────────────────────────
function Spinner() {
  return (
    <svg className="animate-spin h-5 w-5 text-white inline-block mr-2" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ── Toast ──────────────────────────────────────────────
function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  return (
    <div
      className={`fixed top-4 right-4 z-50 px-5 py-3 rounded-lg shadow-lg text-sm font-medium transition-all duration-300 ${
        type === 'success' ? 'bg-green-600' : 'bg-red-600'
      } text-white flex items-center gap-3`}
    >
      <span>{type === 'success' ? '✅' : '❌'} {message}</span>
      <button onClick={onClose} className="ml-2 hover:opacity-70">✕</button>
    </div>
  );
}

// ── Provider Info ──────────────────────────────────────
const PROVIDER_INFO: Record<string, { icon: string; desc: string }> = {
  openai: { icon: '🤖', desc: 'Powers Whisper captions & GPT translations' },
  gemini: { icon: '💎', desc: 'Google Gemini Pro — affordable & powerful AI' },
  deepgram: { icon: '🎙️', desc: 'Fast, accurate speech-to-text' },
  deepl: { icon: '🌐', desc: 'Premium translation quality' },
  google_translate: { icon: '🔤', desc: 'Wide language support' },
};

// ── Plan Data (fallback) ──────────────────────────────
const FALLBACK_PLANS: Plan[] = [
  { id: 'free', name: 'Free', price: 0, videoLimit: 5, features: ['5 videos/month', 'Basic trim & compress', 'Local Whisper captions', 'Watermarked output'] },
  { id: 'starter', name: 'Starter', price: 99, videoLimit: 30, features: ['30 videos/month', 'All editing tools', 'AI captions (Whisper)', '4 SA language translations', 'No watermark'] },
  { id: 'pro', name: 'Pro', price: 299, videoLimit: 100, features: ['100 videos/month', 'All Starter features', 'BYOK support', 'Highlight generation', 'Burn subtitles', 'Priority processing'] },
  { id: 'business', name: 'Business', price: 599, videoLimit: 500, features: ['500 videos/month', 'All Pro features', 'Team collaboration', 'API access', 'Custom branding', 'Dedicated support'] },
];

// ── Main App ───────────────────────────────────────────
export default function App() {
  // Page state
  const [page, setPage] = useState<Page>('editor');

  // Auth state
  const [user, setUser] = useState<UserInfo | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [showUserMenu, setShowUserMenu] = useState(false);

  // Upload state
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Tab state
  // Snippet cutter state
  interface SnippetRange { id: number; start: string; end: string; }
  const [snippetRanges, setSnippetRanges] = useState<SnippetRange[]>([{ id: 1, start: '00:00:00', end: '00:00:10' }]);
  const [snippetNextId, setSnippetNextId] = useState(2);
  const [snippetResult, setSnippetResult] = useState<any>(null);
  const [snippetLoading, setSnippetLoading] = useState(false);

  const addSnippetRange = () => {
    setSnippetRanges(prev => [...prev, { id: snippetNextId, start: '00:00:00', end: '00:00:10' }]);
    setSnippetNextId(prev => prev + 1);
  };
  const removeSnippetRange = (id: number) => {
    setSnippetRanges(prev => prev.filter(s => s.id !== id));
  };
  const updateSnippetRange = (id: number, field: 'start' | 'end', value: string) => {
    setSnippetRanges(prev => prev.map(s => s.id === id ? { ...s, [field]: value } : s));
  };
  const handleCutSnippets = async () => {
    if (!uploadResult || snippetRanges.length === 0) return;
    setSnippetLoading(true);
    setSnippetResult(null);
    try {
      const result = await cutSnippets(
        uploadResult.fileId,
        uploadResult.ext,
        snippetRanges.map(s => ({ start: s.start, end: s.end }))
      );
      setSnippetResult(result);
    } catch (e: any) {
      alert(e.message || 'Snippet cut failed');
    } finally {
      setSnippetLoading(false);
    }
  };

  const [activeTab, setActiveTab] = useState<Tab>('trim');

  // Trim state
  const [trimStart, setTrimStart] = useState('00:00:00.000');
  const [trimEnd, setTrimEnd] = useState('00:00:10.000');
  const [trimResult, setTrimResult] = useState<{ outputId: string; size: number; filename: string } | null>(null);
  const [trimming, setTrimming] = useState(false);

  // Compress state
  const [codec, setCodec] = useState('libx264');
  const [crf, setCrf] = useState(23);
  const [resolution, setResolution] = useState('original');
  const [audioBitrate, setAudioBitrate] = useState('128k');
  const [preset, setPreset] = useState('medium');
  const [compressResult, setCompressResult] = useState<{ outputId: string; originalSize: number; newSize: number; ratio: number; filename: string } | null>(null);
  const [compressing, setCompressing] = useState(false);

  // Captions state
  const [openaiKey, setOpenaiKey] = useState('');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [captioning, setCaptioning] = useState(false);
  const [captionModel, setCaptionModel] = useState('');

  // Translate state
  const [translations, setTranslations] = useState<TranslationSet[]>([]);
  const [translating, setTranslating] = useState(false);
  const [activeTransLang, setActiveTransLang] = useState('');
  const [translateModel, setTranslateModel] = useState('');

  // Silence removal state
  const [silenceThreshold, setSilenceThreshold] = useState('-30dB');
  const [minSilenceDuration, setMinSilenceDuration] = useState(0.5);
  const [silenceResult, setSilenceResult] = useState<{ outputId: string; filename: string; removedCount: number; savedDuration: number } | null>(null);
  const [removingSilence, setRemovingSilence] = useState(false);

  // Burn subtitles state
  const [burnFontSize, setBurnFontSize] = useState(24);
  const [burnFontColor, setBurnFontColor] = useState('#FFFFFF');
  const [burnBgColor, setBurnBgColor] = useState('#000000');
  const [burnBgOpacity, setBurnBgOpacity] = useState(0.5);
  const [burnPosition, setBurnPosition] = useState('bottom');
  const [burnModel, setBurnModel] = useState('');
  const [burnResult, setBurnResult] = useState<{ outputId: string; filename: string } | null>(null);
  const [burningSubtitles, setBurningSubtitles] = useState(false);

  // Highlights state
  const [highlightDuration, setHighlightDuration] = useState(60);
  const [highlightSensitivity, setHighlightSensitivity] = useState(0.5);
  const [highlightModel, setHighlightModel] = useState('');
  const [highlightResult, setHighlightResult] = useState<{ outputId: string; filename: string; highlights: any[] } | null>(null);
  const [generatingHighlights, setGeneratingHighlights] = useState(false);

  // Models state
  const [models, setModels] = useState<ModelOption[]>([]);

  // Settings state
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('profile');
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [newKeyProvider, setNewKeyProvider] = useState('openai');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [testingKey, setTestingKey] = useState(false);
  const [testKeyResult, setTestKeyResult] = useState<{ valid: boolean; message: string } | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const [editName, setEditName] = useState('');
  const [subInfo, setSubInfo] = useState<SubscriptionInfo | null>(null);
  const [plans, setPlans] = useState<Plan[]>(FALLBACK_PLANS);
  const [paymentGateway, setPaymentGateway] = useState('paystack');
  const [subscribing, setSubscribing] = useState(false);

  // Login/Register form state
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirm, setRegConfirm] = useState('');
  const [authSubmitting, setAuthSubmitting] = useState(false);

  // Toast
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [loading, setLoading] = useState(false);

  const showToast = (message: string, type: 'success' | 'error') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // ── Auth check on mount ──
  useEffect(() => {
    if (isLoggedIn()) {
      getMe()
        .then((data) => { setUser(data); setEditName(data.name || ''); })
        .catch(() => setUser(null))
        .finally(() => setAuthLoading(false));
    } else {
      setAuthLoading(false);
    }
  }, []);

  // ── Load models ──
  useEffect(() => {
    getModels().then(setModels).catch(() => {});
  }, [user]);

  // ── Google Sign-In setup ──
  useEffect(() => {
    const clientId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '';
    if (!clientId) return;
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => {
      (window as any).google?.accounts?.id?.initialize({
        client_id: clientId,
        callback: handleGoogleCallback,
      });
    };
    document.head.appendChild(script);
    return () => { document.head.removeChild(script); };
  }, []);

  const handleGoogleCallback = async (response: any) => {
    try {
      const data = await googleAuth(response.credential);
      setUser(data.user || data);
      setPage('editor');
      showToast('Signed in with Google!', 'success');
    } catch (e: any) {
      showToast(e.message || 'Google sign-in failed', 'error');
    }
  };

  const triggerGoogleSignIn = () => {
    const clientId = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '';
    if (!clientId) {
      showToast('Google Sign-In not configured', 'error');
      return;
    }
    (window as any).google?.accounts?.id?.prompt();
  };

  // ── Auth handlers ──
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthSubmitting(true);
    try {
      const data = await login(loginEmail, loginPassword);
      setUser(data.user || data);
      setPage('editor');
      showToast('Welcome back!', 'success');
    } catch (e: any) {
      showToast(e.message || 'Login failed', 'error');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (regPassword !== regConfirm) {
      showToast('Passwords do not match', 'error');
      return;
    }
    setAuthSubmitting(true);
    try {
      const data = await register(regEmail, regPassword, regName);
      setUser(data.user || data);
      setPage('editor');
      showToast('Account created!', 'success');
    } catch (e: any) {
      showToast(e.message || 'Registration failed', 'error');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleLogout = () => {
    apiLogout();
    setUser(null);
    setShowUserMenu(false);
    setPage('editor');
    showToast('Logged out', 'success');
  };

  // ── Settings loaders ──
  const loadKeys = async () => {
    try {
      const data = await listKeys();
      setApiKeys(Array.isArray(data) ? data : data.keys || []);
    } catch { }
  };

  const loadSubscription = async () => {
    try {
      const data = await getSubscription();
      setSubInfo(data);
    } catch { }
  };

  const loadPlans = async () => {
    try {
      const data = await getPlans();
      if (Array.isArray(data) && data.length > 0) setPlans(data);
    } catch { }
  };

  useEffect(() => {
    if (page === 'settings' && user) {
      loadKeys();
      loadSubscription();
      loadPlans();
    }
    if (page === 'pricing') {
      loadPlans();
    }
  }, [page, user]);

  // ── Key handlers ──
  const handleTestKey = async () => {
    setTestingKey(true);
    setTestKeyResult(null);
    try {
      const result = await testKey(newKeyProvider, newKeyValue);
      setTestKeyResult(result);
    } catch (e: any) {
      setTestKeyResult({ valid: false, message: e.message });
    } finally {
      setTestingKey(false);
    }
  };

  const handleSaveKey = async () => {
    if (!newKeyValue || !newKeyLabel) {
      showToast('Please fill in key and label', 'error');
      return;
    }
    setSavingKey(true);
    try {
      await addKey(newKeyProvider, newKeyValue, newKeyLabel);
      setNewKeyValue('');
      setNewKeyLabel('');
      setTestKeyResult(null);
      loadKeys();
      showToast('API key saved!', 'success');
    } catch (e: any) {
      showToast(e.message || 'Failed to save key', 'error');
    } finally {
      setSavingKey(false);
    }
  };

  const handleDeleteKey = async (keyId: string) => {
    try {
      await deleteKey(keyId);
      loadKeys();
      showToast('Key deleted', 'success');
    } catch (e: any) {
      showToast(e.message || 'Failed to delete key', 'error');
    }
  };

  // ── Subscribe handler ──
  const handleSubscribe = async (planId: string) => {
    if (!user) { setPage('register'); return; }
    setSubscribing(true);
    try {
      const result = await subscribe(planId, paymentGateway);
      if (result.url) {
        window.open(result.url, '_blank');
      }
      showToast('Redirecting to payment...', 'success');
    } catch (e: any) {
      showToast(e.message || 'Subscription failed', 'error');
    } finally {
      setSubscribing(false);
    }
  };

  // ── Upload handlers ──
  const handleFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('video/')) {
      showToast('Please upload a video file', 'error');
      return;
    }
    setUploading(true);
    try {
      const result = await uploadVideo(file);
      setUpload(result);
      setVideoUrl(URL.createObjectURL(file));
      if (result.info?.duration) {
        setTrimEnd(formatTimestamp(result.info.duration));
      }
      showToast('Video uploaded successfully!', 'success');
    } catch (e: any) {
      showToast(e.message || 'Upload failed', 'error');
    } finally {
      setUploading(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  }, [handleFile]);

  // ── Trim ──
  const handleTrim = async () => {
    if (!upload) return;
    setTrimming(true);
    try {
      const result = await trimVideo(upload.fileId, upload.ext, trimStart, trimEnd);
      setTrimResult(result);
      showToast('Video trimmed!', 'success');
    } catch (e: any) {
      showToast(e.message || 'Trim failed', 'error');
    } finally {
      setTrimming(false);
    }
  };

  // ── Compress ──
  const handleCompress = async () => {
    if (!upload) return;
    setCompressing(true);
    try {
      const result = await compressVideo(upload.fileId, upload.ext, { codec, crf, resolution, audioBitrate, preset });
      setCompressResult(result);
      showToast(`Compressed! Saved ${result.ratio}%`, 'success');
    } catch (e: any) {
      showToast(e.message || 'Compression failed', 'error');
    } finally {
      setCompressing(false);
    }
  };

  const applyPreset = (name: string) => {
    switch (name) {
      case 'lossless': setCrf(0); setPreset('veryslow'); setResolution('original'); setAudioBitrate('320k'); break;
      case 'high': setCrf(18); setPreset('slow'); setResolution('original'); setAudioBitrate('192k'); break;
      case 'balanced': setCrf(23); setPreset('medium'); setResolution('original'); setAudioBitrate('128k'); break;
      case 'low': setCrf(28); setPreset('fast'); setResolution('720p'); setAudioBitrate('96k'); break;
      case 'maximum': setCrf(35); setPreset('ultrafast'); setResolution('480p'); setAudioBitrate('64k'); break;
    }
  };

  // ── Captions ──
  const handleCaptions = async () => {
    if (!upload) return;
    setCaptioning(true);
    try {
      const result = await generateCaptions(upload.fileId, upload.ext, captionModel || undefined);
      setSegments(result.segments);
      showToast(`Generated ${result.segments.length} caption segments!`, 'success');
    } catch (e: any) {
      showToast(e.message || 'Caption generation failed', 'error');
    } finally {
      setCaptioning(false);
    }
  };

  const handleExportSrt = async (segs: Segment[], lang: string) => {
    try {
      const blob = await exportSrt(segs, lang);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `captions_${lang}.srt`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('SRT exported!', 'success');
    } catch (e: any) {
      showToast(e.message || 'Export failed', 'error');
    }
  };

  // ── Translate ──
  const LANGUAGES = [
    { id: 'sesotho', name: 'Sesotho', color: 'from-green-600 to-blue-600' },
    { id: 'zulu', name: 'Zulu', color: 'from-yellow-500 to-green-600' },
    { id: 'tswana', name: 'Tswana', color: 'from-blue-500 to-purple-600' },
    { id: 'xhosa', name: 'Xhosa', color: 'from-orange-500 to-red-600' },
  ];

  const handleTranslate = async (langId: string) => {
    if (segments.length === 0) {
      showToast('Generate captions first', 'error');
      return;
    }
    setTranslating(true);
    try {
      const result = await translateCaptions(segments, langId, translateModel || undefined);
      setTranslations((prev) => {
        const filtered = prev.filter((t) => t.language !== langId);
        return [...filtered, { language: langId, segments: result.segments }];
      });
      setActiveTransLang(langId);
      showToast(`Translated to ${langId}!`, 'success');
    } catch (e: any) {
      showToast(e.message || 'Translation failed', 'error');
    } finally {
      setTranslating(false);
    }
  };

  // ── Silence Removal ──
  const handleRemoveSilence = async () => {
    if (!upload) return;
    setRemovingSilence(true);
    try {
      const result = await removeSilence(upload.fileId, upload.ext, silenceThreshold, minSilenceDuration);
      setSilenceResult(result);
      showToast('Silence removed!', 'success');
    } catch (e: any) {
      showToast(e.message || 'Silence removal failed', 'error');
    } finally {
      setRemovingSilence(false);
    }
  };

  // ── Burn Subtitles ──
  const handleBurnSubtitles = async () => {
    if (!upload) return;
    if (segments.length === 0) {
      showToast('Generate captions first', 'error');
      return;
    }
    setBurningSubtitles(true);
    try {
      const result = await burnSubtitles(upload.fileId, upload.ext, {
        segments: JSON.stringify(segments),
        fontSize: burnFontSize,
        fontColor: burnFontColor,
        bgColor: burnBgColor,
        bgOpacity: burnBgOpacity,
        position: burnPosition,
        model: burnModel || undefined,
      });
      setBurnResult(result);
      showToast('Subtitles burned!', 'success');
    } catch (e: any) {
      showToast(e.message || 'Subtitle burn failed', 'error');
    } finally {
      setBurningSubtitles(false);
    }
  };

  // ── Highlights ──
  const handleHighlights = async () => {
    if (!upload) return;
    setGeneratingHighlights(true);
    try {
      const result = await generateHighlights(upload.fileId, upload.ext, highlightDuration, highlightSensitivity);
      setHighlightResult(result);
      showToast('Highlights generated!', 'success');
    } catch (e: any) {
      showToast(e.message || 'Highlight generation failed', 'error');
    } finally {
      setGeneratingHighlights(false);
    }
  };

  // ── Model Selector Component ──
  const ModelSelector = ({ value, onChange, type }: { value: string; onChange: (v: string) => void; type: string }) => {
    const filtered = models.filter((m) => m.type === type);
    if (filtered.length === 0) return null;
    const userProviders = apiKeys.map((k) => k.provider);
    return (
      <div className="mb-4">
        <label className="text-xs text-wizo-muted mb-1 block">AI Model</label>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="bg-wizo-bg border border-white/10 rounded-lg px-4 py-2 text-white text-sm focus:border-wizo-accent focus:outline-none w-full max-w-xs"
        >
          <option value="">Default</option>
          {filtered.map((m) => {
            const needsKey = m.requiresByok && !userProviders.includes(m.provider);
            return (
              <option key={m.id} value={m.id} disabled={needsKey}>
                {m.name} {m.requiresByok ? '(BYOK)' : '(Free)'} {needsKey ? '🔑' : ''}
              </option>
            );
          })}
        </select>
        {value && filtered.find((m) => m.id === value)?.requiresByok && !userProviders.includes(filtered.find((m) => m.id === value)?.provider || '') && (
          <p className="text-xs text-yellow-400 mt-1 cursor-pointer" onClick={() => { setPage('settings'); setSettingsTab('keys'); }}>
            🔑 Add API key in Settings
          </p>
        )}
      </div>
    );
  };

  // ── Tabs config ──
  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'trim', label: 'Trim', icon: '✂️' },
    { id: 'snippets', label: 'Snippets', icon: '🎬' },
    { id: 'compress', label: 'Compress', icon: '📦' },
    { id: 'captions', label: 'Captions', icon: '💬' },
    { id: 'translate', label: 'Translate', icon: '🌍' },
    { id: 'silence', label: 'Silence', icon: '🔇' },
    { id: 'subtitles', label: 'Subtitles', icon: '🔤' },
    { id: 'highlights', label: 'Highlights', icon: '⭐' },
  ];

  // ── Render ───────────────────────────────────────────
  return (
    <div className="min-h-screen bg-wizo-bg">
      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      {/* Header */}
      <header className="border-b border-white/10 bg-wizo-card/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3 cursor-pointer" onClick={() => setPage('editor')}>
              <span className="text-3xl">🎬</span>
              <div>
                <h1 className="text-2xl font-bold">
                  <span className="text-white">Vid</span>
                  <span className="text-wizo-accent">|</span>
                  <span className="text-white">Wizo</span>
                </h1>
                <p className="text-xs text-wizo-muted tracking-wider uppercase">Advanced Video Editor</p>
              </div>
            </div>
            <nav className="hidden sm:flex items-center gap-4 ml-4">
              <button
                onClick={() => setPage('editor')}
                className={`text-sm font-medium transition-colors ${page === 'editor' ? 'text-wizo-accent' : 'text-wizo-muted hover:text-white'}`}
              >
                Editor
              </button>
              <button
                onClick={() => setPage('pricing')}
                className={`text-sm font-medium transition-colors ${page === 'pricing' ? 'text-wizo-accent' : 'text-wizo-muted hover:text-white'}`}
              >
                Pricing
              </button>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            {user && user.usage && (
              <span className="text-xs text-wizo-muted hidden sm:inline bg-wizo-bg/50 px-3 py-1 rounded-full">
                📊 {user.usage.used}/{user.usage.limit} videos used
              </span>
            )}
            {upload && (
              <div className="text-xs text-wizo-muted hidden md:block">
                📁 {upload.filename}
              </div>
            )}
            {user ? (
              <div className="relative">
                <button
                  onClick={() => setShowUserMenu(!showUserMenu)}
                  className="flex items-center gap-2 bg-wizo-bg/50 hover:bg-wizo-bg rounded-lg px-3 py-2 transition-colors"
                >
                  <div className="w-7 h-7 rounded-full bg-wizo-accent/30 flex items-center justify-center text-sm font-bold text-wizo-accent">
                    {user.name?.charAt(0)?.toUpperCase() || '?'}
                  </div>
                  <span className="text-sm text-white hidden sm:inline">{user.name}</span>
                  <span className="text-wizo-muted text-xs">▼</span>
                </button>
                {showUserMenu && (
                  <div className="absolute right-0 top-full mt-2 w-48 bg-wizo-card border border-white/10 rounded-lg shadow-xl overflow-hidden z-50">
                    <button
                      onClick={() => { setPage('settings'); setShowUserMenu(false); }}
                      className="w-full text-left px-4 py-3 text-sm text-white hover:bg-white/5 transition-colors flex items-center gap-2"
                    >
                      ⚙️ Settings
                    </button>
                    <button
                      onClick={handleLogout}
                      className="w-full text-left px-4 py-3 text-sm text-red-400 hover:bg-white/5 transition-colors flex items-center gap-2 border-t border-white/5"
                    >
                      🚪 Logout
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage('login')}
                  className="text-sm text-wizo-muted hover:text-white transition-colors px-3 py-2"
                >
                  Log In
                </button>
                <button
                  onClick={() => setPage('register')}
                  className="text-sm bg-wizo-accent hover:bg-wizo-accent/80 text-white px-4 py-2 rounded-lg transition-colors"
                >
                  Sign Up
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Click outside to close user menu */}
      {showUserMenu && (
        <div className="fixed inset-0 z-30" onClick={() => setShowUserMenu(false)} />
      )}

      {/* ══════════════ LOGIN PAGE ══════════════ */}
      {page === 'login' && (
        <main className="max-w-md mx-auto px-4 py-16">
          <div className="bg-wizo-card rounded-2xl p-8 border border-white/5">
            <h2 className="text-2xl font-bold text-center mb-2">Welcome Back</h2>
            <p className="text-wizo-muted text-center text-sm mb-8">Log in to your Vid|Wizo account</p>
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="text-xs text-wizo-muted mb-1 block">Email</label>
                <input
                  type="email"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  required
                  placeholder="you@example.com"
                  className="w-full bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none transition-colors"
                />
              </div>
              <div>
                <label className="text-xs text-wizo-muted mb-1 block">Password</label>
                <input
                  type="password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                  className="w-full bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none transition-colors"
                />
              </div>
              <button
                type="submit"
                disabled={authSubmitting}
                className="w-full bg-wizo-accent hover:bg-wizo-accent/80 disabled:opacity-50 text-white font-medium py-3 rounded-lg transition-all flex items-center justify-center gap-2"
              >
                {authSubmitting && <Spinner />}
                {authSubmitting ? 'Logging in...' : 'Log In'}
              </button>
            </form>
            <div className="my-6 flex items-center gap-3">
              <div className="flex-1 border-t border-white/10" />
              <span className="text-xs text-wizo-muted">or</span>
              <div className="flex-1 border-t border-white/10" />
            </div>
            <button
              onClick={triggerGoogleSignIn}
              className="w-full bg-white/5 hover:bg-white/10 border border-white/10 text-white font-medium py-3 rounded-lg transition-all flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
              Continue with Google
            </button>
            <p className="text-center text-sm text-wizo-muted mt-6">
              Don't have an account?{' '}
              <button onClick={() => setPage('register')} className="text-wizo-accent hover:underline">
                Sign Up
              </button>
            </p>
          </div>
        </main>
      )}

      {/* ══════════════ REGISTER PAGE ══════════════ */}
      {page === 'register' && (
        <main className="max-w-md mx-auto px-4 py-16">
          <div className="bg-wizo-card rounded-2xl p-8 border border-white/5">
            <h2 className="text-2xl font-bold text-center mb-2">Create Account</h2>
            <p className="text-wizo-muted text-center text-sm mb-8">Get started with Vid|Wizo</p>
            <form onSubmit={handleRegister} className="space-y-4">
              <div>
                <label className="text-xs text-wizo-muted mb-1 block">Name</label>
                <input
                  type="text"
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  required
                  placeholder="Your name"
                  className="w-full bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none transition-colors"
                />
              </div>
              <div>
                <label className="text-xs text-wizo-muted mb-1 block">Email</label>
                <input
                  type="email"
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                  required
                  placeholder="you@example.com"
                  className="w-full bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none transition-colors"
                />
              </div>
              <div>
                <label className="text-xs text-wizo-muted mb-1 block">Password</label>
                <input
                  type="password"
                  value={regPassword}
                  onChange={(e) => setRegPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                  className="w-full bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none transition-colors"
                />
              </div>
              <div>
                <label className="text-xs text-wizo-muted mb-1 block">Confirm Password</label>
                <input
                  type="password"
                  value={regConfirm}
                  onChange={(e) => setRegConfirm(e.target.value)}
                  required
                  placeholder="••••••••"
                  className="w-full bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none transition-colors"
                />
              </div>
              <button
                type="submit"
                disabled={authSubmitting}
                className="w-full bg-wizo-accent hover:bg-wizo-accent/80 disabled:opacity-50 text-white font-medium py-3 rounded-lg transition-all flex items-center justify-center gap-2"
              >
                {authSubmitting && <Spinner />}
                {authSubmitting ? 'Creating account...' : 'Create Account'}
              </button>
            </form>
            <div className="my-6 flex items-center gap-3">
              <div className="flex-1 border-t border-white/10" />
              <span className="text-xs text-wizo-muted">or</span>
              <div className="flex-1 border-t border-white/10" />
            </div>
            <button
              onClick={triggerGoogleSignIn}
              className="w-full bg-white/5 hover:bg-white/10 border border-white/10 text-white font-medium py-3 rounded-lg transition-all flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
              Continue with Google
            </button>
            <p className="text-center text-sm text-wizo-muted mt-6">
              Already have an account?{' '}
              <button onClick={() => setPage('login')} className="text-wizo-accent hover:underline">
                Log In
              </button>
            </p>
          </div>
        </main>
      )}

      {/* ══════════════ SETTINGS PAGE ══════════════ */}
      {page === 'settings' && (
        <main className="max-w-4xl mx-auto px-4 py-8">
          {!user ? (
            <div className="text-center py-16">
              <p className="text-4xl mb-4">🔒</p>
              <p className="text-wizo-muted mb-4">Please log in to access settings</p>
              <button onClick={() => setPage('login')} className="bg-wizo-accent hover:bg-wizo-accent/80 text-white px-6 py-2 rounded-lg">
                Log In
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              <h2 className="text-2xl font-bold">⚙️ Settings</h2>

              {/* Settings tabs */}
              <div className="flex gap-1 bg-wizo-card rounded-xl p-1.5">
                {([
                  { id: 'profile' as SettingsTab, label: 'Profile', icon: '👤' },
                  { id: 'keys' as SettingsTab, label: 'API Keys', icon: '🔑' },
                  { id: 'subscription' as SettingsTab, label: 'Subscription', icon: '💳' },
                ] as const).map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setSettingsTab(tab.id)}
                    className={`flex-1 py-3 px-4 rounded-lg text-sm font-medium transition-all duration-200 flex items-center justify-center gap-2 ${
                      settingsTab === tab.id
                        ? 'bg-wizo-accent text-white shadow-lg shadow-wizo-accent/30'
                        : 'text-wizo-muted hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <span>{tab.icon}</span>
                    <span className="hidden sm:inline">{tab.label}</span>
                  </button>
                ))}
              </div>

              {/* ── Profile Tab ── */}
              {settingsTab === 'profile' && (
                <div className="bg-wizo-card rounded-xl p-6 space-y-6">
                  <h3 className="text-lg font-semibold">👤 Profile</h3>
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-full bg-wizo-accent/20 flex items-center justify-center text-2xl font-bold text-wizo-accent">
                      {user.name?.charAt(0)?.toUpperCase() || '?'}
                    </div>
                    <div>
                      <p className="text-lg font-medium">{user.name}</p>
                      <p className="text-sm text-wizo-muted">{user.email}</p>
                      <span className={`inline-block mt-1 text-xs px-2 py-0.5 rounded-full ${
                        user.role === 'admin' ? 'bg-red-500/20 text-red-400' : 'bg-wizo-accent/20 text-wizo-accent'
                      }`}>
                        {user.role || 'user'}
                      </span>
                    </div>
                  </div>
                  <div className="border-t border-white/5 pt-4">
                    <label className="text-xs text-wizo-muted mb-1 block">Display Name</label>
                    <div className="flex gap-3">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="flex-1 bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none transition-colors"
                      />
                      <button className="bg-wizo-accent hover:bg-wizo-accent/80 text-white px-6 py-3 rounded-lg transition-colors text-sm font-medium">
                        Save
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* ── API Keys Tab ── */}
              {settingsTab === 'keys' && (
                <div className="space-y-6">
                  {/* Existing keys */}
                  <div className="bg-wizo-card rounded-xl p-6 space-y-4">
                    <h3 className="text-lg font-semibold">🔑 Your API Keys</h3>
                    {apiKeys.length === 0 ? (
                      <p className="text-wizo-muted text-sm py-4 text-center">No API keys added yet. Add one below to use premium AI models.</p>
                    ) : (
                      <div className="space-y-3">
                        {apiKeys.map((key) => (
                          <div key={key.id} className="bg-wizo-bg/50 rounded-lg p-4 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <span className="text-xl">{PROVIDER_INFO[key.provider]?.icon || '🔐'}</span>
                              <div>
                                <p className="font-medium text-sm capitalize">{key.provider.replace('_', ' ')}</p>
                                <p className="text-xs text-wizo-muted">{key.label} • {key.maskedKey}</p>
                              </div>
                            </div>
                            <button
                              onClick={() => handleDeleteKey(key.id)}
                              className="text-red-400 hover:text-red-300 text-sm px-3 py-1 rounded-lg hover:bg-red-400/10 transition-colors"
                            >
                              🗑️ Delete
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Add new key */}
                  <div className="bg-wizo-card rounded-xl p-6 space-y-4">
                    <h3 className="text-lg font-semibold">➕ Add New Key</h3>
                    <div>
                      <label className="text-xs text-wizo-muted mb-1 block">Provider</label>
                      <select
                        value={newKeyProvider}
                        onChange={(e) => setNewKeyProvider(e.target.value)}
                        className="w-full bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none"
                      >
                        <option value="openai">OpenAI</option>
                        <option value="gemini">Gemini Pro</option>
                        <option value="deepgram">Deepgram</option>
                        <option value="deepl">DeepL</option>
                        <option value="google_translate">Google Translate</option>
                      </select>
                      <p className="text-xs text-wizo-muted mt-1">
                        {PROVIDER_INFO[newKeyProvider]?.icon} {PROVIDER_INFO[newKeyProvider]?.desc}
                      </p>
                    </div>
                    <div>
                      <label className="text-xs text-wizo-muted mb-1 block">API Key</label>
                      <input
                        type="password"
                        value={newKeyValue}
                        onChange={(e) => setNewKeyValue(e.target.value)}
                        placeholder="Enter your API key"
                        className="w-full bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none transition-colors"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-wizo-muted mb-1 block">Label</label>
                      <input
                        type="text"
                        value={newKeyLabel}
                        onChange={(e) => setNewKeyLabel(e.target.value)}
                        placeholder="e.g. My OpenAI Key"
                        className="w-full bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none transition-colors"
                      />
                    </div>
                    {testKeyResult && (
                      <div className={`rounded-lg p-3 text-sm ${testKeyResult.valid ? 'bg-green-900/20 border border-green-500/30 text-green-400' : 'bg-red-900/20 border border-red-500/30 text-red-400'}`}>
                        {testKeyResult.valid ? '✅' : '❌'} {testKeyResult.message}
                      </div>
                    )}
                    <div className="flex gap-3">
                      <button
                        onClick={handleTestKey}
                        disabled={testingKey || !newKeyValue}
                        className="bg-white/5 hover:bg-white/10 border border-white/10 disabled:opacity-50 text-white font-medium px-6 py-3 rounded-lg transition-all flex items-center gap-2"
                      >
                        {testingKey && <Spinner />}
                        {testingKey ? 'Testing...' : '🧪 Test Key'}
                      </button>
                      <button
                        onClick={handleSaveKey}
                        disabled={savingKey || !newKeyValue || !newKeyLabel}
                        className="bg-wizo-accent hover:bg-wizo-accent/80 disabled:opacity-50 text-white font-medium px-6 py-3 rounded-lg transition-all flex items-center gap-2"
                      >
                        {savingKey && <Spinner />}
                        {savingKey ? 'Saving...' : '💾 Save Key'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Subscription Tab ── */}
              {settingsTab === 'subscription' && (
                <div className="space-y-6">
                  {/* Current plan */}
                  <div className="bg-wizo-card rounded-xl p-6 space-y-4">
                    <h3 className="text-lg font-semibold">💳 Current Plan</h3>
                    <div className="flex items-center gap-4">
                      <span className="bg-wizo-accent/20 text-wizo-accent px-4 py-2 rounded-full text-sm font-bold capitalize">
                        {subInfo?.plan || 'Free'}
                      </span>
                      <span className="text-sm text-wizo-muted">
                        {subInfo ? `${subInfo.used}/${subInfo.limit} videos this month` : 'No usage data'}
                      </span>
                    </div>
                    {subInfo && (
                      <div className="w-full bg-wizo-bg rounded-full h-2">
                        <div
                          className="bg-wizo-accent h-2 rounded-full transition-all"
                          style={{ width: `${Math.min(100, (subInfo.used / subInfo.limit) * 100)}%` }}
                        />
                      </div>
                    )}
                  </div>

                  {/* Payment gateway selector */}
                  <div className="bg-wizo-card rounded-xl p-6 space-y-4">
                    <h3 className="text-lg font-semibold">🏦 Payment Gateway</h3>
                    <div className="flex gap-3">
                      {['paystack', 'yoco'].map((gw) => (
                        <button
                          key={gw}
                          onClick={() => setPaymentGateway(gw)}
                          className={`flex-1 py-3 px-4 rounded-lg text-sm font-medium transition-all border ${
                            paymentGateway === gw
                              ? 'bg-wizo-accent/20 border-wizo-accent text-wizo-accent'
                              : 'bg-wizo-bg border-white/10 text-wizo-muted hover:border-wizo-accent/50'
                          }`}
                        >
                          {gw === 'paystack' ? '🟢 Paystack' : '🔵 Yoco'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Plan cards */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    {plans.map((plan) => (
                      <div
                        key={plan.id}
                        className={`bg-wizo-card rounded-xl p-6 border transition-all hover:border-wizo-accent/50 ${
                          plan.id === 'pro' ? 'border-wizo-accent ring-1 ring-wizo-accent/30' : 'border-white/5'
                        }`}
                      >
                        {plan.id === 'pro' && (
                          <span className="inline-block bg-wizo-accent text-white text-xs px-2 py-0.5 rounded-full mb-2">⭐ Recommended</span>
                        )}
                        <h4 className="text-lg font-bold">{plan.name}</h4>
                        <div className="mt-2 mb-4">
                          <span className="text-3xl font-bold">R{plan.price}</span>
                          {plan.price > 0 && <span className="text-wizo-muted text-sm">/mo</span>}
                        </div>
                        <ul className="space-y-2 text-sm text-wizo-muted mb-6">
                          {plan.features.map((f, i) => (
                            <li key={i} className="flex items-start gap-2">
                              <span className="text-wizo-accent2 mt-0.5">✓</span>
                              <span>{f}</span>
                            </li>
                          ))}
                        </ul>
                        <button
                          onClick={() => handleSubscribe(plan.id)}
                          disabled={subscribing || subInfo?.plan === plan.id}
                          className={`w-full py-2 rounded-lg text-sm font-medium transition-all ${
                            subInfo?.plan === plan.id
                              ? 'bg-wizo-accent2/20 text-wizo-accent2 cursor-default'
                              : 'bg-wizo-accent hover:bg-wizo-accent/80 text-white'
                          }`}
                        >
                          {subInfo?.plan === plan.id ? '✓ Current Plan' : subscribing ? 'Processing...' : 'Subscribe'}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      )}

      {/* ══════════════ PRICING PAGE ══════════════ */}
      {page === 'pricing' && (
        <main className="max-w-6xl mx-auto px-4 py-16">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-3">Simple, Transparent Pricing</h2>
            <p className="text-wizo-muted text-lg">Choose the plan that works for you. All prices in ZAR.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {plans.map((plan) => (
              <div
                key={plan.id}
                className={`bg-wizo-card rounded-2xl p-8 border transition-all hover:scale-[1.02] hover:shadow-xl ${
                  plan.id === 'pro' ? 'border-wizo-accent ring-2 ring-wizo-accent/20 relative' : 'border-white/5'
                }`}
              >
                {plan.id === 'pro' && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="bg-wizo-accent text-white text-xs font-bold px-4 py-1 rounded-full">⭐ Most Popular</span>
                  </div>
                )}
                <h3 className="text-xl font-bold">{plan.name}</h3>
                <div className="mt-4 mb-6">
                  <span className="text-4xl font-bold">R{plan.price}</span>
                  {plan.price > 0 && <span className="text-wizo-muted">/mo</span>}
                </div>
                <ul className="space-y-3 text-sm text-wizo-muted mb-8">
                  {plan.features.map((f, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="text-wizo-accent2 mt-0.5">✓</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <button
                  onClick={() => {
                    if (!user) { setPage('register'); return; }
                    setPage('settings');
                    setSettingsTab('subscription');
                  }}
                  className={`w-full py-3 rounded-xl font-medium transition-all ${
                    plan.id === 'pro'
                      ? 'bg-wizo-accent hover:bg-wizo-accent/80 text-white'
                      : 'bg-white/5 hover:bg-white/10 border border-white/10 text-white'
                  }`}
                >
                  Get Started
                </button>
              </div>
            ))}
          </div>
        </main>
      )}

      {/* ══════════════ EDITOR PAGE ══════════════ */}
      {page === 'editor' && (
        <main className="max-w-6xl mx-auto px-4 py-8 space-y-8">
          {/* Upload Zone */}
          {!upload ? (
            <div
              className={`border-2 border-dashed rounded-2xl p-16 text-center transition-all duration-300 cursor-pointer ${
                dragOver ? 'border-wizo-accent bg-wizo-accent/10 scale-[1.02]' : 'border-white/20 hover:border-wizo-accent/50 bg-wizo-card/50'
              }`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
              />
              {uploading ? (
                <div className="flex flex-col items-center gap-4">
                  <Spinner />
                  <p className="text-lg text-wizo-muted">Uploading video...</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-4">
                  <div className="text-6xl">🎥</div>
                  <p className="text-xl font-semibold text-white">Drop your video here</p>
                  <p className="text-sm text-wizo-muted">or click to browse • MP4, MOV, AVI, MKV, WebM</p>
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Video Info & Preview */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Video Player */}
                <div className="bg-wizo-card rounded-xl overflow-hidden">
                  {videoUrl && (
                    <video
                      src={videoUrl}
                      controls
                      className="w-full aspect-video bg-black"
                    />
                  )}
                </div>

                {/* Video Info */}
                <div className="bg-wizo-card rounded-xl p-6 space-y-4">
                  <h3 className="text-lg font-semibold flex items-center gap-2">
                    📋 Video Information
                  </h3>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    {[
                      { label: 'Duration', value: formatDuration(upload.info.duration) },
                      { label: 'Resolution', value: `${upload.info.width}×${upload.info.height}` },
                      { label: 'Codec', value: upload.info.codec?.toUpperCase() || 'N/A' },
                      { label: 'Size', value: formatBytes(upload.info.size) },
                      { label: 'FPS', value: upload.info.fps ? `${Math.round(upload.info.fps)} fps` : 'N/A' },
                      { label: 'Bitrate', value: upload.info.bitrate ? formatBytes(upload.info.bitrate) + '/s' : 'N/A' },
                    ].map((item) => (
                      <div key={item.label} className="bg-wizo-bg/50 rounded-lg p-3">
                        <div className="text-wizo-muted text-xs mb-1">{item.label}</div>
                        <div className="font-medium">{item.value}</div>
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={() => { setUpload(null); setVideoUrl(null); setSegments([]); setTranslations([]); setTrimResult(null); setCompressResult(null); setSilenceResult(null); setBurnResult(null); setHighlightResult(null); }}
                    className="text-xs text-wizo-muted hover:text-wizo-accent transition-colors"
                  >
                    ↻ Upload different video
                  </button>
                </div>
              </div>

              {/* Tab Navigation */}
              <div className="flex gap-1 bg-wizo-card rounded-xl p-1.5 overflow-x-auto">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex-1 py-3 px-3 rounded-lg text-sm font-medium transition-all duration-200 flex items-center justify-center gap-1.5 whitespace-nowrap min-w-0 ${
                      activeTab === tab.id
                        ? 'bg-wizo-accent text-white shadow-lg shadow-wizo-accent/30'
                        : 'text-wizo-muted hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <span>{tab.icon}</span>
                    <span className="hidden sm:inline">{tab.label}</span>
                  </button>
                ))}
              </div>

              {/* Tab Content */}
              <div className="bg-wizo-card rounded-xl p-6">
                {/* ── TRIM TAB ── */}
                {activeTab === 'trim' && (
                  <div className="space-y-6">
                    <h3 className="text-lg font-semibold">✂️ Trim Video</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="text-xs text-wizo-muted mb-1 block">Start Time</label>
                        <input
                          type="text"
                          value={trimStart}
                          onChange={(e) => setTrimStart(e.target.value)}
                          placeholder="00:00:00.000"
                          className="w-full bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none transition-colors"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-wizo-muted mb-1 block">End Time</label>
                        <input
                          type="text"
                          value={trimEnd}
                          onChange={(e) => setTrimEnd(e.target.value)}
                          placeholder="00:00:10.000"
                          className="w-full bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none transition-colors"
                        />
                      </div>
                    </div>
                    <button
                      onClick={handleTrim}
                      disabled={trimming}
                      className="bg-wizo-accent hover:bg-wizo-accent/80 disabled:opacity-50 text-white font-medium px-8 py-3 rounded-lg transition-all duration-200 flex items-center gap-2"
                    >
                      {trimming && <Spinner />}
                      {trimming ? 'Trimming...' : '✂️ Trim Video'}
                    </button>
                    {trimResult && (
                      <div className="bg-green-900/20 border border-green-500/30 rounded-lg p-4 space-y-3">
                        <p className="text-green-400 font-medium">✅ Trim complete!</p>
                        <p className="text-sm text-wizo-muted">Size: {formatBytes(trimResult.size)}</p>
                        <video
                          src={getDownloadUrl(trimResult.outputId)}
                          controls
                          className="w-full rounded-lg border border-wizo-border max-h-[400px]"
                        />
                        <a
                          href={getDownloadUrl(trimResult.outputId)}
                          download={trimResult.filename}
                          className="inline-block bg-wizo-accent2 hover:bg-wizo-accent2/80 text-white px-5 py-2 rounded-lg text-sm transition-colors"
                        >
                          ⬇ Download
                        </a>
                      </div>
                    )}
                  </div>
                )}

                {/* ── COMPRESS TAB ── */}
                {activeTab === 'snippets' && (
                  <div className="space-y-4">
                    <h3 className="text-lg font-semibold text-white">🎬 Snippet Cutter</h3>
                    <p className="text-sm text-gray-400">Mark multiple time ranges to extract and merge into one video. Free — powered by ffmpeg.</p>
                    
                    <div className="space-y-3">
                      {snippetRanges.map((s, idx) => (
                        <div key={s.id} className="flex items-center gap-3 bg-gray-700/50 rounded-lg p-3">
                          <span className="text-sm text-purple-400 font-bold w-6">#{idx + 1}</span>
                          <div className="flex-1 flex items-center gap-2">
                            <label className="text-xs text-gray-400">Start</label>
                            <input
                              type="text"
                              value={s.start}
                              onChange={e => updateSnippetRange(s.id, 'start', e.target.value)}
                              placeholder="00:00:00"
                              className="bg-gray-800 text-white rounded px-2 py-1 text-sm w-28 border border-gray-600 focus:border-purple-500 focus:outline-none"
                            />
                            <label className="text-xs text-gray-400">End</label>
                            <input
                              type="text"
                              value={s.end}
                              onChange={e => updateSnippetRange(s.id, 'end', e.target.value)}
                              placeholder="00:00:10"
                              className="bg-gray-800 text-white rounded px-2 py-1 text-sm w-28 border border-gray-600 focus:border-purple-500 focus:outline-none"
                            />
                          </div>
                          {snippetRanges.length > 1 && (
                            <button
                              onClick={() => removeSnippetRange(s.id)}
                              className="text-red-400 hover:text-red-300 text-lg"
                              title="Remove snippet"
                            >✕</button>
                          )}
                        </div>
                      ))}
                    </div>

                    <div className="flex gap-3">
                      <button
                        onClick={addSnippetRange}
                        disabled={snippetRanges.length >= 20}
                        className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg text-sm disabled:opacity-50"
                      >
                        + Add Snippet
                      </button>
                      <button
                        onClick={handleCutSnippets}
                        disabled={snippetLoading || snippetRanges.length === 0}
                        className="px-6 py-2 bg-gradient-to-r from-purple-600 to-pink-600 text-white rounded-lg font-medium disabled:opacity-50 hover:opacity-90"
                      >
                        {snippetLoading ? '⏳ Cutting...' : `🎬 Cut ${snippetRanges.length} Snippet${snippetRanges.length > 1 ? 's' : ''}`}
                      </button>
                    </div>

                    {snippetResult && (
                      <div className="bg-green-900/30 border border-green-700 rounded-lg p-4 space-y-3">
                        <p className="text-green-400 font-medium">✅ {snippetResult.snippetCount} snippet{snippetResult.snippetCount > 1 ? 's' : ''} merged! ({(snippetResult.size / 1024 / 1024).toFixed(1)} MB)</p>
                        <video
                          controls
                          className="w-full rounded-lg border border-gray-700"
                          src={getDownloadUrl(snippetResult.outputId)}
                        />
                        <a
                          href={getDownloadUrl(snippetResult.outputId)}
                          download={snippetResult.filename}
                          className="inline-block px-6 py-2 bg-gradient-to-r from-green-600 to-teal-600 text-white rounded-lg font-medium hover:opacity-90"
                        >
                          ⬇️ Download Merged Video
                        </a>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'compress' && (
                  <div className="space-y-6">
                    <h3 className="text-lg font-semibold">📦 Compress Video</h3>

                    {/* Presets */}
                    <div>
                      <label className="text-xs text-wizo-muted mb-2 block">Quick Presets</label>
                      <div className="flex flex-wrap gap-2">
                        {[
                          { id: 'lossless', label: 'Lossless', desc: 'CRF 0' },
                          { id: 'high', label: 'High Quality', desc: 'CRF 18' },
                          { id: 'balanced', label: 'Balanced', desc: 'CRF 23' },
                          { id: 'low', label: 'Low Size', desc: 'CRF 28' },
                          { id: 'maximum', label: 'Max Compress', desc: 'CRF 35' },
                        ].map((p) => (
                          <button
                            key={p.id}
                            onClick={() => applyPreset(p.id)}
                            className="bg-wizo-bg hover:bg-wizo-accent/20 border border-white/10 hover:border-wizo-accent/50 rounded-lg px-4 py-2 text-sm transition-all"
                          >
                            <div className="font-medium">{p.label}</div>
                            <div className="text-xs text-wizo-muted">{p.desc}</div>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Codec */}
                    <div>
                      <label className="text-xs text-wizo-muted mb-2 block">Codec</label>
                      <div className="flex gap-2">
                        {[
                          { id: 'libx264', label: 'H.264' },
                          { id: 'libx265', label: 'H.265 (HEVC)' },
                        ].map((c) => (
                          <button
                            key={c.id}
                            onClick={() => setCodec(c.id)}
                            className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${
                              codec === c.id ? 'bg-wizo-accent text-white' : 'bg-wizo-bg text-wizo-muted border border-white/10 hover:border-wizo-accent/50'
                            }`}
                          >
                            {c.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* CRF Slider */}
                    <div>
                      <label className="text-xs text-wizo-muted mb-2 block">
                        CRF (Quality): <span className="text-white font-medium">{crf}</span>
                        <span className="ml-2 text-xs">
                          {crf <= 10 ? '(Near lossless)' : crf <= 20 ? '(High quality)' : crf <= 28 ? '(Good balance)' : '(Smaller file)'}
                        </span>
                      </label>
                      <input
                        type="range"
                        min={0}
                        max={51}
                        value={crf}
                        onChange={(e) => setCrf(Number(e.target.value))}
                        className="w-full"
                      />
                      <div className="flex justify-between text-xs text-wizo-muted mt-1">
                        <span>Best Quality (0)</span>
                        <span>Smallest File (51)</span>
                      </div>
                    </div>

                    {/* Resolution */}
                    <div>
                      <label className="text-xs text-wizo-muted mb-2 block">Resolution</label>
                      <select
                        value={resolution}
                        onChange={(e) => setResolution(e.target.value)}
                        className="bg-wizo-bg border border-white/10 rounded-lg px-4 py-2 text-white focus:border-wizo-accent focus:outline-none"
                      >
                        <option value="original">Original</option>
                        <option value="1080p">1080p</option>
                        <option value="720p">720p</option>
                        <option value="480p">480p</option>
                        <option value="360p">360p</option>
                      </select>
                    </div>

                    {/* Audio Bitrate */}
                    <div>
                      <label className="text-xs text-wizo-muted mb-2 block">Audio Bitrate</label>
                      <select
                        value={audioBitrate}
                        onChange={(e) => setAudioBitrate(e.target.value)}
                        className="bg-wizo-bg border border-white/10 rounded-lg px-4 py-2 text-white focus:border-wizo-accent focus:outline-none"
                      >
                        <option value="320k">320k (Best)</option>
                        <option value="192k">192k (High)</option>
                        <option value="128k">128k (Standard)</option>
                        <option value="96k">96k (Low)</option>
                        <option value="64k">64k (Min)</option>
                      </select>
                    </div>

                    <button
                      onClick={handleCompress}
                      disabled={compressing}
                      className="bg-wizo-accent hover:bg-wizo-accent/80 disabled:opacity-50 text-white font-medium px-8 py-3 rounded-lg transition-all duration-200 flex items-center gap-2"
                    >
                      {compressing && <Spinner />}
                      {compressing ? 'Compressing...' : '📦 Compress Video'}
                    </button>

                    {compressResult && (
                      <div className="bg-green-900/20 border border-green-500/30 rounded-lg p-4 space-y-3">
                        <p className="text-green-400 font-medium">✅ Compression complete!</p>
                        <div className="grid grid-cols-3 gap-4 text-sm">
                          <div>
                            <div className="text-wizo-muted text-xs">Original</div>
                            <div className="font-medium">{formatBytes(compressResult.originalSize)}</div>
                          </div>
                          <div>
                            <div className="text-wizo-muted text-xs">Compressed</div>
                            <div className="font-medium">{formatBytes(compressResult.newSize)}</div>
                          </div>
                          <div>
                            <div className="text-wizo-muted text-xs">Saved</div>
                            <div className="font-medium text-green-400">{compressResult.ratio}%</div>
                          </div>
                        </div>
                        <video
                          src={getDownloadUrl(compressResult.outputId)}
                          controls
                          className="w-full rounded-lg border border-wizo-border max-h-[400px]"
                        />
                        <a
                          href={getDownloadUrl(compressResult.outputId)}
                          download={compressResult.filename}
                          className="inline-block bg-wizo-accent2 hover:bg-wizo-accent2/80 text-white px-5 py-2 rounded-lg text-sm transition-colors"
                        >
                          ⬇ Download Compressed
                        </a>
                      </div>
                    )}
                  </div>
                )}

                {/* ── CAPTIONS TAB ── */}
                {activeTab === 'captions' && (
                  <div className="space-y-6">
                    <h3 className="text-lg font-semibold">💬 Generate Captions</h3>

                    <ModelSelector value={captionModel} onChange={setCaptionModel} type="captions" />

                    <div>
                      <label className="text-xs text-wizo-muted mb-1 block">OpenAI API Key (optional, legacy)</label>
                      <input
                        type="password"
                        value={openaiKey}
                        onChange={(e) => setOpenaiKey(e.target.value)}
                        placeholder="sk-... (leave blank for local Whisper)"
                        className="w-full bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none transition-colors"
                      />
                      <p className="text-xs text-wizo-muted mt-1">
                        💡 If no key is provided, the server uses local Whisper model (free but slower)
                      </p>
                    </div>

                    <button
                      onClick={handleCaptions}
                      disabled={captioning}
                      className="bg-wizo-accent hover:bg-wizo-accent/80 disabled:opacity-50 text-white font-medium px-8 py-3 rounded-lg transition-all duration-200 flex items-center gap-2"
                    >
                      {captioning && <Spinner />}
                      {captioning ? 'Generating captions...' : '💬 Generate Captions'}
                    </button>

                    {segments.length > 0 && (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <p className="text-sm text-wizo-muted">{segments.length} segments found</p>
                          <button
                            onClick={() => handleExportSrt(segments, 'en')}
                            className="bg-wizo-accent2 hover:bg-wizo-accent2/80 text-white px-4 py-2 rounded-lg text-sm transition-colors"
                          >
                            📄 Export SRT
                          </button>
                        </div>
                        <div className="max-h-80 overflow-y-auto space-y-2 pr-2">
                          {segments.map((seg) => (
                            <div key={seg.id} className="bg-wizo-bg/50 rounded-lg p-3 flex gap-4 items-start">
                              <div className="text-xs text-wizo-accent font-mono whitespace-nowrap pt-0.5">
                                {formatTimestamp(seg.start)} → {formatTimestamp(seg.end)}
                              </div>
                              <div className="text-sm flex-1">{seg.text}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ── TRANSLATE TAB ── */}
                {activeTab === 'translate' && (
                  <div className="space-y-6">
                    <h3 className="text-lg font-semibold">🌍 Translate Captions</h3>

                    <ModelSelector value={translateModel} onChange={setTranslateModel} type="translate" />

                    {segments.length === 0 ? (
                      <div className="text-center py-8 text-wizo-muted">
                        <p className="text-4xl mb-3">💬</p>
                        <p>Generate captions first in the Captions tab</p>
                      </div>
                    ) : (
                      <>
                        {/* Language selector grid */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          {LANGUAGES.map((lang) => (
                            <button
                              key={lang.id}
                              onClick={() => handleTranslate(lang.id)}
                              disabled={translating}
                              className={`bg-gradient-to-br ${lang.color} hover:opacity-80 disabled:opacity-50 text-white font-medium py-4 px-4 rounded-xl transition-all duration-200 shadow-lg hover:shadow-xl hover:scale-[1.02]`}
                            >
                              <div className="text-lg font-bold">{lang.name}</div>
                              <div className="text-xs opacity-80 mt-1">
                                {translations.find((t) => t.language === lang.id) ? '✓ Translated' : 'Click to translate'}
                              </div>
                            </button>
                          ))}
                        </div>

                        {translating && (
                          <div className="text-center py-4">
                            <Spinner /> <span className="text-wizo-muted">Translating...</span>
                          </div>
                        )}

                        {/* Translation results */}
                        {translations.length > 0 && (
                          <div className="space-y-4">
                            {/* Language tabs */}
                            <div className="flex gap-1 bg-wizo-bg rounded-lg p-1">
                              {translations.map((t) => (
                                <button
                                  key={t.language}
                                  onClick={() => setActiveTransLang(t.language)}
                                  className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-all capitalize ${
                                    activeTransLang === t.language
                                      ? 'bg-wizo-accent text-white'
                                      : 'text-wizo-muted hover:text-white'
                                  }`}
                                >
                                  {t.language}
                                </button>
                              ))}
                            </div>

                            {/* Active translation segments */}
                            {translations
                              .filter((t) => t.language === activeTransLang)
                              .map((t) => (
                                <div key={t.language} className="space-y-3">
                                  <div className="flex items-center justify-between">
                                    <p className="text-sm text-wizo-muted capitalize">
                                      {t.language} — {t.segments.length} segments
                                    </p>
                                    <button
                                      onClick={() => handleExportSrt(t.segments, t.language)}
                                      className="bg-wizo-accent2 hover:bg-wizo-accent2/80 text-white px-4 py-2 rounded-lg text-sm transition-colors"
                                    >
                                      📄 Export {t.language} SRT
                                    </button>
                                  </div>
                                  <div className="max-h-72 overflow-y-auto space-y-2 pr-2">
                                    {t.segments.map((seg) => (
                                      <div key={seg.id} className="bg-wizo-bg/50 rounded-lg p-3 flex gap-4 items-start">
                                        <div className="text-xs text-wizo-accent font-mono whitespace-nowrap pt-0.5">
                                          {formatTimestamp(seg.start)} → {formatTimestamp(seg.end)}
                                        </div>
                                        <div className="text-sm flex-1">{seg.text}</div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* ── SILENCE REMOVAL TAB ── */}
                {activeTab === 'silence' && (
                  <div className="space-y-6">
                    <h3 className="text-lg font-semibold">🔇 Remove Silence</h3>
                    <p className="text-sm text-wizo-muted">Automatically detect and remove silent portions from your video — perfect for tightening up vlogs and podcasts.</p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="text-xs text-wizo-muted mb-1 block">Silence Threshold</label>
                        <select
                          value={silenceThreshold}
                          onChange={(e) => setSilenceThreshold(e.target.value)}
                          className="w-full bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none"
                        >
                          <option value="-20dB">-20dB (Aggressive)</option>
                          <option value="-25dB">-25dB (Moderate)</option>
                          <option value="-30dB">-30dB (Default)</option>
                          <option value="-35dB">-35dB (Conservative)</option>
                          <option value="-40dB">-40dB (Very Conservative)</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-wizo-muted mb-1 block">Min Silence Duration (seconds)</label>
                        <input
                          type="number"
                          value={minSilenceDuration}
                          onChange={(e) => setMinSilenceDuration(parseFloat(e.target.value) || 0.5)}
                          step="0.1"
                          min="0.1"
                          max="5"
                          className="w-full bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none transition-colors"
                        />
                        <p className="text-xs text-wizo-muted mt-1">Only remove silence longer than this duration</p>
                      </div>
                    </div>

                    <button
                      onClick={handleRemoveSilence}
                      disabled={removingSilence}
                      className="bg-wizo-accent hover:bg-wizo-accent/80 disabled:opacity-50 text-white font-medium px-8 py-3 rounded-lg transition-all duration-200 flex items-center gap-2"
                    >
                      {removingSilence && <Spinner />}
                      {removingSilence ? 'Removing silence...' : '🔇 Remove Silence'}
                    </button>

                    {silenceResult && (
                      <div className="bg-green-900/20 border border-green-500/30 rounded-lg p-4 space-y-3">
                        <p className="text-green-400 font-medium">✅ Silence removed!</p>
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          <div>
                            <div className="text-wizo-muted text-xs">Silent Sections Removed</div>
                            <div className="font-medium">{silenceResult.removedCount}</div>
                          </div>
                          <div>
                            <div className="text-wizo-muted text-xs">Time Saved</div>
                            <div className="font-medium text-green-400">{silenceResult.savedDuration ? formatDuration(silenceResult.savedDuration) : 'N/A'}</div>
                          </div>
                        </div>
                        <video
                          src={getDownloadUrl(silenceResult.outputId)}
                          controls
                          className="w-full rounded-lg border border-wizo-border max-h-[400px]"
                        />
                        <a
                          href={getDownloadUrl(silenceResult.outputId)}
                          download={silenceResult.filename}
                          className="inline-block bg-wizo-accent2 hover:bg-wizo-accent2/80 text-white px-5 py-2 rounded-lg text-sm transition-colors"
                        >
                          ⬇ Download
                        </a>
                      </div>
                    )}
                  </div>
                )}

                {/* ── BURN SUBTITLES TAB ── */}
                {activeTab === 'subtitles' && (
                  <div className="space-y-6">
                    <h3 className="text-lg font-semibold">🔤 Burn Subtitles</h3>
                    <p className="text-sm text-wizo-muted">Permanently embed subtitles into the video. Generate captions first in the Captions tab.</p>

                    <ModelSelector value={burnModel} onChange={setBurnModel} type="subtitles" />

                    {segments.length === 0 ? (
                      <div className="text-center py-8 text-wizo-muted">
                        <p className="text-4xl mb-3">💬</p>
                        <p>Generate captions first in the Captions tab</p>
                      </div>
                    ) : (
                      <>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                          <div>
                            <label className="text-xs text-wizo-muted mb-1 block">Font Size</label>
                            <input
                              type="number"
                              value={burnFontSize}
                              onChange={(e) => setBurnFontSize(Number(e.target.value))}
                              min={10}
                              max={72}
                              className="w-full bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none transition-colors"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-wizo-muted mb-1 block">Font Color</label>
                            <div className="flex gap-2 items-center">
                              <input
                                type="color"
                                value={burnFontColor}
                                onChange={(e) => setBurnFontColor(e.target.value)}
                                className="w-10 h-10 rounded border border-white/10 bg-transparent cursor-pointer"
                              />
                              <input
                                type="text"
                                value={burnFontColor}
                                onChange={(e) => setBurnFontColor(e.target.value)}
                                className="flex-1 bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none transition-colors"
                              />
                            </div>
                          </div>
                          <div>
                            <label className="text-xs text-wizo-muted mb-1 block">Background Color</label>
                            <div className="flex gap-2 items-center">
                              <input
                                type="color"
                                value={burnBgColor}
                                onChange={(e) => setBurnBgColor(e.target.value)}
                                className="w-10 h-10 rounded border border-white/10 bg-transparent cursor-pointer"
                              />
                              <input
                                type="text"
                                value={burnBgColor}
                                onChange={(e) => setBurnBgColor(e.target.value)}
                                className="flex-1 bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none transition-colors"
                              />
                            </div>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div>
                            <label className="text-xs text-wizo-muted mb-1 block">
                              Background Opacity: <span className="text-white font-medium">{burnBgOpacity}</span>
                            </label>
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.1}
                              value={burnBgOpacity}
                              onChange={(e) => setBurnBgOpacity(Number(e.target.value))}
                              className="w-full"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-wizo-muted mb-1 block">Position</label>
                            <select
                              value={burnPosition}
                              onChange={(e) => setBurnPosition(e.target.value)}
                              className="w-full bg-wizo-bg border border-white/10 rounded-lg px-4 py-3 text-white focus:border-wizo-accent focus:outline-none"
                            >
                              <option value="top">Top</option>
                              <option value="center">Center</option>
                              <option value="bottom">Bottom</option>
                            </select>
                          </div>
                        </div>

                        <button
                          onClick={handleBurnSubtitles}
                          disabled={burningSubtitles}
                          className="bg-wizo-accent hover:bg-wizo-accent/80 disabled:opacity-50 text-white font-medium px-8 py-3 rounded-lg transition-all duration-200 flex items-center gap-2"
                        >
                          {burningSubtitles && <Spinner />}
                          {burningSubtitles ? 'Burning subtitles...' : '🔤 Burn Subtitles'}
                        </button>

                        {burnResult && (
                          <div className="bg-green-900/20 border border-green-500/30 rounded-lg p-4 space-y-3">
                            <p className="text-green-400 font-medium">✅ Subtitles burned!</p>
                            <p className="text-sm text-wizo-muted">Video with embedded subtitles is ready</p>
                            <video
                              src={getDownloadUrl(burnResult.outputId)}
                              controls
                              className="w-full rounded-lg border border-wizo-border max-h-[400px]"
                            />
                            <a
                              href={getDownloadUrl(burnResult.outputId)}
                              download={burnResult.filename}
                              className="inline-block bg-wizo-accent2 hover:bg-wizo-accent2/80 text-white px-5 py-2 rounded-lg text-sm transition-colors"
                            >
                              ⬇ Download
                            </a>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* ── HIGHLIGHTS TAB ── */}
                {activeTab === 'highlights' && (
                  <div className="space-y-6">
                    <h3 className="text-lg font-semibold">⭐ Generate Highlights</h3>
                    <p className="text-sm text-wizo-muted">Automatically extract the most engaging moments from your video to create a highlight reel.</p>

                    <ModelSelector value={highlightModel} onChange={setHighlightModel} type="highlights" />

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="text-xs text-wizo-muted mb-1 block">
                          Target Duration: <span className="text-white font-medium">{highlightDuration}s</span>
                        </label>
                        <input
                          type="range"
                          min={15}
                          max={300}
                          step={5}
                          value={highlightDuration}
                          onChange={(e) => setHighlightDuration(Number(e.target.value))}
                          className="w-full"
                        />
                        <div className="flex justify-between text-xs text-wizo-muted mt-1">
                          <span>15s</span>
                          <span>5 min</span>
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-wizo-muted mb-1 block">
                          Sensitivity: <span className="text-white font-medium">{highlightSensitivity.toFixed(1)}</span>
                        </label>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.1}
                          value={highlightSensitivity}
                          onChange={(e) => setHighlightSensitivity(Number(e.target.value))}
                          className="w-full"
                        />
                        <div className="flex justify-between text-xs text-wizo-muted mt-1">
                          <span>Fewer highlights</span>
                          <span>More highlights</span>
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={handleHighlights}
                      disabled={generatingHighlights}
                      className="bg-wizo-accent hover:bg-wizo-accent/80 disabled:opacity-50 text-white font-medium px-8 py-3 rounded-lg transition-all duration-200 flex items-center gap-2"
                    >
                      {generatingHighlights && <Spinner />}
                      {generatingHighlights ? 'Generating highlights...' : '⭐ Generate Highlights'}
                    </button>

                    {highlightResult && (
                      <div className="bg-green-900/20 border border-green-500/30 rounded-lg p-4 space-y-3">
                        <p className="text-green-400 font-medium">✅ Highlights generated!</p>
                        {highlightResult.highlights && highlightResult.highlights.length > 0 && (
                          <div className="space-y-2">
                            <p className="text-sm text-wizo-muted">{highlightResult.highlights.length} highlight segments:</p>
                            <div className="max-h-40 overflow-y-auto space-y-1">
                              {highlightResult.highlights.map((h: any, i: number) => (
                                <div key={i} className="bg-wizo-bg/50 rounded px-3 py-2 text-sm flex items-center gap-3">
                                  <span className="text-wizo-accent font-mono text-xs">
                                    {formatTimestamp(h.start)} → {formatTimestamp(h.end)}
                                  </span>
                                  {h.label && <span className="text-wizo-muted">{h.label}</span>}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        <video
                          src={getDownloadUrl(highlightResult.outputId)}
                          controls
                          className="w-full rounded-lg border border-wizo-border max-h-[400px]"
                        />
                        <a
                          href={getDownloadUrl(highlightResult.outputId)}
                          download={highlightResult.filename}
                          className="inline-block bg-wizo-accent2 hover:bg-wizo-accent2/80 text-white px-5 py-2 rounded-lg text-sm transition-colors"
                        >
                          ⬇ Download Highlight Reel
                        </a>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </main>
      )}

      {/* Footer */}
      <footer className="border-t border-white/5 py-6 mt-12">
        <div className="max-w-6xl mx-auto px-4 text-center text-xs text-wizo-muted">
          <p>🎬 Vid|Wizo — Advanced Video Editor • Built with FastAPI + React</p>
          <p className="mt-1">Supports Sesotho, Zulu, Tswana & Xhosa caption translation</p>
        </div>
      </footer>
    </div>
  );
}
