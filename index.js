// BananaTalk — 실리태번 보조 메신저 창
// 메인 채팅은 건드리지 않고, 연결 프로필로 별도 대화를 한다.
// 기록은 data/<user>/user/files/bananatalk-<key>.json 에 채팅 파일별로 저장된다.

const MODULE = 'bananatalk';
const FILE_PREFIX = 'bananatalk-';
const LS_KEY = 'bananatalk_window';

const ctx = () => SillyTavern.getContext();

const DEFAULTS = Object.freeze({
    enabled: true,
    profileId: '',
    defaultMode: 'assistant',     // character | director | assistant
    stream: true,
    maxTokens: 600,
    minChars: 0,                  // 0 = 지시 안 함
    maxChars: 0,                  // 0 = 지시 안 함
    ctxMessages: 12,
    ctxMsgChars: 1500,
    ctxCard: true,
    ctxPersona: true,
    ctxWorldInfo: false,
    customSystem: '',             // 모든 모드 앞에 붙는 추가 지시
    theme: 'st',                  // st | kakao | telegram | dark | mint
    opacity: 100,
    hoverOpaque: true,
    fontSize: 14,
    selectionButton: true,
    mobileSheet: true,
    showAvatar: true,
    cacheVer: 1,
});

const MODES = {
    character: { label: '캐릭터', icon: 'fa-masks-theater', desc: '캐릭터 말투로, 대화 맥락을 알고 답함' },
    director:  { label: '연출 상의', icon: 'fa-clapperboard', desc: '대화 맥락을 알고, 흐름·방향을 같이 고민하는 조수' },
    assistant: { label: '어시스턴트', icon: 'fa-robot', desc: '맥락 없이 일반 질의응답' },
};

const THEMES = {
    st: '실리태번 테마 따라가기',
    kakao: '노랑 메신저',
    telegram: '파랑 메신저',
    dark: '다크',
    mint: '민트',
};

let S;                       // settings
let state = {
    chatKey: null,
    data: null,              // { v, chatKey, label, threads:[], active }
    open: false,
    generating: false,
    abort: null,
    saveTimer: null,
    loadedKey: null,
    settingsMoved: false,
    minimized: false,
};

// ---------- 유틸 ----------
function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c])); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function ls(key, val) {
    try {
        if (val === undefined) { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }
        localStorage.setItem(key, JSON.stringify(val));
    } catch { return null; }
}
function timeStr(ts) {
    const d = new Date(ts || Date.now());
    const h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0');
    return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${m}`;
}
function trimMiddle(text, max) {
    if (!text || text.length <= max) return text ?? '';
    const head = Math.floor(max * 0.3), tail = max - head;
    return text.slice(0, head) + '\n[…]\n' + text.slice(-tail);
}

// ---------- 설정 ----------
function loadSettings() {
    const es = ctx().extensionSettings;
    if (!es[MODULE]) es[MODULE] = {};
    S = es[MODULE];
    for (const k of Object.keys(DEFAULTS)) if (S[k] === undefined) S[k] = DEFAULTS[k];
    if (S.cacheVer !== DEFAULTS.cacheVer) { S.cacheVer = DEFAULTS.cacheVer; }
}
const saveSettings = () => ctx().saveSettingsDebounced();

// ---------- 채팅 키 ----------
function currentChatKey() {
    const c = ctx();
    if (c.groupId) {
        const g = (c.groups || []).find(x => x.id == c.groupId);
        if (!g) return null;
        return { key: `g:${g.id}:${g.chat_id}`, label: `${g.name} / ${g.chat_id}`, name: g.name, avatar: null };
    }
    if (c.characterId !== undefined && c.characters?.[c.characterId]) {
        const ch = c.characters[c.characterId];
        if (!ch.chat) return null;
        return { key: `c:${ch.avatar}:${ch.chat}`, label: `${ch.name} / ${ch.chat}`, name: ch.name, avatar: ch.avatar };
    }
    return null;
}
function fileNameFor(key) { return `${FILE_PREFIX}${hash(key)}.json`; }

// ---------- 저장/불러오기 (별도 파일) ----------
async function loadData(info) {
    const c = ctx();
    const key = info?.key || '_nochat';
    if (state.loadedKey === key && state.data) return;
    flushSave();
    state.chatKey = key;
    state.loadedKey = key;
    state.data = { v: 1, chatKey: key, label: info?.label || '(채팅 없음)', threads: [], active: null };
    try {
        const res = await fetch(`/user/files/${fileNameFor(key)}?t=${Date.now()}`, { headers: c.getRequestHeaders(), cache: 'no-cache' });
        if (res.ok) {
            const json = await res.json();
            if (json && Array.isArray(json.threads)) state.data = { ...state.data, ...json, chatKey: key };
        }
    } catch (e) { console.warn('[BananaTalk] load failed', e); }
    if (!state.data.threads.length) newThread(S.defaultMode, false);
    if (!state.data.threads.find(t => t.id === state.data.active)) state.data.active = state.data.threads[0].id;
    render();
}
function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(flushSave, 800);
}
async function flushSave() {
    clearTimeout(state.saveTimer); state.saveTimer = null;
    if (!state.data || !state.chatKey) return;
    const c = ctx();
    try {
        const bytes = new TextEncoder().encode(JSON.stringify(state.data));
        let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        const res = await fetch('/api/files/upload', {
            method: 'POST', headers: c.getRequestHeaders(),
            body: JSON.stringify({ name: fileNameFor(state.chatKey), data: btoa(bin) }),
        });
        if (!res.ok) throw new Error(await res.text());
    } catch (e) { console.error('[BananaTalk] save failed', e); toast('저장 실패: ' + (e.message || e), 'error'); }
}
async function deleteDataFile() {
    const c = ctx();
    try {
        await fetch('/api/files/delete', { method: 'POST', headers: c.getRequestHeaders(), body: JSON.stringify({ path: `/user/files/${fileNameFor(state.chatKey)}` }) });
    } catch (e) { console.warn(e); }
}
function toast(msg, type = 'info') { try { toastr[type](msg, 'BananaTalk'); } catch { console.log(msg); } }

// ---------- 스레드 ----------
function activeThread() { return state.data?.threads.find(t => t.id === state.data.active); }
function newThread(mode, doRender = true) {
    const t = { id: uid(), title: '', mode: mode || S.defaultMode, createdAt: Date.now(), messages: [] };
    state.data.threads.push(t);
    state.data.active = t.id;
    scheduleSave();
    if (doRender) render();
    return t;
}
function threadTitle(t) {
    if (t.title) return t.title;
    const first = t.messages.find(m => m.role === 'user');
    return first ? first.text.replace(/\s+/g, ' ').slice(0, 18) : '새 대화';
}

// ---------- 프롬프트 ----------
function recentChatLog() {
    const c = ctx();
    const n = Number(S.ctxMessages) || 0;
    if (!n || !Array.isArray(c.chat)) return [];
    const msgs = c.chat.filter(m => !m.is_system && m.mes).slice(-n);
    return msgs.map(m => ({ name: m.name, user: !!m.is_user, text: trimMiddle(String(m.mes), Number(S.ctxMsgChars) || 1500) }));
}
function cardText() {
    const c = ctx();
    const parts = [];
    try {
        if (c.groupId) {
            const g = (c.groups || []).find(x => x.id == c.groupId);
            for (const avatar of g?.members || []) {
                const idx = c.characters.findIndex(x => x.avatar === avatar);
                if (idx < 0) continue;
                const f = c.getCharacterCardFields({ chid: idx });
                parts.push(`### ${c.characters[idx].name}\n${trimMiddle(f.description || '', 2000)}\n${f.personality ? '성격: ' + f.personality : ''}`.trim());
            }
            if (g?.scenario || parts.length) parts.push(g?.scenario ? `시나리오: ${g.scenario}` : '');
        } else {
            const f = c.getCharacterCardFields();
            if (f.description) parts.push(f.description);
            if (f.personality) parts.push(`성격: ${f.personality}`);
            if (f.scenario) parts.push(`시나리오: ${f.scenario}`);
        }
    } catch (e) { console.warn('[BananaTalk] card fields', e); }
    return parts.filter(Boolean).join('\n\n');
}
function personaText() {
    try { return ctx().getCharacterCardFields().persona || ''; } catch { return ''; }
}
async function worldInfoText(log) {
    try {
        const c = ctx();
        const chatForWI = log.map(m => `${m.name}: ${m.text}`).reverse();
        const r = await c.getWorldInfoPrompt(chatForWI, c.maxContext || 8192, true);
        return (r?.worldInfoString || '').trim();
    } catch (e) { console.warn('[BananaTalk] world info', e); return ''; }
}
function lengthInstruction() {
    const out = [];
    if (Number(S.minChars) > 0) out.push(`답은 최소 ${S.minChars}자 이상으로 쓴다.`);
    if (Number(S.maxChars) > 0) out.push(`답은 ${S.maxChars}자를 넘기지 않는다.`);
    return out.join(' ');
}
async function buildPrompt(thread) {
    const c = ctx();
    const user = c.name1 || 'User';
    const charName = c.name2 || 'Character';
    const mode = thread.mode;
    const sys = [];
    if (S.customSystem?.trim()) sys.push(S.customSystem.trim());

    if (mode === 'assistant') {
        sys.push(`당신은 메신저 창 안의 유능한 어시스턴트다. ${user}의 질문에 정확하고 간결하게, 핵심부터 답한다. 모르면 모른다고 말한다. 사용자가 쓰는 언어로 답한다.`);
    } else {
        const log = recentChatLog();
        const blocks = [];
        if (S.ctxCard) { const t = cardText(); if (t) blocks.push(`[캐릭터 정보]\n${t}`); }
        if (S.ctxPersona) { const t = personaText(); if (t) blocks.push(`[${user} 정보]\n${t}`); }
        if (S.ctxWorldInfo) { const t = await worldInfoText(log); if (t) blocks.push(`[세계관 정보]\n${t}`); }
        if (log.length) blocks.push(`[최근 롤플레이 대화 — 마지막이 지금 장면]\n` + log.map(m => `${m.name}: ${m.text}`).join('\n\n'));

        if (mode === 'character') {
            sys.push(`당신은 ${charName}이다. 지금은 롤플레이 본편이 아니라, ${charName}과 ${user}가 메신저로 짧게 주고받는 사적인 채팅이다. ${charName}의 말투·성격·현재 관계와 감정을 그대로 유지하되, 메신저답게 짧고 자연스럽게 답한다. 서술이나 행동 묘사 대신 말로 한다. 아래 정보와 최근 대화를 알고 있다.`);
        } else {
            sys.push(`당신은 ${user}의 롤플레이를 돕는 작가 겸 연출 조수다. 캐릭터가 아니라 제3자로서(OOC) 말한다. 아래 캐릭터 정보와 최근 대화를 바탕으로 흐름 분석, 다음 전개 제안, 설정 질문, 사실 확인에 답한다. 메신저이므로 간결하게, 필요하면 선택지로 정리한다. 사용자가 쓰는 언어로 답한다.`);
        }
        if (blocks.length) sys.push(blocks.join('\n\n'));
    }
    const li = lengthInstruction();
    if (li) sys.push(li);

    const messages = [{ role: 'system', content: sys.join('\n\n') }];
    for (const m of thread.messages) {
        if (!m.text) continue;
        messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text });
    }
    return messages;
}

// ---------- 생성 ----------
function getProfile() {
    const CM = ctx().ConnectionManagerRequestService;
    let profiles = [];
    try { profiles = CM.getSupportedProfiles(); } catch { return { error: '연결 프로필 관리자(Connection Manager) 확장이 꺼져 있습니다.' }; }
    const p = profiles.find(x => x.id === S.profileId);
    if (!p) return { error: profiles.length ? '설정에서 연결 프로필을 고르세요.' : '연결 프로필이 없습니다. 먼저 프로필을 만드세요.' };
    return { profile: p };
}
async function send(text) {
    const t = activeThread();
    if (!t || state.generating) return;
    text = String(text || '').trim();
    if (!text) return;
    const { profile, error } = getProfile();
    if (error) { toast(error, 'warning'); return; }

    t.messages.push({ role: 'user', text, ts: Date.now() });
    const reply = { role: 'assistant', text: '', ts: Date.now(), pending: true };
    t.messages.push(reply);
    scheduleSave();
    renderMessages();
    setGenerating(true);
    const CM = ctx().ConnectionManagerRequestService;
    state.abort = new AbortController();
    try {
        const messages = await buildPrompt(t);
        const prompt = CM.constructPrompt(messages, profile.id);
        const maxTokens = clamp(Number(S.maxTokens) || 600, 16, 32768);
        const res = await CM.sendRequest(profile.id, prompt, maxTokens, {
            stream: !!S.stream, signal: state.abort.signal, extractData: true, includePreset: true, includeInstruct: true,
        });
        if (typeof res === 'function') {
            let last = 0;
            for await (const chunk of res()) {
                reply.text = chunk.text ?? '';
                if (chunk.state?.reasoning) reply.reasoning = chunk.state.reasoning;
                const now = performance.now();
                if (now - last > 60) { last = now; updateLastBubble(reply); }
            }
        } else {
            reply.text = res?.content ?? '';
            if (res?.reasoning) reply.reasoning = res.reasoning;
        }
        reply.text = reply.text.trim();
        if (!reply.text) reply.text = reply.reasoning ? '(본문이 비었습니다. 추론 모델이면 최대 토큰을 올려 보세요.)' : '(빈 응답)';
    } catch (e) {
        if (e?.name === 'AbortError' || state.abort?.signal.aborted) {
            reply.text = (reply.text || '').trim() || '(중단됨)';
        } else {
            console.error('[BananaTalk]', e);
            reply.text = `⚠️ ${e?.message || e}`;
            reply.error = true;
        }
    } finally {
        delete reply.pending;
        state.abort = null;
        setGenerating(false);
        scheduleSave();
        renderMessages();
    }
}
function stopGeneration() { try { state.abort?.abort(); } catch { /* ignore */ } }
function setGenerating(v) {
    state.generating = v;
    const win = document.getElementById('bananatalk_win');
    if (!win) return;
    win.classList.toggle('bt-generating', v);
    const sendBtn = win.querySelector('.bt-send');
    if (sendBtn) { sendBtn.classList.toggle('bt-stop', v); sendBtn.innerHTML = v ? '<i class="fa-solid fa-stop"></i>' : '<i class="fa-solid fa-paper-plane"></i>'; sendBtn.title = v ? '중단' : '보내기'; }
}

// ---------- UI: 창 ----------
function ensureWindow() {
    if (document.getElementById('bananatalk_win')) return;
    const win = document.createElement('div');
    win.id = 'bananatalk_win';
    win.innerHTML = `
      <div class="bt-head">
        <div class="bt-head-left">
          <img class="bt-avatar" alt="">
          <div class="bt-head-text">
            <div class="bt-title"></div>
            <div class="bt-sub"></div>
          </div>
        </div>
        <div class="bt-head-btns">
          <button class="bt-ib bt-threads-btn" title="대화 목록"><i class="fa-solid fa-bars"></i></button>
          <button class="bt-ib bt-settings-btn" title="설정"><i class="fa-solid fa-gear"></i></button>
          <button class="bt-ib bt-min-btn" title="접기"><i class="fa-solid fa-minus"></i></button>
          <button class="bt-ib bt-close-btn" title="닫기"><i class="fa-solid fa-xmark"></i></button>
        </div>
      </div>
      <div class="bt-tabs">
        <div class="bt-tabs-scroll"></div>
        <button class="bt-ib bt-new-btn" title="새 대화"><i class="fa-solid fa-plus"></i></button>
      </div>
      <div class="bt-modes"></div>
      <div class="bt-body">
        <div class="bt-panel bt-threads-panel"></div>
        <div class="bt-panel bt-settings-panel"><div class="bt-settings-host"></div></div>
        <div class="bt-msgs"></div>
      </div>
      <div class="bt-input">
        <textarea class="bt-text" rows="1" placeholder="메시지 입력"></textarea>
        <button class="bt-send" title="보내기"><i class="fa-solid fa-paper-plane"></i></button>
      </div>
      <div class="bt-sheet-handle"></div>`;
    document.body.appendChild(win);

    const q = s => win.querySelector(s);
    q('.bt-close-btn').addEventListener('click', () => toggleWindow(false));
    q('.bt-min-btn').addEventListener('click', () => { state.minimized = !state.minimized; win.classList.toggle('bt-minimized', state.minimized); });
    q('.bt-new-btn').addEventListener('click', () => { closePanels(); newThread(activeThread()?.mode || S.defaultMode); focusInput(); });
    q('.bt-threads-btn').addEventListener('click', () => togglePanel('threads'));
    q('.bt-settings-btn').addEventListener('click', () => togglePanel('settings'));
    const ta = q('.bt-text');
    ta.addEventListener('input', autosize);
    ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !ctx().isMobile()) { e.preventDefault(); submit(); }
    });
    q('.bt-send').addEventListener('click', () => state.generating ? stopGeneration() : submit());
    q('.bt-modes').addEventListener('click', (e) => {
        const b = e.target.closest('[data-mode]'); if (!b) return;
        const t = activeThread(); if (!t) return;
        t.mode = b.dataset.mode; scheduleSave(); renderHeader(); renderModes();
    });
    q('.bt-tabs-scroll').addEventListener('click', (e) => {
        const b = e.target.closest('[data-tid]'); if (!b) return;
        state.data.active = b.dataset.tid; scheduleSave(); closePanels(); render();
    });
    win.addEventListener('pointerdown', () => win.classList.add('bt-active'));
    document.addEventListener('pointerdown', (e) => { if (!win.contains(e.target)) win.classList.remove('bt-active'); });

    setupDrag(win);
    setupResize(win);
    applyLook();
    applyGeometry();
}
function submit() {
    const ta = document.querySelector('#bananatalk_win .bt-text');
    const text = ta.value; if (!text.trim()) return;
    ta.value = ''; autosize({ target: ta });
    send(text);
}
function autosize(e) {
    const ta = e.target; ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
}
function focusInput() { if (!ctx().isMobile()) document.querySelector('#bananatalk_win .bt-text')?.focus(); }
function togglePanel(name) {
    const win = document.getElementById('bananatalk_win');
    const was = win.dataset.panel === name;
    closePanels();
    if (was) return;
    win.dataset.panel = name;
    if (name === 'threads') renderThreadsPanel();
    if (name === 'settings') moveSettingsIntoWindow();
}
function closePanels() { const win = document.getElementById('bananatalk_win'); if (win) delete win.dataset.panel; }

function toggleWindow(force) {
    ensureWindow();
    const win = document.getElementById('bananatalk_win');
    state.open = force === undefined ? !state.open : !!force;
    win.classList.toggle('bt-open', state.open);
    document.getElementById('bananatalk_toggle')?.classList.toggle('bt-on', state.open);
    if (state.open) { state.minimized = false; win.classList.remove('bt-minimized'); applyGeometry(); render(); focusInput(); }
}

// ---------- UI: 그리기 ----------
function render() {
    const win = document.getElementById('bananatalk_win');
    if (!win || !state.data) return;
    renderHeader(); renderTabs(); renderModes(); renderMessages();
    if (win.dataset.panel === 'threads') renderThreadsPanel();
}
function renderHeader() {
    const win = document.getElementById('bananatalk_win');
    const t = activeThread(); const c = ctx();
    const info = currentChatKey();
    const img = win.querySelector('.bt-avatar');
    if (S.showAvatar && info?.avatar) { img.src = c.getThumbnailUrl('avatar', info.avatar); img.style.display = ''; }
    else { img.removeAttribute('src'); img.style.display = 'none'; }
    const name = t?.mode === 'character' ? (info?.name || c.name2 || '캐릭터') : t?.mode === 'director' ? '연출 조수' : '어시스턴트';
    win.querySelector('.bt-title').textContent = name;
    const { profile, error } = getProfile();
    win.querySelector('.bt-sub').textContent = error ? `⚠ ${error}` : `${profile.name} · ${info ? info.label : '채팅 없음'}`;
    win.querySelector('.bt-sub').classList.toggle('bt-warn', !!error);
}
function renderTabs() {
    const host = document.querySelector('#bananatalk_win .bt-tabs-scroll');
    host.innerHTML = state.data.threads.map(t => `<button class="bt-tab ${t.id === state.data.active ? 'bt-sel' : ''}" data-tid="${t.id}" title="${esc(threadTitle(t))}"><i class="fa-solid ${MODES[t.mode]?.icon || 'fa-comment'}"></i><span>${esc(threadTitle(t))}</span></button>`).join('');
    host.querySelector('.bt-sel')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function renderModes() {
    const host = document.querySelector('#bananatalk_win .bt-modes');
    const t = activeThread();
    host.innerHTML = Object.entries(MODES).map(([k, m]) => `<button class="bt-mode ${t?.mode === k ? 'bt-sel' : ''}" data-mode="${k}" title="${esc(m.desc)}"><i class="fa-solid ${m.icon}"></i> ${m.label}</button>`).join('');
}
function bubbleHtml(m, idx, charName) {
    const c = ctx();
    const isUser = m.role === 'user';
    let body;
    try { body = c.messageFormatting(m.text, isUser ? c.name1 : charName, false, isUser, -1); } catch { body = esc(m.text).replace(/\n/g, '<br>'); }
    if (m.pending && !m.text) body = '<span class="bt-typing"><i></i><i></i><i></i></span>';
    return `<div class="bt-row ${isUser ? 'bt-me' : 'bt-them'} ${m.error ? 'bt-err' : ''}" data-idx="${idx}">
      <div class="bt-bubble">${body}</div>
      <div class="bt-meta"><span class="bt-time">${timeStr(m.ts)}</span>
        <button class="bt-mb bt-copy" title="복사"><i class="fa-solid fa-copy"></i></button>
        <button class="bt-mb bt-del" title="삭제"><i class="fa-solid fa-trash"></i></button></div>
    </div>`;
}
function renderMessages() {
    const win = document.getElementById('bananatalk_win');
    const host = win.querySelector('.bt-msgs');
    const t = activeThread(); if (!t) { host.innerHTML = ''; return; }
    const info = currentChatKey();
    const charName = t.mode === 'character' ? (info?.name || ctx().name2 || '') : t.mode === 'director' ? '연출 조수' : '어시스턴트';
    const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 40;
    const prevTop = host.scrollTop;
    if (!t.messages.length) {
        host.innerHTML = `<div class="bt-empty"><i class="fa-solid ${MODES[t.mode].icon}"></i><div>${esc(MODES[t.mode].desc)}</div><div class="bt-empty-hint">메인 채팅에는 아무 영향이 없습니다.</div></div>`;
        return;
    }
    host.innerHTML = t.messages.map((m, i) => bubbleHtml(m, i, charName)).join('');
    host.querySelectorAll('.bt-copy').forEach(b => b.addEventListener('click', (e) => {
        const i = Number(e.currentTarget.closest('.bt-row').dataset.idx);
        navigator.clipboard?.writeText(t.messages[i]?.text || '').then(() => toast('복사했습니다')).catch(() => {});
    }));
    host.querySelectorAll('.bt-del').forEach(b => b.addEventListener('click', (e) => {
        const i = Number(e.currentTarget.closest('.bt-row').dataset.idx);
        if (state.generating) return;
        t.messages.splice(i, 1); scheduleSave(); renderMessages(); renderTabs();
    }));
    host.scrollTop = atBottom || state.generating ? host.scrollHeight : prevTop;
}
function updateLastBubble(m) {
    const host = document.querySelector('#bananatalk_win .bt-msgs');
    const row = host?.querySelector('.bt-row:last-child .bt-bubble');
    if (!row) return;
    const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 80;
    row.textContent = m.text;
    if (atBottom) host.scrollTop = host.scrollHeight;
}
function renderThreadsPanel() {
    const host = document.querySelector('#bananatalk_win .bt-threads-panel');
    host.innerHTML = `<div class="bt-panel-title">대화 목록 <span class="bt-dim">(${esc(state.data.label)})</span></div>` +
        state.data.threads.map(t => `<div class="bt-thread-item ${t.id === state.data.active ? 'bt-sel' : ''}" data-tid="${t.id}">
            <i class="fa-solid ${MODES[t.mode]?.icon}"></i>
            <input class="bt-thread-title" value="${esc(threadTitle(t))}" title="이름 바꾸기">
            <span class="bt-dim">${t.messages.length}</span>
            <button class="bt-ib bt-thread-clear" title="내용 비우기"><i class="fa-solid fa-broom"></i></button>
            <button class="bt-ib bt-thread-del" title="대화 삭제"><i class="fa-solid fa-trash"></i></button>
        </div>`).join('') +
        `<div class="bt-panel-foot"><button class="bt-btn bt-wipe">이 채팅의 BananaTalk 기록 전부 삭제</button></div>`;
    host.querySelectorAll('.bt-thread-item').forEach(el => {
        const t = state.data.threads.find(x => x.id === el.dataset.tid);
        el.addEventListener('click', (e) => { if (e.target.closest('input,button')) return; state.data.active = t.id; scheduleSave(); closePanels(); render(); });
        el.querySelector('.bt-thread-title').addEventListener('change', (e) => { t.title = e.target.value.trim(); scheduleSave(); renderTabs(); });
        el.querySelector('.bt-thread-clear').addEventListener('click', () => { t.messages = []; scheduleSave(); render(); });
        el.querySelector('.bt-thread-del').addEventListener('click', () => {
            state.data.threads = state.data.threads.filter(x => x !== t);
            if (!state.data.threads.length) newThread(S.defaultMode, false);
            if (state.data.active === t.id) state.data.active = state.data.threads[0].id;
            scheduleSave(); render();
        });
    });
    host.querySelector('.bt-wipe').addEventListener('click', async () => {
        const ok = await ctx().Popup.show.confirm('BananaTalk', '이 채팅에 귀속된 BananaTalk 대화를 모두 지웁니다. 메인 채팅은 그대로입니다.');
        if (!ok) return;
        state.data.threads = []; newThread(S.defaultMode, false);
        await deleteDataFile(); scheduleSave(); closePanels(); render();
    });
}

// ---------- 모양·위치 ----------
function applyLook() {
    const win = document.getElementById('bananatalk_win'); if (!win) return;
    win.dataset.theme = S.theme;
    win.style.setProperty('--bt-opacity', clamp(Number(S.opacity) || 100, 15, 100) / 100);
    win.style.setProperty('--bt-font', (Number(S.fontSize) || 14) + 'px');
    win.classList.toggle('bt-hover-opaque', !!S.hoverOpaque);
    win.classList.toggle('bt-sheet', isSheet());
}
function isSheet() { return S.mobileSheet && ctx().isMobile(); }
function applyGeometry() {
    const win = document.getElementById('bananatalk_win'); if (!win) return;
    if (isSheet()) { positionSheet(); return; }
    win.style.bottom = ''; win.style.right = '';
    const g = ls(LS_KEY) || {};
    const w = clamp(g.w || 360, 260, window.innerWidth), h = clamp(g.h || 520, 240, window.innerHeight);
    const x = clamp(g.x ?? (window.innerWidth - w - 24), 0, Math.max(0, window.innerWidth - w));
    const y = clamp(g.y ?? 80, 0, Math.max(0, window.innerHeight - h));
    Object.assign(win.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
}
function saveGeometry() {
    const win = document.getElementById('bananatalk_win'); if (!win || isSheet()) return;
    const r = win.getBoundingClientRect();
    ls(LS_KEY, { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), sheetH: (ls(LS_KEY) || {}).sheetH });
}
function positionSheet() {
    const win = document.getElementById('bananatalk_win'); if (!win) return;
    const form = document.getElementById('send_form');
    const vv = window.visualViewport;
    const vh = vv ? vv.height : window.innerHeight;
    const formTop = form ? form.getBoundingClientRect().top : vh;
    const g = ls(LS_KEY) || {};
    const h = clamp(g.sheetH || Math.round(vh * 0.55), 160, Math.max(160, formTop - 8));
    Object.assign(win.style, { left: '0px', width: '100%', right: '', bottom: '', top: Math.max(0, formTop - h) + 'px', height: h + 'px' });
}
function setupDrag(win) {
    const head = win.querySelector('.bt-head');
    let drag = null;
    head.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button,input,select') || isSheet()) return;
        const r = win.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
        head.setPointerCapture(e.pointerId); win.classList.add('bt-dragging');
    });
    head.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const r = win.getBoundingClientRect();
        const x = clamp(e.clientX - drag.dx, 0, window.innerWidth - r.width);
        const y = clamp(e.clientY - drag.dy, 0, window.innerHeight - r.height);
        win.style.left = x + 'px'; win.style.top = y + 'px';
    });
    const end = () => { if (!drag) return; drag = null; win.classList.remove('bt-dragging'); saveGeometry(); };
    head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end);

    // 모바일 시트: 손잡이로 높이 조절
    const handle = win.querySelector('.bt-sheet-handle');
    let sh = null;
    handle.addEventListener('pointerdown', (e) => { sh = { y: e.clientY, h: win.getBoundingClientRect().height }; handle.setPointerCapture(e.pointerId); });
    handle.addEventListener('pointermove', (e) => {
        if (!sh) return;
        const g = ls(LS_KEY) || {}; g.sheetH = clamp(sh.h + (sh.y - e.clientY), 160, window.innerHeight - 60); ls(LS_KEY, g); positionSheet();
    });
    handle.addEventListener('pointerup', () => { sh = null; }); handle.addEventListener('pointercancel', () => { sh = null; });
}
function setupResize(win) {
    let t;
    new ResizeObserver(() => { if (!state.open || isSheet()) return; clearTimeout(t); t = setTimeout(saveGeometry, 200); }).observe(win);
    window.addEventListener('resize', () => { if (state.open) applyGeometry(); });
    window.visualViewport?.addEventListener('resize', () => { if (state.open && isSheet()) positionSheet(); });
    window.visualViewport?.addEventListener('scroll', () => { if (state.open && isSheet()) positionSheet(); });
    const form = document.getElementById('send_form');
    if (form) new ResizeObserver(() => { if (state.open && isSheet()) positionSheet(); }).observe(form);
}

// ---------- 메인 채팅 글자 선택 → 물어보기 ----------
function setupSelectionButton() {
    const btn = document.createElement('button');
    btn.id = 'bananatalk_selbtn';
    btn.innerHTML = '<i class="fa-solid fa-comments"></i> 물어보기';
    btn.style.display = 'none';
    document.body.appendChild(btn);
    let text = '';
    const hide = () => { btn.style.display = 'none'; };
    const check = () => {
        if (!S.enabled || !S.selectionButton) return hide();
        const sel = window.getSelection();
        const s = sel?.toString().trim();
        if (!s || !sel.rangeCount) return hide();
        const node = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
        if (!node?.closest('#chat .mes_text')) return hide();
        text = s;
        const r = sel.getRangeAt(0).getBoundingClientRect();
        btn.style.display = '';
        const bw = btn.offsetWidth || 90;
        btn.style.left = clamp(r.left + r.width / 2 - bw / 2, 4, window.innerWidth - bw - 4) + 'px';
        btn.style.top = Math.max(4, r.top - 36) + 'px';
    };
    document.addEventListener('selectionchange', () => { clearTimeout(check._t); check._t = setTimeout(check, 150); });
    document.addEventListener('pointerdown', (e) => { if (e.target !== btn && !btn.contains(e.target)) hide(); });
    btn.addEventListener('pointerdown', e => e.preventDefault());
    btn.addEventListener('click', () => {
        hide();
        toggleWindow(true);
        const ta = document.querySelector('#bananatalk_win .bt-text');
        const quoted = text.split('\n').map(l => '> ' + l).join('\n');
        ta.value = (ta.value ? ta.value + '\n' : '') + quoted + '\n';
        autosize({ target: ta }); focusInput();
        ta.selectionStart = ta.selectionEnd = ta.value.length;
    });
}

// ---------- 설정 패널 ----------
function settingsHtml() {
    const opt = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(v.label ?? v)}</option>`).join('');
    const num = (key, label, min, max, step = 1, hint = '') => `<label class="bt-f bt-f-num"><span>${label}${hint ? `<small>${hint}</small>` : ''}</span><input type="number" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${S[key]}"></label>`;
    const chk = (key, label) => `<label class="bt-f bt-f-chk checkbox_label"><input type="checkbox" data-key="${key}" ${S[key] ? 'checked' : ''}><span>${label}</span></label>`;
    return `
    <div class="bt-settings">
      ${chk('enabled', '사용')}
      <label class="bt-f"><span>연결 프로필</span>
        <div class="bt-f-row"><select data-key="profileId" class="bt-profile text_pole"></select><button class="bt-ib bt-profile-refresh" title="목록 새로고침"><i class="fa-solid fa-rotate"></i></button></div>
        <small class="bt-dim">메인 API와 별개로 쓸 연결 프로필입니다 (Connection Manager 확장 필요).</small></label>
      <details class="bt-group" data-group="gen" open><summary>생성</summary>
        <label class="bt-f"><span>새 대화 기본 모드</span><select data-key="defaultMode" class="text_pole">${opt(MODES, S.defaultMode)}</select></label>
        ${chk('stream', '스트리밍 응답')}
        ${num('maxTokens', '최대 토큰', 16, 32768, 1, '강제 적용')}
        ${num('minChars', '최소 글자 수', 0, 20000, 1, '0=끔 · 프롬프트 지시라 보장은 안 됨')}
        ${num('maxChars', '최대 글자 수', 0, 20000, 1, '0=끔 · 프롬프트 지시')}
        <label class="bt-f"><span>추가 지시 (모든 모드 앞에 붙음)</span><textarea data-key="customSystem" class="text_pole" rows="2">${esc(S.customSystem)}</textarea></label>
      </details>
      <details class="bt-group" data-group="ctx"><summary>맥락 (캐릭터·연출 상의 모드)</summary>
        ${num('ctxMessages', '최근 메시지 수', 0, 200)}
        ${num('ctxMsgChars', '메시지당 최대 글자', 200, 20000, 100, '넘치면 앞 30%·끝 70%만')}
        ${chk('ctxCard', '캐릭터 카드(설명·성격·시나리오)')}
        ${chk('ctxPersona', '페르소나')}
        ${chk('ctxWorldInfo', '월드 인포 (최근 메시지로 스캔)')}
      </details>
      <details class="bt-group" data-group="look"><summary>모양</summary>
        <label class="bt-f"><span>테마</span><select data-key="theme" class="text_pole">${opt(THEMES, S.theme)}</select></label>
        <label class="bt-f"><span>투명도 <b class="bt-opacity-val">${S.opacity}</b>%</span><input type="range" data-key="opacity" min="15" max="100" value="${S.opacity}"></label>
        ${chk('hoverOpaque', '마우스 올리면 선명하게')}
        ${num('fontSize', '글자 크기(px)', 10, 24)}
        ${chk('showAvatar', '캐릭터 아바타 표시')}
        ${chk('selectionButton', '메인 채팅 글자 선택 시 "물어보기" 버튼')}
        ${chk('mobileSheet', '모바일에서 하단 시트로')}
        <div class="bt-f"><button class="bt-btn bt-reset-pos">창 위치·크기 초기화</button></div>
      </details>
      <div class="bt-f bt-settings-back" style="display:none"><button class="bt-btn bt-settings-return">설정을 확장 탭으로 되돌리기</button></div>
    </div>`;
}
function fillProfiles(sel) {
    let profiles = []; let err = '';
    try { profiles = ctx().ConnectionManagerRequestService.getSupportedProfiles(); } catch (e) { err = e.message; }
    sel.innerHTML = `<option value="">${err ? '(연결 프로필 관리자 꺼짐)' : '— 선택 —'}</option>` + profiles.map(p => `<option value="${esc(p.id)}" ${p.id === S.profileId ? 'selected' : ''}>${esc(p.name)} (${esc(p.api || p.mode || '')})</option>`).join('');
}
function bindSettings(root) {
    fillProfiles(root.querySelector('.bt-profile'));
    root.querySelector('.bt-profile-refresh').addEventListener('click', () => fillProfiles(root.querySelector('.bt-profile')));
    root.querySelectorAll('[data-key]').forEach(el => {
        const key = el.dataset.key;
        const ev = el.type === 'range' ? 'input' : 'change';
        el.addEventListener(ev, () => {
            if (el.type === 'checkbox') S[key] = el.checked;
            else if (el.type === 'number' || el.type === 'range') S[key] = Number(el.value);
            else S[key] = el.value;
            if (key === 'opacity') root.querySelector('.bt-opacity-val').textContent = S.opacity;
            saveSettings();
            applyLook(); applyGeometry();
            if (key === 'enabled') updateEnabled();
            if (key === 'profileId') renderHeader();
        });
    });
    root.querySelectorAll('details.bt-group').forEach(d => {
        const k = 'bananatalk_grp_' + d.dataset.group;
        const saved = ls(k); if (saved !== null) d.open = saved;
        d.addEventListener('toggle', () => ls(k, d.open));
    });
    root.querySelector('.bt-reset-pos').addEventListener('click', () => { ls(LS_KEY, {}); applyGeometry(); });
    root.querySelector('.bt-settings-return').addEventListener('click', returnSettings);
}
function addSettingsDrawer() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    const drawer = document.createElement('div');
    drawer.id = 'bananatalk_settings';
    drawer.className = 'bananatalk-settings-drawer';
    drawer.innerHTML = `<div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header"><b>BananaTalk</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
      <div class="inline-drawer-content">
        <div class="bt-drawer-body"></div>
        <div class="bt-drawer-moved" style="display:none">설정이 BananaTalk 창 안에 있습니다. <a href="#" class="bt-drawer-bring">여기로 가져오기</a></div>
        <div class="bt-f"><button class="menu_button bt-open-win"><i class="fa-solid fa-comments"></i> 창 열기</button></div>
      </div></div>`;
    host.appendChild(drawer);
    const body = drawer.querySelector('.bt-drawer-body');
    body.innerHTML = settingsHtml();
    bindSettings(body.firstElementChild);
    drawer.querySelector('.bt-drawer-bring').addEventListener('click', (e) => { e.preventDefault(); returnSettings(); });
    drawer.querySelector('.bt-open-win').addEventListener('click', () => toggleWindow(true));
}
function moveSettingsIntoWindow() {
    const el = document.querySelector('#bananatalk_settings .bt-settings');
    const host = document.querySelector('#bananatalk_win .bt-settings-host');
    if (!el || !host) return;
    host.appendChild(el);
    el.querySelector('.bt-settings-back').style.display = '';
    const moved = document.querySelector('#bananatalk_settings .bt-drawer-moved'); if (moved) moved.style.display = '';
    state.settingsMoved = true;
}
function returnSettings() {
    const el = document.querySelector('#bananatalk_win .bt-settings');
    const body = document.querySelector('#bananatalk_settings .bt-drawer-body');
    if (el && body) { body.appendChild(el); el.querySelector('.bt-settings-back').style.display = 'none'; }
    const moved = document.querySelector('#bananatalk_settings .bt-drawer-moved'); if (moved) moved.style.display = 'none';
    state.settingsMoved = false; closePanels();
}

// ---------- ST에 붙이기 ----------
function addToggleButton() {
    const form = document.getElementById('rightSendForm');
    if (!form || document.getElementById('bananatalk_toggle')) return;
    const b = document.createElement('div');
    b.id = 'bananatalk_toggle';
    b.className = 'fa-solid fa-comments interactable';
    b.title = 'BananaTalk';
    b.tabIndex = 0;
    b.addEventListener('click', () => toggleWindow());
    form.prepend(b);
}
function addWandMenu() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const c = document.createElement('div');
    c.className = 'extension_container'; c.id = 'bananatalk_wand';
    c.innerHTML = '<div class="list-group-item flex-container flexGap5 interactable" tabindex="0"><div class="fa-solid fa-comments extensionsMenuExtensionButton"></div><span>BananaTalk</span></div>';
    c.firstElementChild.addEventListener('click', () => toggleWindow());
    menu.appendChild(c);
}
function addSlashCommand() {
    const c = ctx();
    try {
        c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
            name: 'bananatalk',
            aliases: ['btalk'],
            callback: async (_args, value) => {
                toggleWindow(true);
                const text = String(value || '').trim();
                if (text) await send(text);
                return activeThread()?.messages.at(-1)?.text || '';
            },
            unnamedArgumentList: [c.SlashCommandArgument.fromProps({ description: '보낼 메시지(없으면 창만 엶)', typeList: ['string'], isRequired: false })],
            helpString: 'BananaTalk 창을 열고, 메시지가 있으면 현재 대화에 보냅니다. 답장을 반환합니다.',
            returns: '마지막 답장',
        }));
    } catch (e) { console.warn('[BananaTalk] slash', e); }
}
function updateEnabled() {
    document.getElementById('bananatalk_toggle')?.classList.toggle('bt-hidden', !S.enabled);
    document.getElementById('bananatalk_wand')?.classList.toggle('bt-hidden', !S.enabled);
    if (!S.enabled) toggleWindow(false);
}
async function onChatChanged() {
    const info = currentChatKey();
    await loadData(info);
}

jQuery(async () => {
    loadSettings();
    addSettingsDrawer();
    addToggleButton();
    addWandMenu();
    addSlashCommand();
    setupSelectionButton();
    ensureWindow();
    updateEnabled();
    const c = ctx();
    c.eventSource.on(c.eventTypes.CHAT_CHANGED, onChatChanged);
    c.eventSource.on(c.eventTypes.CONNECTION_PROFILE_LOADED, () => { const s = document.querySelector('.bt-profile'); if (s) fillProfiles(s); renderHeader(); });
    if (c.eventTypes.MESSAGE_RECEIVED) c.eventSource.on(c.eventTypes.MESSAGE_RECEIVED, () => { if (state.open) renderHeader(); });
    window.addEventListener('beforeunload', () => { if (state.saveTimer) flushSave(); });
    await onChatChanged();
    globalThis.BananaTalk = { state, settings: S, send, toggleWindow, buildPrompt, activeThread, newThread };
});
