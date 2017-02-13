const logger = require('morgan');
const _ = require('lodash');
const cors = require('cors');
const http = require('http');
const express = require('express');
const errorhandler = require('errorhandler');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
const cuid = require('cuid');
const fs = require('fs');
const MersenneTwister = require('mersenne-twister');
const jwt = require('jsonwebtoken');
const config = require('./config');
const rules = require('./rules');

const tip = 0.05;

// XXX: This should be a database of users :).
const users = [{
	id: 1,
	username: 'pj',
	password: 'test',
	money: 1000,
	elo: 1500,
	xp: 0,
}, {
	id: 2,
	username: 'pj2',
	password: 'test',
	money: 1000,
	elo: 1500,
	xp: 0,
}];

function createToken(user) {
	return jwt.sign(_.omit(user, 'password'), config.secret, {
		expiresIn: 60 * 60 * 5
	});
}

function getUserScheme(credentials) {
	let username;
	let type;
	let userSearch = {};

	if (credentials.username) {
		// The POST contains a username and not an email
		username = credentials.username;
		type = 'username';
		userSearch = {
			username
		};
	} else if (credentials.email) {
		// The POST contains an email and not an username
		username = credentials.email;
		type = 'email';
		userSearch = {
			email: username
		};
	}

	return {
		username,
		type,
		userSearch,
	};
}

function signup(credentials) {
	const userScheme = getUserScheme(credentials);

	if (!userScheme.username || !credentials.password) {
		return {
			error: 'You must send the username and the password'
		};
	}

	if (_.find(users, userScheme.userSearch)) {
		return {
			error: 'A user with that username already exists'
		};
	}

	const user = _.pick(credentials, userScheme.type, 'password', 'extra');
	user.id = _.max(users, 'id').id + 1;
	user.money = 0;

	users.push(user);

	return Object.assign({
		id_token: createToken(user)
	}, _.omit(user, 'password'));
}

function login(credentials) {
	if (credentials.token) {
		try {
			const decoded = jwt.verify(credentials.token, config.secret);
			const userScheme = getUserScheme({
				username: decoded.username
			});

			if (!decoded.username) {
				return {
					error: 'Token didn\'t contain username'
				};
			}

			const user = _.find(users, userScheme.userSearch);

			if (!user) {
				return {
					error: 'The username was not found.'
				};
			}
			return Object.assign({
				id_token: createToken(user)
			}, _.omit(user, 'password'));
		} catch (err) {
			console.error('err', err);
			return {
				error: 'Invalid token: ' + err.message,
				err,
			};
		}
	} else {
		const userScheme = getUserScheme(credentials);

		if (!userScheme.username || !credentials.password) {
			return {
				error: 'You must send the username and the password'
			};
		}

		const user = _.find(users, userScheme.userSearch);

		if (!user) {
			return {
				error: 'The username or password don\'t match'
			};
		}

		if (user.password !== credentials.password) {
			return {
				error: 'The username or password don\'t match'
			};
		}

		return Object.assign({
			id_token: createToken(user)
		}, _.omit(user, 'password'));
	}
}

const generator = new MersenneTwister();
const app = express();

dotenv.load();

// Parsers
// old version of line
// app.use(bodyParser.urlencoded());
// new version of line
app.use(bodyParser.urlencoded({
	extended: true
}));
app.use(bodyParser.json());
app.use(cors());

app.use((err, req, res, next) => {
	if (err.name === 'StatusError') {
		res.send(err.status, err.message);
	} else {
		next(err);
	}
});

// IMPORTANT: Your application HAS to respond to GET /health with status 200
//            for OpenShift health monitoring
app.get('/health', function(req, res) {
	res.status(200).send();
});

if (process.env.NODE_ENV === 'development') {
	app.use(logger('dev'));
	app.use(errorhandler());
}

// app.use(require('./anonymous-routes'));
// app.use(require('./protected-routes'));

const server = http.createServer(app);
const io = require('socket.io').listen(server, {
	pingInterval: 5000,
	pingTimeout: 10000
});


const waitingUsers = [];
let gamesInProgress = [];

var serverPort = process.env.OPENSHIFT_NODEJS_PORT || 3001;
var serverIpAddress = process.env.OPENSHIFT_NODEJS_IP || '127.0.0.1';

server.listen(serverPort, serverIpAddress, function(err) {
	if (err) {
		console.error(err);
	} else {
		console.log('Listening on ' + serverIpAddress + ', port ' + serverPort);
	}
});


process.on('SIGTERM', () => {
	console.log('SIGTERM received');
	// fs.writeFileSync('gamesInProgress.json', JSON.stringify(gamesInProgress));
	// console.log('gamesInProgress.json saved');
	server.close(() => {
		process.exit(0);
	});
});

const boards = [{
	id: 1,
	title: 'Wood',
	bet: 100
}, {
	id: 2,
	title: 'Stone',
	bet: 200
}, {
	id: 3,
	title: 'Water',
	bet: 500
}, {
	id: 4,
	title: 'Lava',
	bet: 1000
}, {
	id: 5,
	title: 'Air',
	bet: 5000
}, {
	id: 6,
	title: 'Void',
	bet: 20000
}];

if (fs.existsSync('gamesInProgress.json')) {
	gamesInProgress = JSON.parse(fs.readFileSync('gamesInProgress.json'));
}

io.on('connection', (socket) => {
	console.log('connection made', socket.id);
	console.log('%d games in progress', gamesInProgress.length);
	console.log('%d players connected', io.engine.clientsCount);

	socket.on('ping', () => {
		console.log('RECEIVED ping from %s', socket.id);
	});
	socket.on('pong', () => {
		console.log('RECEIVED pong from %s', socket.id);
	});

	socket.on('login', (credentials) => {
		console.log('RECEIVED login from %s', socket.id);
		const data = login(credentials);
		if (data.error) {
			socket.emit('userError', data);
		} else {
			socket.emit('setUser', data);
			checkForGamesInProgress(socket)(data.id);
		}
	});
	socket.on('signup', (credentials) => {
		console.log('RECEIVED signup from %s', socket.id);
		const data = signup(credentials);
		if (data.error) {
			socket.emit('userError', data);
		} else {
			socket.emit('setUser', data);
		}
	});

	socket.on('gameInProgress', (data) => {
		console.log('RECEIVED gameInProgress from %s', socket.id, data);
		const game = data.game;
		const user = data.user;
		if (game && user) {
			const foundGame = _.find(gamesInProgress, g => g.roomId === game.roomId);
			if (!foundGame) {
				if (game.white.user.id === user.id) game.white.socketId = socket.id;
				if (game.black.user.id === user.id) game.black.socketId = socket.id;
				gamesInProgress.push(game);
			} else {
				if (foundGame.white.user.id === user.id) foundGame.white.socketId = socket.id;
				if (foundGame.black.user.id === user.id) foundGame.black.socketId = socket.id;
				if (io.sockets.connected[foundGame.white.socketId]) io.sockets.connected[foundGame.white.socketId].join(foundGame.roomId);
				if (io.sockets.connected[foundGame.black.socketId]) io.sockets.connected[foundGame.black.socketId].join(foundGame.roomId);
				io.in(foundGame.roomId).emit('joined', foundGame);
				console.log('%d games in progress', gamesInProgress.length);
			}
		}
	});

	socket.on('getBoards', () => {
		console.log('RECEIVED getBoards from %s', socket.id);
		socket.emit('setBoards', boards);
	});

	socket.on('selectBoard', (data) => {
		console.log('RECEIVED selectBoard from %s', socket.id, data);
		if (data.userId && ~boards.map(b => b.bet).indexOf(data.bet)) {
			removeUserFromWaitingList(data.userId);
			addUserToWaitingList({
				bet: data.bet,
				userId: data.userId,
				socketId: socket.id,
			});
			checkForReadyGames();
		}
	});

	socket.on('rollDice', () => {
		console.log('RECEIVED rollDice from %s', socket.id);
		const game = findGame(socket.id);
		if (game) {
			const color = findColor(game, socket.id);
			if (game.lastRolled !== color) {
				const dice = [Math.floor(generator.random() * 6 + 1), Math.floor(generator.random() * 6 + 1)].sort().reverse();
				const originalDice = dice.slice();
				if (dice[0] === dice[1]) dice.splice(0, 0, ...(dice.slice()));
				const history = game.history.concat({
					type: 'dice',
					color,
					data: dice.slice(),
				});
				const update = {
					dice,
					originalDice,
					history,
					lastRolled: color,
				};
				updateAndSend(game, update);
			}
		}
	});

	socket.on('makeMoves', (data) => {
		console.log('RECEIVED makeMoves from %s', socket.id, data);
		const game = findGame(socket.id);
		if (game) {
			const color = findColor(game, socket.id);
			// TODO: check move validity
			// All moves correspond to different dice
			const checkDice = game.dice.slice();
			let isCheating = false;
			data.forEach((move) => {
				const usedDie = parseInt(move[2], 10);
				if (~checkDice.indexOf(usedDie)) {
					checkDice.splice(checkDice.indexOf(usedDie), 1);
				} else {
					isCheating = true;
				}
			});

			if (!isCheating) {
				const opponentColor = color === 'white' ? 'black' : 'white';
				const opponentBar = opponentColor === 'white' ? 25 : 0;
				const tempGame = Object.assign({}, game);
				data.forEach((move) => {
					const fromIndex = parseInt(move[0], 10);
					const toIndex = parseInt(move[1], 10);
					if (rules.isValidMove(fromIndex, toIndex, tempGame)) {
						tempGame[color].position[fromIndex]--;
						tempGame[color].position[toIndex]++;
						if (tempGame[opponentColor].position[toIndex] === 1) {
							tempGame[opponentColor].position[toIndex] = 0;
							tempGame[opponentColor].position[opponentBar]++;
						}
					} else {
						console.log('NOT A VALID MOVE', move);
						isCheating = true;
					}
				});
				if (!isCheating) {
					game.white.position = tempGame.white.position.slice();
					game.black.position = tempGame.black.position.slice();
					game.dice.length = 0;
					game.originalDice.length = 0;
					game.lastMove = Date.now();
					if (currentPlayerIsWinner(game)) {
						game.won = color;
						updateUsers(game);
					}
					if (currentPlayerBlocksOppenent(game)) {
						game.lastRolled = opponentColor;
					} else {
						game.turn = opponentColor;
					}
					io.in(game.roomId).emit('setGame', game);
				} else {
					console.warn('%s might be trying to cheat (invalid moves)', socket.id);
				}
			} else {
				console.warn('%s might be trying to cheat (moves don\'t correspond to dice)', socket.id);
			}
		}
	});

	socket.on('makeMove', (move) => {
		console.log('RECEIVED makeMove from %s', socket.id, move);
		const game = findGame(socket.id);
		if (game) {
			const color = findColor(game, socket.id);
			const opponentColor = color === 'white' ? 'black' : 'white';
			const opponentBar = opponentColor === 'white' ? 25 : 0;
			const fromIndex = move[0];
			const toIndex = move[1];
			const usedDie = move[2];
			if (rules.isValidMove(fromIndex, toIndex, game) && ~game.dice.indexOf(usedDie)) {
				game[color].position[fromIndex]--;
				game[color].position[toIndex]++;
				if (game[opponentColor].position[toIndex] === 1) {
					game[opponentColor].position[toIndex] = 0;
					game[opponentColor].position[opponentBar]++;
					move[3] = '*';
				}
				game.dice.splice(game.dice.indexOf(usedDie), 1);
				game.history.push({
					type: 'move',
					color,
					data: move
				});
				console.log('game', game);
				io.in(game.roomId).emit('setGame', game);
			}
		}
	});

	socket.on('undoMove', () => {
		console.log('RECEIVED undoMove from %s', socket.id);
		const game = findGame(socket.id);
		if (game) {
			const color = findColor(game, socket.id);
			const opponentColor = color === 'white' ? 'black' : 'white';
			const opponentBar = opponentColor === 'white' ? 25 : 0;
			const lastMove = game.history[game.history.length - 1];
			console.log('lastMove', lastMove);
			if (lastMove && lastMove.color === color && lastMove.type === 'move') {
				const playerPosition = game[color].position.slice();
				const opponentPosition = game[opponentColor].position.slice();
				playerPosition[lastMove.data[1]]--;
				playerPosition[lastMove.data[0]]++;
				if (lastMove.data[3]) {
					opponentPosition[opponentBar]--;
					opponentPosition[lastMove.data[1]]++;
				}
				game[color].position = playerPosition;
				game[opponentColor].position = opponentPosition;
				if (game.dice.length === 0) {
					game.dice = [lastMove.data[2]];
				} else if (lastMove.data[2] > game.dice[0]) {
					game.dice.splice(0, 0, lastMove.data[2]);
				} else {
					game.dice.push(lastMove.data[2]);
				}
				game.history.pop();
				console.log('game', game);
				io.in(game.roomId).emit('setGame', game);
			}
		}
	});

	socket.on('endTurn', () => {
		console.log('RECEIVED endTurn from %s', socket.id);
		const game = findGame(socket.id);
		if (game) {
			const color = findColor(game, socket.id);
			const opponentColor = color === 'white' ? 'black' : 'white';
			if (game.dice.length === 0 || noMoreValidMoves(game)) {
				game.dice.length = 0;
				game.originalDice.length = 0;
				game.lastMove = Date.now();
				if (currentPlayerIsWinner(game)) {
					game.won = color;
					updateUsers(game);
				}
				if (currentPlayerBlocksOppenent(game)) {
					game.lastRolled = opponentColor;
				} else {
					game.turn = opponentColor;
				}
				io.in(game.roomId).emit('setGame', game);
			} else {
				console.error('still has to make a move', game);
			}
		}
	});

	socket.on('disconnect', (data) => {
		console.log('socket %s disconnected (%s)', socket.id, data);
		const game = findGame(socket.id);
		if (game) {
			const color = findColor(game, socket.id);
			game[color].user.message = 'I\'m disconnected. If I can\'t reconnect, you win.';
			io.in(game.roomId).emit('setGame', game);
		}
	});
	socket.on('userInfo', checkForGamesInProgress(socket));
	socket.on('askPlayAgain', () => {
		console.log('RECEIVED askPlayAgain from %s', socket.id);
		const game = findGame(socket.id);
		if (game) {
			const color = findColor(game, socket.id);
			game[color].wantsAgain = true;
			game[color].user.message = 'Let\'s play again';
			if (game.black.wantsAgain && game.white.wantsAgain) {
				const gameIndex = _.findIndex(gamesInProgress, g => g.roomId === game.roomId);
				gamesInProgress.splice(gameIndex, 1);
				io.sockets.connected[game.white.socketId].leave(game.roomId);
				io.sockets.connected[game.black.socketId].leave(game.roomId);
				const newGame = {
					bet: game.bet,
					white: {
						userId: game.white.user.id,
						socket: io.sockets.connected[game.white.socketId],
					},
					black: {
						userId: game.black.user.id,
						socket: io.sockets.connected[game.black.socketId],
					},
					turn: game.won === 'black' ? 'white' : 'black',
				};
				createGame(newGame);
			} else {
				io.in(game.roomId).emit('setGame', game);
			}
		}
	});
	socket.on('backToLobby', () => {
		console.log('RECEIVED backToLobby from %s', socket.id);
		const game = findGame(socket.id);
		if (game) {
			const color = findColor(game, socket.id);
			const opponentColor = color === 'black' ? 'white' : 'black';
			io.sockets.connected[game[color].socketId].leave(game.roomId);
			game[color].socketId = undefined;
			game[color].user.hasLeft = true;
			game[color].user.message = 'I\'ve got to leave';
			game[opponentColor].user.message = undefined;
			if (game[opponentColor].socketId) io.in(game[opponentColor].socketId).emit('setGame', game);
		}
	});
	socket.on('resign', () => {
		console.log('RECEIVED resign from %s', socket.id);
		const game = findGame(socket.id);
		if (game && !game.won) {
			const lostColor = findColor(game, socket.id);
			const opponentColor = lostColor === 'black' ? 'white' : 'black';
			game.playerAskingToDouble = undefined;
			game.won = opponentColor;
			game[lostColor].user.message = 'I resign';
			updateUsers(game);
			io.in(game.roomId).emit('setGame', game);
		}
	});
	socket.on('doubleBet', () => {
		console.log('RECEIVED doubleBet from %s', socket.id);
		const game = findGame(socket.id);
		if (game) {
			const color = findColor(game, socket.id);
			const opponentColor = color === 'black' ? 'white' : 'black';
			if (game.turn === color && (game.attemptMultiply === undefined || game.attemptMultiply < 64)) {
				game.turn = opponentColor;
				game.lastMove = Date.now();
				game.playerAskingToDouble = color;
				game.doublers = game.doublers || [];
				game.doublers.push(color);
				game.attemptMultiply = 2 * Math.max(game.multiplier, game.attemptMultiply || 1);
				const maxbet = Math.min(game.attemptMultiply * game.bet,
					(_.find(users, u => u.id === game.white.user.id)).money,
					(_.find(users, u => u.id === game.black.user.id)).money
				);
				game.maxbet = maxbet;
				game[color].user.message = game.doublers.length === 1 ? 'Let\'s double the bet' : 'Let\'s redouble that again';
				io.in(game.roomId).emit('setGame', game);
			}
		}
	});
	socket.on('acceptDouble', () => {
		console.log('RECEIVED acceptDouble from %s', socket.id);
		const game = findGame(socket.id);
		if (game) {
			const color = findColor(game, socket.id);
			if (game.turn === color) {
				game.turn = game.doublers[0];
				game.lastDoubledBet = game.doublers.length > 1 ? game.doublers.reverse()[1] : game.doublers[0];
				game.lastMove = Date.now();
				game.playerAskingToDouble = undefined;
				game.multiplier = game.attemptMultiply;
				const maxbet = Math.min(game.multiplier * game.bet,
					(_.find(users, u => u.id === game.white.user.id)).money,
					(_.find(users, u => u.id === game.black.user.id)).money
				);
				game.maxbet = maxbet;
				game.currentAmountBet = 2 * maxbet;
				game.white.user.money = (_.find(users, u => u.id === game.white.user.id)).money - maxbet;
				game.black.user.money = (_.find(users, u => u.id === game.black.user.id)).money - maxbet;
				game.white.user.message = undefined;
				game.black.user.message = undefined;
				game.doublers.length = 0;
				io.in(game.roomId).emit('setGame', game);
			}
		}
	});
});

function checkForTimeouts() {
	gamesInProgress.forEach((game) => {
		if ((game.lastMove + game.limit * 1000) < Date.now() && !game.won) {
			const lostColor = game.turn;
			const opponentColor = lostColor === 'black' ? 'white' : 'black';
			game.won = opponentColor;
			game.playerAskingToDouble = undefined;
			game[lostColor].user.message = 'I ran out of time';
			updateUsers(game);
			console.log('game timed out', game);
			io.in(game.roomId).emit('setGame', game);
		}
	});
}

function checkForGamesInProgress(socket) {
	return (userId) => {
		const game = _.find(gamesInProgress, g => g.white.user.id === userId || g.black.user.id === userId);
		if (game) {
			console.log('Found a game in progress game for user %s!', userId);
			const color = game.black.user.id === userId ? 'black' : 'white';
			game[color].socketId = socket.id;
			game[color].user.message = undefined;
			socket.join(game.roomId);
			io.in(game.roomId).emit('setGame', game);
		} else {
			console.log('Found no games in progress for user', userId);
		}
	};
}

function removeUserFromWaitingList(userId) {
	const foundAt = _.findIndex(waitingUsers, {
		userId
	});
	if (~foundAt) waitingUsers.splice(foundAt, 1);
}

function addUserToWaitingList(data) {
	waitingUsers.push(data);
	console.log('addUserToWaitingList waitingUsers', waitingUsers);
}

function checkForReadyGames() {
	boards.forEach((board) => {
		const waitingUsersForBoard = waitingUsers.filter(u => u.bet === board.bet);
		console.log('waitingUsersForBoard %s', board.title, waitingUsersForBoard);
		if (waitingUsersForBoard.length > 1) {
			if (io.sockets.connected[waitingUsersForBoard[0].socketId] && io.sockets.connected[waitingUsersForBoard[1].socketId]) {
				const game = {
					bet: board.bet,
					white: {
						userId: waitingUsersForBoard[0].userId,
						socket: io.sockets.connected[waitingUsersForBoard[0].socketId],
					},
					black: {
						userId: waitingUsersForBoard[1].userId,
						socket: io.sockets.connected[waitingUsersForBoard[1].socketId],
					}
				};
				createGame(game);
				removeUserFromWaitingList(game.white.userId);
				removeUserFromWaitingList(game.black.userId);
			}
		}
	});
}

function createGame(data) {
	const roomId = cuid();
	data.white.socket.join(roomId);
	data.black.socket.join(roomId);
	const game = {
		roomId,
		bet: parseInt(data.bet, 10),
		tip,
		currentAmountBet: 2 * parseInt(data.bet, 10),
		multiplier: 1,
		lastDoubledBet: 'none',
		doublers: [],
		lastRolled: 'none',
		turn: data.turn || (Math.round(generator.random()) === 0 ? 'white' : 'black'),
		limit: 45,
		lastMove: Date.now(),
		dice: [],
		originalDice: [],
		moves: [],
		history: [],
		white: {
			user: _.omit(_.find(users, u => u.id === data.white.userId), 'password'),
			socketId: data.white.socket.id,
			// position: [0, 0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0], // real game
			position: [0, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1], // test: black is almost won
			// position: [0, 0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], // test: white is blocked
			// position: [0, 0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], // test: two on the bar
			// position: [0, 0, 0, 0, 0, 0, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // test: huge stack
			// position: [13, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // test: end game
		},
		black: {
			user: _.omit(_.find(users, u => u.id === data.black.userId), 'password'),
			socketId: data.black.socket.id,
			// position: [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 3, 0, 5, 0, 0, 0, 0, 0, 0], // real game
			position: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 3, 2, 2, 3, 0, 0], // test: black is almost won
			// position: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 2, 2, 2, 2, 2, 2, 0], // test: white is blocked
			// position: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 3, 0, 5, 0, 0, 0, 0, 0, 0], // test: two on the bar
			// position: [0, 0, 0, 0, 0, 0, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // test: huge stack
			// position: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 13], // test: end game
		}
	};
	game.white.user.money -= game.bet;
	game.black.user.money -= game.bet;
	game.white.user.message = undefined;
	game.black.user.message = undefined;
	gamesInProgress.push(game);
	io.in(roomId).emit('setGame', game);
}

// function getNumberOfWaitingUsers() {
// 	return waitingUsers.length;
// }

function currentPlayerIsWinner(game) {
	const homeIndex = game.turn === 'white' ? 0 : 25;
	const board = game[game.turn].position.slice(0);
	board.splice(homeIndex, 1);
	return (board.reduce((p, c) => p + c, 0) === 0);
}

function currentPlayerBlocksOppenent(game) {
	const homeArea = game.turn === 'white' ? [1, 2, 3, 4, 5, 6] : [19, 20, 21, 22, 23, 24];
	const opponentColor = game.turn === 'white' ? 'black' : 'white';
	const opponentBar = game.turn === 'white' ? 0 : 25;
	// all positions in the home area have at least two stones and the opponent's bar has at least one stone
	return homeArea.map(index => game[game.turn].position[index] > 1).reduce((p, c) => p && c, true) && game[opponentColor].position[opponentBar] > 0;
}

function changeUserMoney(id, amount) {
	_.find(users, u => u.id === id).money += amount;
}

function changeUserXP(id, amount) {
	_.find(users, u => u.id === id).xp += amount;
}

function changeUserElo(id, opponentElo, won) {
	// http://www.bkgm.com/faq/Ratings.html
	const user = _.find(users, u => u.id === id);
	if (user) {
		const xp = user.xp;
		const exponent = (user.elo - opponentElo) / 2000;
		let amount;
		if (xp > 400) {
			amount = won ?
				(4 / (1 + Math.pow(10, exponent))) :
				-(4 / (1 + Math.pow(10, -exponent)));
		} else {
			// still in ramp-up
			amount = won ?
				((500 - user.xp) * 4 / (100 * (1 + Math.pow(10, exponent)))) :
				-((500 - user.xp) * 4 / (100 * (1 + Math.pow(10, -exponent))));
		}
		user.elo += amount;
	}
}


function findGame(socketId) {
	return _.find(gamesInProgress, g => g.black.socketId === socketId || g.white.socketId === socketId);
}

function findColor(game, socketId) {
	return game.black.socketId === socketId ? 'black' : 'white';
}

function updateAndSend(game, update) {
	Object.assign(game, update);
	io.in(game.roomId).emit('setGame', game);
	console.log('game', game);
}

function updateUsers(game) {
	handleMoney(game);
	handleElo(game);
	handleXP(game);
}

function handleMoney(game) {
	const lostColor = game.won === 'black' ? 'white' : 'black';

	changeUserMoney(game[game.won].user.id, Math.ceil((game.currentAmountBet / 2) * (1 - tip)));
	changeUserMoney(game[lostColor].user.id, -(game.currentAmountBet / 2));

	game.white.user.money = (_.find(users, u => u.id === game.white.user.id)).money;
	game.black.user.money = (_.find(users, u => u.id === game.black.user.id)).money;
}

function handleElo(game) {
	const lostColor = game.won === 'black' ? 'white' : 'black';

	changeUserElo(game[game.won].user.id, game[lostColor].user.elo, true);
	changeUserElo(game[lostColor].user.id, game[game.won].user.elo, false);

	game.white.user.elo = (_.find(users, u => u.id === game.white.user.id)).elo;
	game.black.user.elo = (_.find(users, u => u.id === game.black.user.id)).elo;
}

function handleXP(game) {
	const lostColor = game.won === 'black' ? 'white' : 'black';

	changeUserXP(game[game.won].user.id, 1);
	changeUserXP(game[lostColor].user.id, 1);

	game.white.user.xp = (_.find(users, u => u.id === game.white.user.id)).xp;
	game.black.user.xp = (_.find(users, u => u.id === game.black.user.id)).xp;
}


function validMoves(game) {
	return rules.computeValidMoves(game);
}

function noMoreValidMoves(game) {
	return !((validMoves(game)).reduce((p, c) => p || c, false));
}

setInterval(checkForTimeouts, 3000);
