/** 效能資訊面板的本機座標（開發除錯用）：場景 id 與場景內座標（公尺），不是經緯度。 */
export interface DebugPosition {
  zone: string
  /** 四捨五入到 0.1 公尺。 */
  x: number
  z: number
  /** 面向，度（0～359 的整數）。 */
  heading: number
}

const round1 = (v: number) => {
  const r = Math.round(v * 10) / 10
  return r === 0 ? 0 : r // 避免 -0 顯示成 "-0.0"
}

/** 取整後的座標：放進 UiState 前先取整，數值沒變時 JSON 比對相同，不會多推送。 */
export function debugPosition(zone: string, x: number, z: number, headingRad: number): DebugPosition {
  const deg = Math.round((headingRad * 180) / Math.PI) % 360
  return { zone, x: round1(x), z: round1(z), heading: deg < 0 ? deg + 360 : deg }
}

/** 等寬排版：數值靠右補空白，走動時欄位不左右跳動（例：`courtyard x   3.2 z -11.5  90°`）。 */
export function formatPosition(p: DebugPosition): string {
  return `${p.zone} x ${p.x.toFixed(1).padStart(5)} z ${p.z.toFixed(1).padStart(5)} ${String(p.heading).padStart(3)}°`
}
