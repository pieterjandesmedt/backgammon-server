const mongoose = require('mongoose');

const game = {
	archived: Boolean,
	attemptMultiply: Number,
	bet: Number,
	black: {
		position: [Number],
		user: {
			id: String
		}
	},
	boardId: Number,
	currentAmountBet: Number,
	dice: [Number],
	doublers: [String],
	history: [{}],
	lastDoubledBet: String,
	lastMove: Number,
	lastRolled: String,
	limit: Number,
	maxbet: Number,
	multiplier: Number,
	originalDice: [Number],
	roomId: String,
	tip: Number,
	turn: String,
	white: {
		position: [Number],
		user: {
			id: String
		}
	},
	won: String,
};


const schema = mongoose.Schema(game);

// schema.options.toJSON.transform = (doc, ret) => {
// 	ret.id = ret._id;
// 	delete ret._id;
// 	delete ret.__v;
// };

module.exports = schema;
