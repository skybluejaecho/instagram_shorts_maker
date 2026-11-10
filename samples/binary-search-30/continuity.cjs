// CSS timelines use the narration clock; the renderer can seek directly to any frame.
function keyframes(name, frames, duration) {
  const stops = frames.map(([time, css]) => {
    if (!Number.isFinite(time) || time < 0 || time > duration) throw Error('Invalid motion time: ' + name);
    return (100 * time / duration).toFixed(5) + '%{' + css + '}';
  });
  return '@keyframes ' + name + '{' + stops.join('') + '}';
}

function at(x, y, scale = 1) {
  return `transform:translate(${x}px,${y}px) scale(${scale});`;
}

function buildContinuity(values, episode) {
  const shots = Object.fromEntries(episode.shots.map(shot => [shot.id, shot]));
  const span = (id) => shots[id].transitionSeconds;
  const { setupIn: setup, firstCutIn: first, secondCutIn: second, discoveryIn: found,
    counterexampleIn: counter, right, left } = values;
  const duration = episode.durationSeconds;
  const colors = {
    base: ['#e2e8e3', '#172f39'], focus: ['#ffd67e', '#2a2724'],
    muted: ['#354950', '#a8bbba'], found: ['#adefba', '#13392e'],
    counter: ['#ffc2aa', '#471f21']
  };
  const paint = ([bg, fg]) => 'background-color:' + bg + ';color:' + fg + ';';
  const css = [];
  const rule = (name, frames) => css.push(keyframes(name, frames, duration));

  rule('backdrop', [
    [0, 'background:#172f44'], [setup, 'background:#172f44'],
    [setup + span('setup'), 'background:#193643'], [first, 'background:#193643'],
    [first + span('firstCut'), 'background:#29354c'], [second, 'background:#29354c'],
    [second + span('secondCut'), 'background:#163c3c'], [found, 'background:#163c3c'],
    [found + span('discovery'), 'background:#174139'], [counter, 'background:#174139'],
    [counter + span('counterexample'), 'background:#412e36'], [duration, 'background:#412e36']
  ]);
  const brandStart = Math.max(0, setup - .4);
  rule('move-brand', [[0,at(96,477)],[brandStart,at(96,477)],
    [brandStart+span('setup'),at(96,184)],[duration,at(96,184)]]);
  // The short underline from the opener opens into the physical baseline of the array.
  const railAt = (y, width) => `transform:translate(96px,${y}px) scaleX(${width / 804});`;
  rule('move-rail', [[0,railAt(985,190)],[setup,railAt(985,190)],
    [setup+span('setup'),railAt(1053,804)],[first,railAt(1053,804)],
    [first+span('firstCut'),railAt(1076,804)],[second,railAt(1076,804)],
    [second+span('secondCut'),railAt(1000,804)],[found,railAt(1000,804)],
    [found+span('discovery'),railAt(1100,804)],[counter,railAt(1100,804)],
    [counter+span('counterexample'),railAt(1060,804)],[duration,railAt(1060,804)]]);

  const tiles = episode.values.map((value, i) => {
    const x = 142 + i * 102;
    const survivor = i >= 4;
    const isTarget = value === episode.target;
    const dest = episode.counterexampleValues.indexOf(value);
    if (dest < 0) throw Error('Counterexample must use the same values.');
    const base = at(x,970);
    const comparison = at(x,995);
    const zoomed = survivor ? at(195 + (i-4)*210,870,1.72) : at(x-24,995);
    const discovered = isTarget ? at(490,860,3.5) : zoomed;
    const final = at(142 + dest * 102,975);
    rule('move-' + i, [[0,at(x,1002,.92)],[setup,at(x,1002,.92)],[setup+span('setup'),base],
      [first,base],[first+span('firstCut'),comparison],[second,comparison],
      [second+span('secondCut'),zoomed],[found,zoomed],[found+span('discovery'),discovered],
      [counter,discovered],[counter+span('counterexample'),final],[duration,final]]);
    const alpha = [[0,0],[setup,0],[setup+.34,1]];
    if (!survivor) alpha.push([second-.15,1],[second,0]);
    else if (!isTarget) alpha.push([found-.15,1],[found,0]);
    if (!isTarget) alpha.push([counter+span('counterexample')*.78,0],
      [counter+span('counterexample')+.14,1]);
    alpha.push([duration,1]);
    rule('alpha-' + i, alpha.map(([t,a]) => [t,'opacity:'+a+';']));
    const colorStops = [[0,colors.base]];
    if (i===3) colorStops.push([first,colors.focus]);
    if (!survivor) colorStops.push([right,colors.muted]);
    if (i===5) colorStops.push([second,colors.focus]);
    if (i>4) colorStops.push([left,colors.muted]);
    if (isTarget) colorStops.push([found,colors.found]);
    const finalColor = isTarget ? colors.counter : (i===3 ? colors.focus : colors.base);
    colorStops.push([counter,finalColor],[duration,finalColor]);
    rule('paint-' + i, colorStops.map(([t,color]) => [t,paint(color)]));
    // Hold colors exactly until the named word; only spatial interpolation eases.
    css.push(`.tile-${i}{animation-name:move-${i},alpha-${i},paint-${i};${isTarget ? 'z-index:2;' : ''}}`);
    return `<li class="tile tile-${i}">${Number(value)}</li>`;
  });
  return { sharedMotion: css.join('\n'), sharedTiles: tiles.join('\n') };
}
module.exports = { buildContinuity };
