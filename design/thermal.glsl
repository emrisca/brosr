/** @resolution */
uniform vec2 u_resolution;

/** @time */
uniform float u_time;

/**
 * @label Key Color
 * @color
 * @default #1f6bff
 */
uniform vec3 u_key;

#define u_hueSpread 0.64

#define u_highlightCap 0.6

#define u_highlightSat 0.35

/**
 * @label Size
 * @default 0.46
 * @range 0.1, 0.95
 */
uniform float u_ballSize;

/**
 * @label Pos X
 * @default 0
 * @range -1, 1
 */
uniform float u_ballX;

/**
 * @label Pos Y
 * @default 0
 * @range -1, 1
 */
uniform float u_ballY;

/**
 * @label Depth Z
 * @default 0
 * @range -1, 1
 */
uniform float u_ballZ;

#define u_wallBright 0.0

#define u_stripeLight 0.14

#define u_backdropZ -1.0

/**
 * @label Loop Duration
 * @default 12
 * @range 2, 30
 */
uniform float u_loopDur;

#define u_density 0.5650000000000001

#define u_sweepFalloff 0.625

#define u_stripeBalance 0.0

#define u_lightLag -0.07

#define u_coronaWidth 0.585

#define u_rimLinear 0.17

#define u_coronaIntensity 0.36

#define u_dispersion 1.0

#define u_emissive 0.12

#define u_bloom 0.37

#define u_glowAdd 0.03

#define u_scatter 0.7000000000000001

#define u_scatterSpread 0.1

#define u_scatterIntensity 2.7

#define u_fresnel 2.0

#define u_darkCore 0.97

#define u_coreBlack 0.855

#define u_contact 0.215

#define u_shadow2 0.645

#define u_shadowSway 0.39

#define u_ambient 0.15

#define u_depthBlur 1.0

vec3 toLinear(vec3 c) {
  return pow(c, vec3(2.2));
}

vec3 toGamma(vec3 c) {
  return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
}

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 palette(float t, vec3 keyLin) {
  t = clamp(t, 0.0, 1.2);
  vec3 shadow = keyLin * 0.02;
  vec3 mid = keyLin;

  vec3 hi = mix(mix(keyLin, vec3(1.0), 0.55), clamp(keyLin * 2.2, 0.0, 1.0), u_highlightSat);
  vec3 peak = mix(mix(keyLin, vec3(1.0), 0.9), clamp(keyLin * 3.2, 0.0, 1.0), u_highlightSat);
  if (t < 0.5) return mix(shadow, mid, smoothstep(0.0, 0.5, t));
  if (t < 1.0) return mix(mid, hi, smoothstep(0.5, 1.0, t));
  return mix(hi, peak, smoothstep(1.0, 1.2, t));
}

vec3 shadeRGB(vec3 t, vec3 keyLin) {
  return vec3(
    palette(t.x, keyLin).r,
    palette(t.y, keyLin).g,
    palette(t.z, keyLin).b
  );
}

float stripeField(float x, float scroll, float period, float soft, float balance) {

  float s = cos((x + scroll) / period * 6.2831853) - balance;
  return smoothstep(-soft, soft, s);
}

float blurStripe(float x, float scroll, float period, float soft, float balance, float spread) {
  const int TAPS = 5;
  float sum = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < TAPS; i++) {
    float o = float(i) - 2.0;
    float gw = exp(-o * o * 0.5);
    sum += stripeField(x + o * spread * 0.5, scroll, period, soft, balance) * gw;
    wsum += gw;
  }
  return sum / wsum;
}

float mirrorDome(float r, float width) {
  float d = clamp((r - 1.0) / max(width, 1.0e-3), 0.0, 1.0);
  float zMir = sqrt(max(1.0 - (1.0 - d) * (1.0 - d), 0.0));
  return pow(1.0 - zMir, 2.0) * step(1.0, r);
}

vec3 softClip(vec3 t, float ceil) {
  vec3 x = t / ceil;
  return ceil * x / pow(1.0 + x * x * x, vec3(1.0 / 3.0));
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float aspect = u_resolution.x / u_resolution.y;

  vec2 p = uv - 0.5;
  p.x *= aspect;

  float nx = 2.0 * uv.x - 1.0;

  vec2 c = p - vec2(u_ballX, u_ballY) * 0.5;
  float depthScale = 1.0 / clamp(1.0 - 0.4 * u_ballZ, 0.3, 2.0);
  float R = u_ballSize * depthScale;
  float r = length(c) / R;

  float z = sqrt(max(1.0 - r * r, 0.0));
  vec2 outward = normalize(c + vec2(1.0e-5));

  float bandW = max(u_density, 0.03);
  float period = 2.0 * bandW;
  float scroll = fract(u_time / max(u_loopDur, 0.1)) * period;

  float ballScroll = scroll + u_lightLag * period;
  float soft = mix(0.05, 1.0, clamp(u_sweepFalloff, 0.0, 1.0));

  float disp = u_dispersion * 0.05;
  vec3 chOff = vec3(-disp, 0.0, disp);

  float bx = nx + 0.25 * outward.x;

  float spread = u_depthBlur * max(r - 1.0, 0.0) * 0.6;
  vec3 sBg = vec3(
    blurStripe(nx + chOff.x, scroll, period, soft, u_stripeBalance, spread),
    blurStripe(nx + chOff.y, scroll, period, soft, u_stripeBalance, spread),
    blurStripe(nx + chOff.z, scroll, period, soft, u_stripeBalance, spread)
  );
  vec3 sBall = vec3(
    stripeField(bx + chOff.x, ballScroll, period, soft, u_stripeBalance),
    stripeField(bx + chOff.y, ballScroll, period, soft, u_stripeBalance),
    stripeField(bx + chOff.z, ballScroll, period, soft, u_stripeBalance)
  );
  vec3 ballLit = u_ambient + (1.0 - u_ambient) * sBall;

  float pEff = mix(10.0, 1.5, clamp(u_coronaWidth, 0.0, 1.0));

  float rimCoord = mix(1.0 - z, r, clamp(u_rimLinear, 0.0, 1.0));
  float rimF = pow(rimCoord, pEff);
  float edge = pow(1.0 - z, 16.0);
  float scatExp = mix(3.5, 0.5, u_scatterSpread);
  float scat = pow(rimCoord, scatExp);
  float rimBase = rimF + u_fresnel * edge + u_scatter * u_scatterIntensity * scat;

  float vig = smoothstep(1.7, 0.2, length(p));

  float darkLevel = mix(0.0, 0.28, u_wallBright);
  float lightLevel = mix(0.1, 1.6, u_stripeLight);
  float bgMul = (1.0 + 0.3 * u_backdropZ) * mix(1.0, 0.65 + 0.35 * vig, 0.4);
  vec3 tBg = mix(vec3(darkLevel), vec3(lightLevel), sBg) * bgMul;

  vec3 tBall = (rimBase * ballLit + u_emissive * rimF) * u_coronaIntensity;

  float coreMask = smoothstep(1.0 - u_darkCore, 1.0, z);
  tBall *= 1.0 - coreMask;

  float atmos = mix(0.7, 1.5, u_depthBlur);
  float glow = mirrorDome(r, (0.25 + 1.5 * u_bloom) * atmos);
  vec3 halo = glow * ballLit * (u_bloom * 1.3 + 0.5 * u_emissive);
  tBg += halo;

  float glowIn = dot(tBall, vec3(0.3333));
  float glowOut = dot(halo, vec3(0.3333));

  float ballCenterNx = u_ballX / aspect;
  float so = min(0.5, period * 0.25);

  float sLeft = stripeField(ballCenterNx - so, scroll, period, soft, u_stripeBalance);
  float sRight = stripeField(ballCenterNx + so, scroll, period, soft, u_stripeBalance);

  float lightX = sRight - sLeft;
  float lean = -outward.x * lightX * u_shadowSway * 2.0;

  float dirAway = smoothstep(0.15, 1.0, clamp(lean, 0.0, 1.0));
  float dirToward = smoothstep(0.15, 1.0, clamp(-lean, 0.0, 1.0));

  float dome1 = mirrorDome(r, (0.25 + 1.5 * u_contact) * atmos);
  float dome2 = mirrorDome(r, (0.25 + 1.5 * u_shadow2) * atmos);
  float shadow1 = dome1 * (0.12 + 0.88 * dirAway) * u_contact;
  float shadow2 = dome2 * dirToward * u_shadow2;
  tBg = max(tBg * (1.0 - clamp((shadow1 + shadow2) * 1.7, 0.0, 0.93)), 0.0);

  float tCeil = mix(0.6, 1.2, u_highlightCap);
  tBg = softClip(tBg, tCeil);
  tBall = softClip(tBall, tCeil);

  vec3 keyLin = toLinear(u_key);
  vec3 bgCol = shadeRGB(tBg, keyLin);
  vec3 ballCol = shadeRGB(tBall, keyLin);

  ballCol *= 1.0 - u_coreBlack * coreMask;

  float px = 1.0 / (R * u_resolution.y);
  float ballMask = smoothstep(1.0 + 1.5 * px, 1.0 - 1.5 * px, r);
  vec3 col = mix(bgCol, ballCol, ballMask);

  float lit = mix(sBg.y, sBall.y, ballMask);
  vec3 hsv = rgb2hsv(col);
  hsv.x = fract(hsv.x + u_hueSpread * 0.03 * (lit - 0.5));
  col = hsv2rgb(hsv);

  float glowSrc = mix(glowOut, glowIn, ballMask);
  vec3 glowCol = mix(keyLin, vec3(1.0), 0.5);
  col += glowCol * glowSrc * u_glowAdd;

  col = toGamma(col);

  col += (hash21(gl_FragCoord.xy) - 0.5) / 255.0;

  gl_FragColor = vec4(col, 1.0);
}
