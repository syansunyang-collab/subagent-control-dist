// 阶梯化关键帧生成器：styles.css 里 pulse-soft/blink/twinkle/tool-live-pulse/float-y
// 的多停靠点 @keyframes 由本脚本生成。改包络（幅度/步数/量化粒度）在这里改，
// 重跑后把输出整块替换进 styles.css——不要手调中间停靠点。
//   node tools/gen-stepped-keyframes.mjs
// 原理：连续插值动画迫使合成器以显示器刷新率持续出帧（165Hz 屏即 165fps）；
// 逐段保持(step-end)的余弦包络采样让值不变的帧被合成器跳过。
// 步数按该 keyframes 的最快使用点定，使更新率 ≤~27 次/秒（opus 复核 F8：
// blink 最快用在 0.9s 周期，48 步会到 54/s，故取 24；其余最快 1.8-2s，取 48）。
// 包络 v(t) = lo + (1-lo) * (0.5 + 0.5*cos(2*pi*t))，与原 ease-in-out 0/50/100 往返感知一致；
// opacity 量化 0.005、位移量化 0.25px，相邻同值步合并，单步差恒在感知阈下。
// 后半程镜像前半程采样值：浮点余弦在镜像点两侧可差一个量化桶（opus 复核 F12）。
function mirroredSamples(N, sample) {
  const half = [];
  for (let k = 0; k <= N / 2; k += 1) half.push(sample(k));
  const values = [];
  for (let k = 0; k < N; k += 1) values.push(k <= N / 2 ? half[k] : half[N - k]);
  return values;
}

function emitStops(name, values, N, render, perLine) {
  const stops = [];
  let prev = null;
  for (let k = 0; k < N; k += 1) {
    const v = values[k];
    if (v === prev) continue;
    const pct = Number(((k * 100) / N).toFixed(2));
    stops.push(`${pct}%{${render(v)};animation-timing-function:step-end}`);
    prev = v;
  }
  stops.push(`100%{${render(values[0])}}`);
  const lines = [];
  for (let i = 0; i < stops.length; i += perLine) lines.push('  ' + stops.slice(i, i + perLine).join(' '));
  return `@keyframes ${name} {\n${lines.join('\n')}\n}`;
}

function emitOpacity(name, lo, N) {
  const values = mirroredSamples(N, (k) =>
    Number((Math.round((lo + (1 - lo) * (0.5 + 0.5 * Math.cos((2 * Math.PI * k) / N))) / 0.005) * 0.005).toFixed(3)));
  return emitStops(name, values, N, (v) => `opacity:${v}`, 6);
}

function emitTranslateY(name, peak, N) {
  const values = mirroredSamples(N, (k) =>
    Number((Math.round((-peak * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / N))) / 0.25) * 0.25).toFixed(2)));
  return emitStops(name, values, N, (v) => `transform:translateY(${v}px)`, 4);
}

export function generateSteppedKeyframes() {
  return [
    emitOpacity('pulse-soft', 0.55, 48),
    emitOpacity('blink', 0.25, 24),
    emitOpacity('twinkle', 0.72, 48),
    emitOpacity('tool-live-pulse', 0.55, 48),
    emitTranslateY('float-y', 9, 96),
  ];
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())) {
  console.log(generateSteppedKeyframes().join('\n'));
}
