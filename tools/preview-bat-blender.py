"""Import fixed bat, remove stray meshes, render preview, save .blend"""
import bpy
import sys
import math

argv = sys.argv[sys.argv.index("--") + 1:]
src = argv[0]
out_png = argv[1]
out_blend = argv[2]

bpy.ops.wm.read_factory_settings(use_empty=True)
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

bpy.ops.import_scene.gltf(filepath=src)
for o in list(bpy.context.scene.objects):
    if o.type == 'MESH' and o.name != 'Object_7' and 'bat' not in o.name.lower():
        bpy.data.objects.remove(o, do_unlink=True)

# Play fly action on armature if present
for o in bpy.context.scene.objects:
    if o.type == 'ARMATURE' and o.animation_data is None:
        o.animation_data_create()
    if o.type == 'ARMATURE' and 'fly' in bpy.data.actions:
        o.animation_data.action = bpy.data.actions['fly']

bpy.context.scene.frame_set(1)

# Camera
bpy.ops.object.camera_add(location=(1.4, -1.4, 0.8))
cam = bpy.context.active_object
cam.rotation_euler = (math.radians(65), 0, math.radians(45))
bpy.context.scene.camera = cam

# Light
bpy.ops.object.light_add(type='SUN', location=(2, 2, 5))
bpy.context.object.data.energy = 3

scene = bpy.context.scene
scene.render.resolution_x = 800
scene.render.resolution_y = 600
scene.render.filepath = out_png
scene.render.image_settings.file_format = 'PNG'
scene.world = bpy.data.worlds.new('World') if not scene.world else scene.world
scene.world.use_nodes = True
bg = scene.world.node_tree.nodes['Background']
bg.inputs[0].default_value = (0.45, 0.55, 0.65, 1)
bg.inputs[1].default_value = 1.0

bpy.ops.render.render(write_still=True)
print("WROTE", out_png)

bpy.ops.wm.save_as_mainfile(filepath=out_blend)
print("WROTE", out_blend)
