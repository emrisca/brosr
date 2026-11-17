'use strict';

import { Chess, SQUARES } from './chess-engine.mjs';

const params = new URLSearchParams(location.search);
const ROOM = params.get('room') || 'default';
const HOST = params.get('role') === 'host';
const PEER = params.get('peer') || (HOST ? 'host' : 'guest-' + Math.random().toString(16).slice(2, 10));
const NAME = cleanName(params.get('name')) || (HOST ? 'Host' : 'Guest');

const PIECES = { p: '\u265F', n: '\u265E', b: '\u265D', r: '\u265C', q: '\u265B', k: '\u265A' };
const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const PROMOTIONS = new Set(['q', 'r', 'b', 'n']);
const HERE_MS = 5000;
const STALE_MS = 120000;

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const hintEl = document.getElementById('hint');
const roomStateEl = document.getElementById('room-state');
const whitePlayerEl = document.getElementById('white-player');
const blackPlayerEl = document.getElementById('black-player');
const whiteNameEl = document.getElementById('white-name');
const blackNameEl = document.getElementById('black-name');
const whiteYouEl = document.getElementById('white-you');
const blackYouEl = document.getElementById('black-you');
const movesEl = document.getElementById('moves');
const moveCountEl = document.getElementById('move-count');
const newGameEl = document.getElementById('new-game');
const openSeatEl = document.getElementById('open-seat');
const joinEl = document.getElementById('join-game');
const leaveEl = document.getElementById('leave-seat');
const queueEl = document.getElementById('queue');
const queueBlockEl = document.getElementById('queue-block');
const sessionNumberEl = document.getElementById('session-number');
const sessionStateEl = document.getElementById('session-state');
const flipEl = document.getElementById('flip');
const promotionEl = document.getElementById('promotion');
const promotionCancelEl = document.getElementById('promotion-cancel');

let game = new Chess();
let socket = null;
let retryTimer = 0;
let helloTimer = 0;
let hereTimer = 0;
let awaitTimer = 0;
let connected = false;
let hasState = HOST;
let seats = HOST ? { [PEER]: 'w' } : {};
let names = HOST ? { w: NAME, b: '' } : { w: '', b: '' };
const seen = new Map();
let side = HOST ? 'w' : null;
let last = null;
let history = [];
let status = HOST ? gameStatus() : 'Connecting to the room.';
let selected = '';
let pending = null;
let awaiting = false;
let flipped = false;
let autoSide = null;
let session = 1;
let queue = [];
const labels = new Map();

newGameEl.hidden = !HOST;
openSeatEl.hidden = true;
newGameEl.addEventListener('click', newGame);
openSeatEl.addEventListener('click', openSeat);
joinEl.addEventListener('click', onJoinClick);
leaveEl.addEventListener('click', onLeaveClick);
flipEl.addEventListener('click', () => {
  flipped = !flipped;
  renderBoard();
});
boardEl.addEventListener('click', onBoardClick);
promotionEl.addEventListener('click', onPromotionClick);
promotionCancelEl.addEventListener('click', cancelPromotion);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && pending) {
    event.preventDefault();
    cancelPromotion();
  }
});

renderAll();
connect();

if (HOST) {
  window.setInterval(() => {
    if (!pruneSeats()) return;
    status = gameStatus();
    sendState();
    renderAll();
  }, 15000);
}

function connect() {
  if (socket) return;
  const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
  let next;
  try {
    next = new WebSocket(scheme + location.host + '/room?room=' + encodeURIComponent(ROOM));
  } catch {
    schedule();
    return;
  }
  socket = next;

  next.addEventListener('open', () => {
    if (socket !== next) return;
    connected = true;
    send({ op: 'hello', name: NAME });
    send({ op: 'here' });
    if (HOST) sendState();
    startHello();
    clearInterval(hereTimer);
    hereTimer = window.setInterval(() => send({ op: 'here' }), HERE_MS);
    renderAll();
  });

  next.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!frame || frame.type !== 'app' || frame.name !== 'chess') return;
    const data = frame.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    if (data.op !== 'move' && data.to && data.to !== PEER) return;
    if (HOST) hostMessage(String(frame.peerId || ''), data);
    else guestMessage(String(frame.peerId || ''), data);
  });

  next.addEventListener('close', () => {
    if (socket !== next) return;
    socket = null;
    connected = false;
    awaiting = false;
    hasState = HOST;
    clearInterval(helloTimer);
    clearInterval(hereTimer);
    clearTimeout(awaitTimer);
    helloTimer = 0;
    hereTimer = 0;
    awaitTimer = 0;
    schedule();
    renderAll();
  });

  next.addEventListener('error', () => next.close());
}

function schedule() {
  clearTimeout(retryTimer);
  retryTimer = window.setTimeout(connect, 2000);
}

function startHello() {
  clearInterval(helloTimer);
  if (HOST || hasState) return;
  helloTimer = window.setInterval(() => {
    if (connected && !hasState) send({ op: 'hello', name: NAME });
  }, 2000);
}

function send(data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ v: 1, type: 'app', peerId: PEER, name: 'chess', data }));
  return true;
}

function sendTo(peer, data) {
  if (!peer) return false;
  return send({ ...data, to: peer });
}

function hostMessage(peer, data) {
  if (!peer || peer === PEER) return;

  if (data.op === 'hello' || data.op === 'here') {
    seen.set(peer, Date.now());
    if (data.op === 'here') return;

    labels.set(peer, cleanName(data.name) || 'Guest');
    pruneSeats();
    sendState();
    renderAll();
    return;
  }

  if (data.op === 'join') joinSeat(peer);
  else if (data.op === 'leave') releaseSeat(peer);
  else if (data.op === 'unqueue') unqueue(peer, false);
  else if (data.op === 'move') applyMove(peer, data);
}

function guestMessage(peer, data) {
  if (data.op === 'state') {
    applyState(data);
    return;
  }
  if (data.op === 'invalid') {
    awaiting = false;
    clearTimeout(awaitTimer);
    awaitTimer = 0;
    status =
      typeof data.message === 'string' && data.message
        ? data.message.slice(0, 160)
        : 'That move is not legal.';
    renderAll();
  }
}

function applyMove(peer, data) {
  if (seats[peer] !== game.turn()) {
    sendState();
    return;
  }

  const from = typeof data.from === 'string' ? data.from : '';
  const to = typeof data.to === 'string' ? data.to : '';
  const promotion = cleanPromotion(data.promotion);
  if (!isSquare(from) || !isSquare(to)) {
    reject(peer, 'That move is not legal.');
    return;
  }

  let candidates = [];
  try {
    candidates = game.moves({ square: from, verbose: true }).filter((move) => move.to === to);
  } catch {
    candidates = [];
  }
  if (!candidates.length) {
    reject(peer, 'That move is not legal.');
    return;
  }

  const needsPromotion = candidates.some((move) => move.promotion);
  if (needsPromotion && !candidates.some((move) => move.promotion === promotion)) {
    reject(peer, 'Choose a promotion piece.');
    return;
  }

  try {
    const move = game.move({
      from,
      to,
      ...(needsPromotion ? { promotion } : {}),
    });
    if (!move) {
      reject(peer, 'That move is not legal.');
      return;
    }
    last = move;
    history = game.history();
    status = gameStatus();
    selected = '';
    pending = null;
    awaiting = false;
    clearTimeout(awaitTimer);
    awaitTimer = 0;
    hidePromotion();
    sendState();
    renderAll();
  } catch {
    reject(peer, 'That move is not legal.');
  }
}

function reject(peer, message) {
  if (peer === PEER) {
    status = message;
    renderAll();
    return;
  }
  sendTo(peer, { op: 'invalid', message });
}

function sendState() {
  if (!HOST) return;
  send({
    op: 'state',
    host: PEER,
    fen: game.fen(),
    seats: { ...seats },
    names: { ...names },
    session,
    queue: queue.map((entry) => ({ id: entry.id, name: entry.name })),
    history: game.history(),
    last: wireLast(last),
    status: status || gameStatus(),
  });
}

function applyState(data) {
  if (typeof data.fen !== 'string') return;
  const next = new Chess();
  try {
    next.load(data.fen);
  } catch {
    return;
  }

  game = next;
  seats = {};
  if (data.seats && typeof data.seats === 'object' && !Array.isArray(data.seats)) {
    for (const [peer, seat] of Object.entries(data.seats)) {
      if (peer && (seat === 'w' || seat === 'b')) seats[peer] = seat;
    }
  }
  names = {
    w: cleanName(data.names && data.names.w) || 'White',
    b: cleanName(data.names && data.names.b) || '',
  };
  session = Number.isInteger(data.session) && data.session > 0 ? data.session : 1;
  queue = Array.isArray(data.queue)
    ? data.queue
        .filter((entry) => entry && typeof entry.id === 'string' && entry.id)
        .map((entry) => ({ id: entry.id.slice(0, 64), name: cleanName(entry.name) || 'Guest' }))
        .slice(0, 32)
    : [];
  side = seats[PEER] || null;
  last = cleanLast(data.last);
  history = Array.isArray(data.history)
    ? data.history.filter((item) => typeof item === 'string').slice(0, 500)
    : [];
  status =
    typeof data.status === 'string' && data.status
      ? data.status.slice(0, 160)
      : gameStatus();
  hasState = true;
  awaiting = false;
  selected = '';
  pending = null;
  clearInterval(helloTimer);
  clearTimeout(awaitTimer);
  helloTimer = 0;
  awaitTimer = 0;
  hidePromotion();

  if (side && side !== autoSide) {
    autoSide = side;
    flipped = side === 'b';
  }
  renderAll();
}

function newGame() {
  if (!HOST) return;
  if (history.length && !window.confirm('Start a new game? This clears the board.')) return;
  game = new Chess();
  session += 1;
  last = null;
  history = [];
  status = gameStatus();
  selected = '';
  pending = null;
  awaiting = false;
  hidePromotion();
  sendState();
  renderAll();
}

function openSeat() {
  if (!HOST) return;
  const blackPeer = seatOwner('b');
  if (!blackPeer) return;
  seen.delete(blackPeer);
  releaseSeat(blackPeer);
}

function joinSeat(peer) {
  if (seats[peer]) {
    sendState();
    return;
  }
  const free = firstFreeSeat();
  if (free) {
    unqueue(peer, true);
    seats[peer] = free;
    names[free] = labels.get(peer) || 'Guest';
    status = gameStatus();
  } else if (!queue.some((entry) => entry.id === peer)) {
    queue.push({ id: peer, name: labels.get(peer) || 'Guest' });
    if (queue.length > 32) queue = queue.slice(-32);
  }
  sendState();
  renderAll();
}

function unqueue(peer, quiet) {
  const before = queue.length;
  queue = queue.filter((entry) => entry.id !== peer);
  if (!quiet && queue.length !== before) {
    sendState();
    renderAll();
  }
}

function releaseSeat(peer) {
  if (peer === PEER || !seats[peer]) return;
  freeSeat(peer);
  seatFromQueue();
  status = gameStatus();
  sendState();
  renderAll();
}

function freeSeat(peer) {
  const seat = seats[peer];
  if (!seat) return false;
  delete seats[peer];
  names[seat] = '';
  return true;
}

function firstFreeSeat() {
  if (!seatOwner('b')) return 'b';
  if (!seatOwner('w')) return 'w';
  return '';
}

function seatFromQueue() {
  const free = firstFreeSeat();
  if (!free) return false;
  const entry = queue.shift();
  if (!entry) return false;
  seats[entry.id] = free;
  names[free] = entry.name;
  return true;
}

function onJoinClick() {
  if (HOST || !hasState) return;
  if (queue.some((entry) => entry.id === PEER)) {
    send({ op: 'unqueue' });
    return;
  }
  send({ op: 'join' });
}

function onLeaveClick() {
  if (HOST || !side) return;
  if (history.length && !window.confirm('Leave your seat? The board stays for the next player.')) {
    return;
  }
  send({ op: 'leave' });
}

function pruneSeats() {
  let changed = false;
  const blackPeer = seatOwner('b');
  if (blackPeer) {
    const at = seen.get(blackPeer) || 0;
    if (Date.now() - at > STALE_MS) {
      freeSeat(blackPeer);
      changed = true;
    }
  }
  const kept = queue.filter((entry) => Date.now() - (seen.get(entry.id) || 0) <= STALE_MS);
  if (kept.length !== queue.length) {
    queue = kept;
    changed = true;
  }
  if (!seatOwner('b') && seatFromQueue()) changed = true;
  return changed;
}

function onBoardClick(event) {
  const button = event.target.closest('button[data-square]');
  if (!button || !boardEl.contains(button)) return;
  const square = button.dataset.square;
  if (!square || !canMove()) return;

  if (selected === square) {
    selected = '';
    renderBoard();
    return;
  }

  if (selected) {
    const moves = game
      .moves({ square: selected, verbose: true })
      .filter((move) => move.to === square);
    if (moves.length) {
      if (moves.some((move) => move.promotion)) {
        pending = { from: selected, to: square };
        selected = '';
        showPromotion(game.turn());
        renderAll();
        return;
      }
      playMove(selected, square, '');
      return;
    }
  }

  const piece = game.get(square);
  selected = piece && piece.color === game.turn() ? square : '';
  renderBoard();
}

function playMove(from, to, promotion) {
  selected = '';
  pending = null;
  hidePromotion();

  if (HOST) {
    applyMove(PEER, { from, to, ...(promotion ? { promotion } : {}) });
    return;
  }

  const data = { op: 'move', from, to };
  if (promotion) data.promotion = promotion;
  if (!send(data)) {
    status = 'The room is offline.';
    renderAll();
    return;
  }

  awaiting = true;
  clearTimeout(awaitTimer);
  awaitTimer = window.setTimeout(() => {
    if (!awaiting) return;
    awaiting = false;
    status = 'The host did not answer. Try the move again.';
    renderAll();
  }, 5000);
  renderAll();
}

function showPromotion(color) {
  promotionEl.hidden = false;
  promotionEl.dataset.color = color;
  for (const button of promotionEl.querySelectorAll('button[data-promotion]')) {
    const piece = cleanPromotion(button.dataset.promotion);
    button.textContent = PIECES[piece] || '';
    button.className = 'promotion-piece ' + (color === 'w' ? 'white' : 'black');
  }
}

function hidePromotion() {
  promotionEl.hidden = true;
  promotionEl.dataset.color = '';
}

function onPromotionClick(event) {
  if (event.target.closest('#promotion-cancel')) {
    cancelPromotion();
    return;
  }
  const button = event.target.closest('button[data-promotion]');
  if (!button || !pending) return;
  const choice = cleanPromotion(button.dataset.promotion);
  if (!choice) return;
  const from = pending.from;
  const to = pending.to;
  pending = null;
  hidePromotion();
  playMove(from, to, choice);
}

function cancelPromotion() {
  pending = null;
  hidePromotion();
  selected = '';
  renderAll();
}

function canMove() {
  return Boolean(
    connected &&
      !pending &&
      !awaiting &&
      side &&
      side === game.turn() &&
      !game.isGameOver()
  );
}

function renderAll() {
  const blackPeer = seatOwner('b');
  newGameEl.hidden = !HOST;
  openSeatEl.hidden = !HOST || !blackPeer;
  renderBoard();
  renderPlayers();
  renderSession();
  renderSeatActions();
  renderQueue();
  renderMoves();
  renderStatus();
  renderRoom();
  renderHint();
}

function renderSession() {
  sessionNumberEl.textContent = String(session);
  const state = game.isGameOver() ? 'finished' : isBoardFull() ? 'live' : 'waiting';
  sessionStateEl.dataset.state = state;
  sessionStateEl.textContent =
    state === 'live' ? 'In play' : state === 'finished' ? 'Finished' : 'Open seat';
}

function renderSeatActions() {
  const mine = seats[PEER] || '';
  const queued = queue.some((entry) => entry.id === PEER);
  const free = firstFreeSeat();
  joinEl.hidden = HOST || Boolean(mine) || !hasState;
  leaveEl.hidden = HOST || !mine;
  joinEl.classList.toggle('is-quiet', queued);
  if (!joinEl.hidden) {
    joinEl.dataset.mode = queued ? 'unqueue' : free ? 'join' : 'queue';
    joinEl.textContent = queued ? 'Leave queue' : free ? 'Join as ' + sideName(free) : 'Join queue';
  }
}

function renderQueue() {
  queueEl.replaceChildren();
  queueBlockEl.hidden = !queue.length;
  queue.forEach((entry, index) => {
    const row = document.createElement('li');
    row.className = 'queue-row';
    const place = document.createElement('span');
    place.className = 'queue-pos';
    place.textContent = String(index + 1);
    const name = document.createElement('span');
    name.className = 'queue-name';
    name.textContent = entry.name;
    row.append(place, name);
    if (entry.id === PEER) {
      const you = document.createElement('span');
      you.className = 'you';
      you.textContent = 'You';
      row.append(you);
    }
    queueEl.append(row);
  });
}

function renderBoard() {
  const can = canMove();
  const legal = selected ? game.moves({ square: selected, verbose: true }) : [];
  const targets = new Map();
  for (const move of legal) targets.set(move.to, move);
  const checkSquare = game.inCheck() ? findKing(game.turn()) : '';
  const lastFrom = last && last.from;
  const lastTo = last && last.to;
  const files = flipped
    ? ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']
    : ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const ranks = flipped
    ? ['1', '2', '3', '4', '5', '6', '7', '8']
    : ['8', '7', '6', '5', '4', '3', '2', '1'];
  const fragment = document.createDocumentFragment();

  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const file = files[col];
      const rank = ranks[row];
      const square = file + rank;
      const piece = game.get(square);
      const target = targets.get(square);
      const fileIndex = file.charCodeAt(0) - 97;
      const light = (fileIndex + Number(rank)) % 2 === 0;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'square ' + (light ? 'light' : 'dark');
      button.dataset.square = square;
      button.disabled = !can;
      button.setAttribute('aria-pressed', selected === square ? 'true' : 'false');
      button.setAttribute(
        'aria-label',
        piece
          ? square + ', ' + sideName(piece.color) + ' ' + PIECE_NAMES[piece.type]
          : square + ', empty'
      );

      if (selected === square) button.classList.add('is-selected');
      if (target) {
        button.classList.add('is-target');
        if (piece || target.flags.includes('e')) button.classList.add('is-capture');
      }
      if (square === lastFrom || square === lastTo) button.classList.add('is-last');
      if (square === checkSquare) button.classList.add('is-check');

      if (col === 0) {
        const rankLabel = document.createElement('span');
        rankLabel.className = 'coord coord-rank';
        rankLabel.textContent = rank;
        rankLabel.setAttribute('aria-hidden', 'true');
        button.append(rankLabel);
      }
      if (row === 7) {
        const fileLabel = document.createElement('span');
        fileLabel.className = 'coord coord-file';
        fileLabel.textContent = file;
        fileLabel.setAttribute('aria-hidden', 'true');
        button.append(fileLabel);
      }
      if (piece) {
        const glyph = document.createElement('span');
        glyph.className = 'piece ' + piece.color;
        glyph.textContent = PIECES[piece.type] || '';
        glyph.setAttribute('aria-hidden', 'true');
        button.append(glyph);
      }
      fragment.append(button);
    }
  }

  boardEl.replaceChildren(fragment);
  boardEl.classList.toggle('is-disabled', !can);
  boardEl.setAttribute(
    'aria-label',
    'Chess board. ' + (game.inCheck() ? sideName(game.turn()) + ' is in check.' : gameStatus())
  );
}

function renderPlayers() {
  whiteNameEl.textContent = names.w || 'White';
  blackNameEl.textContent = names.b || 'Open';
  whiteYouEl.hidden = seats[PEER] !== 'w';
  blackYouEl.hidden = seats[PEER] !== 'b';
  whitePlayerEl.classList.toggle('is-turn', !game.isGameOver() && game.turn() === 'w');
  blackPlayerEl.classList.toggle('is-turn', !game.isGameOver() && game.turn() === 'b');
  blackPlayerEl.classList.toggle('is-open', !names.b);
}

function renderMoves() {
  movesEl.replaceChildren();
  moveCountEl.textContent = String(Math.ceil(history.length / 2));
  if (!history.length) {
    const empty = document.createElement('li');
    empty.className = 'moves-empty';
    empty.textContent = 'No moves yet.';
    movesEl.append(empty);
    return;
  }

  const lastIndex = history.length - 1;
  for (let index = 0; index < history.length; index += 2) {
    const row = document.createElement('li');
    row.className = 'move-row';

    const number = document.createElement('span');
    number.className = 'move-number';
    number.textContent = String(index / 2 + 1) + '.';

    const white = document.createElement('span');
    white.className = 'move-san';
    white.textContent = history[index] || '';
    if (index === lastIndex) white.classList.add('is-last');

    const black = document.createElement('span');
    black.className = 'move-san';
    black.textContent = history[index + 1] || '';
    if (index + 1 === lastIndex) black.classList.add('is-last');

    row.append(number, white, black);
    movesEl.append(row);
  }
  movesEl.scrollTop = movesEl.scrollHeight;
}

function renderStatus() {
  let text = status || gameStatus();
  if (!connected) {
    text = 'Connecting to the room.';
  } else if (awaiting) {
    text = 'Waiting for the host.';
  } else if (!game.isGameOver() && !isBoardFull()) {
    text = queue.length
      ? 'Waiting for a seat. ' + queue.length + ' in line.'
      : 'Waiting for a second player.';
  }
  statusEl.textContent = text;
  statusEl.classList.toggle('is-over', game.isGameOver());
}

function renderRoom() {
  const queued = queue.some((entry) => entry.id === PEER);
  const state = !connected
    ? 'connecting'
    : HOST
      ? 'host'
      : side
        ? 'live'
        : queued
          ? 'queued'
          : 'watching';
  const words = {
    connecting: 'Connecting',
    host: 'Hosting',
    live: 'Live',
    queued: 'In line',
    watching: 'Spectating',
  };
  roomStateEl.dataset.state = state;
  roomStateEl.textContent = words[state];
}

function renderHint() {
  if (!connected) {
    hintEl.textContent = 'Connecting to the room.';
  } else if (pending) {
    hintEl.textContent = 'Choose a piece to promote to.';
  } else if (awaiting) {
    hintEl.textContent = 'Waiting for the host to confirm the move.';
  } else if (HOST && !isBoardFull()) {
    hintEl.textContent = queue.length
      ? 'Opening the seat gives it to the first person in line.'
      : 'Share the room invite. A guest presses Join game for Black.';
  } else if (queue.some((entry) => entry.id === PEER)) {
    hintEl.textContent = 'You are next in line. The seat is yours when it opens.';
  } else if (game.isGameOver()) {
    hintEl.textContent = HOST
      ? 'New game starts the next session.'
      : 'The host can start the next session.';
  } else if (!side) {
    hintEl.textContent =
      'Spectating game ' + session + '. A seat opens here when a player leaves.';
  } else {
    hintEl.textContent =
      'You are ' + sideName(side) + '. Click a piece, then a highlighted square.';
  }
}

function gameStatus() {
  if (game.isCheckmate()) {
    return sideName(other(game.turn())) + ' wins by checkmate.';
  }
  if (game.isStalemate()) return 'Stalemate. The game is a draw.';
  if (game.isThreefoldRepetition()) return 'Draw by threefold repetition.';
  if (game.isInsufficientMaterial()) return 'Draw by insufficient material.';
  if (game.isDrawByFiftyMoves()) return 'Draw by the fifty-move rule.';
  if (game.isDraw()) return 'Draw.';
  if (game.inCheck()) return sideName(game.turn()) + ' is in check.';
  return sideName(game.turn()) + ' to move.';
}

function findKing(color) {
  for (const square of SQUARES) {
    const piece = game.get(square);
    if (piece && piece.type === 'k' && piece.color === color) return square;
  }
  return '';
}

function cleanLast(value) {
  if (!value || typeof value !== 'object') return null;
  const from = isSquare(value.from) ? value.from : '';
  const to = isSquare(value.to) ? value.to : '';
  if (!from || !to) return null;
  return {
    from,
    to,
    san: typeof value.san === 'string' ? value.san.slice(0, 16) : '',
    color: value.color === 'w' || value.color === 'b' ? value.color : '',
    piece: typeof value.piece === 'string' ? value.piece.slice(0, 1) : '',
    flags: typeof value.flags === 'string' ? value.flags.slice(0, 8) : '',
  };
}

function wireLast(move) {
  if (!move) return null;
  return {
    from: move.from,
    to: move.to,
    san: move.san,
    color: move.color,
    piece: move.piece,
    flags: move.flags,
  };
}

function isBoardFull() {
  return Boolean(seatOwner('w') && seatOwner('b'));
}

function seatOwner(seat) {
  for (const [peer, value] of Object.entries(seats)) {
    if (value === seat) return peer;
  }
  return '';
}

function cleanName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

function cleanPromotion(value) {
  return PROMOTIONS.has(value) ? value : '';
}

function isSquare(value) {
  return typeof value === 'string' && /^[a-h][1-8]$/.test(value);
}

function sideName(color) {
  return color === 'w' ? 'White' : 'Black';
}

function other(color) {
  return color === 'w' ? 'b' : 'w';
}
