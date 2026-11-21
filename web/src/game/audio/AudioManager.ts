/**
 * 音訊管理：環境音（風聲、鳥鳴、遠處鐘聲與頌缽）與短音效分開、獨立音量、淡入淡出、背景暫停。
 *
 * 聲音留白大於填滿，沒有背景音樂。
 * - 風聲：一段幾秒的循環雜訊 AudioBuffer，經 lowpass，增益與截止頻率由兩個極慢的 LFO 起伏成陣風。
 * - 鐘、木魚、頌缽、鳥叫是一次性合成的短 AudioBuffer，只在觸發時播放。
 * - 遠處鐘聲：隨機間隔響一聲低音量、壓暗高頻的鐘，純本機，不經網路也不連動庭院鐘亭。
 * - 靜音或總音量為 0 時暫停整個 AudioContext；環境音量為 0 時停止風聲、鳥叫與遠處鐘聲；切到背景時同樣暫停。
 *   暫停後音訊執行緒不再運算，才真正省電。
 * - AudioContext 只能在使用者操作後建立／恢復，因此 unlock() 必須在點擊事件中呼叫。
 */

type SynthName = 'bell' | 'wood' | 'bowl' | 'bump' | 'knock'

const MAX_VOICES = 12

/** 風聲循環雜訊長度與首尾交叉淡化長度（秒）。 */
const WIND_LOOP_SECONDS = 6
const WIND_FADE_SECONDS = 1
/** 風聲：基礎增益與陣風起伏幅度（增益 0.02–0.08）、截止頻率中心與幅度（Hz）、兩個 LFO 的頻率（Hz，週期約 9 秒與 14 秒）。 */
const WIND_GAIN = 0.05
const WIND_GAIN_DEPTH = 0.03
const WIND_CUTOFF_HZ = 450
const WIND_CUTOFF_DEPTH = 200
const WIND_GAIN_LFO_HZ = 0.11
const WIND_CUTOFF_LFO_HZ = 0.07

/** 遠鐘間隔（毫秒）、音量、lowpass 截止頻率（Hz）與播放速率（<1 更低沉、餘韻更長）。 */
export const FAR_BELL_MIN_MS = 90_000
export const FAR_BELL_MAX_MS = 210_000
const FAR_BELL_GAIN = 0.1
const FAR_BELL_CUTOFF_HZ = 500
const FAR_BELL_RATE = 0.85

export interface Volumes {
  master: number
  music: number
  sfx: number
  muted: boolean
}

function synthesize(ctx: BaseAudioContext, name: SynthName): AudioBuffer {
  const sr = ctx.sampleRate
  const spec: Record<SynthName, { seconds: number; partials: Array<[ratio: number, amp: number, decay: number]>; f0: number; click?: number }> = {
    // 寺鐘：不和諧泛音、長衰減
    bell: { seconds: 7, f0: 98, partials: [[1, 1, 3.2], [2.0, 0.6, 2.2], [2.76, 0.45, 1.6], [5.4, 0.25, 0.9], [8.93, 0.12, 0.5]] },
    // 木魚：中頻短促敲擊
    wood: { seconds: 0.35, f0: 620, partials: [[1, 1, 0.07], [2.31, 0.4, 0.04]], click: 0.004 },
    // 頌缽：拍頻造成的嗡嗡聲
    bowl: { seconds: 6, f0: 294, partials: [[1, 1, 3.5], [1.006, 0.8, 3.5], [2.71, 0.35, 2], [5.15, 0.12, 1]] },
    // 碰碰車碰撞：低沉短促橡膠撞擊
    bump: { seconds: 0.25, f0: 95, partials: [[1, 1, 0.05], [1.8, 0.4, 0.03]], click: 0.015 },
    // 撞飛：較重的擊中感與滑落衰減
    knock: { seconds: 0.45, f0: 140, partials: [[1, 1, 0.08], [0.65, 0.7, 0.12], [2.1, 0.3, 0.04]], click: 0.02 },
  }
  const s = spec[name]
  const len = Math.floor(sr * s.seconds)
  const buffer = ctx.createBuffer(1, len, sr)
  const data = buffer.getChannelData(0)
  const attack = Math.floor(sr * 0.004)
  let peak = 0
  for (let i = 0; i < len; i++) {
    const t = i / sr
    let v = 0
    for (const [ratio, amp, decay] of s.partials) {
      v += amp * Math.sin(2 * Math.PI * s.f0 * ratio * t) * Math.exp(-t / decay)
    }
    if (s.click && t < s.click) v += (Math.random() * 2 - 1) * (1 - t / s.click)
    if (i < attack) v *= i / attack
    data[i] = v
    peak = Math.max(peak, Math.abs(v))
  }
  const norm = peak > 0 ? 0.8 / peak : 1
  for (let i = 0; i < len; i++) data[i]! *= norm
  return buffer
}

/** 壓磬：餘韻收掉與「嘀」聲本身的衰減時間（秒），以及「嘀」相對於敞著敲的音量。 */
const QING_DAMP_SECONDS = 0.04
const QING_DAMP_GAIN = 0.55

/**
 * 合成引磬（手持的小磬）：清亮的高音、餘韻約 2 秒。strikes 是每一聲的起點（秒），可在一段音效裡敲數下，
 * 例如對齊叩拜的動畫。音量為每聲疊加後再正規化。
 * damps 是壓磬的時間（秒）：手指壓住磬再敲，之前的餘韻在那一刻收掉，只留一聲短促的「嘀」（禮佛時起身的號令）。
 */
export function synthesizeQing(ctx: BaseAudioContext, strikes: readonly number[] = [0], damps: readonly number[] = []): AudioBuffer {
  const sr = ctx.sampleRate
  const f0 = 1320
  const partials: Array<[ratio: number, amp: number, decay: number]> = [[1, 1, 1.4], [2.32, 0.35, 0.6], [4.1, 0.18, 0.3], [6.3, 0.08, 0.15]]
  const tail = 2.6
  const len = Math.floor(sr * (Math.max(0, ...strikes, ...damps) + tail))
  const buffer = ctx.createBuffer(1, len, sr)
  const data = buffer.getChannelData(0)
  const attack = Math.floor(sr * 0.002)
  for (const start of strikes) {
    const s0 = Math.floor(start * sr)
    // 這一聲之後最早的壓磬：從那一刻起餘韻以 QING_DAMP_SECONDS 收掉
    const damp = Math.min(Infinity, ...damps.filter((d) => d > start)) - start
    for (let i = 0; i < len - s0; i++) {
      const t = i / sr
      let v = 0
      for (const [ratio, amp, decay] of partials) v += amp * Math.sin(2 * Math.PI * f0 * ratio * t) * Math.exp(-t / decay)
      if (i < attack) v *= i / attack
      if (t > damp) v *= Math.exp(-(t - damp) / QING_DAMP_SECONDS)
      data[s0 + i]! += v
    }
  }
  // 壓磬本身：同樣的分音但幾乎沒有餘韻，音量較小
  for (const start of damps) {
    const s0 = Math.floor(start * sr)
    const n = Math.min(len - s0, Math.floor(sr * QING_DAMP_SECONDS * 8))
    for (let i = 0; i < n; i++) {
      const t = i / sr
      let v = 0
      for (const [ratio, amp] of partials) v += amp * Math.sin(2 * Math.PI * f0 * ratio * t)
      data[s0 + i]! += QING_DAMP_GAIN * v * Math.exp(-t / QING_DAMP_SECONDS) * Math.min(1, i / attack)
    }
  }
  let peak = 0
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(data[i]!))
  const norm = peak > 0 ? 0.6 / peak : 1
  for (let i = 0; i < len; i++) data[i]! *= norm
  return buffer
}

/** 上香音效：香腳入灰的沙聲長度（秒，結束在插香那一刻）與大磬的餘韻長度（秒）。 */
const ASH_SECONDS = 0.3
const DAQING_TAIL = 4.5

/**
 * 合成上香的音效：前面留白（三拜不出聲），plantAt 秒（香插進香爐的那一刻）之前是香腳入灰的一小聲「沙」，
 * 插下時敲一聲大磬（缽形、低而溫潤、兩個相近的分音造成緩慢的拍頻），與跪拜清亮的引磬區分。
 */
export function synthesizeIncenseOffering(ctx: BaseAudioContext, plantAt: number, random: () => number = Math.random): AudioBuffer {
  const sr = ctx.sampleRate
  const f0 = 466
  const partials: Array<[ratio: number, amp: number, decay: number]> = [[1, 1, 1.6], [1.005, 0.6, 1.6], [2.72, 0.3, 0.9], [4.9, 0.1, 0.35]]
  const len = Math.floor(sr * (plantAt + DAQING_TAIL))
  const buffer = ctx.createBuffer(1, len, sr)
  const data = buffer.getChannelData(0)
  const s0 = Math.floor(plantAt * sr)
  // 沙聲：去掉低頻的白噪音（白噪音減掉自己的 lowpass），sin² 包絡
  const ash = Math.min(s0, Math.floor(ASH_SECONDS * sr))
  let low = 0
  for (let i = 0; i < ash; i++) {
    const white = random() * 2 - 1
    low += 0.3 * (white - low)
    data[s0 - ash + i] = 0.2 * (white - low) * Math.sin((Math.PI * i) / ash) ** 2
  }
  // 大磬：包布的槌，起音比引磬慢；尾端半秒淡出，避免截斷
  const attack = Math.floor(sr * 0.006)
  const fade = Math.floor(sr * 0.5)
  let peak = 0
  for (let i = 0; i < len - s0; i++) {
    const t = i / sr
    let v = 0
    for (const [ratio, amp, decay] of partials) v += amp * Math.sin(2 * Math.PI * f0 * ratio * t) * Math.exp(-t / decay)
    if (i < attack) v *= i / attack
    v *= Math.min(1, (len - s0 - i) / fade)
    data[s0 + i] = v
    peak = Math.max(peak, Math.abs(v))
  }
  const norm = peak > 0 ? 0.6 / peak : 1
  for (let i = 0; i < len; i++) data[i]! *= norm
  return buffer
}

/**
 * 合成一段鳥叫：數個快速滑音組成的短句。每次呼叫用 random 產生不同的叫法。
 * random 可注入，方便產生可重現的結果。
 */
export function synthesizeBirdCall(ctx: BaseAudioContext, random: () => number = Math.random): AudioBuffer {
  const sr = ctx.sampleRate
  const notes = 2 + Math.floor(random() * 5)
  const trill = random() < 0.4 // 顫音型：振幅快速起伏
  const base = 2600 + random() * 2200
  const spec = Array.from({ length: notes }, () => ({
    dur: 0.05 + random() * 0.09,
    gap: 0.03 + random() * 0.07,
    f0: base * (0.85 + random() * 0.3),
    sweep: (random() - 0.4) * 1800,
  }))
  const total = spec.reduce((t, n) => t + n.dur + n.gap, 0.05)
  const buffer = ctx.createBuffer(1, Math.ceil(total * sr), sr)
  const data = buffer.getChannelData(0)
  let offset = 0
  let peak = 0
  for (const n of spec) {
    const len = Math.floor(n.dur * sr)
    let phase = 0
    for (let i = 0; i < len; i++) {
      const p = i / len
      const f = n.f0 + n.sweep * p
      phase += (2 * Math.PI * f) / sr
      let amp = Math.sin(Math.PI * p) ** 2
      if (trill) amp *= 0.55 + 0.45 * Math.sin(2 * Math.PI * 45 * (i / sr))
      // 少量二次諧波讓聲音不那麼像純正弦波
      const v = amp * (Math.sin(phase) + 0.18 * Math.sin(2 * phase))
      const idx = offset + i
      if (idx < data.length) {
        data[idx] = v
        peak = Math.max(peak, Math.abs(v))
      }
    }
    offset += len + Math.floor(n.gap * sr)
  }
  const norm = peak > 0 ? 0.7 / peak : 1
  for (let i = 0; i < data.length; i++) data[i]! *= norm
  return buffer
}

const BIRD_VARIANTS = 5

/** 下一聲遠鐘的等待時間（毫秒）；random 可注入。 */
export function nextFarBellDelayMs(random: () => number = Math.random): number {
  return FAR_BELL_MIN_MS + random() * (FAR_BELL_MAX_MS - FAR_BELL_MIN_MS)
}

/** 合成可無縫循環的風聲雜訊：單極點 lowpass 白噪音，尾段以等功率交叉淡化疊回開頭。 */
export function synthesizeWindNoise(ctx: BaseAudioContext, random: () => number = Math.random): AudioBuffer {
  const sr = ctx.sampleRate
  const len = Math.floor(sr * WIND_LOOP_SECONDS)
  const fade = Math.floor(sr * WIND_FADE_SECONDS)
  const raw = new Float32Array(len + fade)
  let y = 0
  for (let i = 0; i < raw.length; i++) {
    y += 0.05 * (random() * 2 - 1 - y)
    raw[i] = y
  }
  const buffer = ctx.createBuffer(1, len, sr)
  const data = buffer.getChannelData(0)
  let peak = 0
  for (let i = 0; i < len; i++) {
    let v = raw[i]!
    if (i < fade) {
      const w = (i / fade) * (Math.PI / 2)
      v = v * Math.sin(w) + raw[len + i]! * Math.cos(w)
    }
    data[i] = v
    peak = Math.max(peak, Math.abs(v))
  }
  const norm = peak > 0 ? 0.8 / peak : 1
  for (let i = 0; i < len; i++) data[i]! *= norm
  return buffer
}

/**
 * 依音量與前景狀態決定音訊該運作到什麼程度（純函式，方便測試）。
 * - audible=false：整個 AudioContext 暫停。
 * - musicOn=false：風聲、鳥叫、遠處頌缽與遠鐘停止。
 */
export function runState(v: Volumes, hidden: boolean, ambientStarted: boolean): { audible: boolean; musicOn: boolean } {
  const audible = !hidden && !v.muted && v.master > 0
  return { audible, musicOn: audible && ambientStarted && v.music > 0 }
}

export class AudioManager {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private musicBus: GainNode | null = null
  private sfxBus: GainNode | null = null
  private buffers = new Map<string, AudioBuffer>()
  private pendingUrls = new Map<string, string>()
  private pendingSynths = new Map<string, (ctx: BaseAudioContext) => AudioBuffer>()
  private voices = 0
  private birdBuffers: AudioBuffer[] = []
  private birdTimer: ReturnType<typeof setTimeout> | null = null
  private bowlTimer: ReturnType<typeof setTimeout> | null = null
  private farBellTimer: ReturnType<typeof setTimeout> | null = null
  private windBuffer: AudioBuffer | null = null
  private wind: { sources: AudioScheduledSourceNode[]; nodes: AudioNode[] } | null = null
  private ambientStarted = false
  private volumes: Volumes = { master: 0.8, music: 0.6, sfx: 0.8, muted: false }
  private hidden = false
  /** 每次狀態變更遞增；延遲中的暫停若遇到新變更就取消。 */
  private stateToken = 0
  /** 室內：鳥叫變小、像是從殿外傳來。 */
  private indoor = false

  get unlocked(): boolean {
    return this.ctx !== null
  }

  /** AudioContext 是否在運作。靜音時為 false 屬正常。 */
  get running(): boolean {
    return this.ctx?.state === 'running'
  }

  /** 目前是否應該發出聲音（未靜音、在前景）。 */
  get audible(): boolean {
    return runState(this.volumes, this.hidden, this.ambientStarted).audible
  }

  /** 在使用者點擊時呼叫。重複呼叫安全。 */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      const ctx = new Ctor({ latencyHint: 'playback' })
      this.ctx = ctx
      this.master = ctx.createGain()
      this.musicBus = ctx.createGain()
      this.sfxBus = ctx.createGain()
      this.master.gain.value = 0
      this.musicBus.connect(this.master)
      this.sfxBus.connect(this.master)
      this.master.connect(ctx.destination)
      for (const n of ['bell', 'wood', 'bowl', 'bump', 'knock'] as const) this.buffers.set(n, synthesize(ctx, n))
      this.birdBuffers = Array.from({ length: BIRD_VARIANTS }, () => synthesizeBirdCall(ctx))
      this.windBuffer = synthesizeWindNoise(ctx)
      for (const [name, url] of this.pendingUrls) void this.loadSfx(name, url)
      this.pendingUrls.clear()
      for (const [name, synth] of this.pendingSynths) this.buffers.set(name, synth(ctx))
      this.pendingSynths.clear()
    }
    await this.applyRunState(1.5)
  }

  setVolumes(v: Volumes): void {
    this.volumes = { ...v }
    void this.applyRunState(0.15)
  }

  /** 以 URL 載入或替換音效（例如正式錄製的鐘聲）。unlock 前呼叫會延後載入。 */
  async loadSfx(name: string, url: string): Promise<void> {
    if (!this.ctx) {
      this.pendingUrls.set(name, url)
      return
    }
    const res = await fetch(url)
    if (!res.ok) throw new Error(`音效載入失敗：${url}`)
    this.buffers.set(name, await this.ctx.decodeAudioData(await res.arrayBuffer()))
  }

  /**
   * 以合成函式定義音效（玩法模組加自己的聲音，不用音檔）。unlock 前呼叫會延到建立 AudioContext 時才合成。
   * 回傳的函式移除這個音效。
   */
  defineSfx(name: string, synth: (ctx: BaseAudioContext) => AudioBuffer): () => void {
    if (this.ctx) this.buffers.set(name, synth(this.ctx))
    else this.pendingSynths.set(name, synth)
    return () => {
      this.pendingSynths.delete(name)
      this.buffers.delete(name)
    }
  }

  hasSfx(name: string): boolean {
    return this.buffers.has(name) || this.pendingUrls.has(name) || this.pendingSynths.has(name)
  }

  /**
   * 播放短音效。gain 可用於距離衰減。超過同時發聲上限或音效音量為 0 時略過。
   * at 是預定的播放時間（performance.now 毫秒）：在 AudioContext 的時間軸上排程，不受計時器誤差影響
   * （節拍類的聲音先排好接下來幾百毫秒內的拍點）；已經過去或沒給時立即播放。
   */
  play(name: string, opts: { gain?: number; rate?: number; at?: number } = {}): void {
    const ctx = this.ctx
    const buffer = this.buffers.get(name)
    if (!ctx || !buffer || !this.sfxBus || ctx.state !== 'running' || this.voices >= MAX_VOICES) return
    if (this.volumes.sfx <= 0) return
    const gain = opts.gain ?? 1
    if (gain < 0.01) return
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = opts.rate ?? 1
    const g = ctx.createGain()
    g.gain.value = gain
    src.connect(g).connect(this.sfxBus)
    this.voices++
    src.onended = () => {
      this.voices--
      src.disconnect()
      g.disconnect()
    }
    src.start(opts.at === undefined ? 0 : ctx.currentTime + Math.max(0, (opts.at - performance.now()) / 1000))
  }

  /** 開始環境音：風聲、鳥鳴、遠處頌缽與遠鐘。 */
  startAmbient(): void {
    if (!this.ctx || !this.musicBus) return
    this.stopAmbient()
    this.ambientStarted = true
    void this.applyRunState(1.5)
  }

  stopAmbient(): void {
    this.ambientStarted = false
    this.stopAmbientTimers()
    this.stopWind()
  }

  setIndoor(indoor: boolean): void {
    this.indoor = indoor
  }

  /** 進入背景：淡出後暫停 AudioContext。 */
  async suspend(): Promise<void> {
    this.hidden = true
    await this.applyRunState(0.25)
  }

  /** 回到前景；iOS 來電等中斷後也透過這裡恢復。 */
  async resume(): Promise<void> {
    this.hidden = false
    await this.applyRunState(0.8)
  }

  async dispose(): Promise<void> {
    this.stopAmbient()
    const ctx = this.ctx
    this.ctx = null
    this.buffers.clear()
    this.windBuffer = null
    if (ctx) await ctx.close().catch(() => {})
  }

  private async applyRunState(fadeSeconds: number): Promise<void> {
    const ctx = this.ctx
    if (!ctx || !this.musicBus || !this.sfxBus) return
    const token = ++this.stateToken
    const v = this.volumes
    const { audible, musicOn } = runState(v, this.hidden, this.ambientStarted)

    if (audible) {
      if (ctx.state !== 'running') await ctx.resume().catch(() => {})
      if (token !== this.stateToken) return
      const now = ctx.currentTime
      this.musicBus.gain.setTargetAtTime(v.music, now, 0.1)
      this.sfxBus.gain.setTargetAtTime(v.sfx, now, 0.1)
      this.fadeMaster(v.master, fadeSeconds)
    } else {
      this.fadeMaster(0, fadeSeconds)
    }

    if (musicOn) {
      this.startWind()
      if (!this.birdTimer) this.scheduleBirds()
      if (!this.bowlTimer) this.scheduleDistantBowl()
      if (!this.farBellTimer) this.scheduleFarBell()
    } else {
      this.stopAmbientTimers()
      // 等淡出結束再停止風聲，避免突然中斷。
      setTimeout(() => {
        if (token === this.stateToken) this.stopWind()
      }, fadeSeconds * 1000)
    }

    if (!audible) {
      await new Promise((r) => setTimeout(r, fadeSeconds * 1000 + 50))
      if (token === this.stateToken && ctx.state === 'running') await ctx.suspend().catch(() => {})
    }
  }

  private stopAmbientTimers(): void {
    if (this.birdTimer) clearTimeout(this.birdTimer)
    if (this.bowlTimer) clearTimeout(this.bowlTimer)
    if (this.farBellTimer) clearTimeout(this.farBellTimer)
    this.birdTimer = this.bowlTimer = this.farBellTimer = null
  }

  /** 風聲：循環雜訊 → lowpass → 增益 → 環境音軌；兩個極慢的 LFO 調變增益與截止頻率。 */
  private startWind(): void {
    const ctx = this.ctx
    if (!ctx || !this.musicBus || !this.windBuffer || this.wind) return
    const src = ctx.createBufferSource()
    src.buffer = this.windBuffer
    src.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = WIND_CUTOFF_HZ
    filter.Q.value = 0.7
    const gain = ctx.createGain()
    gain.gain.value = WIND_GAIN
    const modulate = (param: AudioParam, hz: number, depth: number): [AudioScheduledSourceNode, AudioNode[]] => {
      const lfo = ctx.createOscillator()
      lfo.frequency.value = hz
      const amount = ctx.createGain()
      amount.gain.value = depth
      lfo.connect(amount).connect(param)
      return [lfo, [lfo, amount]]
    }
    const [gainLfo, gainNodes] = modulate(gain.gain, WIND_GAIN_LFO_HZ, WIND_GAIN_DEPTH)
    const [cutLfo, cutNodes] = modulate(filter.frequency, WIND_CUTOFF_LFO_HZ, WIND_CUTOFF_DEPTH)
    src.connect(filter).connect(gain).connect(this.musicBus)
    src.start(0, Math.random() * this.windBuffer.duration)
    gainLfo.start()
    cutLfo.start()
    this.wind = { sources: [src, gainLfo, cutLfo], nodes: [src, filter, gain, ...gainNodes, ...cutNodes] }
  }

  private stopWind(): void {
    const wind = this.wind
    if (!wind) return
    this.wind = null
    for (const s of wind.sources) {
      try {
        s.stop()
      } catch {
        // AudioContext 已關閉時忽略。
      }
    }
    for (const n of wind.nodes) n.disconnect()
  }

  /** 每隔 90–210 秒一聲遠處鐘聲。AudioContext 暫停時計時器已被清除，恢復後重新排程，不累積。 */
  private scheduleFarBell(): void {
    this.farBellTimer = setTimeout(() => {
      this.playFarBell()
      this.scheduleFarBell()
    }, nextFarBellDelayMs())
  }

  /** 沿用寺鐘音色，放慢速率、壓暗高頻、音量低，走環境音軌。只在本機播放。 */
  private playFarBell(): void {
    const ctx = this.ctx
    const buffer = this.buffers.get('bell')
    if (!ctx || !buffer || !this.musicBus || ctx.state !== 'running' || this.voices >= MAX_VOICES) return
    if (this.volumes.music <= 0) return
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = FAR_BELL_RATE
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = FAR_BELL_CUTOFF_HZ
    const gain = ctx.createGain()
    gain.gain.value = FAR_BELL_GAIN
    src.connect(filter).connect(gain).connect(this.musicBus)
    this.voices++
    src.onended = () => {
      this.voices--
      for (const n of [src, filter, gain]) n.disconnect()
    }
    src.start()
  }

  /** 每隔數秒隨機一聲鳥叫，偶爾有另一隻鳥回應。 */
  private scheduleBirds(): void {
    this.birdTimer = setTimeout(() => {
      this.playBird()
      if (Math.random() < 0.35) setTimeout(() => this.playBird(), 600 + Math.random() * 1200)
      this.scheduleBirds()
    }, 4_000 + Math.random() * 10_000)
  }

  /** 鳥叫走環境音軌（musicBus），由「環境與音樂」音量控制；左右位置與音高隨機。 */
  private playBird(): void {
    const ctx = this.ctx
    const buffer = this.birdBuffers[Math.floor(Math.random() * this.birdBuffers.length)]
    if (!ctx || !buffer || !this.musicBus || ctx.state !== 'running' || this.voices >= MAX_VOICES) return
    if (this.volumes.music <= 0) return
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = 0.9 + Math.random() * 0.2
    const gain = ctx.createGain()
    gain.gain.value = (0.05 + Math.random() * 0.1) * (this.indoor ? 0.3 : 1)
    const nodes: AudioNode[] = [src, gain]
    let tail: AudioNode = src.connect(gain)
    if (typeof ctx.createStereoPanner === 'function') {
      const pan = ctx.createStereoPanner()
      pan.pan.value = (Math.random() * 2 - 1) * 0.8
      tail = tail.connect(pan)
      nodes.push(pan)
    }
    tail.connect(this.musicBus)
    this.voices++
    src.onended = () => {
      this.voices--
      for (const n of nodes) n.disconnect()
    }
    src.start()
  }

  /** 遠處偶爾傳來的頌缽聲。 */
  private scheduleDistantBowl(): void {
    this.bowlTimer = setTimeout(() => {
      this.play('bowl', { gain: 0.12, rate: 0.85 + Math.random() * 0.3 })
      this.scheduleDistantBowl()
    }, 25_000 + Math.random() * 30_000)
  }

  private fadeMaster(value: number, seconds: number): void {
    const ctx = this.ctx
    if (!ctx || !this.master) return
    const g = this.master.gain
    const now = ctx.currentTime
    g.cancelScheduledValues(now)
    g.setValueAtTime(g.value, now)
    g.linearRampToValueAtTime(value, now + Math.max(0.01, seconds))
  }
}
