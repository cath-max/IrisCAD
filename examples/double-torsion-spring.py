"""Double torsion spring: helical coils and tangent path-swept arms."""
import math
import simplecadapi as scad

wire_diameter = 3.0
mean_coil_diameter = 20.0
turn_count = 5
turn_clearance = 0.8
central_gap = 20.0
bridge_height = 54.0
bridge_half_width = 7.0
bridge_corner_radius = 3.0

r = wire_diameter / 2
R = mean_coil_diameter / 2
pitch = wire_diameter + turn_clearance
length = turn_count * pitch
inner = -central_gap / 2
outer = inner - length
slope = pitch / (2 * math.pi * R)

# Build in the helix's unambiguous +Z frame, then rotate the whole solid.
profile = scad.make_circle_rwire((R, 0, outer), r, normal=(0, R, pitch / (2 * math.pi)))
coil = scad.helical_sweep_rsolid(profile, pitch, length, R, center=(0, 0, outer))
coil = scad.rotate_shape(coil, 90, (0, 0, 1), (0, 0, 0))
left_coil = scad.rotate_shape(coil, 90, (0, 1, 0), (0, 0, 0))

def sweep_path(points):
    """Piecewise cubic Bezier path; neighboring spans share a tangent."""
    spans = (len(points) - 1) // 3
    path = scad.make_spline_rwire(
        control_points=points, degree=3,
        knots=list(range(spans + 1)),
        multiplicities=[4] + [3] * (spans - 1) + [4],
    )
    tangent = tuple(points[1][i] - points[0][i] for i in range(3))
    section = scad.make_circle_rface(points[0], r, normal=tangent)
    return scad.sweep_rsolid(section, path, is_frenet=False)

# Start in the exact direction of the helix end, then converge toward the bridge.
h = bridge_height
w = bridge_half_width
c = bridge_corner_radius
k = 4 * (math.sqrt(2) - 1) / 3  # Cubic approximation of a quarter circle.
left_arm = sweep_path([
    (inner, R, 0), (inner + 10*slope, R, 10), (-w, R, 22), (-w, R, 32),
    (-w, R, 38), (-w, R, h-c-5), (-w, R, h-c),
    (-w, R, h-c+k*c), (-w+c-k*c, R, h), (-w+c, R, h),
    (2*(-w+c)/3, R, h), ((-w+c)/3, R, h), (0, R, h),
])
# Turn toward the center beneath each coil; keep the coil-start tangent exact.
left_leg = sweep_path([
    (outer, R, 0), (outer - 4*slope, R, -4), (outer - 1, R, -9), (outer - 1, R, -14),
    (outer - 1, R, -14-4*k), (outer + 3-4*k, R, -18), (outer + 3, R, -18),
    (outer + 6, R, -18), (outer + 9, R, -18), (outer + 12, R, -18),
])
left_half = scad.union_rsolid(left_coil, left_arm, left_leg, glue=False)
# Reflection changes handedness while preserving every matching connection.
right_half = scad.mirror_shape(left_half, plane_origin=(0,0,0), plane_normal=(1,0,0))
result = scad.union_rsolid(left_half, right_half, glue=False)
