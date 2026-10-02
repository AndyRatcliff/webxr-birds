"""Inspect bat armature, materials, and actions."""
import bpy
import sys

src = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.open_mainfile(filepath=src)

for o in bpy.context.scene.objects:
    print("OBJ", o.name, o.type, "parent", o.parent.name if o.parent else None)

arm = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
print("BONES:")
for b in arm.data.bones:
    print(" ", b.name, "parent", b.parent.name if b.parent else None, "head", tuple(b.head_local), "children", [c.name for c in b.children])

print("POSE:")
for b in arm.pose.bones:
    print(" ", b.name, "rot_mode", b.rotation_mode, "loc", tuple(b.location), "euler", tuple(b.rotation_euler))

mesh = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
print("MESH mats", [s.material.name if s.material else None for s in mesh.material_slots])
for m in bpy.data.materials:
    print("MAT", m.name, "nodes", m.use_nodes)
    if m.use_nodes:
        for n in m.node_tree.nodes:
            print("  node", n.type, n.name)

print("ACTIONS", [a.name for a in bpy.data.actions])
for a in bpy.data.actions:
    print(" action", a.name, "fcurves", len(a.fcurves) if hasattr(a, 'fcurves') else 'n/a')
