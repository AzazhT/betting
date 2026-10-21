
/* Fast Keno Frontend — Wallet Sync + Real Tickets */
(() => {
  'use strict';

  const API = {
    user: '/api/wallet/sync',
    wallet: '/api/wallet/sync',
    status: '/api/keno/status',
    play: '/api/keno/play',
    tickets: '/api/keno/tickets',
    results: '/api/keno/results'
  };

  const MIN_STAKE = 10;
  const MAX_STAKE = 1000;
  const STEP = 10;
  const MAX_PICKS = 10;
  const DRAW_DELAY = 700;

  const $ = selector => document.querySelector(selector);

  const tg = window.Telegram?.WebApp || null;

  const state = {
    identifier: '',
    name: 'Player',
    balance: 0,
    userLoaded: false,
    picks: new Set(),
    stake: MIN_STAKE,
    round: null,
    myTickets: [],
    activeTab: 'ACTIVE',
    draw: [],
    drawingRound: null,
    animating: false,
    betBusy: false,
    historyRequest: 0
  };

  const el = {
    grid: $('#numberGrid'),
    timerBadge: $('#roundTimerBadge'),
    title: $('#gameTitle'),
    count: $('#selectedCount'),
    stake: $('#stakeAmount'),
    bet: $('#betButton'),
    balance: $('.wallet-balance'),
    player: $('#playerInfo'),
    notice: $('#notice'),
    placeholder: $('#drawPlaceholder'),
    current: $('#currentBall'),
    controls: $('#bettingControlsSection'),
    drawn: $('#drawnBalls'),
    counter: $('#drawCounter'),
    list: $('#ticketList'),
    listTitle: $('#listTitle'),
    listCount: $('#listCount'),
    activePlayers: $('#activePlayerCount')
  };

  let noticeTimer = null;
  let pollBusy = false;

  function money(value) {
    const number = Number(value);
    return `${(Number.isFinite(number) ? number : 0).toFixed(2)} ETB`;
  }

  function getRoundId(round) {
    return round?.roundId ?? round?.round_id ?? round?.id ?? null;
  }

  function getTicketRoundId(ticket) {
    return ticket?.roundId ?? ticket?.round_id ?? null;
  }

  function getPicks(ticket) {
    const picks = ticket?.picks ?? ticket?.numbers ?? [];
    return Array.isArray(picks)
      ? picks.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 80)
      : [];
  }

  function getTicketStatus(ticket) {
    return String(ticket?.status ?? 'PENDING').toUpperCase();
  }

  function getTicketPayout(ticket) {
    const value = Number(ticket?.payout ?? ticket?.winAmount ?? ticket?.win_amount ?? 0);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  function updateBalance(value) {
    const number = Number(value);

    if (!Number.isFinite(number) || number < 0) return;

    state.balance = number;

    if (el.balance) {
      el.balance.textContent = money(number);
    }
  }

  function notice(message, error = false) {
    if (!el.notice) {
      console[error ? 'error' : 'log'](message);
      return;
    }

    el.notice.textContent = message;
    el.notice.classList.toggle('error', error);
    el.notice.classList.add('show');

    clearTimeout(noticeTimer);

    noticeTimer = setTimeout(() => {
      el.notice.classList.remove('show');
    }, 3500);
  }

  function playClickSound() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;

      const context = new AudioContextClass();
      const oscillator = context.createOscillator();
      const gain = context.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(650, context.currentTime);
      gain.gain.setValueAtTime(0.035, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(
        0.001,
        context.currentTime + 0.07
      );

      oscillator.connect(gain);
      gain.connect(context.destination);

      oscillator.start();
      oscillator.stop(context.currentTime + 0.07);
      oscillator.onended = () => context.close().catch(() => {});
    } catch (_) {
      // Sound is optional.
    }
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });

    const raw = await response.text();
    let data = {};

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_) {
      throw new Error(`የServer ምላሽ JSON አይደለም። (${url})`);
    }

    if (!response.ok || data.success === false) {
      throw new Error(
        data.error ||
        data.message ||
        `HTTP ${response.status} · ${url}`
      );
    }

    return data;
  }

  function getTelegramUser() {
    return tg?.initDataUnsafe?.user || null;
  }

  async function loadUser() {
    if (tg) {
      tg.ready();
      tg.expand();
    }

    const telegramUser = getTelegramUser();

    if (!telegramUser?.id) {
      state.userLoaded = false;
      notice('እባክዎ Kenoን ከTelegram Web App ይክፈቱ።', true);
      updateBetButton();
      return;
    }

    state.identifier = String(telegramUser.id);

    const name = [
      telegramUser.first_name,
      telegramUser.last_name
    ].filter(Boolean).join(' ');

    try {
      const data = await request(API.user, {
        method: 'POST',
        body: JSON.stringify({
          telegram_id: state.identifier,
          name: name || 'Keno Player',
          username: telegramUser.username || ''
        })
      });

      if (!data.user) {
        throw new Error('የተጠቃሚ መረጃ ከServer አልተመለሰም።');
      }

      state.identifier = String(
        data.user.telegram_id ?? state.identifier
      );

      state.name = data.user.name || name || 'Player';
      state.userLoaded = true;

      if (el.player) {
        el.player.textContent = `PLAYER · ${state.name}`;
      }

      if (data.user.balance !== undefined) {
        updateBalance(data.user.balance);
      } else {
        await refreshWallet();
      }
    } catch (error) {
      state.userLoaded = false;
      console.error('Keno user load:', error);
      notice(error.message || 'የተጠቃሚ መረጃ ማግኘት አልተቻለም።', true);
    }

    updateBetButton();
  }

  async function refreshWallet() {
    if (!state.identifier) return;

    try {
      const data = await request(API.wallet, {
        method: 'POST',
        body: JSON.stringify({
          telegram_id: state.identifier
        })
      });

      if (data.user?.balance !== undefined) {
        updateBalance(data.user.balance);
      }
    } catch (error) {
      console.warn('Wallet refresh:', error.message);
    }
  }

  function buildGrid() {
    if (!el.grid) {
      console.error('Keno HTML is missing #numberGrid');
      return;
    }

    el.grid.replaceChildren();

    for (let number = 1; number <= 80; number++) {
      const button = document.createElement('button');

      button.type = 'button';
      button.className = 'number';
      button.textContent = String(number);
      button.dataset.number = String(number);

      button.addEventListener('click', () => {
        playClickSound();
        togglePick(number);
      });

      el.grid.appendChild(button);
    }

    syncGrid();
  }

  function togglePick(number) {
    if (!state.round || state.round.status !== 'BETTING') {
      notice('የመምረጫ ጊዜው አልቋል።', true);
      return;
    }

    if (state.picks.has(number)) {
      state.picks.delete(number);
    } else {
      if (state.picks.size >= MAX_PICKS) {
        notice('እስከ 10 ቁጥሮች ብቻ መምረጥ ይችላሉ።', true);
        return;
      }

      state.picks.add(number);
    }

    syncGrid();
  }

  function syncGrid() {
    if (el.grid) {
      el.grid.querySelectorAll('.number').forEach(button => {
        const number = Number(button.dataset.number);

        button.classList.toggle('selected', state.picks.has(number));
        button.classList.toggle('winning', state.draw.includes(number));

        button.disabled = (
          !state.round ||
          state.round.status !== 'BETTING' ||
          state.betBusy
        );
      });
    }

    if (el.count) {
      el.count.textContent = String(state.picks.size);
    }
  }

  function setStake(value) {
    if (state.round && state.round.status !== 'BETTING') return;
    if (state.betBusy) return;

    const amount = Number(value);
    const rounded = Number.isFinite(amount)
      ? Math.floor(amount / STEP) * STEP
      : MIN_STAKE;

    state.stake = Math.min(
      MAX_STAKE,
      Math.max(MIN_STAKE, rounded)
    );

    if (el.stake) {
      el.stake.textContent = money(state.stake);
    }

    updateBetButton();
  }

  function updateBetButton() {
    if (!el.bet) return;

    if (!state.userLoaded) {
      el.bet.disabled = true;
      el.bet.textContent = 'የተጠቃሚ መረጃ በመጠበቅ ላይ';
    } else if (state.betBusy) {
      el.bet.disabled = true;
      el.bet.textContent = 'ቲኬት በመመዝገብ ላይ...';
    } else if (!state.round || state.round.status !== 'BETTING') {
      el.bet.disabled = true;
      el.bet.textContent = 'ውጤቱን በመጠበቅ ላይ';
    } else {
      el.bet.disabled = false;
      el.bet.textContent = `BET · ${money(state.stake)}`;
    }

    syncGrid();
  }

  async function placeBet() {
    if (state.betBusy) return;

    if (!state.userLoaded || !state.identifier) {
      notice('የTelegram ተጠቃሚ መለያ አልተገኘም።', true);
      return;
    }

    if (!state.round || state.round.status !== 'BETTING') {
      notice('የውርርድ ጊዜው ተዘግቷል።', true);
      return;
    }

    if (state.picks.size < 1) {
      notice('ቢያንስ 1 ቁጥር ይምረጡ።', true);
      return;
    }

    if (state.picks.size > MAX_PICKS) {
      notice('ከ10 በላይ ቁጥሮች መምረጥ አይቻልም።', true);
      return;
    }

    if (
      state.stake < MIN_STAKE ||
      state.stake > MAX_STAKE ||
      state.stake % STEP !== 0
    ) {
      notice('የውርርድ መጠኑ ትክክል አይደለም።', true);
      return;
    }

    if (state.stake > state.balance) {
      notice('በዋሌትዎ ውስጥ በቂ ብር የለም።', true);
      return;
    }

    state.betBusy = true;
    updateBetButton();
    playClickSound();

    try {
      const data = await request(API.play, {
        method: 'POST',
        body: JSON.stringify({
          identifier: state.identifier,
          picks: [...state.picks].sort((a, b) => a - b),
          stake: state.stake
        })
      });

      if (!data.ticket) {
        throw new Error('Server የቲኬት መረጃ አልመለሰም።');
      }

      const ticket = data.ticket;
      const ticketId = ticket.id ?? ticket.ticketId ?? ticket.ticket_id;

      const alreadyExists = state.myTickets.some(existing => {
        const existingId =
          existing.id ?? existing.ticketId ?? existing.ticket_id;

        return ticketId != null && String(existingId) === String(ticketId);
      });

      if (!alreadyExists) {
        state.myTickets.unshift(ticket);
      }

      if (data.balance !== undefined) {
        updateBalance(data.balance);
      } else if (data.user?.balance !== undefined) {
        updateBalance(data.user.balance);
      } else {
        await refreshWallet();
      }

      state.picks.clear();
      syncGrid();
      renderTabContent();

      notice('ቲኬትዎ በተሳካ ሁኔታ ተመዝግቧል!');
    } catch (error) {
      console.error('Keno bet:', error);
      notice(error.message || 'ቲኬት መመዝገብ አልተቻለም።', true);

      await refreshStatus();
      await refreshWallet();
    } finally {
      state.betBusy = false;
      updateBetButton();
    }
  }

  function makePicks(values, draw = []) {
    const box = document.createElement('div');
    box.className = 'picks';

    (values || []).forEach(value => {
      const number = Number(value);
      const span = document.createElement('span');

      span.className = 'pick' + (
        draw.includes(number) ? ' matched' : ''
      );

      span.textContent = String(number).padStart(2, '0');
      box.appendChild(span);
    });

    return box;
  }

  function createTicketRow(ticket, index) {
    const row = document.createElement('div');
    row.className = 'item';

    const top = document.createElement('div');
    top.className = 'itemtop';

    const label = document.createElement('span');
    label.textContent = `⭐ ቲኬት #${index}`;

    const status = document.createElement('span');
    const ticketStatus = getTicketStatus(ticket);

    if (ticketStatus === 'WON') {
      status.className = 'won';
      status.textContent = `አሸንፈዋል · ${money(getTicketPayout(ticket))}`;
    } else if (ticketStatus === 'LOST') {
      status.className = 'lost';
      status.textContent = 'አልተሳካም';
    } else {
      status.className = 'waiting';
      status.textContent = 'በመጠበቅ ላይ...';
    }

    top.append(label, status);

    const picks = getPicks(ticket);
    row.append(top, makePicks(picks, state.draw));

    const bottom = document.createElement('div');
    bottom.className = 'itembottom';

    const stake = Number(ticket.stake ?? 0);
    bottom.textContent = `ውርርድ ${money(stake)}`;

    if (ticketStatus === 'WON' || ticketStatus === 'LOST') {
      bottom.textContent += ` · ክፍያ ${money(getTicketPayout(ticket))}`;
    } else if (state.draw.length) {
      const matches = picks.filter(number => state.draw.includes(number)).length;
      bottom.textContent += ` · የተመቱ ${matches} ቁጥሮች`;
    }

    row.appendChild(bottom);
    return row;
  }

  function renderTabContent() {
    if (!el.list) return;

    el.list.replaceChildren();

    if (state.activeTab === 'ACTIVE') {
      if (el.listTitle) {
        el.listTitle.textContent = 'የእርስዎ ቲኬቶች';
      }

      const currentRoundId = getRoundId(state.round);

      const tickets = state.myTickets.filter(ticket => {
        const ticketRoundId = getTicketRoundId(ticket);

        // If the API doesn't include a round ID, keep the ticket visible.
        return ticketRoundId == null ||
          currentRoundId == null ||
          String(ticketRoundId) === String(currentRoundId);
      });

      if (el.listCount) {
        el.listCount.textContent = String(tickets.length);
      }

      if (!tickets.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'በዚህ ዙር እስካሁን ቲኬት አልተመዘገበም።';
        el.list.appendChild(empty);
        return;
      }

      tickets.forEach((ticket, index) => {
        el.list.appendChild(createTicketRow(ticket, index + 1));
      });

      return;
    }

    loadOtherTabs();
  }

  async function loadOtherTabs() {
    if (!state.identifier && state.activeTab === 'HISTORY') return;

    const requestId = ++state.historyRequest;

    try {
      if (state.activeTab === 'HISTORY') {
        if (el.listTitle) el.listTitle.textContent = 'የውርርድ ታሪክ';

        const data = await request(
          `${API.tickets}?identifier=${encodeURIComponent(state.identifier)}`
        );

        if (requestId !== state.historyRequest ||
            state.activeTab !== 'HISTORY') return;

        renderItems(data.tickets || [], 'HISTORY');
      } else if (state.activeTab === 'RESULTS') {
        if (el.listTitle) el.listTitle.textContent = 'የቅርብ ውጤቶች';

        const data = await request(API.results);

        if (requestId !== state.historyRequest ||
            state.activeTab !== 'RESULTS') return;

        renderItems(data.results || [], 'RESULTS');
      }
    } catch (error) {
      if (requestId !== state.historyRequest) return;

      el.list.replaceChildren();

      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = error.message || 'መረጃ ማግኘት አልተቻለም።';

      el.list.appendChild(empty);
    }
  }

  function renderItems(items, type) {
    if (!el.list) return;

    el.list.replaceChildren();

    if (el.listCount) {
      el.listCount.textContent = String(items.length);
    }

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'ምንም መረጃ የለም።';
      el.list.appendChild(empty);
      return;
    }

    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'item';

      const top = document.createElement('div');
      top.className = 'itemtop';

      const label = document.createElement('span');
      const roundId = item.roundId ?? item.round_id ?? '?';

      if (type === 'RESULTS') {
        label.textContent = `ዙር #${roundId}`;
      } else {
        const createdAt = item.createdAt ?? item.created_at;
        const dateText = createdAt
          ? new Date(createdAt).toLocaleString()
          : '';

        label.textContent = `ዙር #${roundId}${dateText ? ' · ' + dateText : ''}`;
      }

      const status = document.createElement('span');
      const ticketStatus = getTicketStatus(item);

      if (ticketStatus === 'WON') {
        status.className = 'won';
        status.textContent = 'አሸንፈዋል';
      } else if (ticketStatus === 'LOST') {
        status.className = 'lost';
        status.textContent = 'አልተሳካም';
      } else {
        status.className = 'waiting';
        status.textContent = type === 'RESULTS' ? 'ውጤት' : 'በመጠበቅ ላይ';
      }

      top.append(label, status);
      row.appendChild(top);

      if (type === 'RESULTS') {
        const draw = item.draw ?? item.numbers ?? [];
        row.appendChild(makePicks(draw));
      } else {
        const picks = getPicks(item);
        const draw = Array.isArray(item.draw) ? item.draw.map(Number) : [];

        row.appendChild(makePicks(picks, draw));

        const bottom = document.createElement('div');
        bottom.className = 'itembottom';
        bottom.textContent =
          `ውርርድ ${money(item.stake)} · ክፍያ ${money(getTicketPayout(item))}`;

        row.appendChild(bottom);
      }

      el.list.appendChild(row);
    });
  }

  function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  async function animateDraw(draw, roundId) {
    if (!Array.isArray(draw) || !draw.length) return;
    if (state.drawingRound === String(roundId)) return;

    state.drawingRound = String(roundId);
    state.animating = true;
    state.draw = [];

    if (el.placeholder) el.placeholder.style.display = 'none';
    if (el.current) {
      el.current.style.display = 'grid';
      el.current.textContent = '';
    }
    if (el.controls) el.controls.style.display = 'none';
    if (el.title) el.title.textContent = 'የKeno ውጤት በመውጣት ላይ...';
    if (el.drawn) el.drawn.replaceChildren();

    try {
      for (let index = 0; index < draw.length; index++) {
        const number = Number(draw[index]);

        if (!Number.isInteger(number) || number < 1 || number > 80) {
          continue;
        }

        state.draw.push(number);

        if (el.current) {
          el.current.textContent = String(number).padStart(2, '0');
        }

        if (el.counter) {
          el.counter.textContent = `ቁጥር ${index + 1} ከ ${draw.length}`;
        }

        if (el.drawn) {
          const ball = document.createElement('span');
          ball.className = 'ball active';
          ball.textContent = String(number).padStart(2, '0');
          el.drawn.appendChild(ball);
        }

        syncGrid();
        renderTabContent();

        if (index < draw.length - 1) {
          await sleep(DRAW_DELAY);
        }
      }

      if (el.title) el.title.textContent = 'የዙሩ ውጤት ተጠናቋል';

      await refreshMyTickets();
      await refreshWallet();
    } finally {
      state.animating = false;
    }
  }

  async function refreshMyTickets() {
    if (!state.identifier) return;

    try {
      const data = await request(
        `${API.tickets}?identifier=${encodeURIComponent(state.identifier)}`
      );

      if (Array.isArray(data.tickets)) {
        const currentRoundId = getRoundId(state.round);

        state.myTickets = data.tickets.filter(ticket => {
          const ticketRoundId = getTicketRoundId(ticket);

          return ticketRoundId == null ||
            currentRoundId == null ||
            String(ticketRoundId) === String(currentRoundId);
        });

        renderTabContent();
      }
    } catch (error) {
      console.warn('Keno tickets refresh:', error.message);
    }
  }

  async function refreshStatus() {
    if (pollBusy) return;

    pollBusy = true;

    try {
      const data = await request(API.status);
      const round = data.round;

      if (!round) return;

      const previousRoundId = getRoundId(state.round);
      const nextRoundId = getRoundId(round);
      const isNewRound = String(previousRoundId) !== String(nextRoundId);

      state.round = round;

      // Use a real count from the API only; never invent player counts.
      const onlineCount = data.activePlayers ?? data.active_players;

      if (el.activePlayers && onlineCount !== undefined) {
        el.activePlayers.textContent = String(onlineCount);
      }

      if (isNewRound) {
        state.picks.clear();
        state.draw = [];
        state.drawingRound = null;

        if (el.current) {
          el.current.textContent = '';
          el.current.style.display = 'none';
        }

        if (el.drawn) el.drawn.replaceChildren();
        if (el.counter) el.counter.textContent = '';
        if (el.placeholder) el.placeholder.style.display = 'block';

        if (el.title) el.title.textContent = 'ቁጥሮችዎን ይምረጡ';

        if (el.controls) {
          el.controls.style.display =
            round.status === 'BETTING' ? 'block' : 'none';
        }

        await refreshMyTickets();
      }

      if (round.status === 'BETTING') {
        if (el.timerBadge) {
          el.timerBadge.textContent =
            `${Math.max(0, Number(round.timeLeft ?? round.time_left ?? 0))}ሰ`;
        }

        if (el.controls) el.controls.style.display = 'block';

        // Restore the previous draw display only when the new round is betting.
        if (el.current) el.current.style.display = 'none';
        if (el.placeholder) el.placeholder.style.display = 'block';
      } else if (round.status === 'DRAWING') {
        if (el.timerBadge) el.timerBadge.textContent = 'ውጤት';

        const draw = round.draw ?? round.numbers;

        if (Array.isArray(draw) && draw.length) {
          // Do not await the animation: status polling can continue.
          animateDraw(draw, nextRoundId).catch(error => {
            console.error('Keno draw animation:', error);
          });
        }
      } else {
        if (el.timerBadge) el.timerBadge.textContent = 'ጨርሷል';

        const draw = round.draw ?? round.numbers;

        if (
          Array.isArray(draw) &&
          draw.length &&
          state.drawingRound !== String(nextRoundId)
        ) {
          animateDraw(draw, nextRoundId).catch(error => {
            console.error('Keno result animation:', error);
          });
        } else if (!state.animating && el.controls) {
          el.controls.style.display = 'none';
        }
      }

      syncGrid();
      updateBetButton();

      if (state.activeTab === 'ACTIVE' && !state.animating) {
        renderTabContent();
      }
    } catch (error) {
      console.error('Keno status:', error);
    } finally {
      pollBusy = false;
    }
  }

  function bind() {
    if (el.bet) {
      el.bet.addEventListener('click', placeBet);
    }

    $('#minus')?.addEventListener('click', () => {
      setStake(state.stake - STEP);
    });

    $('#plus')?.addEventListener('click', () => {
      setStake(state.stake + STEP);
    });

    $('#double')?.addEventListener('click', () => {
      setStake(state.stake * 2);
    });

    $('#max')?.addEventListener('click', () => {
      const affordable = Math.floor(state.balance / STEP) * STEP;
      setStake(Math.min(MAX_STAKE, affordable));
    });

    document.querySelectorAll('.tab').forEach(button => {
      button.addEventListener('click', async () => {
        document.querySelectorAll('.tab').forEach(tab => {
          tab.classList.toggle('active', tab === button);
        });

        state.activeTab = button.dataset.tab || 'ACTIVE';
        await renderTabContent();
      });
    });
  }

  async function init() {
    buildGrid();
    bind();
    setStake(MIN_STAKE);
    updateBetButton();

    await loadUser();
    await refreshStatus();
    await renderTabContent();

    // Refresh round status regularly.
    setInterval(refreshStatus, 1000);

    // Keep the displayed wallet synchronized with the server.
    setInterval(() => {
      refreshWallet();
    }, 15000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

