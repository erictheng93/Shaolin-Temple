# 庭院靜態光照烘焙（Blender Cycles）。由 scripts/bake-lightmaps.mjs 呼叫：
#   blender -b --factory-startup -P scripts/bake-lightmaps.py -- <匯出目錄> <輸出目錄>
# 也可以在已開啟的 Blender（例如經 MCP）執行：先設定 BAKE_ARGS = [<匯出目錄>, <輸出目錄>] 再 exec 這個檔案；
# 它會建立獨立的 scene，不動到原本的場景。
#
# 輸入：<匯出目錄>/courtyard.json（manifest）與 courtyard.bin（Float32），由 courtyardBake.ts 的 exportCourtyardBake() 產生。
# 輸出：courtyard_{atlas,ground}_{1k,512}.png（RGBA 8 位元、線性）：RGB = AO，A = 太陽可見度。
# PNG 的第一列是 uv1 的 v = 0（即 Blender 影像的最底列），與 three 載入 KTX2（flipY = false）的取樣方向一致。
import json
import math
import os
import struct
import sys
import time
import zlib

import bpy
import numpy as np
from mathutils import Vector


def parse_args():
    if 'BAKE_ARGS' in globals():
        return globals()['BAKE_ARGS']
    argv = sys.argv
    return argv[argv.index('--') + 1:] if '--' in argv else []


def write_png(path, rgba):
    """rgba：H×W×4 的 uint8，依陣列順序寫列（不做任何色彩管理）。"""
    h, w, _ = rgba.shape
    raw = b''.join(b'\x00' + rgba[y].tobytes() for y in range(h))

    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def to_blender(a):
    """three（y 朝上）→ Blender（z 朝上）：(x, y, z) → (x, -z, y)，行列式為 +1，三角形繞向不變。"""
    return np.stack([a[:, 0], -a[:, 2], a[:, 1]], axis=1)


def main():
    src, out = parse_args()[:2]
    with open(os.path.join(src, 'courtyard.json'), encoding='utf-8') as f:
        manifest = json.load(f)
    data = np.fromfile(os.path.join(src, 'courtyard.bin'), dtype='<f4')
    s = manifest['settings']
    size = int(s['atlasSize'])
    pad = int(manifest['padding'])

    scene = bpy.data.scenes.new('CourtyardBake')
    if bpy.context.window is not None:
        bpy.context.window.scene = scene
    view_layer = scene.view_layers[0]
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.use_denoising = False
    world = bpy.data.worlds.new('CourtyardBakeWorld')
    # 新 world 預設以節點發出 0.05 的灰色環境光，會被算進 DIFFUSE 的直接光（全影處不為 0），所以關掉
    world.use_nodes = True
    for node in world.node_tree.nodes:
        if node.type == 'BACKGROUND':
            node.inputs['Strength'].default_value = 0
    world.light_settings.distance = s['aoDistance']
    scene.world = world

    images = {}
    materials = {}
    for kind in ('atlas', 'ground'):
        img = bpy.data.images.new(f'lm_{kind}', size, size, alpha=True, float_buffer=True)
        img.colorspace_settings.name = 'Non-Color'
        images[kind] = img
        mat = bpy.data.materials.new(f'lm_{kind}')
        mat.use_nodes = True
        node = mat.node_tree.nodes.new('ShaderNodeTexImage')
        node.image = img
        mat.node_tree.nodes.active = node
        materials[kind] = mat
    materials['occluder'] = bpy.data.materials.new('lm_occluder')

    receivers = []
    for o in manifest['objects']:
        n = o['vertexCount']
        at = o['offset']
        pos = data[at:at + n * 3].reshape(-1, 3)
        nor = data[at + n * 3:at + n * 6].reshape(-1, 3)
        me = bpy.data.meshes.new(o['name'])
        me.vertices.add(n)
        me.vertices.foreach_set('co', to_blender(pos).ravel())
        me.loops.add(n)
        me.loops.foreach_set('vertex_index', np.arange(n, dtype=np.int32))
        me.polygons.add(n // 3)
        me.polygons.foreach_set('loop_start', np.arange(0, n, 3, dtype=np.int32))
        me.polygons.foreach_set('loop_total', np.full(n // 3, 3, dtype=np.int32))
        me.update(calc_edges=True)
        if o['role'] != 'occluder':
            uv = data[at + n * 6:at + n * 8]
            # 每個三角形的頂點不共用，loop i 就是頂點 i，uv1 逐頂點對應
            me.uv_layers.new(name='lightmap').data.foreach_set('uv', uv)
        me.shade_smooth()
        me.normals_split_custom_set_from_vertices([tuple(v) for v in to_blender(nor)])
        me.materials.append(materials[o['role']])
        ob = bpy.data.objects.new(o['name'], me)
        scene.collection.objects.link(ob)
        if o['role'] != 'occluder':
            receivers.append(ob)

    sun_dir = Vector(to_blender(np.array([manifest['sunDirection']]))[0])
    light = bpy.data.lights.new('sun', 'SUN')
    light.angle = math.radians(s['sunAngleDeg'])
    light.energy = 3
    sun = bpy.data.objects.new('sun', light)
    # 平行光沿物件的 -Z 照射：把 +Z 對準太陽方向
    sun.rotation_mode = 'QUATERNION'
    sun.rotation_quaternion = sun_dir.to_track_quat('Z', 'Y')
    scene.collection.objects.link(sun)

    for ob in scene.objects:
        ob.select_set(False)
    for ob in receivers:
        ob.select_set(True)
    view_layer.objects.active = receivers[0]

    bake = scene.render.bake
    bake.margin = pad
    bake.margin_type = 'EXTEND'
    bake.use_clear = False
    # 太陽可見度：兩次只含直接光的 DIFFUSE 相除——有影子的照度 ÷ 所有物件都不投影時的照度，
    # N·L 與光強度消去，只剩可見度（SHADOW 烘焙類型不保證是純可見度，不使用）。
    def bake_pass(pass_type, samples, **kw):
        for img in images.values():
            # 未烘焙到的 texel（chart 之間的空隙）維持全亮，mipmap 混到時偏亮而不是發黑
            img.pixels.foreach_set(np.ones(size * size * 4, dtype=np.float32))
        scene.cycles.samples = samples
        t0 = time.time()
        bpy.ops.object.bake(type=pass_type, margin=pad, margin_type='EXTEND', use_clear=False, **kw)
        print(f'{pass_type} {kw}: {time.time() - t0:.1f} s')
        res = {}
        for kind, img in images.items():
            px = np.empty(size * size * 4, dtype=np.float32)
            img.pixels.foreach_get(px)
            res[kind] = px.reshape(size, size, 4)[:, :, 0].copy()
        return res

    ao = bake_pass('AO', s['aoSamples'])
    direct = {'pass_filter': {'DIRECT'}}
    lit = bake_pass('DIFFUSE', s['shadowSamples'], **direct)
    for ob in scene.objects:
        ob.visible_shadow = False
    unshadowed = bake_pass('DIFFUSE', s['shadowSamples'], **direct)
    for ob in scene.objects:
        ob.visible_shadow = True
    result = {}
    for kind in images:
        result[('AO', kind)] = ao[kind]
        # 背光面（N·L≈0）的可見度沒有意義，設為 1（執行時那裡本來就沒有直接光）
        base = unshadowed[kind]
        result[('SHADOW', kind)] = np.where(base > 1e-3, lit[kind] / np.maximum(base, 1e-3), 1.0)

    os.makedirs(out, exist_ok=True)
    for kind in images:
        ao = np.clip(result[('AO', kind)], 0, 1)
        vis = np.clip(result[('SHADOW', kind)], 0, 1)
        rgba = np.stack([ao, ao, ao, vis], axis=2)
        for label, img in (('1k', rgba), ('512', rgba.reshape(size // 2, 2, size // 2, 2, 4).mean(axis=(1, 3)))):
            path = os.path.join(out, f'courtyard_{kind}_{label}.png')
            write_png(path, np.round(img * 255).astype(np.uint8))
            print('wrote', path)


main()
