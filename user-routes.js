const _ = require('lodash'),
	config = require('./config'),
	jwt = require('jsonwebtoken');
// var mongoose = require('mongoose');
// mongoose.connect('mongodb://localhost/libackgammon');

// var userModel = mongoose.model('ModelName', {

// });


// XXX: This should be a database of users :).
const users = [{
	id: 1,
	username: 'pj',
	password: 'test',
	money: 1000,
}, {
	id: 2,
	username: 'pj2',
	password: 'test',
	money: 1000,
}];

module.exports = {
	login,
	signup,
};

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
	const userScheme = getUserScheme(credentials);

	if (!userScheme.username || !credentials.password) {
		return {
			error: 'You must send the username and the password'
		};
	}

	const user = _.find(users, userScheme.userSearch);
	console.log('user', user);

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
