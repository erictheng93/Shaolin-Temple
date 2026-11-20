# 獨立的第三份實作（Python），用來產生 protocol-v5.json 的 binary 一段（二進位測試向量）。
# 不 import 前端或 Rust 的任何程式；要增修向量時改這個腳本，執行後把輸出貼回固定資料的 "binary"。
# 協定版本 5 新增 cars 幀（0x04），原本未知的 0x04 標籤改成 0x05。
# 用法：python server/tests/protocol-v5-vectors.py > binary.json
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
    {'name': '未知幀型 0x05', 'hex': '05' + entry},
    {'name': '未知幀型 0x7b（JSON 的「{」）', 'hex': '7b'},
    {'name': '長度不是 1 + 6N（少 1 byte）', 'hex': '01' + entry[:-2]},
    {'name': '長度不是 1 + 6N（多 1 byte）', 'hex': '02' + entry + '00'},
    {'name': 'x 超出 ±100 公尺（10001 公分）', 'hex': '01' + '00' + struct.pack('<hh', 10001, 0).hex() + '00'},
    {'name': 'z 超出 ±100 公尺（−32768 公分）', 'hex': '02' + '00' + struct.pack('<hh', 0, -32768).hex() + '00'},
    {'name': '201 筆（超過單則上限）', 'hex': '01' + entry * 201},
]

# ---- action（0x03，協定版本 3）----
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
edge = [
    ('範圍外：startedAt 比參考時間晚剛好 2^31 ms，解成早 2^31 ms', T + WRAP // 2, T),
]
for name, started_at, reference in edge:
    low = started_at % WRAP
    action_unwrap.append({'name': name, 'low': low, 'reference': reference, 'startedAt': unwrap(low, reference)})

# ---- cars（0x04，協定版本 5）----
def q_heading(h):
    q = int(rnd(h * 32768.0 / PI))
    return ((q + 32768) % 65536) - 32768
def d_heading(q):
    return q * PI / 32768.0
def q_vel(v):
    cm = rnd(v * 100.0)
    return int(max(-3000, min(3000, cm)))
def q_angvel(w):
    val = rnd(w * 16.0)
    return int(max(-127, min(127, val)))

def enc_cars(ack, cars):
    out = bytes([4]) + struct.pack('<H', ack)
    for car in cars:
        c = car['c']
        occ = 1 if car['occupied'] else 0
        bump = 1 if car['bumped'] else 0
        flags = (c & 0x0F) | (occ << 4) | (bump << 5)
        hx = qc(car['x'])
        hz = qc(car['z'])
        hh = q_heading(car['heading'])
        hvx = q_vel(car['vx'])
        hvz = q_vel(car['vz'])
        hw = q_angvel(car['w'])
        out += bytes([flags]) + struct.pack('<hhhhhb', hx, hz, hh, hvx, hvz, hw)
    return out

def dec_car(car):
    return {
        'c': car['c'],
        'occupied': car['occupied'],
        'bumped': car['bumped'],
        'x': qc(car['x']) / 100.0,
        'z': qc(car['z']) / 100.0,
        'heading': d_heading(q_heading(car['heading'])),
        'vx': q_vel(car['vx']) / 100.0,
        'vz': q_vel(car['vz']) / 100.0,
        'w': q_angvel(car['w']) / 16.0,
    }

cars_cases = [
    ('空幀（ack = 0）', 0, []),
    ('一台車：c=3, occupied, x=1.25, z=-3, heading=π/2, vx=8, vz=-2.5, w=1.5, ack=65535', 65535, [
        {'c': 3, 'occupied': True, 'bumped': False, 'x': 1.25, 'z': -3.0, 'heading': PI / 2.0, 'vx': 8.0, 'vz': -2.5, 'w': 1.5}
    ]),
    ('朝向 π（須編成 -32768）', 100, [
        {'c': 0, 'occupied': False, 'bumped': True, 'x': 0.0, 'z': 0.0, 'heading': PI, 'vx': 0.0, 'vz': 0.0, 'w': 0.0}
    ]),
    ('16 台車（滿員狀態）', 1234, [
        {
            'c': i,
            'occupied': (i % 2 == 1),
            'bumped': (i % 3 == 0),
            'x': (i - 8) * 1.0,
            'z': (i - 8) * 1.0,
            'heading': (i - 8) * PI / 8.0,
            'vx': (i - 8) * 1.5,
            'vz': -(i - 8) * 1.5,
            'w': (i - 8) * 0.5,
        } for i in range(16)
    ]),
    ('速度與角速度夾限', 42, [
        {'c': 7, 'occupied': True, 'bumped': False, 'x': 150.0, 'z': -200.0, 'heading': 0.0, 'vx': 50.0, 'vz': -60.0, 'w': 20.0}
    ]),
]

cars_valid = []
for name, ack, clist in cars_cases:
    cars_valid.append({
        'name': name,
        'input': {'ack': ack, 'cars': clist},
        'hex': enc_cars(ack, clist).hex(),
        'decoded': {'ack': ack, 'cars': [dec_car(c) for c in clist]},
    })

single_car_bytes = enc_cars(0, [{'c': 0, 'occupied': False, 'bumped': False, 'x': 0.0, 'z': 0.0, 'heading': 0.0, 'vx': 0.0, 'vz': 0.0, 'w': 0.0}])[3:]
cars_invalid = [
    {'name': '長度 4（不是 3 + 12N）', 'hex': '04000000'},
    {'name': '17 台車（超過 16 台上限）', 'hex': enc_cars(0, [{'c': i % 16, 'occupied': False, 'bumped': False, 'x': 0.0, 'z': 0.0, 'heading': 0.0, 'vx': 0.0, 'vz': 0.0, 'w': 0.0} for i in range(17)]).hex()},
    {'name': '保留位元 bit 6 為 1', 'hex': '040000' + bytes([0x40]).hex() + single_car_bytes[1:].hex()},
    {'name': '保留位元 bit 7 為 1', 'hex': '040000' + bytes([0x80]).hex() + single_car_bytes[1:].hex()},
    {'name': 'x 超出 ±100 公尺（10001 公分）', 'hex': '040000' + '00' + struct.pack('<hh', 10001, 0).hex() + single_car_bytes[5:].hex()},
    {'name': 'z 超出 ±100 公尺（−32768 公分）', 'hex': '040000' + '00' + struct.pack('<hh', 0, -32768).hex() + single_car_bytes[5:].hex()},
    {'name': '同一幀內 c 重複', 'hex': enc_cars(0, [
        {'c': 2, 'occupied': False, 'bumped': False, 'x': 0.0, 'z': 0.0, 'heading': 0.0, 'vx': 0.0, 'vz': 0.0, 'w': 0.0},
        {'c': 2, 'occupied': True, 'bumped': False, 'x': 1.0, 'z': 1.0, 'heading': 0.0, 'vx': 0.0, 'vz': 0.0, 'w': 0.0},
    ]).hex()},
]

sys.stdout.reconfigure(encoding='utf-8')
print(json.dumps({
    'valid': valid,
    'invalid': invalid,
    'action': {'codes': CODES, 'valid': action_valid, 'invalid': action_invalid, 'unwrap': action_unwrap},
    'cars': {'valid': cars_valid, 'invalid': cars_invalid},
}, ensure_ascii=False))
