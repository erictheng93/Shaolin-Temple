/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// public/basis/ 是 three 附的 Basis 轉碼器副本；升級 three 時需重新複製，否則轉碼器與 KTX2Loader 版本不合。
describe('basis transcoder', () => {
  it.each(['basis_transcoder.js', 'basis_transcoder.wasm'])('%s 與 three 附的版本相同', (name) => {
    const ours = readFileSync(new URL(`../../../public/basis/${name}`, import.meta.url))
    const theirs = readFileSync(new URL(`../../../node_modules/three/examples/jsm/libs/basis/${name}`, import.meta.url))
    expect(ours.equals(theirs)).toBe(true)
  })
})
