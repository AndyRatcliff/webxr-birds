"""
Clean Sketchfab bat for Blender editing:
- scale skinned model to size 1 at origin
- keep skinning/actions intact (do NOT edit bone rest lengths)
- remove NOTHING action + stray meshes
- save .blend and a rest-pose preview PNG
"""
import bpy
import sys
import mathutils

argv = sys.argv[sys.argv.index("--") + 1:]
src, blend, preview = argv[0], argv[1], argv[2]

bpy.ops.wm.read_factory_settings(use_empty=True)
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

bpy.ops.import_scene.gltf(filepath=src)
for o in list(bpy.context.scene.objects):
    if o.type == 'MESH' and o.name != 'Object_7':
        bpy.data.objects.remove(o, do_unlink=True)

mesh = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
arm = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
root = bpy.data.objects['Sketchfab_model']

# Clear any auto-assigned action so we see rest pose
if arm.animation_data:
    arm.animation_data.action = None

def eval_bounds():
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    ev = mesh.evaluated_get(deps)
    me = ev.to_mesh()
    min_v = mathutils.Vector((1e9, 1e9, 1e9))
    max_v = mathutils.Vector((-1e9, -1e9, -1e9))
    for v in me.vertices:
        w = ev.matrix_world @ v.co
        min_v = mathutils.Vector((min(min_v.x, w.x), min(min_v.y, w.y), min(min_v.z, w.z)))
        max_v = mathutils.Vector((max(max_v.x, w.x), max(max_v.y, w.y), max(max_v.z, w.z)))
    ev.to_mesh_clear()
    return min_v, max_v

min_v, max_v = eval_bounds()
size = max_v - min_v
center = (min_v + max_v) * 0.5
norm = 1.0 / max(size.x, size.y, size.z)
root.scale *= norm
root.location -= center * norm
min_v, max_v = eval_bounds()
print("normalized center", (min_v + max_v) * 0.5, "size", max_v - min_v)

if 'NOTHING' in bpy.data.actions:
    bpy.data.actions.remove(bpy.data.actions['NOTHING'])

# Hide the absurdly long bone shapes in viewport without changing rest pose:
# use bone display as sticks / octahedral with custom lengths via viewport only.
arm.data.display_type = 'STICK'
for b in arm.pose.bones:
    b.custom_shape_scale_xyz = (0.05, 0.05, 0.05)

# Preview render
center = (min_v + max_v) * 0.5
size = max_v - min_v
dist = max(size.length, 0.2) * 2.2
bpy.ops.object.camera_add(location=(center.x + dist, center.y - dist, center.z + dist * 0.45))
cam = bpy.context.active_object
cam.data.clip_start = 0.001
cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
bpy.context.scene.camera = cam
bpy.ops.object.light_add(type='SUN', location=center + mathutils.Vector((2, 2, 5)))
bpy.context.object.data.energy = 3
scene = bpy.context.scene
if not scene.world:
    scene.world = bpy.data.worlds.new('W')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (0.6, 0.7, 0.8, 1)
scene.render.resolution_x = 1024
scene.render.resolution_y = 768
scene.render.filepath = preview
bpy.ops.render.render(write_still=True)
print("WROTE", preview)

bpy.ops.wm.save_as_mainfile(filepath=blend)
print("WROTE", blend)
print("actions", [a.name for a in bpy.data.actions])
