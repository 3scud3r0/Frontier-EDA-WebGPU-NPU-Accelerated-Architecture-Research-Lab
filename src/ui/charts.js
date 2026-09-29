function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function colorForActivity(value, max) {
  const t = max ? Math.min(1, value / max) : 0;
  const hue = 210 - t * 195;
  const light = 18 + t * 42;
  return `hsl(${hue} 90% ${light}%)`;
}

export function drawSiliconHeatmap(canvas, netlist, activity = null) {
  const { ctx, width, height } = resizeCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#071018';
  ctx.fillRect(0, 0, width, height);
  if (!netlist?.gateCount) return;

  const values = activity ?? netlist.fanout;
  let max = 1;
  for (let i = 0; i < values.length; i++) max = Math.max(max, values[i]);
  const targetCells = Math.min(netlist.gateCount, 8192);
  const cols = Math.max(1, Math.ceil(Math.sqrt(targetCells * width / Math.max(1, height))));
  const rows = Math.ceil(targetCells / cols);
  const cw = width / cols, ch = height / rows;
  const stride = Math.max(1, Math.floor(netlist.gateCount / targetCells));

  for (let cell = 0, i = 0; cell < targetCells && i < netlist.gateCount; cell++, i += stride) {
    const x = (cell % cols) * cw;
    const y = Math.floor(cell / cols) * ch;
    const levelBoost = netlist.level[i] / Math.max(1, netlist.maxLevel);
    const v = (values[i] || 0) + levelBoost * max * 0.12;
    ctx.fillStyle = colorForActivity(v, max);
    ctx.fillRect(x + 0.5, y + 0.5, Math.max(1, cw - 1), Math.max(1, ch - 1));
  }

  ctx.fillStyle = '#a8bad0';
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(`${netlist.nandCount.toLocaleString()} NAND • depth ${netlist.maxLevel} • sampled ${targetCells.toLocaleString()}`, 10, height - 10);
}

export function drawSeries(canvas, series, { label = '', valueFormatter = v => v.toFixed(1), color = '#5cc8ff', maxPoints = 180 } = {}) {
  const { ctx, width, height } = resizeCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#071018';
  ctx.fillRect(0, 0, width, height);
  const data = series.slice(-maxPoints);
  if (!data.length) return;
  let min = Math.min(...data), max = Math.max(...data);
  if (min === max) { min -= 1; max += 1; }
  const pad = 26;
  ctx.strokeStyle = '#173247';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + (height - pad * 2) * i / 4;
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(width - 8, y); ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  data.forEach((value, i) => {
    const x = pad + (width - pad - 10) * i / Math.max(1, data.length - 1);
    const y = height - pad - (value - min) / (max - min) * (height - pad * 2);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#93a9bf';
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText(`${label}  min ${valueFormatter(min)}  max ${valueFormatter(max)}  last ${valueFormatter(data.at(-1))}`, 10, 13);
}

export function drawBranchAccuracy(canvas, history) {
  drawSeries(canvas, history.map(v => v * 100), {
    label: 'Neural branch accuracy',
    valueFormatter: v => `${v.toFixed(1)}%`,
    color: '#78e08f',
  });
}
