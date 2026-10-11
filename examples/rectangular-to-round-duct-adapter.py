import simplecadapi as scad

lower_width = 140  # [80:5:240]
lower_depth = 90  # [60:5:180]
lower_section_height = 42  # [15:2:70]
corner_radius = 14  # [5:1:30]
transition_height = 65  # [50:5:180]
neck_outer_diameter = 76  # [40:2:140]
neck_height = 36  # [15:2:70]
wall_thickness = 3  # [1.5:0.5:6]
transition_overlap = 3


def make_rounded_rectangle_rwire(width, depth, radius, z):
    hx = width / 2.0
    hy = depth / 2.0
    q = radius * (2.0 ** -0.5)
    edges = [
        scad.make_spline_redge(control_points=[(hx - radius, -hy, z), (-hx + radius, -hy, z)], degree=1),
        scad.make_three_point_arc_redge((-hx + radius, -hy, z), (-hx + radius - q, -hy + radius - q, z), (-hx, -hy + radius, z)),
        scad.make_spline_redge(control_points=[(-hx, -hy + radius, z), (-hx, hy - radius, z)], degree=1),
        scad.make_three_point_arc_redge((-hx, hy - radius, z), (-hx + radius - q, hy - radius + q, z), (-hx + radius, hy, z)),
        scad.make_spline_redge(control_points=[(-hx + radius, hy, z), (hx - radius, hy, z)], degree=1),
        scad.make_three_point_arc_redge((hx - radius, hy, z), (hx - radius + q, hy - radius + q, z), (hx, hy - radius, z)),
        scad.make_spline_redge(control_points=[(hx, hy - radius, z), (hx, -hy + radius, z)], degree=1),
        scad.make_three_point_arc_redge((hx, -hy + radius, z), (hx - radius + q, -hy + radius - q, z), (hx - radius, -hy, z)),
    ]
    return scad.make_wire_from_edges_rwire(edges)


inner_width = lower_width - 2.0 * wall_thickness
inner_depth = lower_depth - 2.0 * wall_thickness
inner_corner_radius = corner_radius - wall_thickness
transition_start_z = lower_section_height
transition_end_z = lower_section_height + transition_height
inner_profile_z = transition_start_z - 1.0
inner_end_z = transition_end_z + 1.0

outer_lower_profile = make_rounded_rectangle_rwire(
    lower_width, lower_depth, corner_radius, transition_start_z
)
outer_lower = scad.extrude_rsolid(
    outer_lower_profile, direction=(0.0, 0.0, -1.0), distance=lower_section_height
)
outer_round_profile = scad.make_circle_rwire(
    (0.0, 0.0, transition_end_z), neck_outer_diameter / 2.0
)
outer_transition = scad.loft_rsolid(
    [outer_lower_profile, outer_round_profile], ruled=False
)

inner_lower_profile = make_rounded_rectangle_rwire(
    inner_width, inner_depth, inner_corner_radius, inner_profile_z
)
inner_lower_bottom_profile = make_rounded_rectangle_rwire(
    inner_width, inner_depth, inner_corner_radius, -1.0
)
inner_lower = scad.extrude_rsolid(
    inner_lower_bottom_profile,
    direction=(0.0, 0.0, 1.0),
    distance=lower_section_height + 2.0,
)
inner_round_profile = scad.make_circle_rwire(
    (0.0, 0.0, inner_end_z), neck_outer_diameter / 2.0 - wall_thickness
)
inner_transition = scad.loft_rsolid(
    [inner_lower_profile, inner_round_profile], ruled=False
)

outer_neck = scad.make_cylinder_rsolid(
    neck_outer_diameter / 2.0,
    neck_height,
    bottom_face_center=(0.0, 0.0, transition_end_z - transition_overlap),
)
inner_neck = scad.make_cylinder_rsolid(
    neck_outer_diameter / 2.0 - wall_thickness,
    neck_height + transition_overlap + 2.0,
    bottom_face_center=(0.0, 0.0, transition_end_z - transition_overlap - 1.0),
)
outer_body = scad.union_rsolid(
    outer_lower, outer_transition, outer_neck, glue=False
)
result = scad.cut_rsolid(
    outer_body, inner_lower, inner_transition, inner_neck
)
