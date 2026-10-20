/* Fast Keno frontend - Fixed Wallet Sync */
(() => {
'use strict';
const API={
  user:'/api/wallet/sync',
  wallet:'/api/wallet/sync', // ትክክለኛው የዋሌት/ሲንክ ራውት
  status:'/api/keno/status',
  play:'/api/keno/play',
  tickets:'/api/keno/tickets',
  results:'/api/keno/results'
};
const MIN_STAKE=10,MAX_STAKE=1000,STEP=10,MAX_PICKS=10;

const PAYTABLE = {
  1: {1: 3.8},
  2: {2: 15},
  3: {2: 2, 3: 30},
  4: {2: 1, 3: 6, 4: 100},
  5: {3: 3, 4: 15, 5: 400},
  6: {3: 1, 4: 6, 5: 50, 6: 1200},
  7: {4: 3, 5: 15, 6: 150, 7: 3000},
  8: {4: 2, 5: 10, 6: 60, 7: 600, 8: 8000},
  9: {5: 5, 6: 30, 7: 250, 8: 2000, 9: 12000},
  10: {5: 2, 6: 12, 7: 80, 8: 600, 9: 3000, 10: 20000}
};

const $=s=>document.querySelector(s);
const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : null;
const state={identifier:String(tg?.initDataUnsafe?.user?.id??''),name:'Player',balance:0,picks:new Set(),stake:MIN_STAKE,round:null,myTickets:[],fakeBets:[],drawingRound:null,activeTab:'ACTIVE',draw:[],activePlayerCount:180};
const el={grid:$('#numberGrid'),timerBadge:$('#roundTimerBadge'),title:$('#gameTitle'),count:$('#selectedCount'),stake:$('#stakeAmount'),bet:$('#betButton'),balance:$('.wallet-balance'),player:$('#playerInfo'),notice:$('#notice'),placeholder:$('#drawPlaceholder'),current:$('#currentBall'),controls:$('#bettingControlsSection'),drawn:$('#drawnBalls'),counter:$('#drawCounter'),list:$('#ticketList'),listTitle:$('#listTitle'),listCount:$('#listCount'),activePlayers:$('#activePlayerCount')};
let noticeTimer=null,pollBusy=false;

function playClickSound(){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(650, ctx.currentTime);
    gain.gain.setValueAtTime(0.04, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.07);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.07);
  }catch(e){}
}

function money(v){const n=Number(v);return `${(Number.isFinite(n)?n:0).toFixed(2)} ETB`;}
function updateBalance(v){const n=Number(v);if(!Number.isFinite(n)||n<0)return;state.balance=n;el.balance.textContent=money(n);}
function notice(message,error=false){el.notice.textContent=message;el.notice.classList.toggle('error',error);el.notice.classList.add('show');clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>el.notice.classList.remove('show'),3000);}
async function request(url,options={}){const response=await fetch(url,{...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}});const raw=await response.text();let data={};try{data=raw?JSON.parse(raw):{};}catch{}if(!response.ok||data.success===false){const detail=data.error||data.message||`HTTP ${response.status}`;throw new Error(`${detail} · ${url}`);}return data;}

async function loadUser(){
  if(tg){tg.ready();tg.expand();}
  const tgUser=tg?.initDataUnsafe?.user;
  if(!tgUser?.id){
    notice('እባክዎ Kenoን ከTelegram Web App ይክፈቱ።',true);
    return;
  }
  try{
    const data=await request(API.user,{
      method:'POST',
      body:JSON.stringify({
        telegram_id:String(tgUser.id),
        name:[tgUser.first_name,tgUser.last_name].filter(Boolean).join(' ')||'Keno Player',
        username:tgUser.username||''
      })
    });
    
    if(data.user){
      state.identifier=String(data.user.telegram_id??tgUser.id);
      state.name=data.user.name||tgUser.first_name||'Player';
      el.player.textContent=`PLAYER · ${state.name}`;
      
      // ከ /api/wallet/sync የሚመጣውን balance በቀጥታ በመጠቀም ፈጣን ጭነት ማድረግ
      if(data.user.balance !== undefined){
        updateBalance(data.user.balance);
      }
    }else{
      state.identifier=String(tgUser.id);
      el.player.textContent=`PLAYER · ${state.name}`;
      await refreshWallet();
    }
  }catch(err){
    console.error('Keno user load:',err);
    notice(err.message||'የተጠቃሚ መረጃ ማግኘት አልተቻለም።',true);
  }
}

async function refreshWallet(){
  if(!state.identifier)return;
  try{
    const data=await request(API.user,{
      method:'POST',
      body:JSON.stringify({telegram_id: state.identifier})
    });
    if(data.user && data.user.balance !== undefined){
      updateBalance(data.user.balance);
    }
  }catch(err){
    console.warn('Wallet refresh:', err.message);
  }
}

function buildGrid(){el.grid.replaceChildren();for(let n=1;n<=80;n++){const b=document.createElement('button');b.type='button';b.className='number';b.textContent=String(n);b.dataset.number=String(n);b.addEventListener('click',()=>{playClickSound();togglePick(n);});el.grid.appendChild(b);}syncGrid();}

function togglePick(n){if(!state.round||state.round.status!=='BETTING')return;if(state.picks.has(n))state.picks.delete(n);else{if(state.picks.size>=MAX_PICKS)return notice('እስከ 10 ቁጥሮች ብቻ መምረጥ ይችላሉ።',true);state.picks.add(n);}syncGrid();}

function syncGrid(){el.grid.querySelectorAll('.number').forEach(b=>{const n=Number(b.dataset.number);b.classList.toggle('selected',state.picks.has(n));b.classList.toggle('winning',state.draw.includes(n));b.disabled=!state.round||state.round.status!=='BETTING';});el.count.textContent=state.picks.size;}

function setStake(v){if(state.round&&state.round.status!=='BETTING')return;let n=Math.floor(Number(v)/STEP)*STEP;state.stake=Math.min(MAX_STAKE,Math.max(MIN_STAKE,Number.isFinite(n)?n:MIN_STAKE));el.stake.textContent=money(state.stake);updateBetButton();}

function updateBetButton(){if(!state.round||state.round.status!=='BETTING'){el.bet.textContent='ውጤቱን በመጠበቅ ላይ';el.bet.disabled=true;}else{el.bet.textContent=`BET · ${money(state.stake)}`;el.bet.disabled=false;}}

async function placeBet(){
  if(!state.identifier)return notice('የTelegram ተጠቃሚ መለያ አልተገኘም።',true);
  if(!state.round||state.round.status!=='BETTING')return notice('የውርርድ ጊዜው ተዘግቷል።',true);
  if(!state.picks.size)return notice('ቢያንስ 1 ቁጥር ይምረጡ።',true);
  if(state.stake>state.balance)return notice('በዋሌትዎ ውስጥ በቂ ብር የለም።',true);
  el.bet.disabled=true;
  playClickSound();
  try{
    const data=await request(API.play,{method:'POST',body:JSON.stringify({identifier:state.identifier,picks:[...state.picks].sort((a,b)=>a-b),stake:state.stake})});
    state.myTickets.push(data.ticket);
    updateBalance(data.balance);
    state.picks.clear();
    syncGrid();
    updateBetButton();
    renderTabContent();
    notice('ቲኬትዎ ተመዝግቧል!');
  }catch(err){
    notice(err.message||'ቲኬት መመዝገብ አልተቻለም።',true);
    await refreshStatus();
  }finally{updateBetButton();}
}

function generateFakeBets(timeLeft){
  if(state.fakeBets.length >= 20 || !timeLeft) return;
  const stakes = [1000, 700, 800, 665, 500, 470, 400, 350, 200, 150, 100, 50];
  const stake = stakes[Math.floor(Math.random() * stakes.length)];
  const pickCount = Math.floor(Math.random() * 8) + 2;
  const picks = [];
  while(picks.length < pickCount){
    const r = Math.floor(Math.random() * 80) + 1;
    if(!picks.includes(r)) picks.push(r);
  }
  picks.sort((a,b)=>a-b);
  state.fakeBets.push({id: 'FK-' + Math.floor(Math.random()*8999+1000), name: 'Player ' + Math.floor(Math.random()*900+100), stake: stake, picks: picks});
  state.fakeBets.sort((a,b) => b.stake - a.stake);
}

function makePicks(values,draw=[]){const box=document.createElement('div');box.className='picks';(values||[]).forEach(n=>{const b=document.createElement('span');b.className='pick'+(draw.includes(n)?' matched':'');b.textContent=String(n).padStart(2,'0');box.appendChild(b);});return box;}

function renderTabContent(){
  el.list.replaceChildren();
  if(state.activeTab === 'ACTIVE'){
    el.listTitle.textContent = 'የእርስዎ ቲኬቶች እና የቀጥታ ተጫዋቾች (Active)';
    let allItems = [];
    state.myTickets.forEach((t, idx) => allItems.push({isMine: true, ticket: t, index: idx+1}));
    state.fakeBets.forEach((t, idx) => allItems.push({isMine: false, ticket: t, index: idx+1}));
    el.listCount.textContent = String(allItems.length);
    if(!allItems.length){
      el.list.innerHTML='<div class="empty">በዚህ ዙር የተያዙ ቲኬቶች እየተጫኑ ነው...</div>';
      return;
    }
    allItems.forEach((item) => {
      const row=document.createElement('div');row.className='item';
      const top=document.createElement('div');top.className='itemtop';
      const a=document.createElement('span');
      const t = item.ticket;
      let matchedCount = (t.picks||[]).filter(p => state.draw.includes(p)).length;
      let mult = (PAYTABLE[t.picks?.length] && PAYTABLE[t.picks?.length][matchedCount]) || 0;
      let payout = (t.stake || 10) * mult;
      const isDrawingOrClosed = state.draw.length > 0;
      const s=document.createElement('span');

      if(item.isMine){
        a.innerHTML = `⭐ <b>የእርስዎ ቲኬት #${item.index}</b>`;
        if(!isDrawingOrClosed){s.className = 'waiting';s.textContent = 'በመጠበቅ ላይ...';}
        else if(payout > 0){s.className = 'won';s.textContent = `አሸንፈዋል! +${money(payout)}`;}
        else{s.className = 'lost';s.textContent = 'አልተሳካም (0.00 ETB)';}
      } else {
        a.innerHTML = `🏆 <b>TOP · ${t.name}</b>`;
        if(!isDrawingOrClosed){s.className = 'waiting';s.textContent = 'በመጠበቅ ላይ';}
        else if(payout > 0){s.className = 'won';s.textContent = `አሸነፈ: +${money(payout)}`;}
        else{s.className = 'lost';s.textContent = 'አልተሳካም';}
      }
      top.append(a,s);
      const bottom=document.createElement('div');bottom.className='itembottom';
      bottom.textContent = `ውርርድ ${money(t.stake)} ${isDrawingOrClosed ? '· መታ: ' + matchedCount + ' ቁጥር' : ''}`;
      row.append(top,makePicks(t.picks,state.draw),bottom);
      el.list.append(row);
    });
    return;
  }
  return loadOtherTabs();
}

async function loadOtherTabs(){
  try{
    if(state.activeTab==='HISTORY'){
      el.listTitle.textContent='የውርርድ ታሪክ';
      const data=await request(`${API.tickets}?identifier=${encodeURIComponent(state.identifier)}`);
      renderItems(data.tickets||[],'HISTORY');
    }else if(state.activeTab==='RESULTS'){
      el.listTitle.textContent='የቅርብ ውጤቶች';
      const data=await request(API.results);
      renderItems(data.results||[],'RESULTS');
    }
  }catch(err){el.list.innerHTML='';const d=document.createElement('div');d.className='empty';d.textContent=err.message;el.list.append(d);}
}

function renderItems(items,type){el.list.replaceChildren();el.listCount.textContent=String(items.length);if(!items.length){el.list.innerHTML='<div class="empty">ምንም መረጃ የለም።</div>';return;}items.forEach(item=>{const row=document.createElement('div');row.className='item';const top=document.createElement('div');top.className='itemtop';const label=document.createElement('span');label.textContent=type==='RESULTS'?`ዙር #${item.roundId}`:`ዙር #${item.roundId} · ${new Date(item.createdAt).toLocaleString()}`;const status=document.createElement('span');status.className=item.status==='WON'?'won':item.status==='LOST'?'lost':'waiting';status.textContent=type==='RESULTS'?(item.status==='CLOSED'?'ተዘግቷል':'ውጤት'):(item.status==='WON'?'አሸንፈዋል':item.status==='LOST'?'አልተሳካም':'በመጠበቅ ላይ');top.append(label,status);row.append(top,makePicks(type==='RESULTS'?item.draw:item.picks,type==='RESULTS'?[]:(item.draw||[])));if(type!=='RESULTS'){const bottom=document.createElement('div');bottom.className='itembottom';bottom.textContent=`ውርርድ ${money(item.stake)} · ክፍያ ${money(item.payout)}`;row.append(bottom);}el.list.append(row);});}

async function animateDraw(draw,roundId){
  if(!Array.isArray(draw)||!draw.length||state.drawingRound===roundId)return;
  state.drawingRound=roundId;
  state.draw=[];
  el.placeholder.style.display='none';
  el.current.style.display='grid';
  el.controls.style.display='none';
  el.title.textContent='ቀጥታ የKeno ውጤት በመውጣት ላይ...';
  for(let i=0;i<draw.length;i++){
    state.draw.push(Number(draw[i]));
    el.current.textContent=String(draw[i]);
    el.counter.textContent=`ቁጥር ${i+1} ከ ${draw.length}`;
    const ball=document.createElement('span');
    ball.className='ball active';
    ball.textContent=String(draw[i]);
    el.drawn.append(ball);
    syncGrid();
    renderTabContent();
    if(i<draw.length-1)await new Promise(resolve=>setTimeout(resolve,700));
  }
  el.title.textContent='የዙሩ ውጤት ተጠናቀቀ';
  if(state.myTickets.length)await refreshMyTicket().catch(()=>{});
}

async function refreshMyTicket(){const data=await request(`${API.tickets}?identifier=${encodeURIComponent(state.identifier)}`);if(data.tickets) { state.myTickets = data.tickets.filter(t => String(t.roundId) === String(state.round?.roundId)); renderTabContent(); } await refreshWallet();}

async function refreshStatus(){
  if(pollBusy)return;pollBusy=true;
  try{
    const data=await request(API.status);
    const round=data.round;
    if(!round)return;
    const old=state.round?.roundId;
    state.round=round;
    if(round.status==='BETTING'){
      if(old!==round.roundId){
        state.picks.clear();
        state.myTickets=[];
        state.fakeBets=[];
        state.draw=[];
        state.drawingRound=null;
        el.current.textContent='';
        el.current.style.display='none';
        el.controls.style.display='block';
        el.drawn.replaceChildren();
        el.counter.textContent='';
        el.placeholder.style.display='block';
        el.title.textContent='ቁጥሮችዎን ይምረጡ';
      }
      generateFakeBets(round.timeLeft);
      el.timerBadge.textContent=`${round.timeLeft}ሰ`;
    }else if(round.status==='DRAWING'){
      el.timerBadge.textContent=`ውጤት`;
      await animateDraw(round.draw,round.roundId);
    }else el.timerBadge.textContent='ጨርሷል';
    syncGrid();
    updateBetButton();
    if(state.activeTab==='ACTIVE')renderTabContent();
  }catch(err){console.error('Keno status:',err);}finally{pollBusy=false;}
}

function bind(){
  el.bet.addEventListener('click',placeBet);
  $('#minus').addEventListener('click',()=>setStake(state.stake-STEP));
  $('#plus').addEventListener('click',()=>setStake(state.stake+STEP));
  $('#double').addEventListener('click',()=>setStake(state.stake*2));
  $('#max').addEventListener('click',()=>setStake(Math.min(MAX_STAKE,Math.floor(state.balance/STEP)*STEP)));

  document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',async()=>{
    document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b===btn));
    state.activeTab=btn.dataset.tab;
    await renderTabContent();
  }));
}

async function init(){
  buildGrid();
  bind();
  setStake(MIN_STAKE);
  await loadUser();
  await refreshStatus();
  await renderTabContent();
  
  setInterval(() => {
    state.activePlayerCount += Math.floor(Math.random() * 35) + 10;
    if(state.activePlayerCount > 2800) state.activePlayerCount = 450;
    el.activePlayers.textContent = state.activePlayerCount;
  }, 2000);

  setInterval(refreshStatus,1000);
  setInterval(()=>{refreshWallet().catch(err=>console.warn('Wallet refresh:',err.message));},15000);
}

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
