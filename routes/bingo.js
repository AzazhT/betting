const express = require('express');

module.exports = function(pool, io) {
    const router = express.Router();

    const mixedTelegramNames = [
        "Henok", "Robel", "Dawit", "Yonas", "Elias", "Kebede", "Seleshi", "Nati",
        "Kaleb", "Bereket", "Amanuel", "Yared", "Tewodros", "Girma", "Biniyam", "Sami",
        "Ermias", "Abebe", "Getachew", "Mulugeta", "Matiwos", "Surafel", "Dagi", "Fikru",
        "Bruk", "Kidus", "Abel", "Mikiyas", "Eyob", "Solomon", "Tinsae", "Nathanael"
    ];

    function getRandomTelegramName() {
        return mixedTelegramNames[Math.floor(Math.random() * mixedTelegramNames.length)];
    }

    let activeRooms = {};
    // Wallet settlement is guarded per room so a round cannot pay twice.


    function getActivePlayersCount(room) {
        let activeSocketIds = new Set();
        for (let bNum in room.selectedBoards) {
            if (room.selectedBoards[bNum]) activeSocketIds.add(room.selectedBoards[bNum]);
        }
        for (let socketId of room.players) activeSocketIds.add(socketId);
        return activeSocketIds.size;
    }

    function calculatePrizePool(room) {
        let activeCount = getActivePlayersCount(room);
        let totalBet = activeCount * parseFloat(room.betAmount);
        let prizePool = totalBet * 0.90;
        return Math.floor(prizePool > 0 ? prizePool : parseFloat(room.betAmount));
    }

    function getOrCreateLobby(betAmount) {
        let roomId = null;
        for (let id in activeRooms) {
            if (activeRooms[id].betAmount === betAmount) { roomId = id; break; }
        }

        if (!roomId) {
            let uniqueId = Math.floor(1000 + Math.random() * 9000);
            roomId = `ROOM_${betAmount}_${uniqueId}`;

            activeRooms[roomId] = {
                roomId, betAmount,
                status: 'waiting',
                players: new Set(),
                playerNames: {},
                playerTelegramIds: {},
                payoutDone: false,
                selectedBoards: {},
                tempSelections: {},
                drawnNumbers: [],
                countdown: 30,
                startTime: Date.now() + 30000,
                timer: null,
                gameInterval: null,
                targetBotSelections: Math.floor(Math.random() * 20) + 10
            };
            startGlobalLobbyCountdown(roomId);
        }
        return activeRooms[roomId];
    }

    function resetRoomForNextGame(roomId) {
        let room = activeRooms[roomId];
        if (!room) return;

        room.drawnNumbers = [];
        room.payoutDone = false;
        room.playerTelegramIds = {};
        room.selectedBoards = {};
        room.tempSelections = {};
        room.status = 'waiting';
        room.countdown = 30;
        room.startTime = Date.now() + 30000;
        room.targetBotSelections = Math.floor(Math.random() * 20) + 10;

        io.to(roomId).emit('roomResetForNextRound', {
            status: room.status, countdown: room.countdown, startTime: room.startTime, selectedBoards: room.selectedBoards
        });

        startGlobalLobbyCountdown(roomId);
    }

    function startGlobalLobbyCountdown(roomId) {
        let room = activeRooms[roomId];
        if (!room) return;

        if (room.timer) clearInterval(room.timer);

        room.timer = setInterval(() => {
            if (room.status !== 'waiting') return;
            room.countdown--;

            let currentSelectedCount = Object.keys(room.selectedBoards).length;
            if (currentSelectedCount < room.targetBotSelections && currentSelectedCount < 100) {
                let randomBoard;
                let attempts = 0;
                do {
                    randomBoard = Math.floor(Math.random() * 100) + 1;
                    attempts++;
                } while (room.selectedBoards[randomBoard] && attempts < 50);

                if (!room.selectedBoards[randomBoard]) {
                    let botId = `BOT_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
                    room.selectedBoards[randomBoard] = botId;
                    room.playerNames[botId] = getRandomTelegramName();
                    io.to(roomId).emit('boardSelected', { boardNumber: randomBoard, socketId: botId });
                }
            }

            let currentPrizePool = calculatePrizePool(room);
            io.to(roomId).emit('countdownUpdate', {
                countdown: room.countdown, status: room.status,
                activePlayersCount: getActivePlayersCount(room), prizePool: currentPrizePool, startTime: room.startTime
            });

            if (room.countdown <= 0) {
                startRoomGame(roomId);
            }
        }, 1000);
    }

    function findWinningLine(card, drawnNums) {
        let marked = Array(5).fill(false).map(() => Array(5).fill(false));
        marked[2][2] = true;

        for (let r = 0; r < 5; r++) {
            for (let c = 0; c < 5; c++) {
                let val = card[r][c];
                if (val === '*' || drawnNums.includes(val)) marked[r][c] = true;
            }
        }

        for(let r=0; r<5; r++) if([0,1,2,3,4].every(c => marked[r][c])) return { type: 'row', index: r };
        for(let c=0; c<5; c++) if([0,1,2,3,4].every(r => marked[r][c])) return { type: 'col', index: c };
        if([0,1,2,3,4].every(i => marked[i][i])) return { type: 'diag1', index: 0 };
        if([0,1,2,3,4].every(i => marked[i][4-i])) return { type: 'diag2', index: 0 };

        return null;
    }

    function generateServerBingoCard() {
        let ranges = [[1,15], [16,30], [31,45], [46,60], [61,75]];
        let cols = ranges.map(([min, max]) => {
            let col = [];
            while(col.length < 5) { let r = Math.floor(Math.random()*(max-min+1))+min; if(!col.includes(r)) col.push(r); }
            return col;
        });
        return Array(5).fill(null).map((_, r) => Array(5).fill(null).map((_, c) => (r===2 && c===2) ? "*" : cols[c][r]));
    }

    function startRoomGame(roomId) {
        let room = activeRooms[roomId];
        if (!room) return;

        room.status = 'playing';
        if (room.timer) clearInterval(room.timer);

        let finalPrizePool = calculatePrizePool(room);
        io.to(roomId).emit('gameStarted', { message: 'ጨዋታው ተጀምሯል!', prizePool: finalPrizePool, status: room.status });

        let roomBotCards = {};
        for (let bNum in room.selectedBoards) {
            let ownerId = room.selectedBoards[bNum];
            if (ownerId && ownerId.startsWith('BOT_')) {
                roomBotCards[ownerId] = { boardNumber: bNum, card: generateServerBingoCard() };
            }
        }

        room.gameInterval = setInterval(() => {
            if (room.drawnNumbers.length >= 75) {
                clearInterval(room.gameInterval);
                resetRoomForNextGame(roomId);
                return;
            }

            let rand;
            do { rand = Math.floor(Math.random() * 75) + 1; } while (room.drawnNumbers.includes(rand));

            room.drawnNumbers.push(rand);
            io.to(roomId).emit('numberDrawn', { number: rand, drawnHistory: room.drawnNumbers });

            for (let botId in roomBotCards) {
                let botData = roomBotCards[botId];
                if (findWinningLine(botData.card, room.drawnNumbers)) {
                    clearInterval(room.gameInterval);
                    room.status = 'ended';
                    io.to(roomId).emit('gameOver', {
                        subtitle: 'አሸናፊ ተገኝቷል!',
                        winnerName: room.playerNames[botId] || getRandomTelegramName(),
                        boardNumber: botData.boardNumber,
                        winAmount: finalPrizePool
                    });
                    setTimeout(() => resetRoomForNextGame(roomId), 3000);
                    return;
                }
            }
        }, 3000);
    }

    // Socket.io ግንኙነት አስተዳደር
    io.on('connection', (socket) => {
        socket.on('joinLobby', (data) => {
            const betAmount = data && data.betAmount ? data.betAmount : '20';
            let room = getOrCreateLobby(betAmount);
            socket.join(room.roomId);
            room.players.add(socket.id);

            socket.emit('assignedRoom', {
                roomId: room.roomId, betAmount: room.betAmount, countdown: room.countdown,
                startTime: room.startTime, status: room.status, selectedBoards: room.selectedBoards,
                activePlayersCount: getActivePlayersCount(room), prizePool: calculatePrizePool(room)
            });
        });

        socket.on('selectBoardTemp', (data) => {
            const { roomId, boardNumber } = data;
            let room = activeRooms[roomId];
            if (room && room.status === 'waiting' && !room.selectedBoards[boardNumber]) {
                socket.emit('boardTempSelected', { boardNumber });
            }
        });

        socket.on('startPlayerGame', (data) => {
            const { roomId, boardNumber, name, identifier } = data;
            let room = activeRooms[roomId];
            if (room && room.status === 'waiting' && !room.selectedBoards[boardNumber]) {
                room.selectedBoards[boardNumber] = socket.id;
                room.playerNames[socket.id] = name || 'Player';
                if (identifier !== undefined && identifier !== null) room.playerTelegramIds[socket.id] = String(identifier);
                io.to(roomId).emit('boardSelected', { boardNumber, socketId: socket.id });
                socket.emit('gameJoinSuccess', { boardNumber });
            }
        });

        socket.on('claimBingo', async (data) => {
            const { roomId, boardNumber } = data || {};
            let room = activeRooms[roomId];
            // Only the socket that owns the selected board can claim it.
            if (!room || room.status !== 'playing' || room.payoutDone || String(room.selectedBoards[boardNumber]) !== String(socket.id)) return;
            room.status = 'ended';
            room.payoutDone = true;
            if (room.gameInterval) clearInterval(room.gameInterval);
            const winAmount = calculatePrizePool(room);
            const identifier = room.playerTelegramIds[socket.id];
            let walletPaid = false;
            try {
                // users.telegram_id is the shared-wallet key used by routes/wallet.js.
                if (identifier && Number.isFinite(Number(winAmount)) && Number(winAmount) > 0) {
                    const result = await pool.query(
                        'UPDATE users SET balance = COALESCE(balance, 0) + $1 WHERE telegram_id = $2 RETURNING balance',
                        [winAmount, identifier]
                    );
                    walletPaid = result.rowCount === 1;
                    if (!walletPaid) console.error('Bingo wallet payout skipped: user not found for Telegram ID');
                }
            } catch (err) {
                console.error('Bingo wallet payout failed:', err.message);
            }
            io.to(roomId).emit('gameOver', {
                subtitle: 'አሸናፊ ተገኝቷል!',
                winnerName: room.playerNames[socket.id] || 'Player',
                boardNumber: boardNumber,
                winAmount: winAmount,
                walletPaid: walletPaid
            });
            setTimeout(() => resetRoomForNextGame(roomId), 3000);
        });
    });

    return router;
};
