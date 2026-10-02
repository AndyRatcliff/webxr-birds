"""
Move the bat to the world origin in Blender so it is visible and editable.
Also removes stray empties that yank 'Frame All' into the distance.
"""
import bpy
import math
import mathutils
import sys

argv = sys.argv[sys.argv.index("--") + 1:]
blend_path = argv[0]
glb_path = argv[1] if len(argv) > 1 else None
preview = argv[2] if len(argv) > 2 else None

bpy.ops.wm.open_mainfile(filepath=blend_path)

mesh_obj = next(o for o in bpy.context.scene.objects if o.type == "MESH")
arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
root = bpy.data.objects.get("Sketchfab_model")
if root is None:
    raise RuntimeError("Sketchfab_model root not found")

# Rest pose for measuring bounds
if arm.animation_data:
    arm.animation_data.action = None
bpy.context.scene.frame_set(1)
bpy.context.view_layer.update()


def eval_centroid_and_size():
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    ev = mesh_obj.evaluated_get(deps)
    me = ev.to_mesh()
    ws = [ev.matrix_world @ v.co for v in me.vertices]
    ev.to_mesh_clear()
    c = sum(ws, mathutils.Vector()) / len(ws)
    min_v = mathutils.Vector((min(v.x for v in ws), min(v.y for v in ws), min(v.z for v in ws)))
    max_v = mathutils.Vector((max(v.x for v in ws), max(v.y for v in ws), max(v.z for v in ws)))
    return c, max_v - min_v


centroid, size = eval_centroid_and_size()
print("before centroid", tuple(centroid), "size", tuple(size))

# Root location is applied before scale, so subtracting world centroid works.
root.location -= centroid
bpy.context.view_layer.update()
centroid, size = eval_centroid_and_size()
print("after move centroid", tuple(centroid), "size", tuple(size))

# Normalize size to 1 on longest axis if needed
max_dim = max(size.x, size.y, size.z) or 1.0
if abs(max_dim - 1.0) > 0.05:
    root.scale *= 1.0 / max_dim
    bpy.context.view_layer.update()
    centroid, size = eval_centroid_and_size()
    root.location -= centroid
    bpy.context.view_layer.update()
    centroid, size = eval_centroid_and_size()
    print("after normalize centroid", tuple(centroid), "size", tuple(size))

# ---------------------------------------------------------------
# Bake parent scales into the armature + mesh data so Edit Mode
# is also near the origin (not stuck at -130,-195).
# ---------------------------------------------------------------
# Combined scale from Sketchfab_model * bat.fbx ≈ world scale of mesh data.
bat_fbx = bpy.data.objects.get("bat.fbx")
# World matrix of Object_4 (armature) maps armature-local -> world
arm_mw = arm.matrix_world.copy()
mesh_mw = mesh_obj.matrix_world.copy()

# Target: armature & mesh object matrices identity at origin; data in meters.
# Transform edit bones by arm_mw, mesh verts by mesh_mw, then clear parents scales.

# 1) Make mesh vertices world-space, then translate to center 0
bpy.ops.object.select_all(action="DESELECT")
mesh_obj.select_set(True)
bpy.context.view_layer.objects.active = mesh_obj
bpy.ops.object.mode_set(mode="OBJECT")

# Apply parent transform into mesh object matrix first by clearing parent keep transform
# Walk: unparent mesh and armature keep transform, apply scale/rot/loc, then rebind.

def clear_parent_keep(obj):
    mw = obj.matrix_world.copy()
    obj.parent = None
    obj.matrix_world = mw


# Remember armature modifier / parenting
mesh_parent = mesh_obj.parent
arm_parent = arm.parent

clear_parent_keep(mesh_obj)
clear_parent_keep(arm)

# Also clear empties' scales further up – already unparented mesh/arm
# Apply transforms on mesh and armature objects
for obj in (mesh_obj, arm):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

bpy.context.view_layer.update()

# Now both should have identity matrix; verts/bones still large raw coords around -130.
# Translate mesh verts and edit bones by -local_centroid so data sits at origin.

vs = [v.co.copy() for v in mesh_obj.data.vertices]
local_center = sum(vs, mathutils.Vector()) / len(vs)
print("local data center before bake", tuple(local_center))

for v in mesh_obj.data.vertices:
    v.co -= local_center

bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
for b in arm.data.edit_bones:
    b.head -= local_center
    b.tail -= local_center
bpy.ops.object.mode_set(mode="OBJECT")

# Pose bone custom locations that were in old space – clear them
bpy.ops.object.mode_set(mode="POSE")
bpy.ops.pose.select_all(action="SELECT")
bpy.ops.pose.transforms_clear()
bpy.ops.object.mode_set(mode="OBJECT")

# Re-parent mesh to armature with Armature deform (keep existing modifier if present)
mesh_obj.parent = arm
mesh_obj.parent_type = "OBJECT"
# Ensure armature modifier exists and targets arm
mod = None
for m in mesh_obj.modifiers:
    if m.type == "ARMATURE":
        mod = m
        break
if mod is None:
    mod = mesh_obj.modifiers.new(name="Armature", type="ARMATURE")
mod.object = arm
mod.use_vertex_groups = True

# Delete confusing far empties / old hierarchy wrappers (no longer parents)
for name in (
    "Sketchfab_model",
    "bat.fbx",
    "Object_2",
    "RootNode",
    "Object_6",
    "bat",
    "Camera",
    "Sun",
    "Area",
    "Area.001",
):
    if name in bpy.data.objects:
        bpy.data.objects.remove(bpy.data.objects[name], do_unlink=True)

# Restore wing_flap as active action if present
if arm.animation_data is None:
    arm.animation_data_create()
if "wing_flap" in bpy.data.actions:
    arm.animation_data.action = bpy.data.actions["wing_flap"]

bpy.context.view_layer.update()
centroid, size = eval_centroid_and_size()
print("FINAL centroid", tuple(centroid), "size", tuple(size))
print("bone heads sample", [ (b.name, tuple(round(x, 3) for x in b.head_local)) for b in list(arm.data.bones)[:4] ])

# If still offset, nudge armature object
if centroid.length > 0.01:
    arm.location -= centroid
    bpy.context.view_layer.update()
    centroid, size = eval_centroid_and_size()
    print("nudged FINAL centroid", tuple(centroid), "size", tuple(size))

# Normalize size to 1
max_dim = max(size.x, size.y, size.z) or 1.0
if abs(max_dim - 1.0) > 0.02:
    arm.scale *= 1.0 / max_dim
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    mesh_obj.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.context.view_layer.update()
    centroid, size = eval_centroid_and_size()
    if centroid.length > 0.01:
        arm.location -= centroid
    print("size-normalized", tuple(eval_centroid_and_size()[0]), tuple(eval_centroid_and_size()[1]))

# Camera + light at origin for the saved file
centroid, size = eval_centroid_and_size()
dist = max(size.length, 0.4) * 2.2
bpy.ops.object.camera_add(location=(dist, -dist, dist * 0.45))
cam = bpy.context.active_object
cam.data.clip_start = 0.01
cam.data.clip_end = 1000
cam.rotation_euler = (mathutils.Vector(centroid) - cam.location).to_track_quat("-Z", "Y").to_euler()
bpy.context.scene.camera = cam
bpy.ops.object.light_add(type="SUN", location=(3, 2, 5))
bpy.context.object.data.energy = 4

# World background
scene = bpy.context.scene
if not scene.world:
    scene.world = bpy.data.worlds.new("World")
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.45, 0.5, 0.55, 1)

# Preview
if preview:
    scene.frame_set(1)
    if "wing_flap" in bpy.data.actions:
        arm.animation_data.action = bpy.data.actions["wing_flap"]
    scene.render.resolution_x = 1024
    scene.render.resolution_y = 768
    scene.render.filepath = preview
    bpy.ops.render.render(write_still=True)
    print("WROTE", preview)

bpy.ops.wm.save_as_mainfile(filepath=blend_path)
print("WROTE", blend_path)

if glb_path:
    bpy.ops.export_scene.gltf(
        filepath=glb_path,
        export_format="GLB",
        export_animations=True,
        export_skins=True,
        export_materials="EXPORT",
        export_yup=True,
    )
    print("WROTE", glb_path)

print("objects left:", [o.name for o in bpy.context.scene.objects])
