"""Diagnose bat.glb in Blender: print evaluated vertex bounds and try to render."""
import bpy
import sys
import math
import mathutils

src = sys.argv[sys.argv.index("--") + 1]

bpy.ops.wm.read_factory_settings(use_empty=True)
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

bpy.ops.import_scene.gltf(filepath=src)
for o in list(bpy.context.scene.objects):
    if o.type == 'MESH' and o.name not in ('Object_7',) and 'bat' not in o.name.lower():
        print("remove", o.name)
        bpy.data.objects.remove(o, do_unlink=True)

print("objects:", [(o.name, o.type, tuple(o.location), tuple(o.scale)) for o in bpy.context.scene.objects])

deps = bpy.context.evaluated_depsgraph_get()
for o in bpy.context.scene.objects:
    if o.type != 'MESH':
        continue
    ev = o.evaluated_get(deps)
    me = ev.to_mesh()
    min_v = mathutils.Vector((1e9, 1e9, 1e9))
    max_v = mathutils.Vector((-1e9, -1e9, -1e9))
    for v in me.vertices:
        w = ev.matrix_world @ v.co
        min_v = mathutils.Vector((min(min_v.x, w.x), min(min_v.y, w.y), min(min_v.z, w.z)))
        max_v = mathutils.Vector((max(max_v.x, w.x), max(max_v.y, w.y), max(max_v.z, w.z)))
    print("EVAL mesh", o.name, "verts", len(me.vertices), "min", min_v, "max", max_v, "size", max_v - min_v)
    # Also raw (unevaluated)
    min_r = mathutils.Vector((1e9, 1e9, 1e9))
    max_r = mathutils.Vector((-1e9, -1e9, -1e9))
    for v in o.data.vertices:
        w = o.matrix_world @ v.co
        min_r = mathutils.Vector((min(min_r.x, w.x), min(min_r.y, w.y), min(min_r.z, w.z)))
        max_r = mathutils.Vector((max(max_r.x, w.x), max(max_r.y, w.y), max(max_r.z, w.z)))
    print("RAW  mesh", o.name, "min", min_r, "max", max_r, "size", max_r - min_r)
    ev.to_mesh_clear()
    print("modifiers", [m.type for m in o.modifiers])
    print("parents", o.parent, "armature", o.find_armature())

# Armature bones
for o in bpy.context.scene.objects:
    if o.type != 'ARMATURE':
        continue
    print("ARM", o.name, "bones", len(o.data.bones))
    for b in o.data.bones:
        print("  bone", b.name, "head", b.head_local, "tail", b.tail_local)

# Frame camera on evaluated bounds of Object_7
mesh = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
ev = mesh.evaluated_get(deps)
me = ev.to_mesh()
min_v = mathutils.Vector((1e9, 1e9, 1e9))
max_v = mathutils.Vector((-1e9, -1e9, -1e9))
for v in me.vertices:
    w = ev.matrix_world @ v.co
    min_v = mathutils.Vector((min(min_v.x, w.x), min(min_v.y, w.y), min(min_v.z, w.z)))
    max_v = mathutils.Vector((max(max_v.x, w.x), max(max_v.y, w.y), max(max_v.z, w.z)))
center = (min_v + max_v) * 0.5
size = max_v - min_v
ev.to_mesh_clear()
dist = max(size.length, 0.01) * 2.5
bpy.ops.object.camera_add(location=(center.x + dist, center.y - dist, center.z + dist * 0.5))
cam = bpy.context.active_object
direction = center - cam.location
cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
bpy.context.scene.camera = cam
bpy.ops.object.light_add(type='SUN', location=center + mathutils.Vector((2, 2, 5)))

scene = bpy.context.scene
scene.render.resolution_x = 800
scene.render.resolution_y = 600
scene.render.filepath = r"c:\Users\araf\Downloads\bat-diag.png"
bpy.ops.render.render(write_still=True)
print("WROTE diag", scene.render.filepath, "lookat", center, "size", size)
