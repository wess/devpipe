//
// Terminal drawing, as two instanced quad passes.
//
// A terminal is a grid of fixed slots, which makes it about the friendliest
// thing there is to draw on a GPU: every rectangle is axis-aligned, every glyph
// is a blit out of one texture, and nothing needs shaping or measuring. There
// is no vertex buffer — the quad corners come from the vertex id — so a frame
// is two buffer writes and two draw calls whatever is on screen.
//
// Everything is premultiplied. The atlas comes out of CoreGraphics that way and
// the blend state is (one, one_minus_source_alpha) to match.
//
#include <metal_stdlib>
using namespace metal;

struct Uniforms {
    float2 viewport;   // drawable size, in pixels
};

struct FillInstance {
    float4 rect;       // x, y, w, h in pixels, y down from the top
    uint   color;      // r | g<<8 | b<<16 | a<<24
    uint   style;      // FillStyle
};

struct GlyphInstance {
    float4 rect;       // destination, pixels
    float4 uv;         // u0, v0, u1, v1
    uint   color;
    uint   isColor;    // 1 for emoji and other colour fonts: do not tint
};

// Two triangles, counter-clockwise, as unit-square corners.
constant float2 kCorner[6] = {
    float2(0, 0), float2(1, 0), float2(0, 1),
    float2(0, 1), float2(1, 0), float2(1, 1)
};

// The FillStyle cases that are not a plain rectangle. Kept in step with
// Frame.swift by hand — they are two short lists that change together.
constant uint kCurly  = 3;
constant uint kDotted = 4;
constant uint kDashed = 5;

static inline float4 to_clip(float2 pixels, float2 viewport) {
    // Pixels, y down from the top left, into clip space.
    return float4((pixels / viewport) * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
}

// ---- solid fills ------------------------------------------------------------

struct FillVertex {
    float4 position [[position]];
    float4 color;
    float2 local;    // 0..1 inside the quad
    float2 extent;   // quad size in pixels, for shaping the dashed kinds
    uint   style     [[flat]];
};

vertex FillVertex fill_vertex(uint vid                      [[vertex_id]],
                              uint iid                      [[instance_id]],
                              constant FillInstance *items  [[buffer(0)]],
                              constant Uniforms &u          [[buffer(1)]])
{
    FillInstance item = items[iid];
    float2 corner = kCorner[vid];

    FillVertex out;
    out.position = to_clip(item.rect.xy + corner * item.rect.zw, u.viewport);
    out.color = unpack_unorm4x8_to_float(item.color);
    out.local = corner;
    out.extent = item.rect.zw;
    out.style = item.style;
    return out;
}

fragment float4 fill_fragment(FillVertex in [[stage_in]])
{
    float4 c = in.color;
    float x = in.local.x * in.extent.x;

    if (in.style == kCurly) {
        // A wave that stays inside the quad, thickened to about a pixel and a
        // half so it survives at small sizes. This is the underline a compiler
        // puts under a warning, and a flat line there loses the distinction.
        float amplitude = max(in.extent.y * 0.5 - 1.0, 0.5);
        float centre = in.extent.y * 0.5;
        float wave = centre + sin(x * 0.9) * amplitude;
        float d = abs(in.local.y * in.extent.y - wave);
        c.a *= saturate(1.5 - d);
    } else if (in.style == kDotted) {
        c.a *= step(fract(x * 0.34), 0.5);
    } else if (in.style == kDashed) {
        c.a *= step(fract(x * 0.14), 0.62);
    }

    return float4(c.rgb * c.a, c.a);
}

// ---- glyphs -----------------------------------------------------------------

struct GlyphVertex {
    float4 position [[position]];
    float2 uv;
    float4 color;
    uint   isColor  [[flat]];
};

vertex GlyphVertex glyph_vertex(uint vid                       [[vertex_id]],
                                uint iid                       [[instance_id]],
                                constant GlyphInstance *items  [[buffer(0)]],
                                constant Uniforms &u           [[buffer(1)]])
{
    GlyphInstance item = items[iid];
    float2 corner = kCorner[vid];

    GlyphVertex out;
    out.position = to_clip(item.rect.xy + corner * item.rect.zw, u.viewport);
    out.uv = mix(item.uv.xy, item.uv.zw, corner);
    out.color = unpack_unorm4x8_to_float(item.color);
    out.isColor = item.isColor;
    return out;
}

fragment float4 glyph_fragment(GlyphVertex in            [[stage_in]],
                               texture2d<float> atlas    [[texture(0)]],
                               sampler atlasSampler      [[sampler(0)]])
{
    float4 texel = atlas.sample(atlasSampler, in.uv);

    // A colour font carries its own colour and arrives premultiplied; tinting
    // it would turn every emoji into a monochrome blob.
    if (in.isColor != 0) {
        return texel * in.color.a;
    }

    // Monochrome: the alpha channel is coverage, and the cell's foreground is
    // multiplied through it.
    float coverage = texel.a * in.color.a;
    return float4(in.color.rgb * coverage, coverage);
}
