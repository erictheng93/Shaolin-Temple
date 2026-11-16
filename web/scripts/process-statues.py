# 殿內神像的處理流程（Blender 5.3、Cycles）：寫實模型原檔 → 減面的遊戲模型＋重新烘焙的貼圖。
# 由 scripts/process-statues.mjs 呼叫，一次處理一尊（佛像原檔 345 MB，同時開會吃光記憶體）：
#   blender -b --factory-startup -P scripts/process-statues.py -- <id> <原檔.glb> <assets 輸出目錄> <public 輸出目錄>
#
# 原檔（不提交）：web/.statues-src/<id>/*.glb，來源與授權見 docs/ASSETS.md。
# 輸出（每尊兩個層級 tier：std＝標準畫質、hi＝高畫質）：
#   <assets>/<id>_<tier>_diff.png  底色（sRGB），由原貼圖烘焙到新的 UV
#   <assets>/<id>_<tier>_nor.png   切線空間法線（OpenGL，+Y 朝上），由原始高模（含其法線貼圖）烘焙
#   <public>/<id>_<tier>.glb       只有幾何（位置、法線、切線、UV），Draco 壓縮，不含材質與貼圖
# PNG 之後由 build-textures.mjs statues 編碼成 KTX2。
#
# 只做不改變造型的處理：對齊朝向、原點與高度、合併重複頂點、刪除掃描殘留的細小碎片、減面、重新展 UV、烘焙。
# 模型規格：原點在底面中心、Y 軸朝上、正面朝 +z（glTF）；高度正規化為 1，遊戲端依 STATUE_HEIGHT 等比縮放。
import math
import os
import sys
import time

import bmesh
import bpy
from mathutils import Matrix, Vector

# 每尊的設定：
#   rot_z    匯入後繞 Blender 的 Z 軸轉幾度，讓正面朝 Blender 的 -Y（＝ glTF 的 +z）。
#   tiers    各層級的目標三角形數與貼圖邊長。
#   min_part 小於整體三角形數這個比例的獨立碎片視為掃描殘留，刪除（只刪很小的，持物等正式部件遠大於此）。
#   focus    臉（與手）所在的球形範圍 (中心, 半徑)，正規化後的 Blender 座標（z 朝上、正面 -Y、高 1）。
#            這些面另外展 UV，貼圖密度是其他部分的 FOCUS_SCALE 倍，臉在貼圖中分到較多像素（不影響幾何）。
STATUES = {
    'buddha': {
        'rot_z': 0,
        'tiers': {'std': (15000, 1024), 'hi': (40000, 2048)},
        'min_part': 0.0005,
        # 頭（背光在 y ≈ 0.19 之後，不含）、舉起的右手（施無畏印）、放在膝上的左手
        'focus': [((0, 0.08, 0.79), 0.1), ((-0.095, -0.065, 0.62), 0.06), ((0.09, -0.15, 0.43), 0.05)],
    },
    'guanyin': {
        'rot_z': -90,
        'tiers': {'std': (15000, 1024), 'hi': (40000, 2048)},
        'min_part': 0.0005,
        'focus': [((0.01, 0.06, 0.86), 0.1)],
    },
    'mazu': {
        'rot_z': 0,
        'tiers': {'std': (15000, 1024), 'hi': (40000, 2048)},
        'min_part': 0.0005,
        # 頭與鳳冠（臉大半被冕旒遮住，五官是黑漆面上的淺浮雕）
        'focus': [((0, 0.0, 0.85), 0.13)],
    },
}
FOCUS_SCALE = 2.0

# 可由環境變數覆寫（調整面數時用），例如 STATUE_TIERS="std:20000:1024,hi:40000:2048"
if os.environ.get('STATUE_TIERS'):
    override = {}
    for item in os.environ['STATUE_TIERS'].split(','):
        name, tris, size = item.split(':')
        override[name] = (int(tris), int(size))
    for cfg in STATUES.values():
        cfg['tiers'] = {**cfg['tiers'], **override}
ONLY_TIERS = os.environ.get('STATUE_ONLY')  # 例如 "std" 只做標準畫質


def log(*a):
    print('[statues]', *a, flush=True)


def parse_args():
    if 'STATUE_ARGS' in globals():
        return globals()['STATUE_ARGS']
    argv = sys.argv
    return argv[argv.index('--') + 1:] if '--' in argv else []


def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == 'MESH']


def select_only(objs, active=None):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or objs[0]


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def import_source(path, rot_z):
    """匯入原檔、套用所有變換、合併成一個物件（保留原材質），朝向轉正、高度正規化為 1、原點放在底面中心。"""
    bpy.ops.import_scene.gltf(filepath=path)
    objs = mesh_objects()
    select_only(objs)
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    for o in list(bpy.context.scene.objects):
        if o.type != 'MESH':
            bpy.data.objects.remove(o)
    objs = mesh_objects()
    select_only(objs)
    bpy.ops.object.join()
    hi = bpy.context.view_layer.objects.active
    hi.name = 'high'
    hi.data.transform(Matrix.Rotation(math.radians(rot_z), 4, 'Z') @ hi.matrix_world)
    hi.matrix_world = Matrix.Identity(4)
    co = [v.co for v in hi.data.vertices]
    mn = Vector([min(c[i] for c in co) for i in range(3)])
    mx = Vector([max(c[i] for c in co) for i in range(3)])
    height = mx.z - mn.z
    # 原點：x、y 取外框中心，z 取底面
    hi.data.transform(Matrix.Scale(1 / height, 4) @ Matrix.Translation(Vector(((mn.x + mx.x) / -2, (mn.y + mx.y) / -2, -mn.z))))
    hi.data.update()
    log('high', tri_count(hi), 'tris; source height', round(height, 4), 'dims', [round((mx[i] - mn[i]) / height, 3) for i in range(3)])
    return hi


def clean_low(obj, min_part):
    """合併重複頂點（有些掃描每個三角形各自獨立）、刪除細小的獨立碎片。回傳刪掉的碎片數。"""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.faces.ensure_lookup_table()
    total = len(bm.faces)
    seen = set()
    parts = []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack = [f]
        comp = []
        seen.add(f.index)
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for e in cur.edges:
                for nf in e.link_faces:
                    if nf.index not in seen:
                        seen.add(nf.index)
                        stack.append(nf)
        parts.append(comp)
    parts.sort(key=len, reverse=True)
    small = [p for p in parts if len(p) < total * min_part]
    log('parts', len(parts), 'largest', [len(p) for p in parts[:8]], 'removing', len(small), 'small parts with', sum(len(p) for p in small), 'faces')
    bmesh.ops.delete(bm, geom=[f for p in small for f in p], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(obj.data)
    bm.free()
    return len(small)


def make_low(hi, target, min_part):
    low = hi.copy()
    low.data = hi.data.copy()
    low.name = 'low'
    bpy.context.scene.collection.objects.link(low)
    low.data.materials.clear()
    while low.data.uv_layers:
        low.data.uv_layers.remove(low.data.uv_layers[0])
    for a in [a.name for a in low.data.attributes if not a.name.startswith('.') and a.name not in ('position', 'sharp_face')]:
        if a in low.data.attributes and a != 'position':
            try:
                low.data.attributes.remove(low.data.attributes[a])
            except RuntimeError:
                pass
    clean_low(low, min_part)
    select_only([low])
    tris = tri_count(low)
    mod = low.modifiers.new('decimate', 'DECIMATE')
    mod.decimate_type = 'COLLAPSE'
    mod.ratio = min(1.0, target / tris)
    mod.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.object.shade_smooth()
    log('low', tris, '->', tri_count(low), 'tris')
    return low


def uv_density(bm, uv, faces):
    """UV 面積 / 3D 面積。"""
    area3 = sum(f.calc_area() for f in faces)
    area2 = 0.0
    for f in faces:
        pts = [l[uv].uv for l in f.loops]
        area2 += abs(sum(pts[i].x * pts[i - 1].y - pts[i - 1].x * pts[i].y for i in range(len(pts)))) / 2
    return area2 / max(area3, 1e-12)


def unwrap(low, size, focus):
    """Smart UV Project。focus 範圍內的面另外展開，統一密度後放大 FOCUS_SCALE 倍，再一起排列。"""
    select_only([low])
    margin = 4 / size
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_mode(type='FACE')
    bm = bmesh.from_edit_mesh(low.data)
    centers = [(Vector(c), r) for c, r in (focus or [])]
    in_focus = {f.index for f in bm.faces if any((f.calc_center_median() - c).length <= r for c, r in centers)}
    groups = [in_focus, {f.index for f in bm.faces} - in_focus] if in_focus else [{f.index for f in bm.faces}]
    for group in groups:
        for f in bm.faces:
            f.select = f.index in group
        bmesh.update_edit_mesh(low.data)
        bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=margin, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
        bm = bmesh.from_edit_mesh(low.data)
    if in_focus:
        bm.faces.ensure_lookup_table()
        uv = bm.loops.layers.uv.verify()
        sets = [[bm.faces[i] for i in g] for g in groups]
        base = uv_density(bm, uv, sets[1])
        k = math.sqrt(base / uv_density(bm, uv, sets[0])) * FOCUS_SCALE
        for f in sets[0]:
            for l in f.loops:
                l[uv].uv *= k
        log('focus', len(in_focus), 'faces, uv scale', round(k, 3))
        bmesh.update_edit_mesh(low.data)
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(rotate=True, margin=margin, scale=True)
    bpy.ops.object.mode_set(mode='OBJECT')


def emission_setup(hi):
    """把高模每個材質的底色接到 Emission，以 EMIT 烘焙取得純底色（不受金屬度與打光影響）。回傳還原函式。"""
    restore = []
    for mat in hi.data.materials:
        if not mat or not mat.use_nodes:
            continue
        nt = mat.node_tree
        out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output)
        bsdf = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        old = out.inputs['Surface'].links[0].from_socket if out.inputs['Surface'].links else None
        em = nt.nodes.new('ShaderNodeEmission')
        base = bsdf.inputs['Base Color'] if bsdf else None
        if base is not None and base.links:
            nt.links.new(base.links[0].from_socket, em.inputs['Color'])
        elif base is not None:
            em.inputs['Color'].default_value = base.default_value
        nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
        restore.append((nt, out, old, em))

    def undo():
        for nt, out, old, em in restore:
            nt.nodes.remove(em)
            if old is not None:
                nt.links.new(old, out.inputs['Surface'])
    return undo


def bake(hi, low, kind, size, path):
    img = bpy.data.images.new(f'{low.name}_{kind}', size, size, alpha=False, float_buffer=False)
    img.colorspace_settings.name = 'sRGB' if kind == 'diff' else 'Non-Color'
    img.generated_color = (0.5, 0.5, 1.0, 1.0) if kind == 'nor' else (0, 0, 0, 1)
    mat = bpy.data.materials.new(f'bake_{kind}')
    mat.use_nodes = True
    node = mat.node_tree.nodes.new('ShaderNodeTexImage')
    node.image = img
    mat.node_tree.nodes.active = node
    low.data.materials.clear()
    low.data.materials.append(mat)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 16 if kind == 'diff' else 8
    bk = sc.render.bake
    bk.use_selected_to_active = True
    bk.use_cage = False
    bk.cage_extrusion = 0.01
    bk.max_ray_distance = 0.04
    bk.margin = 16
    bk.margin_type = 'EXTEND'
    bk.target = 'IMAGE_TEXTURES'
    select_only([hi, low], active=low)
    t = time.time()
    if kind == 'diff':
        undo = emission_setup(hi)
        bpy.ops.object.bake(type='EMIT')
        undo()
    else:
        bk.normal_space = 'TANGENT'
        bpy.ops.object.bake(type='NORMAL')
    log('bake', kind, size, round(time.time() - t, 1), 's')
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    low.data.materials.clear()
    bpy.data.materials.remove(mat)
    bpy.data.images.remove(img)


def export_glb(low, path):
    select_only([low])
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_materials='NONE',
        export_texcoords=True,
        export_normals=True,
        export_tangents=True,
        export_attributes=False,
        export_extras=False,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=7,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=12,
        export_draco_generic_quantization=10,
    )
    log('export', path, os.path.getsize(path), 'bytes')


def setup_cycles():
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for kind in ('OPTIX', 'CUDA', 'HIP', 'METAL', 'ONEAPI'):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            gpus = [d for d in prefs.devices if d.type == kind]
            if gpus:
                for d in prefs.devices:
                    d.use = d.type == kind
                sc.cycles.device = 'GPU'
                log('cycles device', kind, [d.name for d in gpus])
                return
        except TypeError:
            continue
    sc.cycles.device = 'CPU'
    log('cycles device CPU')


def main():
    sid, src, assets, public = parse_args()[:4]
    cfg = STATUES[sid]
    os.makedirs(assets, exist_ok=True)
    os.makedirs(public, exist_ok=True)
    if not bpy.app.background:
        # 在已開啟的 Blender（例如經 MCP）執行：建立獨立的 scene，不動到原本的場景
        bpy.context.window.scene = bpy.data.scenes.new(f'statue_{sid}')
    else:
        # 背景模式（-b --factory-startup）：切換 scene 不一定生效（匯出器仍讀預設場景的選取），
        # 直接清掉預設場景的方塊、相機與燈
        for o in list(bpy.data.objects):
            bpy.data.objects.remove(o)
    setup_cycles()
    t0 = time.time()
    hi = import_source(src, cfg['rot_z'])
    for tier, (target, size) in cfg['tiers'].items():
        if ONLY_TIERS and tier not in ONLY_TIERS.split(','):
            continue
        low = make_low(hi, target, cfg['min_part'])
        low.name = f'{sid}_{tier}'
        unwrap(low, size, cfg['focus'])
        bake(hi, low, 'diff', size, os.path.join(assets, f'{sid}_{tier}_diff.png'))
        bake(hi, low, 'nor', size, os.path.join(assets, f'{sid}_{tier}_nor.png'))
        export_glb(low, os.path.join(public, f'{sid}_{tier}.glb'))
        if not os.environ.get('STATUE_KEEP'):
            bpy.data.objects.remove(low)
    log('done', sid, round(time.time() - t0, 1), 's')


main()
