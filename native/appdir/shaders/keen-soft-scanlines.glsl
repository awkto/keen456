#version 120

// Keen soft pixels + scanlines: the WASM build's "soft" filter proper —
// blur(0.6px)-style softening, slight saturation boost, and sine-profile
// scanlines locked to the game's 200 rows. The blur/saturate stage matches
// keen-soft.glsl and the scanline math matches keen-scanlines.glsl;
// SCAN here is a touch lighter (web soft used 0.30) so the blur and lines
// don't stack into a dark image.

#define BLUR 0.7
#define SATURATE 1.06
#define SCAN 0.35

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

vec3 keen_soft_sample(sampler2D tex, vec2 uv)
{
    vec2 px = vec2(BLUR) / rubyTextureSize;
    vec3 c = COMPAT_TEXTURE(tex, uv).rgb * 0.4;
    c += COMPAT_TEXTURE(tex, uv + vec2( px.x,  px.y)).rgb * 0.15;
    c += COMPAT_TEXTURE(tex, uv + vec2(-px.x,  px.y)).rgb * 0.15;
    c += COMPAT_TEXTURE(tex, uv + vec2( px.x, -px.y)).rgb * 0.15;
    c += COMPAT_TEXTURE(tex, uv + vec2(-px.x, -px.y)).rgb * 0.15;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    return mix(vec3(l), c, SATURATE);
}

void main()
{
    vec3 c = keen_soft_sample(rubyTexture, v_texCoord);
    float rows = rubyInputSize.y * 0.5;
    float y = v_texCoord.y * rubyTextureSize.y / rubyInputSize.y;
    float s = sin(3.14159265 * y * rows);
    FragColor = vec4(c * mix(1.0 - SCAN, 1.0, s * s), 1.0);
}

#endif
