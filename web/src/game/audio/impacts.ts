/**
 * 碰碰車的撞擊音效：撞到車、建築、樹與人各有自己的聲音，全部即時合成（沒有音檔）。
 * 每個聲音由「低頻的撞擊」加上能辨認材質的那一層組成：
 * - 車：橡膠圈相撞的悶響、空心車殼的共鳴、車架金屬的輕響。
 * - 建築（含石燈籠、香爐、圍牆）：又低又乾的一聲，帶砂石的粗糙感，沒有餘韻。
 * - 樹：樹幹的「叩」，接著樹冠被震得沙沙作響。
 * - 人：軟軟的「咚」，飛出去時一聲先升後降的「咻」，落地一聲輕響（配合撞飛的 Q 版演出）。
 * random 可注入，方便產生可重現的結果。
 */

const TAU = 2 * Math.PI

type Sample = (t: number) => number

/** 逐取樣算出波形、頭尾淡化避免爆音、正規化到 0.8。 */
function render(ctx: BaseAudioContext, seconds: number, sample: Sample): AudioBuffer {
  const sr = ctx.sampleRate
  const len = Math.floor(sr * seconds)
  const buffer = ctx.createBuffer(1, len, sr)
  const data = buffer.getChannelData(0)
  const attack = Math.floor(sr * 0.002)
  const fade = Math.floor(sr * 0.02)
  let peak = 0
  for (let i = 0; i < len; i++) {
    const v = sample(i / sr) * Math.min(1, i / attack, (len - i) / fade)
    data[i] = v
    peak = Math.max(peak, Math.abs(v))
  }
  const norm = peak > 0 ? 0.8 / peak : 1
  for (let i = 0; i < len; i++) data[i]! *= norm
  return buffer
}

/** 音高從 from 滑到 to（Hz，時間常數 glide 秒）的正弦波；每個取樣呼叫一次。 */
function sweep(sr: number, from: number, to: number, glide: number): Sample {
  let phase = 0
  return (t) => {
    phase += (TAU * (to + (from - to) * Math.exp(-t / glide))) / sr
    return Math.sin(phase)
  }
}

/** 單極點濾波的雜訊：k 越小越悶。回傳 [低頻, 高頻（白噪音減掉低頻）]，每個取樣呼叫一次。 */
function noise(random: () => number, k: number): () => [low: number, high: number] {
  let low = 0
  return () => {
    const white = random() * 2 - 1
    low += k * (white - low)
    return [low, white - low]
  }
}

/** 車撞車。 */
export function synthesizeBumpCar(ctx: BaseAudioContext, random: () => number = Math.random): AudioBuffer {
  const thump = sweep(ctx.sampleRate, 150, 62, 0.03)
  const rubber = noise(random, 0.18)
  return render(ctx, 0.5, (t) =>
    thump(t) * Math.exp(-t / 0.09) +
    // 空心車殼的兩個共鳴
    0.35 * Math.sin(TAU * 233 * t) * Math.exp(-t / 0.06) +
    0.22 * Math.sin(TAU * 371 * t) * Math.exp(-t / 0.045) +
    2.5 * rubber()[0] * Math.exp(-t / 0.02) +
    // 車架金屬的輕響
    0.07 * (Math.sin(TAU * 1130 * t) + 0.7 * Math.sin(TAU * 1870 * t)) * Math.exp(-t / 0.07),
  )
}

/** 車撞建築、石燈籠、香爐或圍牆。 */
export function synthesizeBumpWall(ctx: BaseAudioContext, random: () => number = Math.random): AudioBuffer {
  const thump = sweep(ctx.sampleRate, 110, 48, 0.025)
  const grit = noise(random, 0.35)
  return render(ctx, 0.35, (t) =>
    thump(t) * Math.exp(-t / 0.07) +
    0.3 * Math.sin(TAU * 190 * t) * Math.exp(-t / 0.02) +
    // 砂石：一開始很密，之後零星地落
    grit()[0] * (1.6 * Math.exp(-t / 0.012) + 0.35 * Math.exp(-t / 0.09)),
  )
}

/** 樹冠開始沙沙作響的時間（秒，撞擊傳到樹冠）。 */
const LEAVES_DELAY = 0.04

/** 車撞樹。 */
export function synthesizeBumpTree(ctx: BaseAudioContext, random: () => number = Math.random): AudioBuffer {
  const leaves = noise(random, 0.25)
  return render(ctx, 1.1, (t) => {
    const trunk =
      Math.sin(TAU * 172 * t) * Math.exp(-t / 0.05) +
      0.5 * Math.sin(TAU * 433 * t) * Math.exp(-t / 0.022) +
      0.25 * Math.sin(TAU * 910 * t) * Math.exp(-t / 0.01)
    const u = t - LEAVES_DELAY
    // 抖動著慢慢停下來
    const shake = u < 0 ? 0 : (1 - Math.exp(-u / 0.05)) * Math.exp(-u / 0.3) * (0.6 + 0.4 * Math.sin(TAU * 11 * t))
    return trunk + 0.35 * leaves()[1] * shake
  })
}

/** 車撞人：flight 是被撞飛到落地的時間（秒），「咻」與落地聲對齊它。 */
export function synthesizeKnock(ctx: BaseAudioContext, flight = 0.9, random: () => number = Math.random): AudioBuffer {
  const sr = ctx.sampleRate
  const bonk = sweep(sr, 330, 150, 0.04)
  const soft = noise(random, 0.12)
  let whistle = 0
  return render(ctx, flight + 0.25, (t) => {
    const pad = soft()[0]
    let v = bonk(t) * Math.exp(-t / 0.07) + 2 * pad * Math.exp(-t / 0.015)
    if (t < flight) {
      const arc = Math.sin((Math.PI * t) / flight)
      whistle += (TAU * (520 + 700 * arc)) / sr
      v += 0.16 * Math.sin(whistle) * arc * arc
    } else {
      const u = t - flight
      v += 0.5 * Math.sin(TAU * 95 * u) * Math.exp(-u / 0.05) + 1.5 * pad * Math.exp(-u / 0.02)
    }
    return v
  })
}
