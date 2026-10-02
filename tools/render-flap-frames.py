"""Render wing_flap frames 1,5,9,13 to verify axis."""
import bpy
import sys

blend = sys.argv[sys.argv.index("--") + 1]
outdir = sys.argv[sys.argv.index("--") + 2]
bpy.ops.wm.open_mainfile(filepath=blend)
scene = bpy.context.scene
for f in (1, 5, 9, 13):
    scene.frame_set(f)
    scene.render.filepath = f"{outdir}/bat-flap-{f:02d}.png"
    bpy.ops.render.render(write_still=True)
    print("WROTE", scene.render.filepath)
