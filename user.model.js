const mongoose = require('mongoose');

const user = {
	username: String,
	password: String,
	xp: Number,
	elo: [Number],
	money: Number,
	picture: String,
	email: String,
	social: {
		facebookId: String,
	},
	country: String,
};


const schema = mongoose.Schema(user).set('toJSON', {
	virtuals: true
});

// schema.options.toJSON.transform = (doc, ret) => {
// 	ret.id = ret._id;
// 	delete ret._id;
// 	delete ret.__v;
// };

module.exports = schema;
