'use client';

import { useUser, useAuth } from '@clerk/nextjs';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import {
  Send, Plus, FileText, MessageSquare, X, ChevronLeft,
  Sparkles, Share2, Check, Globe, BookOpen,
  Loader2, BarChart2, ExternalLink,
} from 'lucide-react';
import PdfViewer from '../../../../../component/PdfViewer';

const API = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:5000';

const GAP_COLORS = {
  'METHODOLOGICAL GAP': '#c9a96e',
  'THEORETICAL GAP':    '#a78bfa',
  'EMPIRICAL GAP':      '#7b9fd4',
  'APPLICATION GAP':    '#f59e0b',
  'POPULATION GAP':     '#f472b6',
};

// Evidence levels (backend EVIDENCE_LEVELS): how strongly the workspace
// supports the limitation → gap inference. Speculative items are grouped
// separately as "requires verification", never presented as findings.
const LEVEL_META = {
  EXPLICIT:            { label: 'Explicit', warn: false },
  STRONGLY_SUPPORTED:  { label: 'Strongly supported', warn: false },
  SUPPORTED_INFERENCE: { label: 'Supported inference', warn: false },
  SPECULATIVE:         { label: 'Requires verification', warn: true },
};

// Document processing lifecycle (mirrors backend migration 001)
const STATUS_META = {
  QUEUED:            { color: '#8a8680', label: 'Queued for indexing' },
  PROCESSING:        { color: '#7b9fd4', label: 'Processing…' },
  INDEXED:           { color: '#4ade80', label: 'Indexed — ready for chat' },
  UPLOAD_FAILED:     { color: '#e85d5d', label: 'Upload failed' },
  PROCESSING_FAILED: { color: '#e85d5d', label: 'Processing failed' },
  INDEXING_FAILED:   { color: '#e85d5d', label: 'Indexing failed' },
  UNKNOWN:           { color: '#4a4845', label: 'Status unknown' },
};

const THEMES = {
  pdf: {
    bg:        '#0f0f0f',
    bg2:       '#141414',
    bg3:       '#1a1a1a',
    border:    'rgba(255,255,255,0.07)',
    borderHov: 'rgba(255,255,255,0.12)',
    text:      '#f0ede8',
    textSub:   '#8a8680',
    textMuted: '#4a4845',
    accent:    '#c9a96e',
    accentDim: 'rgba(201,169,110,0.10)',
    accentBdr: 'rgba(201,169,110,0.22)',
    modeLabel: 'PDF · RAG',
    modeDot:   '#c9a96e',
    tabActive: '#c9a96e',
  },
  internet: {
    bg:        '#0a0d12',
    bg2:       '#0d1117',
    bg3:       '#131921',
    border:    'rgba(123,159,212,0.10)',
    borderHov: 'rgba(123,159,212,0.2)',
    text:      '#e8edf5',
    textSub:   '#7a8899',
    textMuted: '#3d4d5c',
    accent:    '#7b9fd4',
    accentDim: 'rgba(123,159,212,0.10)',
    accentBdr: 'rgba(123,159,212,0.22)',
    modeLabel: 'Web · Internet',
    modeDot:   '#7b9fd4',
    tabActive: '#7b9fd4',
  },
};

export default function WorkspaceChatPage() {
  const { isLoaded, user } = useUser();
  const { getToken }       = useAuth();
  const router             = useRouter();
  const params             = useParams();
  const workspaceId        = params?.workspaceId;
  const chatId             = params?.chatId;

  // ── Layout ────────────────────────────────────────────────────────────────
  const [leftPct, setLeftPct]     = useState(48);
  const [dragging, setDragging]   = useState(false);
  const [closedPdfIds, setClosedPdfIds] = useState(new Set());

  // ── Data ──────────────────────────────────────────────────────────────────
  const [workspace, setWorkspace]       = useState(null);
  const [messages, setMessages]         = useState([]);
  const [workspaceChats, setWsChats]    = useState([]);
  const [workspacePdfs, setWsPdfs]      = useState([]);
  const [activePdf, setActivePdf]       = useState(null);
  const [activePage, setActivePage]     = useState(1);
  const [researchGaps, setGaps]         = useState([]);
  const [internetPapers, setIntPapers]  = useState([]);

  // ── UI state ──────────────────────────────────────────────────────────────
  const [input, setInput]           = useState('');
  const [sending, setSending]       = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [uploading, setUploading]   = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [loadingGaps, setLoadingGaps] = useState(false);
  const [showGaps, setShowGaps]     = useState(false);
  const [chatMode, setChatMode]     = useState('pdf');
  const [copied, setCopied]         = useState(false);

  // ── Gap expansion & inline abstract ──────────────────────────────────────
  const [expandedGapId, setExpandedGapId] = useState(null);
  // { [gapId]: { text: string|null, loading: boolean } }
  const [gapAbstracts, setGapAbstracts]   = useState({});

  const bottomRef   = useRef(null);
  const textareaRef = useRef(null);

  const th = THEMES[chatMode];

  // ── Resizer ───────────────────────────────────────────────────────────────
  const onResizerDown = useCallback(e => { e.preventDefault(); setDragging(true); }, []);
  useEffect(() => {
    if (!dragging) return;
    const move = e => {
      const pct = (e.clientX / window.innerWidth) * 100;
      if (pct > 18 && pct < 82) setLeftPct(pct);
    };
    const up = () => setDragging(false);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    return () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
  }, [dragging]);

  // ── Data loaders ──────────────────────────────────────────────────────────
  const loadWsData = useCallback(async () => {
    if (!workspaceId) return;
    const token = await getToken();
    const hdr   = { Authorization: `Bearer ${token}` };
    const [wsRes, pdfRes, chatRes] = await Promise.all([
      fetch(`${API}/workspace/${workspaceId}`,       { headers: hdr }),
      fetch(`${API}/workspace/${workspaceId}/pdfs`,  { headers: hdr }),
      fetch(`${API}/workspace/${workspaceId}/chats`, { headers: hdr }),
    ]);
    const [ws, pdfs, chats] = await Promise.all([wsRes.json(), pdfRes.json(), chatRes.json()]);
    setWorkspace(ws);
    setWsPdfs(Array.isArray(pdfs) ? pdfs : []);
    setWsChats(Array.isArray(chats) ? chats : []);
    if (!activePdf && Array.isArray(pdfs) && pdfs.length > 0) setActivePdf(pdfs[0]);
  }, [workspaceId, getToken]);

  const loadMessages = useCallback(async () => {
    if (!chatId) return;
    setLoadingMsgs(true);
    try {
      const token = await getToken();
      const res   = await fetch(`${API}/chat/${chatId}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setMessages(Array.isArray(data) ? data : []);
    } finally {
      setLoadingMsgs(false);
    }
  }, [chatId, getToken]);

  const loadGaps = useCallback(async () => {
    if (!workspaceId) return;
    setLoadingGaps(true);
    try {
      const token = await getToken();
      const res   = await fetch(`${API}/workspace/${workspaceId}/research-gaps`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setGaps(Array.isArray(data) ? data : []);
      // Reset expansion state when gaps are refreshed
      setExpandedGapId(null);
      setGapAbstracts({});
    } finally {
      setLoadingGaps(false);
    }
  }, [workspaceId, getToken]);

  useEffect(() => { loadWsData();   }, [loadWsData]);
  useEffect(() => { loadMessages(); }, [loadMessages]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // ── Gap expansion + inline abstract fetch (with retry on failure) ──────
  const fetchAbstract = useCallback(async (gap) => {
    const id = gap.id;
    setGapAbstracts(prev => ({ ...prev, [id]: { text: null, loading: true, error: null } }));
    try {
      const token = await getToken();
      const res   = await fetch(`${API}/workspace/${workspaceId}/generate-abstract`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ gapTitle: gap.title, gapDescription: gap.description }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      setGapAbstracts(prev => ({
        ...prev,
        [id]: { text: data.abstract || 'No abstract generated.', loading: false, error: null },
      }));
    } catch (err) {
      setGapAbstracts(prev => ({
        ...prev,
        [id]: { text: null, loading: false, error: err?.message || 'Could not generate the abstract.' },
      }));
    }
  }, [workspaceId, getToken]);

  const toggleGap = useCallback(async (gap) => {
    const id = gap.id;

    // Collapse if already open
    if (expandedGapId === id) {
      setExpandedGapId(null);
      return;
    }

    setExpandedGapId(id);

    // Already fetched (or loading) — nothing to do; errors can be retried
    if (gapAbstracts[id]?.text || gapAbstracts[id]?.loading) return;

    await fetchAbstract(gap);
  }, [expandedGapId, gapAbstracts, fetchAbstract]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: text, mode: chatMode }]);
    setSending(true);
    try {
      const token    = await getToken();
      const endpoint = chatMode === 'internet' ? `${API}/chat/internet` : `${API}/chat`;
      const res = await fetch(endpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ question: text, chatId, workspaceId }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg = data?.debug || data?.error || 'Request failed';
        throw new Error(msg);
      }
      setMessages(prev => [...prev, {
        role:    'assistant',
        content: data.answer || 'No response generated.',
        sources: data.sources || [],
        papers:  data.papers  || [],
        gaps:    data.gaps    || [],
        mode:    chatMode,
        verification: data.verification || null,
      }]);
      if (data.gaps?.length) {
        setGaps(prev => [
          ...data.gaps,
          ...prev.filter(g => !data.gaps.find(ng => ng.title === g.title)),
        ]);
      }
      if (data.papers?.length) setIntPapers(data.papers);
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `⚠️ ${err?.message || 'Request failed. Please try again.'}`,
        sources: [],
      }]);
    } finally {
      setSending(false);
    }
  };

  const uploadPDFs = async files => {
    if (!files?.length) return;
    setUploading(true);
    setUploadError(null);
    try {
      const token = await getToken();
      const failures = [];
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append('pdf', file);
        fd.append('workspaceId', workspaceId);
        try {
          const res = await fetch(`${API}/upload`, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) failures.push(`${file.name}: ${data?.error || `upload failed (${res.status})`}`);
        } catch (err) {
          failures.push(`${file.name}: ${err?.message || 'network error'}`);
        }
      }
      if (failures.length) setUploadError(failures.join(' · '));
      await loadWsData();
      await loadGaps();
      setShowGaps(true);
    } finally {
      setUploading(false);
    }
  };

  const newChat = async () => {
    const token = await getToken();
    const res   = await fetch(`${API}/chat/create`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ workspaceId }),
    });
    const data = await res.json();
    await loadWsData();
    router.push(`/workspace/${workspaceId}/chat/${data.id}`);
  };

  const deleteChat = async (e, id) => {
    e.stopPropagation();
    if (!confirm('Delete this chat and all its messages?')) return;
    try {
      const token = await getToken();
      const res   = await fetch(`${API}/chat/${id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const updated = workspaceChats.filter(c => c.id !== id);
        setWsChats(updated);
        if (chatId === String(id)) {
          router.push(
            updated.length > 0
              ? `/workspace/${workspaceId}/chat/${updated[0].id}`
              : `/workspace/${workspaceId}`
          );
        }
      }
    } catch (err) { console.error(err); }
  };

  const jumpToSource = src => {
    const pdf = workspacePdfs.find(p => p.pdf_id === src.pdfId);
    if (pdf) { setActivePdf(pdf); setActivePage(src.page || 1); }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── Loading screen ────────────────────────────────────────────────────────
  if (!isLoaded) return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: '#0f0f0f', color: '#4a4845',
      fontFamily: "'DM Sans', sans-serif", fontSize: 13,
    }}>
      Loading…
    </div>
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:wght@300;400;500;600&display=swap');

        *, *::before, *::after { box-sizing: border-box; }

        :root {
          --th-bg:         ${th.bg};
          --th-bg2:        ${th.bg2};
          --th-bg3:        ${th.bg3};
          --th-border:     ${th.border};
          --th-text:       ${th.text};
          --th-sub:        ${th.textSub};
          --th-muted:      ${th.textMuted};
          --th-accent:     ${th.accent};
          --th-accent-dim: ${th.accentDim};
          --th-accent-bdr: ${th.accentBdr};
        }

        @keyframes spin   { to { transform: rotate(360deg); } }
        @keyframes pulse  { 0%,100%{opacity:.25;transform:scale(.8)} 50%{opacity:1;transform:scale(1.15)} }
        @keyframes fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes themeIn{ from{opacity:0} to{opacity:1} }

        .chat-root {
          display: flex; flex-direction: column; height: 100vh;
          background: var(--th-bg); color: var(--th-text);
          font-family: 'DM Sans', sans-serif;
          overflow: hidden;
          transition: background 0.35s ease, color 0.35s ease;
          animation: themeIn 0.25s ease;
        }

        * { scrollbar-width: thin; scrollbar-color: ${th.border} transparent; }
        *::-webkit-scrollbar { width: 3px; height: 3px; }
        *::-webkit-scrollbar-track { background: transparent; }
        *::-webkit-scrollbar-thumb { background: ${th.border}; border-radius: 99px; }
        *::-webkit-scrollbar-thumb:hover { background: ${th.borderHov}; }

        .nav {
          display: flex; align-items: center; height: 46px;
          padding: 0 16px; gap: 10px; flex-shrink: 0;
          border-bottom: 1px solid var(--th-border);
          background: var(--th-bg);
          transition: background 0.35s ease, border-color 0.35s ease;
        }
        .nav-logo-name {
          font-family: 'DM Serif Display', serif;
          font-size: 15px; color: var(--th-text);
          letter-spacing: -0.01em; line-height: 1;
        }
        .nav-logo-icon svg { width: 24px; height: 24px; }
        .nav-sep { font-size: 14px; color: var(--th-muted); }
        .nav-ws  {
          font-size: 12px; font-weight: 500; color: var(--th-sub);
          max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }

        .mode-toggle {
          display: flex; background: var(--th-bg3);
          border: 1px solid var(--th-border); border-radius: 9px;
          padding: 3px; gap: 2px; transition: all 0.3s ease;
        }
        .mode-btn {
          display: flex; align-items: center; gap: 5px;
          padding: 5px 12px; border-radius: 7px; border: none;
          font-size: 11px; font-weight: 500;
          font-family: 'DM Sans', sans-serif;
          cursor: pointer; transition: all 0.22s ease;
          background: transparent;
        }
        .mode-btn.active {
          background: var(--th-bg); color: var(--th-accent);
          box-shadow: 0 1px 6px rgba(0,0,0,0.35);
        }
        .mode-btn.inactive { color: var(--th-muted); }
        .mode-btn.inactive:hover { color: var(--th-sub); }

        .icon-btn {
          background: none; border: 1px solid var(--th-border);
          border-radius: 7px; color: var(--th-sub); cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          width: 28px; height: 28px; padding: 0;
          transition: all 0.15s; flex-shrink: 0;
        }
        .icon-btn:hover { border-color: var(--th-accent-bdr); color: var(--th-accent); }

        .tabs-bar {
          display: flex; align-items: center; height: 36px;
          border-bottom: 1px solid var(--th-border);
          background: var(--th-bg2);
          overflow-x: auto; flex-shrink: 0;
          transition: background 0.35s ease;
        }
        .tab {
          display: flex; align-items: center; gap: 5px;
          padding: 0 11px; height: 100%;
          border-right: 1px solid var(--th-border);
          cursor: pointer; flex-shrink: 0; max-width: 160px;
          transition: background 0.15s;
          font-size: 11px; font-weight: 400; color: var(--th-muted);
          border-bottom: 2px solid transparent;
        }
        .tab.active {
          background: var(--th-bg); color: var(--th-text);
          font-weight: 500; border-bottom: 2px solid var(--th-accent);
        }
        .tab span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tab-x {
          margin-left: 3px; flex-shrink: 0; opacity: 0; cursor: pointer;
          display: flex; align-items: center;
          transition: opacity 0.15s, color 0.15s; color: var(--th-muted);
        }
        .tab:hover .tab-x { opacity: 1; }
        .tab-x:hover { color: #c0614a !important; }
        .tab-add {
          display: flex; align-items: center; justify-content: center;
          padding: 0 11px; height: 100%;
          border-right: 1px solid var(--th-border);
          cursor: pointer; flex-shrink: 0; color: var(--th-muted);
          background: none; border-top: none; border-left: none; border-bottom: none;
          transition: color 0.15s;
        }
        .tab-add:hover { color: var(--th-accent); }

        .mode-banner {
          display: flex; align-items: center;
          padding: 6px 14px; gap: 8px;
          border-bottom: 1px solid var(--th-border);
          background: var(--th-bg2); flex-shrink: 0;
          transition: all 0.35s ease;
        }
        .mode-pill {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 3px 9px; border-radius: 20px;
          background: var(--th-accent-dim); border: 1px solid var(--th-accent-bdr);
          font-size: 10px; font-weight: 600; color: var(--th-accent);
          letter-spacing: 0.05em; text-transform: uppercase;
          transition: all 0.35s ease;
        }
        .mode-dot {
          width: 5px; height: 5px; border-radius: 50%;
          background: var(--th-accent); transition: background 0.35s ease;
        }

        .messages { flex: 1; overflow-y: auto; padding: 18px 16px 8px; }
        .msg-fade { animation: fadeUp 0.22s ease both; }

        .ai-avatar {
          width: 26px; height: 26px; border-radius: 7px;
          background: var(--th-bg3); border: 1px solid var(--th-accent-bdr);
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0; transition: all 0.35s ease;
        }
        .ai-label {
          font-size: 10px; font-weight: 600; color: var(--th-accent);
          letter-spacing: 0.08em; text-transform: uppercase;
          margin-bottom: 5px; transition: color 0.35s ease;
        }
        .md-body {
          font-size: 13px; color: var(--th-text);
          line-height: 1.7; font-weight: 300;
        }
        .md-body p { margin-bottom: 10px; }
        .md-body p:last-child { margin-bottom: 0; }
        .md-body strong { font-weight: 600; color: var(--th-text); }
        .md-body code {
          background: var(--th-bg3); border: 1px solid var(--th-border);
          padding: 1px 5px; border-radius: 4px; font-size: 11.5px;
        }

        .source-chip {
          display: inline-flex; align-items: center; gap: 4px;
          background: var(--th-bg3); border: 1px solid var(--th-border);
          border-radius: 6px; padding: 3px 8px;
          font-size: 10px; color: var(--th-muted);
          cursor: pointer; transition: all 0.18s;
        }
        .source-chip:hover { border-color: var(--th-accent-bdr); color: var(--th-text); }

        .user-bubble {
          background: var(--th-bg2); border: 1px solid var(--th-border);
          border-radius: 10px; padding: 10px 14px;
          font-size: 13px; color: var(--th-text);
          max-width: 78%; line-height: 1.65; font-weight: 300;
          transition: all 0.35s ease;
        }

        .input-wrap { padding: 10px 12px; flex-shrink: 0; }
        .input-box {
          background: var(--th-bg2); border: 1px solid var(--th-border);
          border-radius: 12px; overflow: hidden;
          transition: border-color 0.2s, background 0.35s ease;
        }
        .input-box:focus-within { border-color: var(--th-accent-bdr); }
        .input-box textarea {
          width: 100%; background: transparent; border: none; outline: none;
          padding: 11px 14px 5px;
          font-size: 13px; color: var(--th-text);
          resize: none; font-family: 'DM Sans', sans-serif;
          line-height: 1.55; font-weight: 300;
        }
        .input-box textarea::placeholder { color: var(--th-muted); }
        .input-footer {
          display: flex; align-items: center;
          padding: 5px 10px 10px; gap: 8px;
        }
        .send-btn {
          width: 30px; height: 30px; border-radius: 8px;
          border: none; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          transition: all 0.2s; flex-shrink: 0;
        }

        .status-bar {
          height: 26px; border-top: 1px solid var(--th-border);
          background: var(--th-bg2);
          display: flex; align-items: center;
          padding: 0 14px; gap: 14px; flex-shrink: 0;
          transition: all 0.35s ease;
        }

        .gap-panel {
          position: absolute; top: 0; right: 0; bottom: 0; width: 340px;
          background: var(--th-bg); border-left: 1px solid var(--th-border);
          display: flex; flex-direction: column;
          z-index: 20; box-shadow: -8px 0 40px rgba(0,0,0,0.4);
          animation: fadeUp 0.2s ease both;
          transition: background 0.35s ease;
        }
        .gap-card {
          background: var(--th-bg2); border: 1px solid var(--th-border);
          border-radius: 10px; padding: 14px;
          cursor: pointer; transition: background 0.15s, border-color 0.15s;
        }
        .gap-card:hover { background: var(--th-bg3); }
        .gap-card.expanded { border-color: var(--th-accent-bdr); }

        .typing-dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: var(--th-accent);
          animation: pulse 1.2s ease-in-out infinite;
        }

        @media (max-width: 640px) { .nav { padding: 0 10px; } }
      `}</style>

      <div className="chat-root">

        {/* ── NAV ── */}
        <nav className="nav">
          <button className="icon-btn" onClick={() => router.push('/workspace')}>
            <ChevronLeft size={13} />
          </button>

          <div
            style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' }}
            onClick={() => router.push('/workspace')}
          >
            <div className="nav-logo-icon">
              <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="5" y="4" width="14" height="20" rx="2" stroke={th.accent} strokeWidth="1.4" fill="none"/>
                <rect x="9" y="4" width="14" height="20" rx="2" stroke={`${th.accent}55`} strokeWidth="1.4" fill={`${th.accent}08`}/>
                <line x1="12" y1="10" x2="19" y2="10" stroke={th.accent} strokeWidth="1.2" strokeLinecap="round" opacity="0.7"/>
                <line x1="12" y1="14" x2="19" y2="14" stroke={th.accent} strokeWidth="1.2" strokeLinecap="round" opacity="0.5"/>
                <line x1="12" y1="18" x2="16" y2="18" stroke={th.accent} strokeWidth="1.2" strokeLinecap="round" opacity="0.35"/>
              </svg>
            </div>
            <span className="nav-logo-name">Radium</span>
          </div>

          <span className="nav-sep">/</span>
          <span className="nav-ws">{workspace?.title || '…'}</span>

          <div style={{ flex: 1 }} />

          <div className="mode-toggle">
            {[
              { key: 'pdf',      icon: <BookOpen size={11} />, label: 'PDF' },
              { key: 'internet', icon: <Globe size={11} />,    label: 'Web' },
            ].map(m => (
              <button
                key={m.key}
                className={`mode-btn ${chatMode === m.key ? 'active' : 'inactive'}`}
                onClick={() => setChatMode(m.key)}
              >
                {m.icon} {m.label}
              </button>
            ))}
          </div>

          <button
            className="icon-btn"
            title="Research gaps"
            onClick={() => {
              setShowGaps(v => {
                if (!v && researchGaps.length === 0) loadGaps();
                return !v;
              });
            }}
          >
            <Sparkles size={13} style={{ color: showGaps ? th.accent : undefined }} />
          </button>

          <button className="icon-btn" onClick={copyLink} title="Copy link">
            {copied
              ? <Check size={13} style={{ color: '#4ade80' }} />
              : <Share2 size={13} />}
          </button>

          {user?.imageUrl
            ? <img src={user.imageUrl} style={{ width: 26, height: 26, borderRadius: '50%', border: `1px solid ${th.border}`, objectFit: 'cover', flexShrink: 0 }} alt="avatar" />
            : <div style={{ width: 26, height: 26, borderRadius: '50%', background: th.bg3, border: `1px solid ${th.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, flexShrink: 0 }}>👤</div>
          }
        </nav>

        {/* ── BODY ── */}
        <div style={{
          flex: 1, display: 'flex', overflow: 'hidden',
          cursor: dragging ? 'col-resize' : 'auto',
          userSelect: dragging ? 'none' : 'auto',
        }}>

          {/* ── LEFT: PDF PANEL ── */}
          <div style={{
            width: `${leftPct}%`, flexShrink: 0,
            display: 'flex', flexDirection: 'column',
            borderRight: `1px solid ${th.border}`, overflow: 'hidden',
          }}>
            {/* PDF tabs */}
            <div className="tabs-bar">
              {workspacePdfs.filter(p => !closedPdfIds.has(p.pdf_id)).map(pdf => {
                const active = activePdf?.pdf_id === pdf.pdf_id;
                const meta = STATUS_META[pdf.status] || STATUS_META.UNKNOWN;
                return (
                  <div
                    key={pdf.pdf_id}
                    className={`tab ${active ? 'active' : ''}`}
                    onClick={() => { setActivePdf(pdf); setActivePage(1); }}
                    title={`${pdf.filename} — ${meta.label}`}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
                    <FileText size={10} style={{ flexShrink: 0, color: active ? th.accent : th.textMuted }} />
                    <span>{pdf.filename}</span>
                    <span
                      className="tab-x"
                      onClick={e => {
                        e.stopPropagation();
                        setClosedPdfIds(s => new Set([...s, pdf.pdf_id]));
                        if (activePdf?.pdf_id === pdf.pdf_id) setActivePdf(null);
                      }}
                    >
                      <X size={9} />
                    </span>
                  </div>
                );
              })}
              <label className="tab-add" title="Upload PDF">
                {uploading
                  ? <Loader2 size={11} style={{ animation: 'spin 0.8s linear infinite' }} />
                  : <Plus size={11} />}
                <input type="file" multiple accept=".pdf" hidden onChange={e => uploadPDFs(e.target.files)} />
              </label>
            </div>

            {/* Upload error banner */}
            {uploadError && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 12px', fontSize: 11, color: '#e85d5d',
                background: 'rgba(232,93,93,0.07)',
                borderBottom: `1px solid ${th.border}`,
                flexShrink: 0,
              }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={uploadError}>
                  ⚠️ {uploadError}
                </span>
                <button onClick={() => setUploadError(null)} style={{ background: 'none', border: 'none', color: th.textMuted, cursor: 'pointer', padding: 0, display: 'flex' }}>
                  <X size={11} />
                </button>
              </div>
            )}

            {/* PDF viewer */}
            <div style={{
              flex: 1, overflow: 'hidden', background: '#080808',
              display: 'flex',
              alignItems: activePdf ? 'flex-start' : 'center',
              justifyContent: 'center',
            }}>
              {activePdf ? (
                <PdfViewer pdfId={activePdf.pdf_id} page={activePage} />
              ) : (
                <div style={{ textAlign: 'center', color: th.textMuted, padding: 40 }}>
                  <FileText size={32} style={{ marginBottom: 10, opacity: 0.2 }} />
                  <div style={{ fontSize: 13, fontFamily: "'DM Serif Display', serif", fontStyle: 'italic' }}>No PDF open</div>
                  <div style={{ fontSize: 11, marginTop: 4, opacity: 0.5, fontWeight: 300 }}>Upload or select a document</div>
                </div>
              )}
            </div>
          </div>

          {/* ── RESIZER ── */}
          <div
            onMouseDown={onResizerDown}
            style={{
              width: 4, flexShrink: 0, cursor: 'col-resize',
              background: dragging ? th.accent : 'transparent',
              transition: 'background .2s', zIndex: 5,
            }}
          />

          {/* ── RIGHT: CHAT ── */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>

            {/* Chat tabs */}
            <div className="tabs-bar">
              {workspaceChats.map(chat => {
                const active = chatId === String(chat.id);
                return (
                  <div
                    key={chat.id}
                    className={`tab ${active ? 'active' : ''}`}
                    onClick={() => router.push(`/workspace/${workspaceId}/chat/${chat.id}`)}
                  >
                    <MessageSquare size={10} style={{ flexShrink: 0, color: active ? th.accent : th.textMuted }} />
                    <span>{chat.title || 'Chat'}</span>
                    <span className="tab-x" onClick={e => deleteChat(e, chat.id)}>
                      <X size={9} />
                    </span>
                  </div>
                );
              })}
              <button className="tab-add" onClick={newChat} title="New chat">
                <Plus size={11} />
              </button>
            </div>

            {/* Mode banner */}
            <div className="mode-banner">
              <div className="mode-pill">
                <div className="mode-dot" />
                {th.modeLabel}
              </div>
              {chatMode === 'pdf' && activePdf && (
                <span style={{ fontSize: 11, color: th.textMuted, fontWeight: 300 }}>{activePdf.filename}</span>
              )}
              {chatMode === 'internet' && (
                <span style={{ fontSize: 11, color: th.textMuted, fontWeight: 300 }}>CrossRef · Semantic Scholar</span>
              )}
            </div>

            {/* Messages */}
            <div className="messages">
              {loadingMsgs && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
                  <Loader2 size={18} style={{ color: th.textMuted, animation: 'spin 0.9s linear infinite' }} />
                </div>
              )}

              {messages.length === 0 && !loadingMsgs && (
                <div style={{ textAlign: 'center', padding: '60px 20px', color: th.textMuted }}>
                  <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 20, fontStyle: 'italic', marginBottom: 8, color: th.textSub }}>
                    Ask anything
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 300 }}>
                    {chatMode === 'pdf'
                      ? 'Queries are grounded across your uploaded documents.'
                      : 'Searches CrossRef and Semantic Scholar in real time.'}
                  </div>
                </div>
              )}

              {messages.map((m, i) => (
                <div key={i} style={{ marginBottom: 22 }} className="msg-fade">
                  {m.role === 'assistant' ? (
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                      <div className="ai-avatar">
                        <svg viewBox="0 0 28 28" fill="none" width="14" height="14">
                          <rect x="5" y="4" width="14" height="20" rx="2" stroke={th.accent} strokeWidth="1.6" fill="none"/>
                          <rect x="9" y="4" width="14" height="20" rx="2" stroke={`${th.accent}55`} strokeWidth="1.6" fill={`${th.accent}08`}/>
                        </svg>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="ai-label">
                          Radium
                          {m.mode === 'internet' && (
                            <span style={{ marginLeft: 6, fontSize: 9, color: th.accent, background: th.accentDim, border: `1px solid ${th.accentBdr}`, borderRadius: 4, padding: '1px 5px', letterSpacing: '0.06em' }}>WEB</span>
                          )}
                          {m.verification && m.verification.verdict && (
                            <span
                              title={m.verification.citationCoverage != null ? `Citation coverage: ${Math.round(m.verification.citationCoverage * 100)}%` : 'Groundedness check'}
                              style={{
                                marginLeft: 6, fontSize: 9, letterSpacing: '0.06em',
                                color: m.verification.verdict === 'supported' ? '#4ade80' : m.verification.verdict === 'refused' || m.verification.verdict === 'no-claims' ? th.textMuted : '#e8a13d',
                                background: th.bg3, border: `1px solid ${th.border}`,
                                borderRadius: 4, padding: '1px 5px',
                              }}
                            >
                              {String(m.verification.verdict).toUpperCase().replace(/-/g, ' ')}
                            </span>
                          )}
                        </div>
                        <div className="md-body">
                          <ReactMarkdown>{m.content}</ReactMarkdown>
                        </div>

                        {/* PDF sources */}
                        {m.sources?.length > 0 && (
                          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                            {m.sources.map((src, si) => (
                              <button key={si} className="source-chip" onClick={() => jumpToSource(src)} title={src.preview}>
                                <FileText size={9} style={{ color: th.accent }} />
                                {src.filename || src.fileName || 'Source'}
                                <span style={{ opacity: 0.4 }}>p.{src.page}</span>
                              </button>
                            ))}
                          </div>
                        )}

                        {/* Web papers */}
                        {m.papers?.length > 0 && (
                          <div style={{ marginTop: 12 }}>
                            <div style={{ fontSize: 10, color: th.textMuted, marginBottom: 6, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 600 }}>Sources</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                              {m.papers.slice(0, 4).map((p, pi) => (
                                <div key={pi} style={{ background: th.bg3, border: `1px solid ${th.border}`, borderRadius: 8, padding: '8px 10px' }}>
                                  <div style={{ fontSize: 12, fontWeight: 500, color: th.text, marginBottom: 3, lineHeight: 1.4 }}>{p.title}</div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: th.textMuted }}>
                                    <span>{p.authors?.split(',')[0]}{p.year ? ` · ${p.year}` : ''}</span>
                                    <span style={{ background: th.bg, border: `1px solid ${th.border}`, borderRadius: 4, padding: '1px 5px' }}>{p.source}</span>
                                    {p.url && (
                                      <a href={p.url} target="_blank" rel="noreferrer" style={{ display: 'flex', alignItems: 'center', gap: 3, color: th.accent, textDecoration: 'none' }}>
                                        <ExternalLink size={9} /> View
                                      </a>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <div className="user-bubble">{m.content}</div>
                    </div>
                  )}
                </div>
              ))}

              {/* Typing indicator */}
              {sending && (
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 20 }} className="msg-fade">
                  <div className="ai-avatar">
                    <svg viewBox="0 0 28 28" fill="none" width="14" height="14">
                      <rect x="5" y="4" width="14" height="20" rx="2" stroke={th.accent} strokeWidth="1.6" fill="none"/>
                      <rect x="9" y="4" width="14" height="20" rx="2" stroke={`${th.accent}55`} strokeWidth="1.6" fill={`${th.accent}08`}/>
                    </svg>
                  </div>
                  <div style={{ display: 'flex', gap: 5, alignItems: 'center', paddingTop: 8 }}>
                    {[0, 1, 2].map(n => (
                      <div key={n} className="typing-dot" style={{ animationDelay: `${n * 0.18}s` }} />
                    ))}
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Input */}
            <div className="input-wrap">
              <div className="input-box">
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
                  }}
                  placeholder={
                    chatMode === 'internet'
                      ? 'Search the research web…'
                      : activePdf
                        ? `Ask about ${activePdf.filename}…`
                        : 'Ask Radium anything…'
                  }
                  rows={2}
                />
                <div className="input-footer">
                  <span style={{ fontSize: 10, color: th.textMuted, fontWeight: 300 }}>Enter to send · Shift+Enter for newline</span>
                  <div style={{ flex: 1 }} />
                  <button
                    className="send-btn"
                    onClick={sendMessage}
                    disabled={sending || !input.trim()}
                    style={{
                      background: input.trim() ? th.accent : th.bg3,
                      opacity: (!input.trim() || sending) ? 0.5 : 1,
                      cursor: input.trim() ? 'pointer' : 'default',
                    }}
                  >
                    <Send size={12} style={{ color: input.trim() ? th.bg : th.textMuted }} />
                  </button>
                </div>
              </div>
            </div>

            {/* ── GAPS PANEL ── */}
            {showGaps && (
              <div className="gap-panel">

                {/* Header */}
                <div style={{
                  display: 'flex', alignItems: 'center', padding: '12px 14px 10px',
                  borderBottom: `1px solid ${th.border}`,
                  background: th.bg2, flexShrink: 0, gap: 8,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "'DM Serif Display', serif" }}>
                        Research gaps
                      </span>
                      {researchGaps.length > 0 && (
                        <span style={{
                          fontSize: 10, fontWeight: 600, color: th.textMuted,
                          background: th.bg3, border: `1px solid ${th.border}`,
                          borderRadius: 10, padding: '1px 7px',
                        }}>
                          {researchGaps.length}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: th.textMuted, fontWeight: 300, marginTop: 2 }}>
                      Evidence-backed candidates · select one for a draft abstract
                    </div>
                  </div>
                  <button className="icon-btn" onClick={loadGaps} disabled={loadingGaps} title="Refresh analysis">
                    {loadingGaps
                      ? <Loader2 size={12} style={{ animation: 'spin 0.8s linear infinite' }} />
                      : <BarChart2 size={12} />}
                  </button>
                  <button className="icon-btn" onClick={() => { setShowGaps(false); setExpandedGapId(null); }} title="Close panel">
                    <X size={13} />
                  </button>
                </div>

                {/* List */}
                <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>

                  {/* Loading */}
                  {loadingGaps && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 12 }}>
                      <Loader2 size={22} style={{ color: th.accent, animation: 'spin 0.8s linear infinite' }} />
                      <div style={{ fontSize: 11, color: th.textMuted, fontWeight: 300 }}>Analysing documents…</div>
                    </div>
                  )}

                  {/* Empty */}
                  {!loadingGaps && researchGaps.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '40px 16px', color: th.textMuted }}>
                      <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 15, fontStyle: 'italic', marginBottom: 6, color: th.textSub }}>
                        No gaps yet
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 300 }}>Click refresh to analyse your documents.</div>
                    </div>
                  )}

                  {/* Gap cards */}
                  {researchGaps.map((gap, i) => {
                    const col      = GAP_COLORS[gap.type] || th.accent;
                    const isOpen   = expandedGapId === gap.id;
                    const abstract = gapAbstracts[gap.id];
                    const evidence = Array.isArray(gap.evidence) ? gap.evidence : [];
                    const confidence = typeof gap.confidence === 'number' && gap.confidence > 0
                      ? Math.round(gap.confidence * 100)
                      : null;
                    const levelMeta = LEVEL_META[gap.evidenceLevel] || null;
                    const isSpec = gap.evidenceLevel === 'SPECULATIVE';
                    const showSpecDivider = isSpec && (i === 0 || researchGaps[i - 1]?.evidenceLevel !== 'SPECULATIVE');

                    return (
                      <div key={gap.id || i} style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                        {showSpecDivider && (
                          <div style={{
                            display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 2px',
                          }}>
                            <div style={{ flex: 1, height: 1, background: th.border }} />
                            <span style={{ fontSize: 9, fontWeight: 600, color: th.textMuted, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                              Requires verification
                            </span>
                            <div style={{ flex: 1, height: 1, background: th.border }} />
                          </div>
                        )}
                      <div
                        className={`gap-card${isOpen ? ' expanded' : ''}`}
                        onClick={() => toggleGap(gap)}
                      >
                        {/* Index + type + confidence row */}
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 7,
                          marginBottom: 6,
                        }}>
                          <span style={{
                            fontSize: 10, fontWeight: 600, color: th.textMuted,
                            fontVariantNumeric: 'tabular-nums',
                          }}>
                            {String(i + 1).padStart(2, '0')}
                          </span>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: col, flexShrink: 0 }} />
                          <span style={{ fontSize: 9, fontWeight: 600, color: th.textSub, letterSpacing: '0.08em', textTransform: 'uppercase', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {(gap.type || 'RESEARCH GAP').toLowerCase().replace(/\b\w/g, c => c.toUpperCase())}
                          </span>
                          {levelMeta && (
                            <span
                              title={isSpec ? 'Insufficient workspace evidence — treat as a lead, not a finding' : 'How strongly the workspace evidence supports this gap'}
                              style={{
                                fontSize: 9, fontWeight: 600, letterSpacing: '0.04em',
                                color: isSpec ? '#e8a13d' : th.textSub,
                                background: th.bg3,
                                border: isSpec ? '1px dashed rgba(232,161,61,0.5)' : `1px solid ${th.border}`,
                                borderRadius: 4, padding: '1px 6px', flexShrink: 0, whiteSpace: 'nowrap',
                              }}
                            >
                              {levelMeta.label}
                            </span>
                          )}
                          {gap.verification === 'verified' && (
                            <span
                              title="Checked against the workspace: no contradicting evidence found"
                              style={{ fontSize: 9, fontWeight: 500, color: '#4ade80', background: 'rgba(74,222,128,0.07)', border: '1px solid rgba(74,222,128,0.25)', borderRadius: 4, padding: '1px 6px', flexShrink: 0, whiteSpace: 'nowrap' }}
                            >
                              Screened
                            </span>
                          )}
                          {confidence !== null ? (
                            <span
                              title="Share of the proposed supporting references that resolve to real document excerpts"
                              style={{ fontSize: 9, fontWeight: 600, color: th.textSub, background: th.bg3, border: `1px solid ${th.border}`, borderRadius: 4, padding: '1px 6px', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
                            >
                              Evidence {confidence}%
                            </span>
                          ) : (
                            <span
                              title="Stored before evidence scoring — refresh to re-analyse"
                              style={{ fontSize: 9, fontWeight: 500, color: th.textMuted, border: `1px dashed ${th.border}`, borderRadius: 4, padding: '1px 6px', flexShrink: 0 }}
                            >
                              Unscored
                            </span>
                          )}
                          <span style={{
                            color: th.textMuted, fontSize: 12, lineHeight: 1,
                            display: 'inline-block', flexShrink: 0,
                            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                            transition: 'transform 0.2s',
                          }}>
                            ▾
                          </span>
                        </div>

                        {/* Title */}
                        <div style={{
                          fontSize: 13, fontWeight: 500, color: th.text,
                          lineHeight: 1.45, fontFamily: "'DM Serif Display', serif",
                          marginBottom: gap.description ? 6 : 0,
                        }}>
                          {gap.title}
                        </div>

                        {/* Description — always visible */}
                        {gap.description && (
                          <div style={{ fontSize: 12, color: th.textSub, lineHeight: 1.65, fontWeight: 300 }}>
                            {gap.description}
                          </div>
                        )}

                        {/* Unresolved limitation — the chain this gap follows from */}
                        {gap.limitation && (
                          <div style={{
                            marginTop: 7, padding: '7px 9px',
                            background: th.bg3, borderLeft: `2px solid ${col}`,
                            borderRadius: '0 6px 6px 0',
                            fontSize: 11, color: th.textSub, lineHeight: 1.6, fontWeight: 300,
                          }}>
                            <span style={{ fontWeight: 600, color: th.text, fontSize: 10 }}>Unresolved limitation · </span>
                            {gap.limitation}
                          </div>
                        )}

                        {/* Evidence preview */}
                        {evidence.length > 0 && (
                          <div style={{
                            marginTop: 9, paddingTop: 8,
                            borderTop: `1px solid ${th.border}`,
                            fontSize: 11, color: th.textMuted, lineHeight: 1.55, fontWeight: 300,
                          }}>
                            <span style={{ fontWeight: 600, color: th.textSub }}>Evidence · </span>
                            {evidence[0].filename}{evidence[0].page ? `, p. ${evidence[0].page}` : ''}
                            {evidence[0].quote ? ` — “${evidence[0].quote.slice(0, 110)}${evidence[0].quote.length > 110 ? '…' : ''}”` : ''}
                            {evidence.length > 1 && (
                              <span style={{ color: th.textSub }}> (+{evidence.length - 1} more)</span>
                            )}
                          </div>
                        )}

                        {/* Source files */}
                        {gap.citations?.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                            {gap.citations.map((c, ci) => (
                              <div key={ci} style={{
                                display: 'flex', alignItems: 'center', gap: 3,
                                background: th.bg3, border: `1px solid ${th.border}`,
                                borderRadius: 4, padding: '2px 6px',
                                fontSize: 10, color: th.textMuted,
                              }}
                                title={c.section ? `${c.filename}${c.page ? ` — p.${c.page}` : ''} · ${c.section}` : c.filename}
                              >
                                <FileText size={9} /> {c.filename}{c.page ? ` p.${c.page}` : ''}
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Expanded: full evidence + draft abstract */}
                        {isOpen && (
                          <div
                            style={{ marginTop: 12, borderTop: `1px solid ${th.border}`, paddingTop: 12, animation: 'fadeUp 0.18s ease both' }}
                            onClick={e => e.stopPropagation()}
                          >
                            {/* Why this follows from the limitation */}
                            {gap.reasoning && (
                              <div style={{
                                marginBottom: 12, fontSize: 11, color: th.textSub,
                                lineHeight: 1.6, fontWeight: 300,
                              }}>
                                <span style={{ fontWeight: 600, color: th.text, fontSize: 10 }}>Why this follows · </span>
                                {gap.reasoning}
                              </div>
                            )}
                            {evidence.length > 1 && (
                              <div style={{ marginBottom: 12 }}>
                                <div style={{
                                  fontSize: 10, fontWeight: 700, color: th.textSub,
                                  letterSpacing: '0.1em', textTransform: 'uppercase',
                                  marginBottom: 7,
                                }}>
                                  Supporting evidence
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  {evidence.map((e, ei) => (
                                    <div key={ei} style={{
                                      background: th.bg3, border: `1px solid ${th.border}`,
                                      borderRadius: 7, padding: '7px 9px',
                                    }}>
                                      <div style={{ fontSize: 10, fontWeight: 600, color: th.textSub, marginBottom: 3 }}>
                                        {e.filename}{e.page ? ` · p. ${e.page}` : ''}{e.section ? ` · ${e.section}` : ''}
                                      </div>
                                      {e.quote && (
                                        <div style={{ fontSize: 11, color: th.textMuted, lineHeight: 1.6, fontWeight: 300, fontStyle: 'italic' }}>
                                          “{e.quote.slice(0, 220)}{e.quote.length > 220 ? '…' : ''}”
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            <div style={{
                              fontSize: 10, fontWeight: 700, color: th.accent,
                              letterSpacing: '0.1em', textTransform: 'uppercase',
                              marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5,
                            }}>
                              <FileText size={9} /> Draft abstract
                            </div>

                            {abstract?.loading ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0' }}>
                                <Loader2 size={13} style={{ color: th.accent, animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
                                <span style={{ fontSize: 11, color: th.textMuted, fontWeight: 300 }}>Drafting abstract from your documents…</span>
                              </div>
                            ) : abstract?.error ? (
                              <div style={{
                                background: 'rgba(232,93,93,0.06)', border: '1px solid rgba(232,93,93,0.25)',
                                borderRadius: 7, padding: '9px 11px',
                              }}>
                                <div style={{ fontSize: 12, color: '#e85d5d', marginBottom: 7 }}>
                                  Could not generate the abstract{abstract.error && abstract.error !== 'Could not generate the abstract.' ? `: ${abstract.error}` : '.'}
                                </div>
                                <button
                                  onClick={() => fetchAbstract(gap)}
                                  style={{
                                    background: th.bg3, border: `1px solid ${th.border}`,
                                    color: th.text, borderRadius: 6, padding: '5px 12px',
                                    fontSize: 11, cursor: 'pointer', fontWeight: 500,
                                  }}
                                >
                                  Try again
                                </button>
                              </div>
                            ) : abstract?.text ? (
                              <>
                                <div style={{ fontSize: 12, color: th.text, lineHeight: 1.75, fontWeight: 300 }}>
                                  {abstract.text}
                                </div>
                                <div style={{
                                  marginTop: 10, paddingTop: 8,
                                  borderTop: `1px solid ${th.border}`,
                                  fontSize: 10, color: th.textMuted, fontWeight: 300,
                                }}>
                                  Drafted from {workspacePdfs.length} document{workspacePdfs.length !== 1 ? 's' : ''} in this workspace · review before use
                                </div>
                              </>
                            ) : (
                              <div style={{ fontSize: 11, color: th.textMuted, fontWeight: 300, fontStyle: 'italic' }}>
                                Loading…
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── STATUS BAR ── */}
        <div className="status-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {(() => {
              const indexed = workspacePdfs.filter(p => p.status === 'INDEXED').length;
              const failed = workspacePdfs.filter(p => p.status && /FAIL/i.test(p.status)).length;
              const pending = workspacePdfs.length - indexed - failed;
              const dot = failed > 0 ? '#e85d5d' : pending > 0 ? '#7b9fd4' : '#4ade80';
              return (
                <>
                  <div style={{ width: 5, height: 5, borderRadius: '50%', background: dot }} />
                  <span style={{ fontSize: 10, color: th.textMuted, fontWeight: 300 }}>
                    {indexed}/{workspacePdfs.length} doc{workspacePdfs.length !== 1 ? 's' : ''} indexed
                    {pending > 0 && ` · ${pending} processing`}
                    {failed > 0 && ` · ${failed} failed`}
                  </span>
                </>
              );
            })()}
          </div>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 10, color: th.textMuted, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 500 }}>
            Radium · {chatMode === 'internet' ? 'Web Mode' : 'RAG Mode'}
          </span>
        </div>
      </div>
    </>
  );
}
