const logger = require('morgan');
const _ = require('lodash');
const cors = require('cors');
const http = require('http');
const express = require('express');
const request = require('request');
const errorhandler = require('errorhandler');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
const cuid = require('cuid');
const fs = require('fs');
const MersenneTwister = require('mersenne-twister');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const q = require('q');
const bcrypt = require('bcryptjs');

const config = require('./config');
const rules = require('./rules');

const tip = 0.05;

const ONE_MINUTE = 60 * 1000;
// const FIVE_MINUTES = 5 * ONE_MINUTE;
const ONE_HOUR = 60 * ONE_MINUTE;
// const ONE_DAY = 24 * ONE_HOUR;
// const ONE_WEEK = 7 * ONE_DAY;

// default to a 'localhost' configuration:
const connectionString = process.env.OPENSHIFT_MONGODB_DB_URL ?
	process.env.OPENSHIFT_MONGODB_DB_URL :
	'localhost:27017/libackgammon';

const dns = process.env.OPENSHIFT_GEAR_DNS ? 'https://libackgammon.org/api/' : 'http://localhost:3001';

mongoose.Promise = require('q').Promise;

const db = mongoose.connect(connectionString).connection;

db.on('error', console.error.bind(console, 'connection error:'));
db.once('open', function () {
	console.log('connected to mongodb');
});

const messages = {
	DISCONNECTED: 'I\'m disconnected. If I can\'t reconnect, you win.',
	ENTER_USERNAME_PASSWORD: 'You must enter your username and password.',
	ALREADY_EXISTS: 'A user with that username already exists.',
	DONT_MATCH: 'Username and password don\'t match.',
	NO_USERNAME: 'The token didn\'t contain a username.',
	LOG_IN_AGAIN: 'It\'s been a while since we saw you... please log in again.',
	UNVERIFIED_TOKEN: 'That token could not be verified',
	RAN_OUT_OF_TIME: 'I ran out of time',
	LETS_PLAY_AGAIN: 'Let\'s play again',
	GOT_TO_LEAVE: 'I\'ve got to leave',
	RESIGN: 'I resign',
	DOUBLE: 'Let\'s double the bet',
	REDOUBLE: 'Let\'s redouble that again',
};

const users = mongoose.model('users', require('./user.model.js'));
const games = mongoose.model('games', require('./game.model.js'));

function createToken(user) {
	return jwt.sign(_.pick(user, ['id', 'username']), config.secret, {
		expiresIn: '7 days'
	});
}

function signup(credentials) {
	const deferred = q.defer();

	if ((!credentials.username || !credentials.password) && !credentials.facebookId) {
		deferred.reject({
			error: messages.ENTER_USERNAME_PASSWORD
		});
	}

	let userPromise;

	if (credentials.facebookId) {
		userPromise = users
			.findOne({
				'social.facebookId': credentials.facebookId
			});
	} else {
		userPromise = users
			.findOne({
				username: credentials.username
			});
	}

	userPromise.then((result) => {
		console.log('result', result);
		if (!result) {
			// The username doesn't exist yet
			bcrypt
				.hash(credentials.password, 10)
				.then(function (hash) {
					const user = Object.assign({}, {
						username: credentials.username,
						password: hash,
						picture: credentials.picture || '',
						money: 0,
						elo: [1500],
						xp: 0,
					});
					if (credentials.facebookId) {
						user.social = {
							facebookId: credentials.facebookId,
						};
					}
					users
						.create(user)
						.then(function (createdUser) {
							deferred.resolve(userWithToken(createdUser));
						}, deferred.reject);
				}, deferred.reject);
		} else {
			// The username exists
			deferred.reject({
				error: messages.ALREADY_EXISTS
			});
		}
	}, deferred.reject);

	return deferred.promise;
}

function safeUser(user) {
	return _.pick(JSON.parse(JSON.stringify(user)), ['id', 'username', 'picture', 'money', 'xp', 'elo', 'id_token']);
}

function userWithToken(user) {
	const safe = safeUser(user);
	return Object.assign({
		id_token: createToken(safe)
	}, safe);
}


function login(credentials) {
	const deferred = q.defer();

	function findAndSend(search, creds) {
		users
			.findOne(search)
			.then((user) => {
				if (!user) {
					// The username doesn't exist
					deferred.reject({
						error: messages.DONT_MATCH
					});
				} else if (creds) {
					// The username exists, and creds need checking
					bcrypt
						.compare(creds.password, user.password)
						.then((compareRes) => {
							if (compareRes) {
								deferred.resolve(userWithToken(user));
							} else {
								deferred.reject({
									error: messages.DONT_MATCH
								});
							}
						})
						.catch(deferred.reject);
				} else {
					// The username exists and we trust all tokens
					// TODO: investigate if this is such a good idea
					deferred.resolve(userWithToken(user));
				}
			}, deferred.reject);
	}

	if (credentials.token) {
		try {
			const decoded = jwt.verify(credentials.token, config.secret);
			if (!decoded.username) {
				deferred.reject({
					error: messages.NO_USERNAME
				});
			} else {
				findAndSend({
					username: decoded.username
				});
			}
		} catch (err) {
			console.error('error decoding token', err);
			deferred.reject({
				error: messages.LOG_IN_AGAIN,
				err,
			});
		}
	} else if (credentials.facebookId) {
		findAndSend({
			'social.facebookId': credentials.facebookId,
		});
	} else if (!credentials.username || !credentials.password) {
		deferred.reject({
			error: messages.ENTER_USERNAME_PASSWORD
		});
	} else {
		findAndSend({
			username: credentials.username,
		}, credentials);
	}
	return deferred.promise;
}

const generator = new MersenneTwister();
const app = express();
const server = http.createServer(app);
const io = require('socket.io').listen(server, {
	pingInterval: 5000,
	pingTimeout: 10000
});


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
app.get('/health', function (req, res) {
	res.status(200).send();
});

app.get('/login/facebook/return', function (req, res) {
	const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
	const state = req.query.state;
	console.log('ip', ip);
	console.log('state', state);
	console.log('code', req.query.code);
	const params = [
		'client_id=' + config.facebook.appId,
		'redirect_uri=' + dns + '/login/facebook/return',
		'client_secret=' + config.facebook.appSecret,
		'code=' + req.query.code,
	];
	request('https://graph.facebook.com/v2.8/oauth/access_token?' + params.join('&'), function (error, response, body) {
		if (!error) {
			const bod = JSON.parse(body);
			var options = {
				url: 'https://graph.facebook.com/me?fields=id,first_name,last_name,picture.width(512),email,locale,location&width=512&height=512',
				headers: {
					authorization: ['Bearer', bod.access_token].join(' ')
				}
			};
			request(options, function (meError, meResponse, meBody) {
				const meBod = JSON.parse(meBody);
				console.log('meBody', meBody);
				users
					.findOne({
						'social.facebookId': meBod.id
					})
					.then((user) => {
						if (!user) {
							// Create new user
							signup({
								username: meBod.first_name,
								facebookId: meBod.id,
								picture: meBod.picture.data.url,
								password: '' + generator.random(),
							}).then((yup) => {
								io.in(state).emit('setUser', yup);
								res.send('<script>window.close();</script>');
							}, (nope) => {
								res.status(501).send(nope);
							});
						} else {
							// User exists
							login({
								facebookId: user.social.facebookId
							}).then((yup) => {
								io.in(state).emit('setUser', yup);
								res.send('<script>window.close();</script>');
							}, (nope) => {
								res.status(501).send(nope);
							});
						}
					});
			});
		}
	});
});

if (process.env.NODE_ENV === 'development') {
	app.use(logger('dev'));
	app.use(errorhandler());
}

// app.use(require('./anonymous-routes'));
// app.use(require('./protected-routes'));


const waitingUsers = [];
let gamesInProgress = [];

const serverPort = process.env.OPENSHIFT_NODEJS_PORT || 3001;
const serverIpAddress = process.env.OPENSHIFT_NODEJS_IP || '127.0.0.1';

server.listen(serverPort, serverIpAddress, function (err) {
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

const boards = require('./boards.js');

if (fs.existsSync('gamesInProgress.json')) {
	gamesInProgress = JSON.parse(fs.readFileSync('gamesInProgress.json'));
}

io.on('connection', (socket) => {
	function send(type) {
		return function (data) {
			socket.emit(type, data);
		};
	}

	console.log('connection made', socket.id);
	console.log('%d games in progress', gamesInProgress.length);
	console.log('%d players connected', io.engine.clientsCount);
	io.emit('serverStats', {
		connectedPlayers: io.engine.clientsCount,
	});

	socket.on('ping', () => {
		console.log('RECEIVED ping from %s', socket.id);
	});
	socket.on('pong', () => {
		console.log('RECEIVED pong from %s', socket.id);
	});

	socket.on('login', (credentials) => {
		console.log('RECEIVED login from %s', socket.id);
		login(credentials).then(function (data) {
			socket.emit('setUser', data);
			checkForGamesInProgress(socket)(data.id);
		}, send('userError'));
	});
	socket.on('signup', (credentials) => {
		console.log('RECEIVED signup from %s', socket.id);
		signup(credentials).then(send('setUser'), send('userError'));
	});
	socket.on('facebook', () => {

	});

	socket.on('getUserInfo', (token) => {
		console.log('RECEIVED getUserInfo from %s', socket.id);
		try {
			const decoded = jwt.verify(token, config.secret);
			console.log('decoded', decoded);
			if (!decoded.id) {
				send('removeUser')({
					error: 'The token didn\'t contain an id'
				});
			} else {
				users
					.findOne({
						_id: decoded.id
					})
					.then((user) => {
						send('setUser')(safeUser(user));
					}, send('removeUser'));
			}
		} catch (err) {
			console.log('err', err);
			send('removeUser')({
				error: messages.UNVERIFIED_TOKEN,
				err,
			});
		}
	});

	socket.on('gameInProgress', (data) => {
		console.log('RECEIVED gameInProgress from %s: roomId %s', socket.id, data.game.roomId);
		const game = data.game;
		const user = data.user;
		if (game && user) {
			const foundGame = _.find(gamesInProgress, g => g.roomId === game.roomId);
			if (!foundGame) {
				if (game.white.user.id === user.id) game.white.socketId = socket.id;
				if (game.black.user.id === user.id) game.black.socketId = socket.id;
				gamesInProgress.push(game);
			} else {
				['white', 'black'].forEach((color) => {
					if (foundGame[color].user.id === user.id) foundGame[color].socketId = socket.id;
					if (io.sockets.connected[foundGame[color].socketId]) io.sockets.connected[foundGame[color].socketId].join(foundGame.roomId);
					if (foundGame[color].user.message === messages.DISCONNECTED) foundGame[color].user.message = undefined;
				});
				io.in(foundGame.roomId).emit('setGame', foundGame);
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
		if (data.userId && ~boards.map(b => b.id).indexOf(data.boardId)) {
			removeUserFromWaitingList(data.userId);
			addUserToWaitingList({
				boardId: data.boardId,
				userId: data.userId,
				socketId: socket.id,
			});
			checkForReadyGames();
		}
	});

	socket.on('cancelBoard', (data) => {
		console.log('RECEIVED cancelBoard from %s', socket.id, data);
		if (data.userId) {
			removeUserFromWaitingList(data.userId);
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
				}
				if (currentPlayerBlocksOppenent(game)) {
					game.lastRolled = opponentColor;
				} else {
					game.turn = opponentColor;
				}
				if (game.won) {
					updateUsers(game).then((gm) => {
						io.in(game.roomId).emit('setGame', gm);
					});
				} else {
					io.in(game.roomId).emit('setGame', game);
				}
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
			game[color].user.message = messages.DISCONNECTED;
			io.in(game.roomId).emit('setGame', game);
		}
		io.emit('serverStats', {
			connectedPlayers: io.engine.clientsCount,
		});
	});

	socket.on('userInfo', checkForGamesInProgress(socket));

	socket.on('askPlayAgain', () => {
		console.log('RECEIVED askPlayAgain from %s', socket.id);
		const game = findGame(socket.id);
		if (game) {
			const color = findColor(game, socket.id);
			game[color].wantsAgain = true;
			game[color].user.message = messages.LETS_PLAY_AGAIN;
			if (game.black.wantsAgain && game.white.wantsAgain && io.sockets.connected[game.white.socketId] && io.sockets.connected[game.black.socketId]) {
				const gameIndex = _.findIndex(gamesInProgress, g => g.roomId === game.roomId);
				gamesInProgress.splice(gameIndex, 1);
				io.sockets.connected[game.white.socketId].leave(game.roomId);
				io.sockets.connected[game.black.socketId].leave(game.roomId);
				const newGame = {
					board: Object.assign({}, _.find(boards, b => b.id === game.boardId)),
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
			game[color].user.message = messages.GOT_TO_LEAVE;
			game[opponentColor].user.message = undefined;
			if (game[opponentColor].socketId) {
				io.in(game[opponentColor].socketId).emit('setGame', game);
			} else {
				// both players have left - archive game
				game.archived = true;
				archiveGames(gamesInProgress.filter(g => g.archived));
				gamesInProgress = gamesInProgress.filter(g => !g.archived);
				console.log('%d games in progress', gamesInProgress.length);
			}
		}
	});
	socket.on('resign', () => {
		console.log('RECEIVED resign from %s', socket.id);
		const game = findGame(socket.id);
		if (game && !game.won) {
			const color = findColor(game, socket.id);
			const opponentColor = color === 'black' ? 'white' : 'black';
			game.history.push({
				type: 'resign',
				color,
			});
			game.won = opponentColor;
			game[color].user.message = messages.RESIGN;
			game.doublers.length = 0;
			updateUsers(game).then((gm) => {
				io.in(game.roomId).emit('setGame', gm);
			});
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
				game.doublers = game.doublers || [];
				game.doublers.push(color);
				game.attemptMultiply = 2 * Math.max(game.multiplier, game.attemptMultiply || 1);
				findUsers(game.white.user.id, game.black.user.id).then((userResults) => {
					if (userResults[0] && userResults[1]) {
						const maxbet = Math.min(game.attemptMultiply * game.bet,
							userResults[0].money,
							userResults[1].money
						);
						game.history.push({
							type: 'askToDouble',
							color,
							data: game.attemptMultiply,
						});
						game.maxbet = maxbet;
						game[color].user.message = game.doublers.length === 1 ?
							messages.DOUBLE :
							messages.REDOUBLE;
						io.in(game.roomId).emit('setGame', game);
					}
				});
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
				game.multiplier = game.attemptMultiply;
				findUsers(game.white.user.id, game.black.user.id).then((userResults) => {
					if (userResults[0] && userResults[1]) {
						const maxbet = Math.min(game.multiplier * game.bet,
							userResults[0].money,
							userResults[1].money
						);
						game.history.push({
							type: 'acceptDouble',
							color,
							data: game.multiplier,
						});
						game.maxbet = maxbet;
						game.currentAmountBet = 2 * maxbet;
						game.white.user.money = userResults[0].money - maxbet;
						game.black.user.money = userResults[1].money - maxbet;
						game.white.user.message = undefined;
						game.black.user.message = undefined;
						game.doublers.length = 0;
						io.in(game.roomId).emit('setGame', game);
					}
				});
			}
		}
	});
});

function findUsers(id1, id2) {
	var userPromises = [
		users.findOne({
			_id: id1
		}).exec(),
		users.findOne({
			_id: id2
		}),
	];
	return q.all(userPromises);
}


function checkForTimeouts() {
	gamesInProgress.forEach((game) => {
		if ((game.lastMove + game.limit * 1000) < Date.now() && !game.won) {
			const lostColor = game.turn;
			const opponentColor = lostColor === 'black' ? 'white' : 'black';
			game.won = opponentColor;
			game.doublers.length = 0;
			game[lostColor].user.message = messages.RAN_OUT_OF_TIME;
			updateUsers(game).then((gm) => {
				console.log('game timed out', game);
				io.in(game.roomId).emit('setGame', gm);
			});
		}
	});
}

function checkToArchive() {
	gamesInProgress.forEach((game) => {
		if ((game.lastMove + ONE_MINUTE) < Date.now() &&
			game.won &&
			(game.white.socketId === undefined || game.black.socketId === undefined)) {
			console.log('archiving game', game.roomId);
			io.in(game.roomId).emit('setGame', {});
			const colorToMakeLeaveRoom = game.white.socketId === undefined ? 'black' : 'white';
			if (game[colorToMakeLeaveRoom].socketId) {
				console.log('%s was still connected to this game', colorToMakeLeaveRoom);
				io.sockets.connected[game[colorToMakeLeaveRoom].socketId].leave(game.roomId);
				io.in(game[colorToMakeLeaveRoom].socketId).emit('cancelBoard');
			}
			game[colorToMakeLeaveRoom].socketId = undefined;
			game[colorToMakeLeaveRoom].user.hasLeft = true;
			game.black.user.message = undefined;
			game.white.user.message = undefined;
			game.archived = true;
		}

		if ((game.lastMove + ONE_HOUR) < Date.now() && game.won) {
			console.log('archiving game', game.roomId);
			io.in(game.roomId).emit('setGame', {});
			['white', 'black'].forEach((color) => {
				if (game[color].socketId) {
					io.sockets.connected[game[color].socketId].leave(game.roomId);
					io.in(game[color].socketId).emit('cancelBoard');
				}
				game[color].socketId = undefined;
				game[color].user.hasLeft = true;
				game[color].user.message = undefined;
			});
			game.archived = true;
		}
	});

	archiveGames(gamesInProgress.filter(g => g.archived));
	gamesInProgress = gamesInProgress.filter(g => !g.archived);
}

function archiveGames(gamesToArchive) {
	console.log('archiving %d gamesToArchive', gamesToArchive.length);
	if (gamesToArchive && gamesToArchive.length > 0) {
		gamesToArchive.forEach((game) => {
			games.create(game).then((result) => {
				console.log(result);
			}, (err) => {
				console.error(err);
			});
		});
	}
}

function checkForGamesInProgress(socket) {
	return (userId) => {
		const game = _.find(gamesInProgress, g => (g.white.user.id === userId || g.black.user.id === userId));
		if (game) {
			const color = game.black.user.id === userId ? 'black' : 'white';
			if (!game[color].user.hasLeft) {
				console.log('Found a game in progress game for user %s!', userId);
				game[color].socketId = socket.id;
				game[color].user.message = undefined;
				socket.join(game.roomId);
				io.in(game.roomId).emit('setGame', game);
			} else {
				console.log('Found a game in progress game for user %s, but the user has left the game', userId);
			}
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
}

function checkForReadyGames() {
	boards.forEach((board) => {
		const waitingUsersForBoard = waitingUsers.filter(u => u.boardId === board.id);
		console.log('waitingUsersForBoard %s', board.title, waitingUsersForBoard);
		if (waitingUsersForBoard.length > 1) {
			if (io.sockets.connected[waitingUsersForBoard[0].socketId] && io.sockets.connected[waitingUsersForBoard[1].socketId]) {
				const game = {
					board: Object.assign({}, board),
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
	findUsers(data.white.userId, data.black.userId).then((userResults) => {
		if (userResults[0] && userResults[1]) {
			const game = {
				roomId,
				boardId: data.board.id,
				bet: data.board.bet,
				tip,
				currentAmountBet: 2 * data.board.bet,
				multiplier: 1,
				lastDoubledBet: 'none',
				doublers: [],
				lastRolled: 'none',
				turn: data.turn || (Math.round(generator.random()) === 0 ? 'white' : 'black'),
				limit: data.board.time,
				lastMove: Date.now(),
				dice: [],
				originalDice: [],
				history: [],
				white: {
					user: safeUser(userResults[0]),
					socketId: data.white.socket.id,
					position: [0, 0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0], // real game
					// position: [0, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1], // test: black is almost won
					// position: [0, 0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], // test: white is blocked
					// position: [0, 0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], // test: two on the bar
					// position: [0, 0, 0, 0, 0, 0, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // test: huge stack
					// position: [13, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // test: end game
				},
				black: {
					user: safeUser(userResults[1]),
					socketId: data.black.socket.id,
					position: [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 3, 0, 5, 0, 0, 0, 0, 0, 0], // real game
					// position: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 3, 2, 2, 3, 0, 0], // test: black is almost won
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
	});
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

function computeNewElo(user, opponent) {
	// http://www.bkgm.com/faq/Ratings.html
	const exponent = (user.elo - opponent.elo) / 2000;
	let amount;
	if (user.xp > 400) {
		amount = user.won ?
			(4 / (1 + Math.pow(10, exponent))) :
			-(4 / (1 + Math.pow(10, -exponent)));
	} else {
		// still in ramp-up
		amount = user.won ?
			((500 - user.xp) * 4 / (100 * (1 + Math.pow(10, exponent)))) :
			-((500 - user.xp) * 4 / (100 * (1 + Math.pow(10, -exponent))));
	}
	return user.elo + amount;
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
	const deferred = q.defer();
	const lostColor = game.won === 'black' ? 'white' : 'black';
	const gameWonMessage = game[game.won].user.message;
	const gameLostMessage = game[lostColor].user.message;

	findUsers(game[game.won].user.id, game[lostColor].user.id).then((userResults) => {
		if (userResults[0] && userResults[1]) {
			userResults[0].money += Math.ceil((game.currentAmountBet / 2) * (1 - tip));
			userResults[1].money -= game.currentAmountBet / 2;
			const wonData = {
				elo: userResults[0].elo[userResults[0].elo.length - 1],
				xp: userResults[0].xp,
				won: true,
			};
			const lostData = {
				elo: userResults[1].elo[userResults[1].elo.length - 1],
				xp: userResults[1].xp,
				won: false,
			};
			userResults[0].elo.push(computeNewElo(wonData, lostData));
			userResults[1].elo.push(computeNewElo(lostData, wonData));
			userResults[0].xp++;
			userResults[1].xp++;
			const savePromises = [
				userResults[0].save(),
				userResults[1].save(),
			];
			q
				.all(savePromises)
				.then((saveResults) => {
					game[game.won].user = safeUser(saveResults[0]);
					game[game.won].user.message = gameWonMessage;
					io.in(game[game.won].socketId).emit('setUser', safeUser(saveResults[0]));
					game[lostColor].user = safeUser(userResults[1]);
					game[lostColor].user.message = gameLostMessage;
					io.in(game[lostColor].socketId).emit('setUser', safeUser(saveResults[1]));
					deferred.resolve(game);
				}, deferred.reject);
		}
	});
	return deferred.promise;
}

function validMoves(game) {
	return rules.computeValidMoves(game);
}

function noMoreValidMoves(game) {
	return !((validMoves(game)).reduce((p, c) => p || c, false));
}

setInterval(checkForTimeouts, 3000);
setInterval(checkToArchive, ONE_MINUTE);
