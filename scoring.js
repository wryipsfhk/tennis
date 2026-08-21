const AcePointScoring = (() => {
  function positiveInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
  }

  function nonNegativeInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
  }

  function validateStandardSets(rawSets) {
    const raw = rawSets.filter(set => set.player !== '' || set.opponent !== '');
    if (!raw.length) return {ok:false,error:'Enter at least two valid sets.'};
    if (raw.some((set,index) => set.index !== index)) return {ok:false,error:'Enter each set in order without skipping a set.'};
    const sets = [];
    for (const set of raw) {
      const label = `Set ${set.index + 1}`;
      if (set.player === '' || set.opponent === '') return {ok:false,error:`${label}: enter the game count for both players.`};
      const player = nonNegativeInteger(set.player), opponent = nonNegativeInteger(set.opponent);
      if (player === null || opponent === null) return {ok:false,error:`${label}: scores must be whole numbers of zero or more.`};
      const high=Math.max(player,opponent), low=Math.min(player,opponent), difference=high-low;
      if (player === opponent) return {ok:false,error:`${label} cannot end in a tie.`};
      if (high < 6) return {ok:false,error:`${label} is invalid: the winner needs at least 6 games.`};
      if (high === 7 && low === 6) {
        if (!set.hasTb || set.tbPlayer === '' || set.tbOpponent === '') return {ok:false,error:`${label} ended 7–6, so enter both tiebreak scores.`};
        const tbPlayer=nonNegativeInteger(set.tbPlayer), tbOpponent=nonNegativeInteger(set.tbOpponent);
        if (tbPlayer === null || tbOpponent === null || Math.max(tbPlayer,tbOpponent) < 7 || Math.abs(tbPlayer-tbOpponent) < 2) return {ok:false,error:`${label} tiebreak is invalid: the winner needs at least 7 points and a 2-point lead.`};
        if ((player>opponent&&tbPlayer<=tbOpponent)||(opponent>player&&tbOpponent<=tbPlayer)) return {ok:false,error:`${label}: the tiebreak winner must match the set winner.`};
        sets.push({player:String(player),opponent:String(opponent),tiebreak:{player:String(tbPlayer),opponent:String(tbOpponent)}});
      } else {
        if (difference < 2) return {ok:false,error:`${label} is invalid: the winner needs at least 6 games and a 2-game lead. A 7–6 set requires a tiebreak score.`};
        if (set.hasTb) return {ok:false,error:`${label}: enter a tiebreak score only when the set score is 7–6.`};
        sets.push({player:String(player),opponent:String(opponent)});
      }
    }
    let won=0,lost=0;
    sets.forEach(set => Number(set.player)>Number(set.opponent)?won++:lost++);
    if (won<2&&lost<2) return {ok:false,error:'In a best-of-three match, one player must win at least two sets.'};
    return {ok:true,sets,won,lost,scoreFormat:'standard'};
  }

  function validateCustomPoints({player,opponent,target,winBy}) {
    if (player === '' || opponent === '') return {ok:false,error:'Enter the final point score for both players.'};
    const playerPoints=nonNegativeInteger(player), opponentPoints=nonNegativeInteger(opponent), targetPoints=positiveInteger(target), lead=nonNegativeInteger(winBy);
    if (targetPoints === null) return {ok:false,error:'Points to win must be a whole number greater than zero.'};
    if (lead === null) return {ok:false,error:'The required winning lead must be a whole number of zero or more.'};
    if (playerPoints === null || opponentPoints === null) return {ok:false,error:'Final scores must be whole numbers of zero or more.'};
    if (playerPoints === opponentPoints) return {ok:false,error:'A completed game cannot end in a tie.'};
    const high=Math.max(playerPoints,opponentPoints), difference=Math.abs(playerPoints-opponentPoints);
    if (high < targetPoints) return {ok:false,error:`The winner needs at least ${targetPoints} points.`};
    if (difference < lead) return {ok:false,error:`The winner must lead by at least ${lead} ${lead===1?'point':'points'}.`};
    return {ok:true,sets:[{player:String(playerPoints),opponent:String(opponentPoints)}],won:playerPoints>opponentPoints?1:0,lost:playerPoints<opponentPoints?1:0,scoreFormat:'custom-points',customScoring:{target:targetPoints,winBy:lead}};
  }

  return {validateStandardSets,validateCustomPoints};
})();

globalThis.AcePointScoring = AcePointScoring;
