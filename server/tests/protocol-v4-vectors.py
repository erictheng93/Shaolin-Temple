# 獨立的第三份實作（Python），用來產生 protocol-v4.json 的 binary 一段（二進位測試向量）。
# 不 import 前端或 Rust 的任何程式；要增修向量時改這個腳本，執行後把輸出貼回固定資料的 "binary"。
# 協定版本 4 只新增 JSON 訊息（hello.session、welcome.auth、rename、name），二進位幀與 v3 完全相同，
# 所以這個腳本的輸出與 v3 相同（只改了檔名）。
# 用法：python server/tests/protocol-v4-vectors.py > binary.json
import json, math, struct, sys
PI = math.pi

# ---- moves／sync（0x01／0x02），格式自協定版本 2 起不變 ----
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
    {'name': '未知幀型 0x04', 'hex': '04' + entry},
    {'name': '未知幀型 0x7b（JSON 的「{」）', 'hex': '7b'},
    {'name': '長度不是 1 + 6N（少 1 byte）', 'hex': '01' + entry[:-2]},
    {'name': '長度不是 1 + 6N（多 1 byte）', 'hex': '02' + entry + '00'},
    {'name': 'x 超出 ±100 公尺（10001 公分）', 'hex': '01' + '00' + struct.pack('<hh', 10001, 0).hex() + '00'},
    {'name': 'z 超出 ±100 公尺（−32768 公分）', 'hex': '02' + '00' + struct.pack('<hh', 0, -32768).hex() + '00'},
    {'name': '201 筆（超過單則上限）', 'hex': '01' + entry * 201},
]

# ---- action（0x03，協定版本 3）----
# 幀 = 0x03, n (u8, 0～127), 動作編號 (u8, CODES 的索引), startedAt mod 2^32 (u32 little-endian)，固定 7 bytes。
CODES = ['bow', 'prostrate', 'chant', 'chant_end', 'incense', 'bell']
WRAP = 2 ** 32
def enc_action(n, action, started_at):
    return bytes([3, n, CODES.index(action)]) + struct.pack('<I', int(math.floor(started_at)) % WRAP)
def unwrap(low, reference):
    ref = math.floor(reference)
    d = (low - ref % WRAP) % WRAP
    if d >= WRAP // 2:
        d -= WRAP
    return ref + d
T = 1794787200000  # 2026-11-16 00:00:00 UTC（毫秒）
K = (T // WRAP + 1) * WRAP  # T 之後第一個 2^32 的倍數，用來測回繞
action_cases = [
    ('合十（bow），n = 0', 0, 'bow', T + 123),
    ('跪拜（prostrate），n = 1', 1, 'prostrate', T + 4567),
    ('誦經（chant），n = 49（50 人房的最大編號）', 49, 'chant', T + 86_400_000),
    ('起身（chant_end），n = 127（7 位元上限），startedAt 剛好是 2^32 的倍數', 127, 'chant_end', K),
    ('上香（incense），startedAt mod 2^32 = 2^32 − 1', 7, 'incense', K - 1),
    ('敲鐘（bell）', 12, 'bell', T + 999),
]
action_valid = []
for name, n, action, started_at in action_cases:
    action_valid.append({
        'name': name,
        'input': {'n': n, 'id': action, 'startedAt': started_at},
        'hex': enc_action(n, action, started_at).hex(),
        'decoded': {'n': n, 'id': action, 'startedAtLow': started_at % WRAP},
    })
good = enc_action(0, 'bow', T).hex()
action_invalid = [
    {'name': '只有幀型', 'hex': '03'},
    {'name': '少 1 byte（6 bytes）', 'hex': good[:-2]},
    {'name': '多 1 byte（8 bytes）', 'hex': good + '00'},
    {'name': 'n 的 bit 7 為 1（128）', 'hex': '0380' + good[4:]},
    {'name': 'n = 255', 'hex': '03ff' + good[4:]},
    {'name': f'未知動作編號 {len(CODES)}（對照表之外）', 'hex': '0300' + bytes([len(CODES)]).hex() + good[6:]},
    {'name': '未知動作編號 255', 'hex': '0300ff' + good[6:]},
]
# 還原絕對 startedAt：取「與參考時間（客戶端估計的伺服器現在時間）距離最近、且 mod 2^32 相同」的值，
# startedAt − 參考時間 落在 [−2^31, 2^31) 毫秒（約 ±24.8 天）內都還原正確。
unwrap_cases = [
    ('80 ms 前開始（一般的轉送延遲）', T + 123, T + 203),
    ('客戶端時鐘估計慢了 30 ms：startedAt 在參考時間之後', T + 123, T + 93),
    ('參考時間非整數毫秒（performance.now 的小數）', T + 123, T + 203.75),
    ('跨過 2^32 回繞：startedAt 在回繞前、參考時間在回繞後', K - 10, K + 50),
    ('跨過 2^32 回繞：startedAt 在回繞後、參考時間在回繞前', K + 5, K - 20),
    ('分頁凍結 10 分鐘後才收到', T, T + 600_000),
    ('延遲 20 天仍正確', T, T + 20 * 86_400_000),
    ('範圍邊界：startedAt 比參考時間早剛好 2^31 ms 仍正確', T, T + WRAP // 2),
]
action_unwrap = []
for name, started_at, reference in unwrap_cases:
    low = started_at % WRAP
    got = unwrap(low, reference)
    assert got == started_at, name
    action_unwrap.append({'name': name, 'low': low, 'reference': reference, 'startedAt': got})
# 範圍外的行為也固定下來：startedAt 比參考時間晚 2^31 ms 時解成早 2^31 ms（真值 − 2^32）。
edge = [
    ('範圍外：startedAt 比參考時間晚剛好 2^31 ms，解成早 2^31 ms', T + WRAP // 2, T),
]
for name, started_at, reference in edge:
    low = started_at % WRAP
    action_unwrap.append({'name': name, 'low': low, 'reference': reference, 'startedAt': unwrap(low, reference)})

sys.stdout.reconfigure(encoding='utf-8')
print(json.dumps({
    'valid': valid,
    'invalid': invalid,
    'action': {'codes': CODES, 'valid': action_valid, 'invalid': action_invalid, 'unwrap': action_unwrap},
}, ensure_ascii=False))
