#version 120

// Keen scanlines: sine-profile lines locked to the game's 200 pixel rows,
// the same math as the WASM build's overlay (m = mix(1-scan, 1, sin^2)).
// Drawn per game row — not per output row — so the lines get thicker as the
// window grows instead of degenerating into invisible 1px hairlines on HiDPI.

#define SCAN 0.45

uniform vec2 rubyTextureSize;
uniform vec2 rubyInputSize;

#if defined(VERTEX)

#if __VERSION__ >= 130
#define COMPAT_VARYING out
#define COMPAT_ATTRIBUTE in
#else
#define COMPAT_VARYING varying
#define COMPAT_ATTRIBUTE attribute
#endif

COMPAT_ATTRIBUTE vec4 a_position;
COMPAT_VARYING vec2 v_texCoord;

void main()
{
    gl_Position = a_position;
    v_texCoord = vec2(a_position.x + 1.0, 1.0 - a_position.y) / 2.0 * rubyInputSize / rubyTextureSize;
}

#elif defined(FRAGMENT)

#if __VERSION__ >= 130
#define COMPAT_VARYING in
#define COMPAT_TEXTURE texture
out vec4 FragColor;
#else
#define COMPAT_VARYING varying
#define FragColor gl_FragColor
#define COMPAT_TEXTURE texture2D
#endif

uniform sampler2D rubyTexture;
COMPAT_VARYING vec2 v_texCoord;

void main()
{
    vec4 c = COMPAT_TEXTURE(rubyTexture, v_texCoord);
    // rubyInputSize is the double-scanned 640x400 — the game has 200 rows.
    float rows = rubyInputSize.y * 0.5;
    float y = v_texCoord.y * rubyTextureSize.y / rubyInputSize.y; // 0..1 of frame
    float s = sin(3.14159265 * y * rows);
    FragColor = vec4(c.rgb * mix(1.0 - SCAN, 1.0, s * s), c.a);
}

#endif
