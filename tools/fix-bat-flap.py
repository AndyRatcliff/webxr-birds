"""
True up/down wing flap (both tips rise/fall together).
World-Y rotation alone seesaws the wings; left chain uses the opposite sign.
"""
import bpy
import math
import mathutils
import sys

argv = sys.argv[sys.argv.index("--") + 1:]
blend_path = argv[0]
glb_path = argv[1] if len(argv) > 1 else None
preview_dir = argv[2] if len(argv) > 2 else None

bpy.ops.wm.open_mainfile(filepath=blend_path)

arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
mesh_obj = next(o for o in bpy.context.scene.objects if o.type == "MESH")

bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="POSE")
bpy.ops.pose.select_all(action="SELECT")
bpy.ops.pose.transforms_clear()
bpy.ops.object.mode_set(mode="OBJECT")

if "wing_flap" in bpy.data.actions:
    bpy.data.actions.remove(bpy.data.actions["wing_flap"])

action = bpy.data.actions.new("wing_flap")
if arm.animation_data is None:
    arm.animation_data_create()
arm.animation_data.action = action

WING_L = ["Box003_03", "Box004_04", "Box005_05"]
WING_R = ["Box008_06", "Box006_07", "Box007_08"]
AMPS = [42.0, 58.0, 38.0]
AXIS = mathutils.Vector((0.0, 1.0, 0.0))


def local_axis(name, world_axis):
    bone = arm.data.bones[name]
    a = bone.matrix_local.to_3x3().inverted() @ world_axis.normalized()
    return a.normalized() if a.length > 1e-8 else mathutils.Vector((1, 0, 0))


def key_quat(name, frame, quat):
    pb = arm.pose.bones[name]
    pb.rotation_mode = "QUATERNION"
    pb.rotation_quaternion = quat
    pb.keyframe_insert(data_path="rotation_quaternion", frame=frame)


def key_flap(frame, amount):
    # Opposite signs so both tips move the same way in world Z.
    for chain, sign in ((WING_L, -1.0), (WING_R, 1.0)):
        for name, amp in zip(chain, AMPS):
            axis = local_axis(name, AXIS)
            key_quat(name, frame, mathutils.Quaternion(axis, math.radians(sign * amp * amount)))
    key_quat(
        "Box001_01",
        frame,
        mathutils.Quaternion(local_axis("Box001_01", mathutils.Vector((1, 0, 0))), math.radians(5 * amount)),
    )
    key_quat(
        "Box002_02",
        frame,
        mathutils.Quaternion(local_axis("Box002_02", mathutils.Vector((1, 0, 0))), math.radians(-6 * amount)),
    )


scene = bpy.context.scene
scene.render.fps = 24
scene.frame_start = 1
scene.frame_end = 16

for frame, amt in ((1, -1.0), (5, -0.1), (9, 1.0), (13, 0.1), (17, -1.0)):
    key_flap(frame, amt)

action.use_cyclic = True
for strip in action.layers[0].strips:
    for cb in strip.channelbags:
        for fc in cb.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = "BEZIER"
                kp.handle_left_type = "AUTO_CLAMPED"
                kp.handle_right_type = "AUTO_CLAMPED"


def wing_avg_z(frame):
    scene.frame_set(frame)
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    ev = mesh_obj.evaluated_get(deps)
    me = ev.to_mesh()
    pts = [ev.matrix_world @ v.co for v in me.vertices]
    left = [p.z for p in pts if p.x < -0.15]
    right = [p.z for p in pts if p.x > 0.15]
    ev.to_mesh_clear()
    lz = sum(left) / len(left) if left else float("nan")
    rz = sum(right) / len(right) if right else float("nan")
    return lz, rz, len(left), len(right)


for f in (1, 5, 9, 13):
    lz, rz, nl, nr = wing_avg_z(f)
    same = (lz * rz) > 0 if (nl and nr and lz == lz and rz == rz) else None
    print(f"frame {f}: leftZ={lz:.3f} rightZ={rz:.3f} n={nl}/{nr} sameDirection={same}")

if preview_dir:
    cam = bpy.data.objects.get("Camera")
    if cam:
        cam.location = (1.7, -1.9, 0.85)
        cam.rotation_euler = (mathutils.Vector((0, 0, 0)) - cam.location).to_track_quat("-Z", "Y").to_euler()
        cam.data.clip_start = 0.01
    scene.render.resolution_x = 900
    scene.render.resolution_y = 700
    for f, tag in ((1, "up"), (5, "mid"), (9, "down")):
        scene.frame_set(f)
        scene.render.filepath = f"{preview_dir}/bat-flap-{tag}.png"
        bpy.ops.render.render(write_still=True)
        print("WROTE", scene.render.filepath)

scene.frame_set(1)
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
