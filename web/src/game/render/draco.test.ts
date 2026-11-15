/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// public/draco/ 是 three 附的 Draco 解碼器（glTF 版）副本，殿內神像的幾何以 Draco 壓縮；
// 升級 three 時需重新複製，否則解碼器與 DRACOLoader 版本不合。
describe('draco decoder', () => {
  it.each(['draco_decoder.wasm', 'draco_wasm_wrapper.js'])('%s 與 three 附的版本相同', (name) => {
    const ours = readFileSync(new URL(`../../../public/draco/${name}`, import.meta.url))
    const theirs = readFileSync(new URL(`../../../node_modules/three/examples/jsm/libs/draco/gltf/${name}`, import.meta.url))
    expect(ours.equals(theirs)).toBe(true)
  })
})
