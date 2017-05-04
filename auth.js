const _ = require('lodash');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const q = require('q');

const config = require('./config');
const messages = require('./messages');

const users = mongoose.model('users', require('./user.model.js'));

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
						money: 10,
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

function createToken(user) {
	return jwt.sign(_.pick(user, ['id', 'username']), config.secret, {
		expiresIn: '7 days'
	});
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

module.exports = {
	signup,
	login,
};

