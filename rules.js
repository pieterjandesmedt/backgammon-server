module.exports = {
	isValidMove,
	computeValidMoves,
};

function isValidMove(fromIndex, toIndex, game) {
	const playerColor = game.turn;
	const opponentColor = playerColor === 'white' ? 'black' : 'white';
	const barIndex = playerColor === 'white' ? 25 : 0;
	const outIndex = playerColor === 'white' ? 0 : 25;
	const sliceFrom = playerColor === 'white' ? 7 : 0;
	const sliceTo = playerColor === 'white' ? 26 : 19;
	const isFromIndexOnBoard = fromIndex > 0 && fromIndex < 25;
	// already out
	if (fromIndex === outIndex) return false;
	// there are stones on the bar
	if (isFromIndexOnBoard && game[playerColor].position[barIndex] > 0) return false;
	// no stones available
	if (game[playerColor].position[fromIndex] < 1) return false;
	// all stones must be in home before taking a stone out
	if (playerColor === 'white' && toIndex < 1 || playerColor === 'black' && toIndex > 24) {
		const areAllInHome = game[playerColor].position
			.slice(sliceFrom, sliceTo)
			.reduce((p, c) => p && (c === 0), true);
		// In addition to this, the distance between index and outIndex must equal one of the dice
		const isGoodDistance = ~game.dice.indexOf(distance(outIndex, fromIndex));
		// Or all indices greater than the furthest available die are empty, then the
		// furthest non-empty index becomes a valid move too.
		return areAllInHome &&
			(isGoodDistance ||
				distance(outIndex, furthestNonEmpty(game)) < Math.max(...game.dice) &&
				fromIndex === furthestNonEmpty(game)
			);
	}
	// no special move, just check for opponent occupation
	return game[opponentColor].position[toIndex] < 2;
}

function computeValidMoves(game) {
	const sign = game.turn === 'white' ? -1 : 1;
	const endInOut = game.turn === 'white' ? function (index) {
		return Math.max(index, 0);
	} : function (index) {
		return Math.min(index, 25);
	};
	return game[game.turn].position.map((position, index) => {
		if (position === 0) return false;
		return game.dice
			.map(die => isValidMove(index, endInOut(index + die * sign), game))
			.reduce((p, c) => p || c, false);
	});
}

function distance(to, fro) {
	return Math.abs(to - fro);
}

function furthestNonEmpty(game) {
	const playerColor = game.turn;
	const nonEmptyPositions = game[playerColor].position.map((value, index) => (value > 0 ? index : 0)).filter(n => n);
	return playerColor === 'white' ? Math.max(...nonEmptyPositions) : Math.min(...nonEmptyPositions);
}
