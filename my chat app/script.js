// script.js - Client-side only chat demo
// Features:
// - "Login" with phone number (stored in localStorage)
// - Message persistence in localStorage under 'qc_messages'
// - Real-time sync across tabs using BroadcastChannel (fallback to storage events)
// - Simple presence list built from recent heartbeats

(() => {
  // Utils
  const $ = sel => document.querySelector(sel);
  const qs = sel => [...document.querySelectorAll(sel)];
  const now = () => new Date().toISOString();
  const humanTime = ts => new Date(ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});

  // DOM
  const loginModal = $('#loginModal');
  const loginForm = $('#loginForm');
  const phoneInput = $('#phone');
  const displayInput = $('#display');
  const joinBtn = $('#joinBtn');
  const meCard = $('#meCard');
  const meAvatar = $('#meAvatar');
  const mePhone = $('#mePhone');
  const logoutBtn = $('#logoutBtn');
  const usersList = $('#usersList');
  const messagesBox = $('#messages');
  const composer = $('#composer');
  const msgInput = $('#msgInput');
  const emojiBtn = $('#emojiBtn');

  // Storage keys
  const KEY_USER = 'qc_user';
  const KEY_MESSAGES = 'qc_messages';
  const KEY_PRESENCE = 'qc_presence';

  // Local state
  let me = null;
  let messages = []; // array of {id, from, phone, text, ts}
  let presence = {}; // phone -> {phone, name, lastSeen, color}
  // UI state
  let unreadCount = 0;
  let pageFocused = true;

  window.addEventListener('focus', ()=>{ pageFocused = true; unreadCount = 0; updateTitle(); });
  window.addEventListener('blur', ()=>{ pageFocused = false; });

  function updateTitle(){
    document.title = unreadCount > 0 ? `(${unreadCount}) QuickChat` : 'QuickChat — Phone Login Demo';
  }

  function flashWindow(){
    document.body.classList.add('flash');
    setTimeout(()=>document.body.classList.remove('flash'), 350);
  }

  // Attachments storage (IndexedDB)
  const DB_NAME = 'quickchat_db_v1';
  const DB_VERSION = 1;
  let dbPromise = null;
  function openDB(){
    if(dbPromise) return dbPromise;
    dbPromise = new Promise((res, rej)=>{
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if(!db.objectStoreNames.contains('attachments')) db.createObjectStore('attachments', {keyPath:'id'});
      };
      req.onsuccess = (e)=> res(e.target.result);
      req.onerror = (e)=> rej(e.target.error);
    });
    return dbPromise;
  }

  async function saveAttachment(blob, name){
    const id = genId();
    const rec = {id, name: name || 'file', type: blob.type || '', size: blob.size || 0, ts: Date.now()};
    const db = await openDB();
    return new Promise((res, rej)=>{
      const tx = db.transaction('attachments','readwrite');
      const store = tx.objectStore('attachments');
      const putReq = store.put(Object.assign({}, rec, {blob}));
      putReq.onsuccess = ()=> res(id);
      putReq.onerror = (e)=> rej(e);
    });
  }

  async function getAttachment(id){
    const db = await openDB();
    return new Promise((res, rej)=>{
      const tx = db.transaction('attachments','readonly');
      const store = tx.objectStore('attachments');
      const req = store.get(id);
      req.onsuccess = ()=> res(req.result);
      req.onerror = (e)=> rej(e);
    });
  }

  // Pending attachments (before send)
  let pendingAttachments = []; // {file, name, type, size, previewUrl}

  // Cross-tab comms
  const channelName = 'quickchat_channel_v1';
  let bc = null;
  if ('BroadcastChannel' in window) {
    bc = new BroadcastChannel(channelName);
    bc.onmessage = e => handleIncoming(e.data);
  } else {
    window.addEventListener('storage', (e) => {
      if (e.key === 'qc_broadcast' && e.newValue) {
        try { const data = JSON.parse(e.newValue); handleIncoming(data); } catch(e){}
      }
    });
  }

  function broadcast(obj){
    if (bc) bc.postMessage(obj);
    else localStorage.setItem('qc_broadcast', JSON.stringify(obj));
  }

  // Seed messages from storage
  function loadMessages(){
    try { messages = JSON.parse(localStorage.getItem(KEY_MESSAGES) || '[]'); } catch(e){ messages = []; }
  }
  function saveMessages(){ localStorage.setItem(KEY_MESSAGES, JSON.stringify(messages)); }

  // Presence (lightweight heartbeat)
  function loadPresence(){ try { presence = JSON.parse(localStorage.getItem(KEY_PRESENCE) || '{}'); } catch(e){ presence = {}; } }
  function savePresence(){ localStorage.setItem(KEY_PRESENCE, JSON.stringify(presence)); }
  function touchPresence(){ if(!me) return; presence[me.phone] = {phone:me.phone,name:me.name || '',lastSeen:Date.now(),color:me.color}; savePresence(); broadcast({type:'presence',payload:presence}); }

  // Utility color by phone
  function colorFromPhone(s){ let h=0; for(let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i))|0; const r = Math.abs(h)%360; return `hsl(${r}deg 80% 55%)`; }

  // Rendering
  function renderUI(){
    // me
    if(me){
      meCard.hidden = false;
      meAvatar.textContent = (me.name && me.name[0]) || 'U';
      meAvatar.style.background = me.color;
      mePhone.textContent = `${me.name?me.name + ' • ':''}${me.phone}`;
      loginModal.style.display = 'none';
      $('#headerSubtitle').textContent = 'Public room — all logged-in tabs share messages';
    } else {
      meCard.hidden = true;
      loginModal.style.display = 'flex';
    }

    // users list from presence (filter recent)
    const nowms = Date.now();
    const active = Object.values(presence).filter(p => nowms - p.lastSeen < 60_000).sort((a,b)=> b.lastSeen - a.lastSeen);
    usersList.innerHTML = active.map(u => `
      <li class="user-item">
        <div class="avatar" style="background:${u.color}">${(u.name&&u.name[0])||u.phone[0]}</div>
        <div style="flex:1">
          <div style="font-weight:700">${u.name||u.phone}</div>
          <div class="muted small">${Math.floor((nowms - u.lastSeen)/1000)}s ago</div>
        </div>
      </li>
    `).join('') || '<div class="muted small">No one else online</div>';

    // messages
    messagesBox.innerHTML = messages.map(m => {
      const cls = (me && m.from === me.phone) ? 'msg me' : 'msg you';
      const attachAttr = (m.attachments && m.attachments.length) ? ` data-ids="${m.attachments.map(a=>a.id).join(',')}"` : '';
      const attachBlock = (m.attachments && m.attachments.length) ? `<div class="attachments"${attachAttr}></div>` : '';
      return `
        <div class="${cls}" data-id="${m.id}">
          <div class="body">${escapeHtml(m.text)}</div>
          ${attachBlock}
          <div class="meta"><span class="sender">${m.fromName||m.from}</span><span>•</span><span>${humanTime(m.ts)}</span></div>
        </div>
      `;
    }).join('');

    // auto-scroll
    messagesBox.scrollTop = messagesBox.scrollHeight;

    // load attachment blobs and populate UI
    populateAttachments();
  }

  // Message handling
  async function sendMessage(text){
    if(!me) return alert('Please login first');
    if((!text || !text.trim()) && pendingAttachments.length === 0) return;

    // persist attachments first
    let attachmentsMeta = [];
    if(pendingAttachments.length){
      for(const p of pendingAttachments){
        try{
          const id = await saveAttachment(p.file, p.name);
          attachmentsMeta.push({id, name: p.name, type: p.type, size: p.size});
        } catch(e){ console.error('saveAttachment failed', e); }
      }
      pendingAttachments = [];
      renderAttachmentsPreview();
    }

    const msg = {id: genId(), from: me.phone, fromName: me.name || '', text: (text||'').trim(), ts: new Date().toISOString(), attachments: attachmentsMeta};
    messages.push(msg);
    saveMessages();
    broadcast({type:'message', payload: msg});
    renderUI();
  }

  function handleIncoming(data){
    if(!data || !data.type) return;
    if(data.type === 'message'){
      const msg = data.payload;
      // avoid duplicates
      if(!messages.find(m=>m.id===msg.id)){
        messages.push(msg);
        saveMessages();
        renderUI();
        // if page not focused and message not from self, bump unread
        if(!pageFocused && (!me || msg.from !== me.phone)){
          unreadCount = Math.min(99, unreadCount + 1);
          updateTitle();
          flashWindow();
        }
      }
    } else if(data.type === 'presence'){
      // merge presence
      Object.assign(presence, data.payload);
      savePresence();
      renderUI();
    } else if(data.type === 'request-state'){
      // another tab asked for state; respond
      if(me) broadcast({type:'presence',payload:presence});
      broadcast({type:'sync-messages',payload:messages});
    } else if(data.type === 'sync-messages'){
      // merge messages
      const incoming = data.payload || [];
      let changed = false;
      incoming.forEach(m => { if(!messages.find(x=>x.id===m.id)){ messages.push(m); changed = true; } });
      if(changed){ saveMessages(); renderUI(); }
    }
  }

  function genId(){ return Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-4); }

  // Simple escaping
  function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }

  // Login / logout flows
  function login(phone, name){
    me = {phone, name, color: colorFromPhone(phone)};
    localStorage.setItem(KEY_USER, JSON.stringify(me));
    presence[phone] = {phone, name, lastSeen: Date.now(), color: me.color};
    savePresence();
    broadcast({type:'presence', payload: presence});
    broadcast({type:'request-state'});
    touchPresence();
    renderUI();
  }
  function logout(){
    if(!me) return;
    delete presence[me.phone];
    savePresence();
    broadcast({type:'presence', payload: presence});
    localStorage.removeItem(KEY_USER);
    me = null;
    renderUI();
  }

  // populate attachments in rendered messages
  async function populateAttachments(){
    const nodes = messagesBox.querySelectorAll('.attachments');
    for(const node of nodes){
      if(node.dataset.loaded) continue;
      const ids = (node.dataset.ids || '').split(',').filter(Boolean);
      for(const id of ids){
        await tryLoadAttachmentToNode(id, node);
      }
      node.dataset.loaded = '1';
    }
  }

  async function tryLoadAttachmentToNode(id, node, attempt=0){
    try{
      const rec = await getAttachment(id);
      if(rec && rec.blob){
        node.appendChild(createAttachmentNode(rec));
      } else {
        if(attempt < 10) setTimeout(()=> tryLoadAttachmentToNode(id, node, attempt+1), 400);
        else { const span = document.createElement('span'); span.className='muted small'; span.textContent='Attachment unavailable'; node.appendChild(span); }
      }
    } catch(e){ if(attempt < 5) setTimeout(()=> tryLoadAttachmentToNode(id, node, attempt+1), 600); else node.appendChild(Object.assign(document.createElement('span'), {textContent:'Error loading attachment', className:'muted small'})); }
  }

  function createAttachmentNode(rec){
    const url = URL.createObjectURL(rec.blob);
    const wrap = document.createElement('div');
    wrap.className = 'attachment-thumb';
    if(rec.type && rec.type.startsWith('image/')){ const img = document.createElement('img'); img.src = url; img.alt = rec.name; wrap.appendChild(img); }
    else if(rec.type && rec.type.startsWith('video/')){ const v = document.createElement('video'); v.src = url; v.controls = true; v.preload='metadata'; v.style.maxWidth='260px'; wrap.appendChild(v); }
    else if(rec.type && rec.type.startsWith('audio/')){ const a = document.createElement('audio'); a.src = url; a.controls = true; wrap.appendChild(a); }
    else { const a = document.createElement('a'); a.href = url; a.textContent = rec.name; a.target = '_blank'; wrap.appendChild(a); }
    const dl = document.createElement('a'); dl.className='btn small'; dl.textContent='Download'; dl.href = url; dl.download = rec.name || 'file'; wrap.appendChild(dl);
    return wrap;
  }

  // pending attachments UI
  function renderAttachmentsPreview(){
    const container = $('#attachmentsPreview');
    if(!container) return;
    container.innerHTML = pendingAttachments.map((p, idx)=>`<div class="pending-attach"><div class="thumb">${p.type && p.type.startsWith('image/')? `<img src="${p.previewUrl}" />` : `<div class="file-icon">${p.name}</div>`}</div><div class="meta small">${escapeHtml(p.name)}</div><button class="btn small remove" data-idx="${idx}">✖</button></div>`).join('');
    container.querySelectorAll('.remove').forEach(btn=> btn.addEventListener('click', (e)=>{ const i = Number(btn.dataset.idx); pendingAttachments.splice(i,1); renderAttachmentsPreview(); }));
  }

  // events
  // Phone verification: country selector + send/verify flow (Firebase optional, simulated fallback)
  const countrySelect = $('#country');
  const countryCodeInput = $('#countryCode');
  const sendCodeBtn = $('#sendCodeBtn');
  const verifyBtn = $('#verifyBtn');
  const resendBtn = $('#resendBtn');
  const codeInput = $('#code');

  // initialize country code input
  if(countrySelect){ countryCodeInput.value = countrySelect.value; countrySelect.addEventListener('change', ()=> countryCodeInput.value = countrySelect.value); }

  function showVerifyArea(){ $('#verifyArea').style.display = 'block'; codeInput.focus(); }
  function hideVerifyArea(){ $('#verifyArea').style.display = 'none'; codeInput.value = ''; $('#codeHelp').textContent = 'If Firebase is configured and phone auth enabled, you will receive an SMS. Otherwise a test code will be shown here for demo use.'; }

  sendCodeBtn.addEventListener('click', async ()=>{
    const pure = phoneInput.value.trim();
    const name = displayInput.value.trim();
    if(!/^[0-9]+$/.test(pure)) { alert('Please enter digits only for phone'); return; }
    const phoneWithCode = (countrySelect.value || '+256') + pure;

    // Firebase phone auth flow
    if(window.FIREBASE_CONFIG && window.firebase && firebase.auth){
      try{
        // ensure recaptcha exists (invisible)
        if(!window.recaptchaVerifier){
          window.recaptchaVerifier = new firebase.auth.RecaptchaVerifier('recaptcha-container', {size:'invisible'});
        }
        const appVerifier = window.recaptchaVerifier;
        const confirmationResult = await firebase.auth().signInWithPhoneNumber(phoneWithCode, appVerifier);
        window.confirmationResult = confirmationResult;
        $('#codeHelp').textContent = 'SMS sent. Enter the code you received.';
        showVerifyArea();
      } catch(e){ console.error(e); alert('Failed to send SMS via Firebase. Check console and your Firebase setup.'); }
      return;
    }

    // fallback: generate a local test code and show it (for demo/testing only)
    const code = (Math.floor(Math.random()*900000)+100000).toString();
    const expires = Date.now() + 5*60*1000; // 5 min
    const codes = JSON.parse(localStorage.getItem('qc_test_codes') || '{}');
    codes[phoneWithCode] = {code, expires};
    localStorage.setItem('qc_test_codes', JSON.stringify(codes));
    $('#codeHelp').innerHTML = `Test code: <strong>${code}</strong> (expires in 5 min)`;
    showVerifyArea();
    sendCodeBtn.disabled = true; setTimeout(()=> sendCodeBtn.disabled = false, 30000);
  });

  verifyBtn.addEventListener('click', async ()=>{
    const pure = phoneInput.value.trim();
    const phoneWithCode = (countrySelect.value || '+256') + pure;
    const inputCode = codeInput.value.trim();
    if(window.confirmationResult){
      try{
        const result = await window.confirmationResult.confirm(inputCode);
        const phone = (result.user && result.user.phoneNumber) ? result.user.phoneNumber : phoneWithCode;
        login(phone, displayInput.value.trim());
        hideVerifyArea();
      } catch(e){ alert('Verification failed: ' + (e.message || e)); }
      return;
    }
    const codes = JSON.parse(localStorage.getItem('qc_test_codes') || '{}');
    const rec = codes[phoneWithCode];
    if(rec && rec.code === inputCode && rec.expires > Date.now()){
      delete codes[phoneWithCode]; localStorage.setItem('qc_test_codes', JSON.stringify(codes));
      login(phoneWithCode, displayInput.value.trim());
      hideVerifyArea();
    } else { alert('Invalid or expired code'); }
  });

  resendBtn.addEventListener('click', ()=> sendCodeBtn.click());

  logoutBtn.addEventListener('click', ()=> logout());
  composer.addEventListener('submit', (e)=>{
    e.preventDefault(); sendMessage(msgInput.value); msgInput.value=''; msgInput.focus();
  });
  emojiBtn.addEventListener('click', ()=> msgInput.value += '😊');

  // attach / file input
  $('#attachBtn').addEventListener('click', ()=> $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e)=>{
    const files = [...e.target.files];
    for(const f of files){
      const previewUrl = f.type && f.type.startsWith('image/') ? URL.createObjectURL(f) : '';
      pendingAttachments.push({file: f, name: f.name, type: f.type, size: f.size, previewUrl});
    }
    renderAttachmentsPreview();
    e.target.value = '';
  });

  // audio recording
  let mediaRecorder = null; let recordingChunks = [];
  $('#recordBtn').addEventListener('click', async ()=>{
    const btn = $('#recordBtn');
    if(!mediaRecorder){
      try{
        const stream = await navigator.mediaDevices.getUserMedia({audio:true});
        mediaRecorder = new MediaRecorder(stream);
        recordingChunks = [];
        mediaRecorder.ondataavailable = e => recordingChunks.push(e.data);
        mediaRecorder.onstop = ()=>{
          const blob = new Blob(recordingChunks, {type: recordingChunks[0]?.type || 'audio/webm'});
          const name = `recording_${Date.now()}.webm`;
          pendingAttachments.push({file: blob, name, type: blob.type, size: blob.size, previewUrl: ''});
          renderAttachmentsPreview();
          mediaRecorder = null; btn.classList.remove('recording'); btn.textContent = '🎙️';
        };
        mediaRecorder.start();
        btn.classList.add('recording'); btn.textContent = 'Stop';
      } catch(e){ alert('Microphone access denied or unavailable'); }
    } else {
      mediaRecorder.stop();
    }
  });

  // heartbeat
  setInterval(()=>{ touchPresence(); }, 10_000);

  // Charts storage: fallback to localStorage
  const KEY_CHARTS = 'qc_charts';

  function initFirestoreIfConfigured(){
    try{
      if(window.FIREBASE_CONFIG){
        firebase.initializeApp(window.FIREBASE_CONFIG);
        window.qc_db = firebase.firestore();
        // listen to charts collection
        qc_db.collection('charts').orderBy('createdAt','desc').onSnapshot(snap=>{
          const docs = [];
          snap.forEach(d=> docs.push(Object.assign({id:d.id}, d.data())));
          charts = docs; renderCharts();
        });
        console.log('Firestore enabled for charts (FIREBASE_CONFIG detected)');
        return true;
      }
    }catch(e){ console.warn('Firebase init failed',e); }
    return false;
  }

  // charts state
  let charts = []; // each: {id, ownerPhone, title, type, data, createdAt}

  function loadChartsLocal(){
    try{ charts = JSON.parse(localStorage.getItem(KEY_CHARTS) || '[]'); }catch(e){ charts = []; }
  }
  function saveChartsLocal(){ localStorage.setItem(KEY_CHARTS, JSON.stringify(charts)); }

  function renderCharts(){
    const list = $('#chartsList');
    if(!charts || charts.length === 0){ list.innerHTML = '<div class="muted small">No charts yet</div>'; return; }
    list.innerHTML = '';
    charts.forEach(c => list.appendChild(createChartCard(c)));
  }

  function createChartCard(c){
    const wrap = document.createElement('div'); wrap.className='chart-card';
    const cv = document.createElement('canvas'); cv.width=160; cv.height=90; wrap.appendChild(cv);
    const meta = document.createElement('div'); meta.className='meta';
    meta.innerHTML = `<div class="title">${escapeHtml(c.title||'Untitled')}</div><div class="owner muted small">${c.ownerPhone || 'unknown'} • ${new Date(c.createdAt||Date.now()).toLocaleString()}</div>`;
    wrap.appendChild(meta);
    const acts = document.createElement('div'); acts.className='actions';
    const view = document.createElement('button'); view.className='btn small'; view.textContent='View'; view.addEventListener('click', ()=> viewChart(c)); acts.appendChild(view);
    const dl = document.createElement('button'); dl.className='btn small'; dl.textContent='Download'; dl.addEventListener('click', ()=> exportChartPNG(c)); acts.appendChild(dl);
    if(me && me.phone === c.ownerPhone){ const del = document.createElement('button'); del.className='btn small'; del.textContent='Delete'; del.addEventListener('click', ()=> deleteChart(c)); acts.appendChild(del); }
    wrap.appendChild(acts);

    // render mini preview
    try{ new Chart(cv.getContext('2d'), buildChartConfig(c)); }catch(e){ /* ignore */ }
    return wrap;
  }

  function buildChartConfig(c){
    // c.data should be {labels:[], datasets:[{label,data,backgroundColor,...}]}
    return {type: c.type || 'line', data: c.data || {labels:[], datasets:[]}, options: {responsive:true, maintainAspectRatio:false}};
  }

  async function saveChartToBackend(chart){
    if(window.qc_db){
      const payload = Object.assign({}, chart, {createdAt: Date.now()});
      const ref = await qc_db.collection('charts').add(payload);
      // Firestore listener will update charts
      return ref.id;
    } else {
      // local
      chart.id = genId(); chart.createdAt = Date.now(); charts.unshift(chart); saveChartsLocal(); renderCharts(); return chart.id;
    }
  }

  async function deleteChart(chart){
    if(!confirm('Delete this chart?')) return;
    if(window.qc_db && chart.id){
      await qc_db.collection('charts').doc(chart.id).delete();
    } else {
      charts = charts.filter(x=> x.id !== chart.id); saveChartsLocal(); renderCharts();
    }
  }

  function exportChartPNG(chart){
    // render to hidden canvas and download
    const tmp = document.createElement('canvas'); tmp.width = 800; tmp.height = 450;
    try{
      const cfg = buildChartConfig(chart);
      new Chart(tmp.getContext('2d'), Object.assign({}, cfg, {options:{animation:false,responsive:false,maintainAspectRatio:false}}));
      const url = tmp.toDataURL('image/png');
      const a = document.createElement('a'); a.href = url; a.download = (chart.title||'chart') + '.png'; a.click();
    }catch(e){ alert('Export failed'); }
  }

  function viewChart(chart){
    $('#viewerTitle').textContent = chart.title || 'Chart';
    const canvas = $('#viewerCanvas');
    // destroy existing chart if any
    if(canvas._chartInstance) { canvas._chartInstance.destroy(); canvas._chartInstance = null; }
    const cfg = buildChartConfig(chart);
    canvas._chartInstance = new Chart(canvas.getContext('2d'), cfg);
    // show delete if owner
    if(me && me.phone === chart.ownerPhone){ $('#deleteChart').style.display='inline-block'; $('#deleteChart').onclick = ()=> { deleteChart(chart); $('#chartViewer').style.display='none'; }; }
    else { $('#deleteChart').style.display='none'; }
    $('#downloadChart').onclick = ()=> exportChartPNG(chart);
    $('#chartViewer').style.display = 'flex';
  }

  // Create chart modal handling
  $('#createChartBtn').addEventListener('click', ()=> { $('#createChartModal').style.display='flex'; });
  $('#closeCreateChart').addEventListener('click', ()=> { $('#createChartModal').style.display='none'; if(window._previewChart) { window._previewChart.destroy(); window._previewChart = null; } });
  $('#previewChartBtn').addEventListener('click', (e)=>{ e.preventDefault(); previewChartFromForm(); });
  $('#saveChartBtn').addEventListener('click', async ()=>{
    const title = $('#chartTitle').value.trim(); const type = $('#chartType').value; const csv = $('#chartCSV').value.trim();
    const data = parseCSVtoChartData(csv);
    const obj = {title, type, data, ownerPhone: me ? me.phone : null};
    await saveChartToBackend(obj);
    $('#createChartModal').style.display='none';
    if(window._previewChart) { window._previewChart.destroy(); window._previewChart = null; }
  });

  $('#refreshCharts').addEventListener('click', ()=> loadChartsLocal());

  // CSV parser: simple label,value per line
  function parseCSVtoChartData(csv){
    const lines = csv.split('\n').map(l=>l.trim()).filter(Boolean);
    const labels = []; const data = [];
    for(const l of lines){ const parts = l.split(/,|\t/).map(s=>s.trim()); if(parts.length>=2){ labels.push(parts[0]); data.push(Number(parts[1])||0); } }
    return {labels, datasets:[{label:'Series',data,backgroundColor:'rgba(124,92,255,0.5)',borderColor:'rgba(124,92,255,1)',fill:true}]};
  }

  function previewChartFromForm(){
    const title = $('#chartTitle').value.trim(); const type = $('#chartType').value; const csv = $('#chartCSV').value.trim();
    const cfg = {type, data: parseCSVtoChartData(csv), options:{responsive:true,maintainAspectRatio:false}};
    const c = $('#chartPreview'); if(window._previewChart) window._previewChart.destroy(); window._previewChart = new Chart(c.getContext('2d'), cfg);
  }

  // initial load
  function init(){
    loadMessages(); loadPresence();
    const storedUser = localStorage.getItem(KEY_USER);
    if(storedUser){ try { me = JSON.parse(storedUser); } catch(e){ me = null; } }

    // add self to presence if logged
    if(me){ presence[me.phone] = {phone:me.phone,name:me.name,lastSeen:Date.now(),color:me.color}; savePresence(); }

    // request state from others if any
    broadcast({type:'request-state'});

    renderUI();

    // charts: init firestore if config exists, otherwise load local charts
    const fb = initFirestoreIfConfigured(); if(!fb) { loadChartsLocal(); renderCharts(); }

    // keep presence updated when storage changes (other tabs)
    window.addEventListener('storage', (e)=>{
      if(e.key === KEY_PRESENCE) { loadPresence(); renderUI(); }
      if(e.key === KEY_MESSAGES) { loadMessages(); renderUI(); }
      if(e.key === KEY_CHARTS) { loadChartsLocal(); renderCharts(); }
    });

    // make sure we respond to incoming messages via channel if any
    // request initial sync
    setTimeout(()=> broadcast({type:'request-state'}), 500);
  }

  // neat little UX: press Enter to send when input focused
  msgInput.addEventListener('keydown', (e)=>{ if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); composer.dispatchEvent(new Event('submit')); } });

  // close viewer handlers
  $('#closeViewer').addEventListener('click', ()=> { $('#chartViewer').style.display='none'; if($('#viewerCanvas')._chartInstance){ $('#viewerCanvas')._chartInstance.destroy(); $('#viewerCanvas')._chartInstance=null; } });

  // start
  init();
})();