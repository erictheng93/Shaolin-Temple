# 獨立的第三份實作（Python），用來產生 protocol-v2.json 的二進位測試向量。
import json, math, struct, sys
PI = math.pi
def rnd(v):  # .5 遠離零
    return math.copysign(math.floor(abs(v) + 0.5), v)
def qc(v):
    cm = rnd(v * 100.0)
    return int(max(-10000, min(10000, cm)))
def qh(h):
    q = rnd(h * 128.0 / PI)
    return int(q % 256)
def dh(q):
    return (q if q <= 128 else q - 256) * (PI / 128.0)
def enc(kind, m):
    out = bytes([1 if kind == 'moves' else 2])
    for n, x, z, h, mv in m:
        out += bytes([n | (0x80 if mv else 0)]) + struct.pack('<hh', qc(x), qc(z)) + bytes([qh(h)])
    return out
def dec_tuple(n, x, z, h, mv):
    return [n, qc(x) / 100.0, qc(z) / 100.0, dh(qh(h)), mv]
cases = [
    ('moves：移動中與停止各一筆', 'moves', [[0, 1.25, -3, 0.5, 1], [1, 0, 0, 0, 0]]),
    ('sync：最大短編號、場地邊界、heading ±π 與 −π/2', 'sync', [[127, 19, -19, PI, 0], [5, 0.125, -0.125, -PI / 2, 1], [9, -7.4, 8.6, -PI, 1]]),
    ('moves：heading 未正規化（6.0、3.13）與四捨五入到格點', 'moves', [[3, 0.004, -0.006, 6.0, 1], [4, 12.34, -18.99, 3.13, 1]]),
    ('sync：空的整批校正（切換到沒有其他人的場景）', 'sync', []),
    ('moves：座標上限 ±100 公尺', 'moves', [[2, 100, -100, 0, 0]]),
    ('moves：超出上限的座標在編碼時夾回 ±100 公尺', 'moves', [[2, 150, -400, 0, 0]]),
]
valid = []
for name, kind, m in cases:
    valid.append({'name': name, 'input': {'t': kind, 'm': m}, 'hex': enc(kind, m).hex(), 'decoded': {'t': kind, 'm': [dec_tuple(*t) for t in m]}})
big = [[i % 128, 1, 2, 0, 1] for i in range(200)]
valid.append({'name': 'moves：200 筆（單則上限）', 'input': {'t': 'moves', 'm': big}, 'hex': enc('moves', big).hex(), 'decoded': {'t': 'moves', 'm': [dec_tuple(*t) for t in big]}})
entry = enc('moves', [[0, 0, 0, 0, 0]])[1:].hex()
invalid = [
    {'name': '空的幀', 'hex': ''},
    {'name': '未知幀型 0x00', 'hex': '00'},
    {'name': '未知幀型 0x03', 'hex': '03' + entry},
    {'name': '未知幀型 0x7b（JSON 的「{」）', 'hex': '7b'},
    {'name': '長度不是 1 + 6N（少 1 byte）', 'hex': '01' + entry[:-2]},
    {'name': '長度不是 1 + 6N（多 1 byte）', 'hex': '02' + entry + '00'},
    {'name': 'x 超出 ±100 公尺（10001 公分）', 'hex': '01' + '00' + struct.pack('<hh', 10001, 0).hex() + '00'},
    {'name': 'z 超出 ±100 公尺（−32768 公分）', 'hex': '02' + '00' + struct.pack('<hh', 0, -32768).hex() + '00'},
    {'name': '201 筆（超過單則上限）', 'hex': '01' + entry * 201},
]
sys.stdout.reconfigure(encoding='utf-8')
print(json.dumps({'valid': valid, 'invalid': invalid}, ensure_ascii=False))
