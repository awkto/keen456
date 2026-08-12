#version 120

// Keen soft pixels: small gaussian-ish blur + slight saturation boost —
// the native port of the WASM build's "soft" look (CSS blur(0.6px)
// saturate(1.06)), minus that filter's scanlines (see keen-soft-scanlines
// for the combination). BLUR is in input pixels (640x400 frame).

#define BLUR 0.7
#define SATURATE 1.06

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
    // 5-tap tent: center + 4 diagonals (diagonal taps ride the bilinear
    // filter, so this behaves like a cheap 3x3 gaussian).
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
    FragColor = vec4(keen_soft_sample(rubyTexture, v_texCoord), 1.0);
}

#endif
