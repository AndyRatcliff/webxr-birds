"""
Rebuild wing_flap with quaternion local-X rotations + darker bat materials.
"""
import bpy
import sys
import math
import mathutils

argv = sys.argv[sys.argv.index("--") + 1:]
blend_path, glb_path, preview = argv[0], argv[1], argv[2]

bpy.ops.wm.open_mainfile(filepath=blend_path)

for name in ("Camera", "Sun", "Area", "Area.001"):
    if name in bpy.data.objects:
        bpy.data.objects.remove(bpy.data.objects[name], do_unlink=True)

mesh_obj = next(o for o in bpy.context.scene.objects if o.type == "MESH")
arm = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")

# ---------- materials ----------
def make_mat(name, color, roughness, metallic=0.0, alpha=1.0, transmission=0.0, add_noise=False):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (200, 0)
    out.location = (450, 0)

    col = nt.nodes.new("ShaderNodeRGB")
    col.outputs[0].default_value = (*color, 1)
    col.location = (-350, 100)

    if add_noise:
        noise = nt.nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = 25.0
        noise.inputs["Detail"].default_value = 8.0
        noise.location = (-600, -50)
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        ramp.location = (-350, -50)
        ramp.color_ramp.elements[0].position = 0.35
        ramp.color_ramp.elements[0].color = (color[0] * 0.7, color[1] * 0.7, color[2] * 0.7, 1)
        ramp.color_ramp.elements[1].position = 0.7
        ramp.color_ramp.elements[1].color = (min(1, color[0] * 1.25), min(1, color[1] * 1.2), min(1, color[2] * 1.15), 1)
        mix = nt.nodes.new("ShaderNodeMixRGB")
        mix.blend_type = "MULTIPLY"
        mix.inputs["Fac"].default_value = 0.55
        mix.location = (-50, 50)
        nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
        nt.links.new(col.outputs["Color"], mix.inputs["Color1"])
        nt.links.new(ramp.outputs["Color"], mix.inputs["Color2"])
        nt.links.new(mix.outputs["Color"], bsdf.inputs["Base Color"])
    else:
        nt.links.new(col.outputs["Color"], bsdf.inputs["Base Color"])

    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if "Alpha" in bsdf.inputs:
        bsdf.inputs["Alpha"].default_value = alpha
    for key in ("Transmission Weight", "Transmission"):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = transmission
            break
    # Specular / coat for leather
    for key in ("Specular IOR Level", "Specular"):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = 0.35
            break
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    if alpha < 0.999 or transmission > 0:
        mat.blend_method = "HASHED"
    return mat


body_mat = make_mat("BatBody", (0.07, 0.045, 0.03), roughness=0.9, add_noise=True)
wing_mat = make_mat(
    "BatWing",
    (0.16, 0.05, 0.045),
    roughness=0.45,
    alpha=0.88,
    transmission=0.25,
    add_noise=True,
)

mesh = mesh_obj.data
mesh.materials.clear()
mesh.materials.append(body_mat)
mesh.materials.append(wing_mat)

xs = [v.co.x for v in mesh.vertices]
x_mid = 0.5 * (min(xs) + max(xs))
x_span = (max(xs) - min(xs)) or 1.0
wing_threshold = 0.18 * x_span
for poly in mesh.polygons:
    cx = sum(mesh.vertices[i].co.x for i in poly.vertices) / len(poly.vertices)
    poly.material_index = 1 if abs(cx - x_mid) > wing_threshold else 0

# ---------- animation ----------
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

WING_L = ["Box003_03", "Box004_04", "Box005_05"]  # shoulder, mid, tip
WING_R = ["Box008_06", "Box006_07", "Box007_08"]
AMPS = [50.0, 65.0, 40.0]  # degrees at full up


def quat_axis_angle(axis, deg):
    return mathutils.Quaternion(axis, math.radians(deg))


def key_bone_quat(name, frame, quat):
    pb = arm.pose.bones[name]
    pb.rotation_mode = "QUATERNION"
    pb.rotation_quaternion = quat
    pb.keyframe_insert(data_path="rotation_quaternion", frame=frame)


def key_flap(frame, amount):
    """amount +1 = wings up, -1 = wings down. Rotate around local Y (along bone)."""
    # Local Y is typically bone roll axis for this FBX; local Z often flaps membranes.
    # Use Z for left, -Z for right so both wings rise together.
    for names, sign in ((WING_L, 1.0), (WING_R, -1.0)):
        for bone_name, amp in zip(names, AMPS):
            # Flap around local Z (perpendicular to wing chain in this rig)
            q = quat_axis_angle(mathutils.Vector((0.0, 0.0, 1.0)), sign * amp * amount)
            key_bone_quat(bone_name, frame, q)
    # Body bob / head
    key_bone_quat("Box001_01", frame, quat_axis_angle(mathutils.Vector((1, 0, 0)), 6 * amount))
    key_bone_quat("Box002_02", frame, quat_axis_angle(mathutils.Vector((1, 0, 0)), -8 * amount))


scene = bpy.context.scene
scene.render.fps = 24
scene.frame_start = 1
scene.frame_end = 16

for frame, amt in ((1, 1.0), (5, 0.0), (9, -1.0), (13, 0.0), (17, 1.0)):
    key_flap(frame, amt)

action.use_cyclic = True
for strip in action.layers[0].strips:
    for cb in strip.channelbags:
        for fc in cb.fcurves:
            for kp in fc.keyframe_points:
                kp.interpolation = "BEZIER"
                kp.handle_left_type = "AUTO_CLAMPED"
                kp.handle_right_type = "AUTO_CLAMPED"

# ---------- preview ----------
bpy.context.view_layer.update()
deps = bpy.context.evaluated_depsgraph_get()
ev = mesh_obj.evaluated_get(deps)
me = ev.to_mesh()
min_v = mathutils.Vector((1e9, 1e9, 1e9))
max_v = mathutils.Vector((-1e9, -1e9, -1e9))
for v in me.vertices:
    w = ev.matrix_world @ v.co
    min_v = mathutils.Vector((min(min_v.x, w.x), min(min_v.y, w.y), min(min_v.z, w.z)))
    max_v = mathutils.Vector((max(max_v.x, w.x), max(max_v.y, w.y), max(max_v.z, w.z)))
ev.to_mesh_clear()
center = (min_v + max_v) * 0.5
size = max_v - min_v
dist = max(size.length, 0.3) * 2.4

bpy.ops.object.camera_add(location=(center.x + dist, center.y - dist, center.z + dist * 0.5))
cam = bpy.context.active_object
cam.data.clip_start = 0.001
cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
scene.camera = cam
bpy.ops.object.light_add(type="SUN", location=center + mathutils.Vector((3, 2, 6)))
bpy.context.object.data.energy = 4
bpy.ops.object.light_add(type="AREA", location=center + mathutils.Vector((-2, -1, 2)))
bpy.context.object.data.energy = 120
bpy.context.object.data.size = 3

if not scene.world:
    scene.world = bpy.data.worlds.new("World")
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs[0].default_value = (0.5, 0.58, 0.68, 1)
scene.render.resolution_x = 1024
scene.render.resolution_y = 768

# Render a few frames
for f in (1, 5, 9):
    scene.frame_set(f)
    scene.render.filepath = preview.replace(".png", f"-{f:02d}.png")
    bpy.ops.render.render(write_still=True)
    print("WROTE", scene.render.filepath)

scene.frame_set(1)
scene.render.filepath = preview
bpy.ops.render.render(write_still=True)

bpy.ops.wm.save_as_mainfile(filepath=blend_path)
bpy.ops.export_scene.gltf(
    filepath=glb_path,
    export_format="GLB",
    export_animations=True,
    export_skins=True,
    export_materials="EXPORT",
    export_yup=True,
)
print("WROTE", blend_path, glb_path)
