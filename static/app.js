'use strict';
const $ = s => document.querySelector(s);
const MESH = { freq: 869.618, bw: 62.5, sf: 8, cr: 8, tx: 22 };

// ---------- helpers ----------
async function getJSON(u){ const r = await fetch(u); return r.json(); }
async function postJSON(u, body){
  const r = await fetch(u, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body||{})});
  const j = await r.json().catch(()=>({}));
  if(!r.ok || j.ok===false) throw new Error(j.error || ('HTTP '+r.status));
  return j;
}
let toastTimer;
function toast(msg, err){
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err?' err':'');
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>t.className='toast', 2600);
}
const fmtUptime = s => { s=Math.floor(s); const h=Math.floor(s/3600),m=Math.floor(s%3600/60); return h?`${h}h ${m}m`:`${m}m ${s%60}s`; };

// ---------- status poll ----------
let lastInfo = {};
async function pollStatus(){
  let s; try{ s = await getJSON('/api/status'); }catch(e){ setConn(false); return; }
  setConn(s.connected);
  $('#port-text').textContent = s.port;
  $('#uptime').textContent = fmtUptime(s.uptime||0);
  const info = s.self_info || {}; lastInfo = info;

  // identity
  if(document.activeElement !== $('#node-name')) $('#node-name').value = info.name || '';
  $('#pubkey').textContent = info.public_key ? info.public_key.slice(0,16)+'…' : '—';
  $('#pubkey').dataset.full = info.public_key || '';
  $('#adv-type').textContent = info.adv_type ?? '—';
  const lat=info.adv_lat, lon=info.adv_lon;
  $('#loc-text').textContent = (lat||lon) ? `${(+lat).toFixed(4)}, ${(+lon).toFixed(4)}` : 'not set';
  updateMap(lat, lon);

  // battery
  drawBattery(s.battery_mv, s.battery_history||[]);

  // radio (don't clobber a field being edited)
  const focused = document.activeElement;
  const radioInputs = ['#r-freq','#r-bw','#r-sf','#r-cr','#r-tx'].map($);
  if(!radioInputs.includes(focused)){
    setVal('#r-freq', info.radio_freq); setVal('#r-bw', info.radio_bw);
    setVal('#r-sf', info.radio_sf); setVal('#r-cr', info.radio_cr);
    setVal('#r-tx', info.tx_power);
  }
  $('#tx-max').textContent = info.max_tx_power ?? 22;
  const onMesh = info.radio_freq==MESH.freq && info.radio_bw==MESH.bw && info.radio_sf==MESH.sf && info.radio_cr==MESH.cr;
  const tag = $('#radio-match');
  tag.textContent = onMesh ? '✓ on-mesh' : '⚠ mismatch';
  tag.className = 'tag ' + (onMesh?'good':'bad');

  // stat chips
  const ec = s.event_counts||{};
  const top = Object.entries(ec).sort((a,b)=>b[1]-a[1]).slice(0,6);
  $('#stat-strip').innerHTML = top.map(([k,v])=>`<span class="chip">${k.toLowerCase()} <b>${v}</b></span>`).join('')
    || '<span class="chip">no packets yet</span>';
  $('#pkt-total').textContent = s.event_total||0;
  drawSignal(s.signal_history||[], ec);
  renderLink(s.link);
}
function renderLink(l){
  if(!l) return;
  const sent=l.sent||0, acked=l.acked||0, rpm=l.rx_per_min||0, lastAgo=l.last_rx_ago;
  const rxAlive = rpm>0 || (lastAgo!=null && lastAgo<300);
  let v,cls,hint;
  if(!rxAlive){ v='ISOLATED'; cls='lv-bad'; hint='Hearing no RF traffic — move toward a node/repeater or check the antenna.'; }
  else if(sent>0 && acked===0){ v='RX-ONLY'; cls='lv-warn'; hint='You hear the mesh but aren’t being heard back. Better antenna / placement, or move closer to a repeater.'; }
  else if(acked>0){ v='LINKED'; cls='lv-good'; hint='Two-way link confirmed — your messages are being acknowledged.'; }
  else { v='LISTENING'; cls='lv-cyan'; hint='Hearing the mesh. Send a DM to test whether you’re heard back.'; }
  const el=$('#link-verdict'); el.textContent=v; el.className='link-verdict '+cls;
  $('#lk-deliv').textContent = sent ? `${acked}/${sent} (${Math.round(acked/sent*100)}%)` : '—';
  $('#lk-rx').textContent = rpm + ' /min';
  $('#lk-last').textContent = lastAgo==null ? 'never' : (lastAgo<90 ? Math.round(lastAgo)+'s ago' : Math.round(lastAgo/60)+'m ago');
  $('#lk-rssi').textContent = (l.rssi==null) ? '—' : l.rssi+' dBm';
  $('#link-hint').textContent = hint;
}
const setVal=(sel,v)=>{ if(v!=null) $(sel).value = v; };
function setConn(on){
  $('#conn-led').className = 'led' + (on?' on':'');
  $('#conn-text').textContent = on ? 'online' : 'offline';
}

// ---------- battery ----------
let battChart;
function drawBattery(mv, hist){
  const pct = mv==null ? 0 : Math.max(0, Math.min(100, Math.round((mv-3300)/(4200-3300)*100)));
  const C = 327, arc = $('#batt-arc');
  arc.style.strokeDashoffset = C*(1-pct/100);
  arc.style.stroke = pct>50?'var(--green)':pct>20?'var(--amber)':'var(--red)';
  $('#batt-pct').textContent = mv==null?'—':pct+'%';
  $('#batt-mv').textContent  = mv==null?'no data':(mv/1000).toFixed(2)+' V';
  const data = hist.map(h=>+(h.mv/1000).toFixed(3));
  if(!battChart){
    battChart = new Chart($('#batt-spark'), {
      type:'line',
      data:{labels:data.map((_,i)=>i), datasets:[{data, borderColor:'#34d399', borderWidth:2,
        fill:true, backgroundColor:'rgba(52,211,153,.12)', pointRadius:0, tension:.4}]},
      options:{animation:false, plugins:{legend:{display:false}}, scales:{x:{display:false},
        y:{display:false, suggestedMin:3.3, suggestedMax:4.25}}, elements:{line:{capBezierPoints:true}}}
    });
  } else { battChart.data.labels=data.map((_,i)=>i); battChart.data.datasets[0].data=data; battChart.update('none'); }
}

// ---------- live feed + radar ----------
let lastId = 0;
const blips = [];
async function pollEvents(){
  let r; try{ r = await getJSON('/api/events?since='+lastId); }catch(e){ return; }
  if(r.events && r.events.length){
    lastId = r.last;
    const feed = $('#feed'), filt = $('#feed-filter').value.toLowerCase();
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    for(const e of r.events){
      addBlip(e.type);
      const line = JSON.stringify(e.data);
      if(filt && !(e.type.toLowerCase().includes(filt) || line.toLowerCase().includes(filt))) continue;
      const div = document.createElement('div');
      div.className = 'row';
      const ts = new Date(e.ts*1000).toLocaleTimeString();
      div.innerHTML = `<span class="t">${ts}</span><span class="ty ty-${e.type}">${e.type}</span><span class="d"></span>`;
      div.querySelector('.d').textContent = line==='null'?'':line;
      feed.appendChild(div);
    }
    while(feed.children.length>400) feed.removeChild(feed.firstChild);
    if(nearBottom) feed.scrollTop = feed.scrollHeight;
  }
}
let evWindow = [];
function addBlip(type){
  const now = Date.now(); evWindow.push(now); evWindow = evWindow.filter(t=>now-t<60000);
  $('#pkt-rate').textContent = evWindow.length;
  if(['ADVERTISEMENT','NEW_CONTACT','CONTACT_MSG_RECV','CHANNEL_MSG_RECV','PATH_UPDATE','RX_LOG_DATA'].includes(type)){
    blips.push({a:Math.random()*Math.PI*2, r:0.3+Math.random()*0.62, life:1,
      c:type.includes('MSG')?'#e879f9':type==='ADVERTISEMENT'?'#22d3ee':'#fbbf24'});
  }
}

// ---------- contacts ----------
let knownKeys = null;          // pubkeys already seen (null until first load)
const newUntil = {};           // pubkey -> timestamp until which to flash "NEW"
async function pollContacts(){
  let c; try{ c = await getJSON('/api/contacts'); }catch(e){ return; }
  const list = Object.values(c||{});
  list.sort((a,b)=> (b.last_advert||0) - (a.last_advert||0));   // freshest-heard first
  $('#contacts-count').textContent = list.length;
  const now = Date.now();
  const keys = new Set(list.map(ct=> ct.public_key||''));
  if(knownKeys === null){
    knownKeys = keys;                                           // first load: don't flash existing
  } else {
    list.forEach(ct=>{
      const pk = ct.public_key || '';
      if(pk && !knownKeys.has(pk)){
        newUntil[pk] = now + 20000;
        toast('new contact: ' + (ct.adv_name || ct.name || pk.slice(0,8)));
      }
    });
    knownKeys = keys;
  }
  const box = $('#contacts'); contactKeys = {};
  if(!list.length){ box.innerHTML = '<div class="empty">no contacts yet — they appear as nodes advertise</div>'; drawContacts([]); return; }
  box.innerHTML = list.map(ct=>{
    const pubkey = ct.public_key || '';
    const name = ct.adv_name || ct.name || pubkey.slice(0,8) || 'node';
    contactKeys[pubkey.slice(0,12)] = {pubkey, name};
    const isNew = newUntil[pubkey] && now < newUntil[pubkey];
    const badge = isNew ? '<span class="new-badge">NEW</span>' : '';
    return `<div class="contact${isNew?' new-contact':''}" data-pubkey="${pubkey}" data-name="${esc(name)}" title="open PM">
              <span class="c-left"><b>${esc(name)}</b>${badge}</span>
              <span class="c-right"><small>${pubkey.slice(0,8)}… ✉</small>
                <button class="c-trace" title="trace route">⤳</button></span></div>`;
  }).join('');
  box.querySelectorAll('.contact').forEach(el=>{
    el.onclick=()=> openDM(el.dataset.pubkey, el.dataset.name);
    const tb=el.querySelector('.c-trace');
    if(tb) tb.onclick=(e)=>{ e.stopPropagation(); traceContact(el.dataset.pubkey, el.dataset.name); };
  });
  drawContacts(list);
}

// ---------- map ----------
let map, marker, meshLayer, mapFitted=false;
function initMap(){
  map = L.map('map',{zoomControl:false, attributionControl:false}).setView([62.0,16.0],4);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{maxZoom:19}).addTo(map);
  meshLayer = L.layerGroup().addTo(map);
  map.on('click', async ev=>{
    const {lat,lng}=ev.latlng;
    try{ await postJSON('/api/location',{lat,lon:lng}); toast(`location set ${lat.toFixed(4)}, ${lng.toFixed(4)}`); }
    catch(e){ toast('set location failed: '+e.message,true); }
  });
}
function updateMap(lat,lon){              // our own node (cyan)
  if(!map || !(lat||lon)) return;
  const ll=[+lat,+lon];
  if(!marker) marker=L.circleMarker(ll,{radius:9,color:'#22d3ee',fillColor:'#22d3ee',fillOpacity:.7,weight:2}).addTo(map).bindTooltip('this node',{direction:'top'});
  else marker.setLatLng(ll);
}
function drawContacts(list){              // every other node (magenta) + links from us
  if(!map || !meshLayer) return;
  meshLayer.clearLayers();
  const self = (lastInfo.adv_lat||lastInfo.adv_lon) ? [+lastInfo.adv_lat, +lastInfo.adv_lon] : null;
  const pts = self ? [self] : [];
  list.forEach(ct=>{
    const la=ct.adv_lat, lo=ct.adv_lon;
    if(!la && !lo) return;
    const ll=[+la,+lo]; pts.push(ll);
    if(self) L.polyline([self,ll],{color:'#22d3ee',weight:1,opacity:.22,dashArray:'4 5'}).addTo(meshLayer);
    L.circleMarker(ll,{radius:6,color:'#e879f9',fillColor:'#e879f9',fillOpacity:.55,weight:2})
      .bindTooltip(ct.adv_name||ct.name||'node',{direction:'top'}).addTo(meshLayer);
  });
  if(!mapFitted && pts.length){
    mapFitted=true;
    if(pts.length===1) map.setView(pts[0],12);
    else map.fitBounds(L.latLngBounds(pts).pad(0.3));
  }
}

// ---------- signal charts ----------
let rssiChart, pktChart;
function drawSignal(sig, counts){
  const rss=sig.map(s=>s.rssi), snr=sig.map(s=>s.snr), lbl=sig.map((_,i)=>i);
  if(!rssiChart){
    rssiChart=new Chart($('#rssi-chart'),{type:'line',
      data:{labels:lbl,datasets:[
        {label:'rssi',data:rss,borderColor:'#22d3ee',borderWidth:2,pointRadius:0,tension:.35,yAxisID:'y'},
        {label:'snr',data:snr,borderColor:'#fbbf24',borderWidth:2,pointRadius:0,tension:.35,yAxisID:'y1'}]},
      options:{animation:false,plugins:{legend:{labels:{color:'#6b8593',boxWidth:9,font:{size:9}}}},
        scales:{x:{display:false},
          y:{position:'left',ticks:{color:'#6b8593',font:{size:9}},grid:{color:'rgba(255,255,255,.05)'}},
          y1:{position:'right',ticks:{color:'#fbbf24',font:{size:9}},grid:{display:false}}}}});
  } else { rssiChart.data.labels=lbl; rssiChart.data.datasets[0].data=rss; rssiChart.data.datasets[1].data=snr; rssiChart.update('none'); }
  const ent=Object.entries(counts||{}).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const labels=ent.map(e=>e[0].toLowerCase().replace(/_/g,' ')), data=ent.map(e=>e[1]);
  if(!pktChart){
    pktChart=new Chart($('#pkt-chart'),{type:'bar',
      data:{labels,datasets:[{data,backgroundColor:'#34d399',borderRadius:3}]},
      options:{animation:false,indexAxis:'y',plugins:{legend:{display:false}},
        scales:{x:{ticks:{color:'#6b8593',font:{size:9}},grid:{color:'rgba(255,255,255,.05)'}},
          y:{ticks:{color:'#9fc4cf',font:{size:9}},grid:{display:false}}}}});
  } else { pktChart.data.labels=labels; pktChart.data.datasets[0].data=data; pktChart.update('none'); }
}

// ---------- controls ----------
function wire(){
  $('#btn-name').onclick = async ()=>{ try{ await postJSON('/api/name',{name:$('#node-name').value}); toast('renamed'); }catch(e){ toast(e.message,true);} };
  $('#btn-radio').onclick = async ()=>{
    try{
      await postJSON('/api/radio',{freq:+$('#r-freq').value,bw:+$('#r-bw').value,sf:+$('#r-sf').value,cr:+$('#r-cr').value});
      await postJSON('/api/txpower',{dbm:+$('#r-tx').value});
      toast('radio applied');
    }catch(e){ toast(e.message,true);} };
  $('#btn-mesh-default').onclick = ()=>{ $('#r-freq').value=MESH.freq;$('#r-bw').value=MESH.bw;$('#r-sf').value=MESH.sf;$('#r-cr').value=MESH.cr;$('#r-tx').value=MESH.tx; $('#btn-radio').click(); };
  $('#btn-advert').onclick = async ()=>{ try{ await postJSON('/api/advert',{flood:false}); toast('advert sent'); }catch(e){ toast(e.message,true);} };
  $('#btn-advert-flood').onclick = async ()=>{ try{ await postJSON('/api/advert',{flood:true}); toast('flood advert sent'); }catch(e){ toast(e.message,true);} };
  $('#btn-time').onclick = async ()=>{ try{ await postJSON('/api/time/sync'); toast('clock synced'); }catch(e){ toast(e.message,true);} };
  $('#btn-reboot').onclick = async ()=>{ if(!confirm('Reboot the node?'))return; try{ await postJSON('/api/reboot'); toast('rebooting…'); }catch(e){ toast(e.message,true);} };
  $('#btn-chat-send').onclick = sendChat; $('#chat-text').onkeydown = e=>{ if(e.key==='Enter') sendChat(); };
  $('#btn-add-chan').onclick = addChannel;
  $('#btn-clear').onclick = ()=> $('#feed').innerHTML='';
  $('#pubkey').onclick = ()=>{ const f=$('#pubkey').dataset.full; if(f){ navigator.clipboard.writeText(f); toast('pubkey copied'); } };
  $('#trace-close').onclick = ()=> $('#trace-modal').classList.remove('show');
  $('#trace-modal').onclick = (e)=>{ if(e.target.id==='trace-modal') $('#trace-modal').classList.remove('show'); };
}
// ---------- chat: thread sidebar (channels + PMs) with unread badges ----------
let activeThread = 'chan:0', activeDm = null, knownChannels = [], contactKeys = {}, threads = [];
let _msgSig = null, _threadSig = null;   // change-detection so we don't re-render (and re-animate) every poll
const SEEN_KEY = 'meshdash_seen';
const lastSeen = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
const saveSeen = ()=> localStorage.setItem(SEEN_KEY, JSON.stringify(lastSeen));
const esc = s => (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

async function loadChannels(){
  let r; try{ r = await getJSON('/api/channels'); }catch(e){ return; }
  knownChannels = r.channels || [];
}
function threadLabel(t){
  if(t.kind==='dm'){ const c=contactKeys[t.prefix]; return c?c.name:('PM '+t.prefix.slice(0,6)); }
  return t.label;
}
async function pollThreads(){
  let r; try{ r = await getJSON('/api/threads'); }catch(e){ return; }
  threads = r.threads || []; renderThreads();
}
function renderThreads(){
  const sig = JSON.stringify(threads)+'|'+activeThread+'|'+JSON.stringify(lastSeen)+'|'+Object.keys(contactKeys).join(',');
  if(sig===_threadSig) return;          // nothing changed -> skip re-render
  _threadSig = sig;
  const box = $('#thread-list');
  box.innerHTML = threads.map(t=>{
    const unread = Math.max(0, t.count - (lastSeen[t.thread]||0));
    const active = t.thread===activeThread ? 'active' : '';
    const icon = t.kind==='dm' ? '✉' : (t.idx===0 ? '#' : '🔒');
    const badge = (unread>0 && t.thread!==activeThread) ? `<span class="unread">${unread}</span>` : '';
    return `<div class="thread-item ${active}" data-thread="${t.thread}" data-kind="${t.kind}" data-prefix="${t.prefix||''}">
      <div class="ti-top"><span class="ti-icon">${icon}</span><b>${esc(threadLabel(t))}</b>${badge}</div>
      <small>${esc(t.preview||'')}</small></div>`;
  }).join('') || '<div class="empty">no threads</div>';
  box.querySelectorAll('.thread-item').forEach(el=> el.onclick=()=>{
    if(el.dataset.kind==='dm'){ const c=contactKeys[el.dataset.prefix];
      activeDm = c ? {pubkey:c.pubkey,name:c.name} : {pubkey:el.dataset.prefix,name:el.dataset.prefix}; }
    else activeDm=null;
    selectThread(el.dataset.thread);
  });
}
function markSeen(thread){ const t=threads.find(x=>x.thread===thread); if(t){ lastSeen[thread]=t.count; saveSeen(); } }
function selectThread(thread){
  if(thread.startsWith('chan:')) activeDm=null;
  activeThread = thread; markSeen(thread);
  updateChatTitle(); renderThreads(); pollMessages(true);
}
function openDM(pubkey,name){
  activeDm={pubkey,name}; activeThread='dm:'+pubkey.slice(0,12);
  markSeen(activeThread); updateChatTitle(); renderThreads(); pollMessages(true);
  $('#card-chat').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function updateChatTitle(){
  let title, ph;
  if(activeThread.startsWith('dm:') && activeDm){ title='✉ '+activeDm.name; ph='PM to '+activeDm.name+'…'; }
  else { const c=knownChannels.find(c=>('chan:'+c.idx)===activeThread);
         const nm=(c&&c.name)?'#'+c.name:(activeThread==='chan:0'?'#public':activeThread);
         title=nm; ph='message '+nm+'…'; }
  $('#chat-title').textContent=title; $('#chat-text').placeholder=ph;
}
async function pollMessages(force){
  let r; try{ r = await getJSON('/api/messages?thread='+encodeURIComponent(activeThread)); }catch(e){ return; }
  const msgs=r.messages||[];
  const sig = activeThread+'|'+JSON.stringify(msgs);
  if(!force && sig===_msgSig) return;   // unchanged -> don't rebuild (stops the blink)
  _msgSig = sig;
  const box=$('#chat-thread'); const nearBottom = box.scrollHeight-box.scrollTop-box.clientHeight < 80;
  const dmName = (activeThread.startsWith('dm:') && activeDm) ? activeDm.name : null;
  box.innerHTML = msgs.length ? msgs.map(m=>{
    const sec = m.ts<2e10 ? m.ts*1000 : m.ts;
    const t=new Date(sec).toLocaleTimeString();
    const who = m.dir==='out' ? 'me' : (dmName || m.who || 'node');
    const tick = (m.dir==='out' && m.status)
      ? `<span class="tick ${m.status}" title="${m.status}">${m.status==='delivered'?'✓✓':'✓'}</span>` : '';
    return `<div class="bubble ${m.dir}"><span class="meta">${esc(who)} · ${t}${tick}</span>${esc(m.text)}</div>`;
  }).join('') : '<div class="empty">no messages here yet</div>';
  if(force || nearBottom) box.scrollTop=box.scrollHeight;
}
async function sendChat(){
  const t=$('#chat-text').value.trim(); if(!t)return;
  try{
    if(activeThread.startsWith('dm:')){
      if(!activeDm){ toast('pick a contact first',true); return; }
      await postJSON('/api/dm',{pubkey:activeDm.pubkey,text:t});
    } else {
      await postJSON('/api/message',{channel:+activeThread.split(':')[1],text:t});
    }
    $('#chat-text').value=''; pollMessages(true); pollThreads();
  }catch(e){ toast(e.message,true); }
}
async function addChannel(){
  const idx = prompt('Channel slot (1–3 for a new channel):','1'); if(idx===null) return;
  const name = prompt('Channel name (members must use the EXACT same name):',''); if(!name) return;
  const secret = prompt('Optional secret passphrase for a PRIVATE channel.\nLeave blank = key derived from the name (anyone using this name can join).','');
  try{ await postJSON('/api/channel',{idx:+idx,name,secret:secret||undefined}); toast('channel saved'); await loadChannels(); await pollThreads(); selectThread('chan:'+idx); }
  catch(e){ toast(e.message,true); }
}

// ---------- traceroute ----------
async function traceContact(pubkey, name){
  $('#trace-name').textContent = name;
  $('#trace-body').innerHTML = '<div class="empty">discovering route…</div>';
  $('#trace-modal').classList.add('show');
  let r; try{ r = await postJSON('/api/trace',{pubkey}); }
  catch(e){ $('#trace-body').innerHTML = '<div class="empty">trace failed: '+esc(e.message)+'</div>'; return; }
  renderTrace(r, name);
}
function renderTrace(r, name){
  const selfName = lastInfo.name || 'this node';
  if(r.flood){
    $('#trace-body').innerHTML = `<div class="hop-chain">
      <div class="hop me">${esc(selfName)}</div><div class="arrow">⇢</div>
      <div class="hop flood">flood<br><small>no fixed path</small></div><div class="arrow">⇢</div>
      <div class="hop dest">${esc(name)}</div></div>
      <div class="trace-note">No direct route learned yet — your node reaches ${esc(name)} by flooding the mesh.<br>
      Flood-advert your node and send ${esc(name)} a message; once it's delivered (✓✓) the return route is
      recorded, and tracing again will show the repeater hops.</div>`;
    return;
  }
  const hops = r.hops || [];
  let chain = `<div class="hop me">${esc(selfName)}</div>`;
  hops.forEach(h=>{
    chain += `<div class="arrow">⇢</div><div class="hop"><span class="hh">⟲ ${esc(h.hash)}</span>${h.label?'<br><small>'+esc(h.label)+'</small>':''}</div>`;
  });
  chain += `<div class="arrow">⇢</div><div class="hop dest">${esc(name)}</div>`;
  $('#trace-body').innerHTML = `<div class="hop-chain">${chain}</div>
    <div class="trace-note">${hops.length} repeater hop${hops.length===1?'':'s'} · direct route learned by the node.</div>`;
}

// ---------- canvas: radar ----------
function radar(){
  const cv=$('#radar'), ctx=cv.getContext('2d'); let ang=0;
  function size(){ const d=Math.min(cv.clientWidth,cv.clientHeight)||230, dpr=devicePixelRatio||1; cv.width=d*dpr; cv.height=d*dpr; ctx.setTransform(dpr,0,0,dpr,0,0); return d; }
  let D=size(); addEventListener('resize',()=>D=size());
  (function loop(){
    const d=D, c=d/2; ctx.clearRect(0,0,d,d);
    ctx.strokeStyle='rgba(34,211,238,.15)';
    for(let i=1;i<=4;i++){ ctx.beginPath(); ctx.arc(c,c,c*0.92*i/4,0,7); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(c,0);ctx.lineTo(c,d);ctx.moveTo(0,c);ctx.lineTo(d,c); ctx.stroke();
    // sweep
    const g=ctx.createConicGradient ? null : null;
    ctx.save(); ctx.translate(c,c); ctx.rotate(ang);
    const grad=ctx.createLinearGradient(0,0,c,0); grad.addColorStop(0,'rgba(34,211,238,.5)'); grad.addColorStop(1,'rgba(34,211,238,0)');
    ctx.fillStyle=grad; ctx.beginPath(); ctx.moveTo(0,0); ctx.arc(0,0,c*0.92,-0.28,0); ctx.closePath(); ctx.fill(); ctx.restore();
    // blips
    for(let i=blips.length-1;i>=0;i--){ const b=blips[i]; const x=c+Math.cos(b.a)*b.r*c*0.92, y=c+Math.sin(b.a)*b.r*c*0.92;
      ctx.globalAlpha=b.life; ctx.fillStyle=b.c; ctx.beginPath(); ctx.arc(x,y,3.2,0,7); ctx.fill();
      ctx.globalAlpha=b.life*.3; ctx.beginPath(); ctx.arc(x,y,7*(1.4-b.life),0,7); ctx.fill();
      ctx.globalAlpha=1; b.life-=0.006; if(b.life<=0) blips.splice(i,1); }
    ang=(ang+0.018)%(Math.PI*2);
    requestAnimationFrame(loop);
  })();
}

// ---------- canvas: bg grid ----------
function bgGrid(){
  const cv=$('#bg-grid'), ctx=cv.getContext('2d'); let off=0;
  function size(){ cv.width=innerWidth; cv.height=innerHeight; } size(); addEventListener('resize',size);
  (function loop(){
    ctx.clearRect(0,0,cv.width,cv.height); ctx.strokeStyle='rgba(34,211,238,.05)'; ctx.lineWidth=1;
    const g=46; off=(off+0.25)%g;
    for(let x=-off;x<cv.width;x+=g){ ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,cv.height);ctx.stroke(); }
    for(let y=-off;y<cv.height;y+=g){ ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(cv.width,y);ctx.stroke(); }
    requestAnimationFrame(loop);
  })();
}

// ---------- boot ----------
initMap(); wire(); radar(); bgGrid();
loadChannels().then(()=>{ updateChatTitle(); pollThreads(); });
pollStatus(); pollEvents(); pollContacts(); pollMessages();
setInterval(pollStatus, 3000);
setInterval(pollEvents, 1200);
setInterval(pollContacts, 8000);
setInterval(pollMessages, 1500);
setInterval(pollThreads, 3000);
setInterval(loadChannels, 15000);

// deep-link helper for demo screenshots: ?shot=dm | ?shot=trace
const _shot = new URLSearchParams(location.search).get('shot');
if(_shot){
  setTimeout(()=>{
    const vals = Object.values(contactKeys); const first = vals[0];
    if(!first) return;
    if(_shot==='trace') traceContact(first.pubkey, first.name);   // no scroll — clean centered modal
    else if(_shot==='newcontact'){ newUntil[first.pubkey]=Date.now()+30000; toast('new contact: '+first.name); pollContacts(); }
    else openDM(first.pubkey, first.name);
  }, 1700);
}
