// WebGL2 engine: photo + depth → vathograph. One fragment shader renders the
// preview, thumbnails, video frames and print tiles; resolution-dependent
// effects (lines, grain, anti-aliasing) are defined in artwork units, so a
// 1080 px post and a 14000 px print look the same, only sharper.

export const MAX_HL = 8;

const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uPhoto;
uniform sampler2D uDepth;
uniform sampler2D uSig;
uniform vec2 uFbSize;
uniform vec2 uOrigin;
uniform float uPx;
uniform float uArtW;
uniform vec4 uImgRect;
uniform vec4 uSrcRect;
uniform vec2 uPhotoSize;
uniform vec2 uDepthSize;
uniform int uHiQ;
uniform int uView;
uniform float uSplit;
uniform vec3 uBg;
uniform vec3 uBorderColor;
uniform vec4 uSigRect;
uniform vec4 uSigColor;
uniform vec4 uRemap;
uniform float uEdgeClean;
uniform vec3 uNearC;
uniform vec3 uMidC;
uniform vec3 uFarC;
uniform float uMidPos;
uniform vec4 uBase;
uniform vec4 uRelief;
uniform vec4 uContour;
uniform vec3 uContourColor;
uniform vec4 uFinish;
uniform vec4 uFinish2;
uniform int uHlCount;
uniform vec4 uHlA[${MAX_HL}];
uniform vec4 uHlB[${MAX_HL}];
uniform vec4 uHlC[${MAX_HL}];
uniform vec4 uHlD[${MAX_HL}];
out vec4 oColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
// Catmull-Rom bicubic in 9 bilinear taps: crisp upscaling for big prints
vec3 sampleCR(sampler2D t, vec2 uv, vec2 ts) {
  vec2 sp = uv * ts;
  vec2 tp = floor(sp - 0.5) + 0.5;
  vec2 f = sp - tp;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = (tp - 1.0) / ts, t3 = (tp + 2.0) / ts, t12 = (tp + w2 / w12) / ts;
  vec3 r = vec3(0.0);
  r += textureLod(t, vec2(t0.x, t0.y), 0.0).rgb * w0.x * w0.y;
  r += textureLod(t, vec2(t12.x, t0.y), 0.0).rgb * w12.x * w0.y;
  r += textureLod(t, vec2(t3.x, t0.y), 0.0).rgb * w3.x * w0.y;
  r += textureLod(t, vec2(t0.x, t12.y), 0.0).rgb * w0.x * w12.y;
  r += textureLod(t, vec2(t12.x, t12.y), 0.0).rgb * w12.x * w12.y;
  r += textureLod(t, vec2(t3.x, t12.y), 0.0).rgb * w3.x * w12.y;
  r += textureLod(t, vec2(t0.x, t3.y), 0.0).rgb * w0.x * w3.y;
  r += textureLod(t, vec2(t12.x, t3.y), 0.0).rgb * w12.x * w3.y;
  r += textureLod(t, vec2(t3.x, t3.y), 0.0).rgb * w3.x * w3.y;
  return clamp(r, 0.0, 1.0);
}
float remap(float raw) {
  float d = clamp((raw - uRemap.x) / max(uRemap.y - uRemap.x, 1e-5), 0.0, 1.0);
  d = pow(d, uRemap.z);
  return uRemap.w > 0.5 ? 1.0 - d : d;
}
// anti-aliased line of thickness t (per-mille of artwork height) at depth distance dist
float lineMask(float dist, float fw, float t) {
  float tp = t * 0.001 / uPx;
  float a = clamp(tp, 0.0, 1.0);
  tp = max(tp, 1.0);
  float dpx = dist / fw;
  return (1.0 - smoothstep(tp * 0.5 - 0.5, tp * 0.5 + 0.5, dpx)) * a;
}

void main() {
  vec2 fc = vec2(gl_FragCoord.x, uFbSize.y - gl_FragCoord.y);
  vec2 p = uOrigin + fc * uPx;
  vec2 rel = (p - uImgRect.xy) / uImgRect.zw;
  vec2 uv = clamp(uSrcRect.xy + rel * uSrcRect.zw, vec2(0.0), vec2(1.0));

  // depth (everything below is computed in uniform control flow for derivatives)
  float raw = texture(uDepth, uv).r;
  float d = remap(raw);
  float fw = max(fwidth(d), 1e-6);

  // depth discontinuities (object silhouettes): the depth jumps through every
  // distance in a texel or two there, which would draw halos around objects
  float edge = 0.0;
  if (uEdgeClean > 0.0) {
    vec2 o = 1.0 / uDepthSize;
    float gx = abs(remap(texture(uDepth, uv + vec2(o.x, 0.0)).r) - remap(texture(uDepth, uv - vec2(o.x, 0.0)).r));
    float gy = abs(remap(texture(uDepth, uv + vec2(0.0, o.y)).r) - remap(texture(uDepth, uv - vec2(0.0, o.y)).r));
    edge = uEdgeClean * smoothstep(0.012, 0.05, max(gx, gy));
  }

  vec3 ph = uHiQ == 1 ? sampleCR(uPhoto, uv, uPhotoSize) : texture(uPhoto, uv).rgb;
  float lum = dot(ph, vec3(0.2126, 0.7152, 0.0722));

  // base atmosphere: near → mid → far gradient, optional photo detail/mix
  float g = pow(d, uBase.x);
  vec3 col = g < uMidPos ? mix(uNearC, uMidC, g / max(uMidPos, 1e-4)) : mix(uMidC, uFarC, (g - uMidPos) / max(1.0 - uMidPos, 1e-4));
  col *= mix(1.0, lum * 2.0, uBase.w);
  vec3 phAdj = mix(vec3(lum), ph, uBase.z);
  col = mix(col, phAdj, uBase.y);

  // relief: light the depth surface like a sculpture
  if (uRelief.x > 0.0) {
    vec2 o = uRelief.w / uDepthSize;
    float dl = remap(texture(uDepth, uv - vec2(o.x, 0.0)).r);
    float dr = remap(texture(uDepth, uv + vec2(o.x, 0.0)).r);
    float du = remap(texture(uDepth, uv - vec2(0.0, o.y)).r);
    float dd = remap(texture(uDepth, uv + vec2(0.0, o.y)).r);
    vec2 gr = vec2(dr - dl, dd - du) * (60.0 / max(uRelief.w, 0.5));
    vec3 n = normalize(vec3(gr, 1.0));
    vec3 L = normalize(vec3(uRelief.y, uRelief.z, 0.9));
    float sh = clamp(dot(n, L) / L.z, 0.0, 2.0);
    col *= mix(1.0, sh, uRelief.x);
  }

  // iso-depth contour lines
  if (uContour.w > 0.5) {
    float N = uContour.x;
    float f = fract(d * N);
    float dist = min(f, 1.0 - f) / N;
    float m = lineMask(dist, fw, uContour.y);
    m *= (1.0 - smoothstep(0.2, 0.45, fw * N)) * (1.0 - edge);
    float k = floor(d * N + 0.5);
    if (k < 0.5 || k > N - 0.5) m = 0.0; // no line over clipped near/far regions (sky)
    col = mix(col, uContourColor, m * uContour.z);
  }

  // depth highlighters
  for (int i = 0; i < ${MAX_HL}; i++) {
    if (i >= uHlCount) break;
    vec4 A = uHlA[i], B = uHlB[i], C = uHlC[i], D = uHlD[i];
    if (D.z < 0.5) continue;
    float dist = abs(d - A.x);
    int style = int(C.x + 0.5);
    float m;
    if (style == 2) m = lineMask(dist, fw, D.x);
    else m = 1.0 - smoothstep(A.y, A.y + A.z + fw, dist);
    if (D.w > 0.0) m = m + (1.0 - m) * D.w * exp(-max(dist - A.y, 0.0) / max(A.w, 1e-4));
    m *= 1.0 - edge;
    vec3 fill = B.rgb;
    if (style == 1) fill = mix(ph, ph * B.rgb * 1.6, D.y);
    else fill *= mix(1.0, lum * 2.0, C.z);
    fill *= B.a;
    float w = clamp(m * C.w, 0.0, 1.0);
    int blend = int(C.y + 0.5);
    if (blend == 0) col = 1.0 - (1.0 - col) * (1.0 - clamp(fill, 0.0, 1.0) * w);
    else if (blend == 1) col = mix(col, fill, w);
    else if (blend == 2) col += fill * w;
    else col = mix(col, col * fill, w);
  }

  // finish
  col = max(col, 0.0) * uFinish2.z;
  col = (col - 0.5) * uFinish.w + 0.5;
  float cl = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(cl), col, uFinish2.w);
  if (uFinish.z > 0.0) {
    vec2 q = (p - (uImgRect.xy + uImgRect.zw * 0.5)) / (uImgRect.zw * 0.5);
    q.x *= uImgRect.z / uImgRect.w;
    float r = length(q) / max(1.0, uImgRect.z / uImgRect.w);
    col *= 1.0 - uFinish.z * smoothstep(0.35, 1.45, r);
  }
  if (uFinish.x > 0.0) {
    float cell = uFinish.y * 0.0006;
    float n = vnoise(p / cell + uFinish2.y) + vnoise(p / (cell * 0.57) + 17.0 + uFinish2.y) * 0.6 - 0.8;
    float amp = uFinish.x * 0.35 * min(1.0, cell / uPx);
    float lw = 0.35 + 2.6 * cl * (1.0 - cl);
    col += n * amp * lw;
  }
  col = clamp(col, 0.0, 1.0);

  // view modes for inspecting
  if (uView == 1 || (uSplit >= 0.0 && p.x < uSplit)) col = ph;
  else if (uView == 2) col = vec3(d);

  bool inImg = rel.x >= 0.0 && rel.x <= 1.0 && rel.y >= 0.0 && rel.y <= 1.0;
  if (!inImg) col = uBorderColor;
  if (uSigColor.a > 0.0) {
    vec2 sr = (p - uSigRect.xy) / uSigRect.zw;
    if (sr.x >= 0.0 && sr.x <= 1.0 && sr.y >= 0.0 && sr.y <= 1.0) {
      float a = textureLod(uSig, sr, 0.0).a * uSigColor.a;
      col = mix(col, uSigColor.rgb, a);
    }
  }
  if (uSplit >= 0.0) col = mix(col, vec3(1.0), (1.0 - smoothstep(0.0, 1.0, abs(p.x - uSplit) / uPx)) * 0.9);
  if (p.x < 0.0 || p.y < 0.0 || p.x > uArtW || p.y > 1.0) col = uBg;
  // dither before quantisation (off for float exports)
  col += (hash12(fc + uFinish2.y) - hash12(fc + 41.7 + uFinish2.y)) * uFinish2.x / 255.0;
  oColor = vec4(col, 1.0);
}`;

const BLEND = { screen: 0, normal: 1, add: 2, multiply: 3 };
const STYLE = { solid: 0, photo: 1, line: 2 };

export function hexToRgb(h) {
  const n = parseInt((h || '#000000').slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.floatRT = !!gl.getExtension('EXT_color_buffer_float');
    this.floatLinear = !!gl.getExtension('OES_texture_float_linear');
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.maxRB = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0], 4096);
    this.prog = this.#program(VS, FS);
    this.loc = {};
    const n = gl.getProgramParameter(this.prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(this.prog, i).name.replace(/\[0\]$/, '');
      this.loc[name] = gl.getUniformLocation(this.prog, name);
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const a = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    this.photo = this.#tex();
    this.depth = this.#tex();
    this.sig = this.#tex();
    this.photoSize = [1, 1];
    this.depthSize = [1, 1];
    this.sigAspect = 1;
    gl.bindTexture(gl.TEXTURE_2D, this.photo);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.setDepth(new Float32Array([0.5]), 1, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.sig);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  }

  #program(vs, fs) {
    const gl = this.gl;
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(p));
    return p;
  }

  #tex() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // source: ImageBitmap / canvas, already limited to maxTex
  setPhoto(source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.photo);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    this.photoSize = [source.width, source.height];
  }

  setDepth(data, w, h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.depth);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.floatLinear ? gl.R32F : gl.R16F, w, h, 0, gl.RED, gl.FLOAT, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.depthSize = [w, h];
  }

  setSignature(canvas) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.sig);
    if (!canvas) { this.sigAspect = 0; return; }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    this.sigAspect = canvas.width / canvas.height;
  }

  // view: { fbW, fbH, origin:[x,y], px, mode, split, bg, dither, hiQ }
  #draw(s, layout, view) {
    const gl = this.gl, L = this.loc;
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.photo); gl.uniform1i(L.uPhoto, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.depth); gl.uniform1i(L.uDepth, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.sig); gl.uniform1i(L.uSig, 2);
    gl.uniform2f(L.uFbSize, view.fbW, view.fbH);
    gl.uniform2f(L.uOrigin, view.origin[0], view.origin[1]);
    gl.uniform1f(L.uPx, view.px);
    gl.uniform1f(L.uArtW, layout.artW);
    const ir = layout.imgRect, sr = layout.srcRect;
    gl.uniform4f(L.uImgRect, ir.x, ir.y, ir.w, ir.h);
    gl.uniform4f(L.uSrcRect, sr.x, sr.y, sr.w, sr.h);
    gl.uniform2f(L.uPhotoSize, this.photoSize[0], this.photoSize[1]);
    gl.uniform2f(L.uDepthSize, this.depthSize[0], this.depthSize[1]);
    // bicubic when a photo texel covers more than ~0.8 output pixels
    const texelsPerPx = view.px / ir.h * sr.h * this.photoSize[1];
    gl.uniform1i(L.uHiQ, view.hiQ !== false && texelsPerPx < 1.25 ? 1 : 0);
    gl.uniform1i(L.uView, view.mode || 0);
    gl.uniform1f(L.uSplit, view.split ?? -1);
    gl.uniform3fv(L.uBg, view.bg || [0.07, 0.07, 0.08]);
    const f = s.frame;
    gl.uniform3fv(L.uBorderColor, hexToRgb(f.borderColor));
    const sg = s.signature, sgr = layout.sigRect;
    if (sgr && this.sigAspect > 0) {
      const w = sgr.h * this.sigAspect;
      const x = sgr.anchor === 'l' ? sgr.margin : sgr.anchor === 'c' ? layout.imgRect.x + layout.imgRect.w / 2 - w / 2 : sgr.right - w;
      gl.uniform4f(L.uSigRect, x, sgr.y, w, sgr.h);
      gl.uniform4f(L.uSigColor, ...hexToRgb(sg.color), sg.opacity ?? 1);
    } else gl.uniform4f(L.uSigColor, 0, 0, 0, 0);
    const dp = s.depth;
    gl.uniform4f(L.uRemap, dp.near, Math.max(dp.far, dp.near + 1e-4), dp.gamma, dp.invert ? 1 : 0);
    gl.uniform1f(L.uEdgeClean, dp.edgeClean ?? 0);
    const b = s.base;
    gl.uniform3fv(L.uNearC, hexToRgb(b.near));
    gl.uniform3fv(L.uMidC, hexToRgb(b.mid));
    gl.uniform3fv(L.uFarC, hexToRgb(b.far));
    gl.uniform1f(L.uMidPos, b.midPos);
    gl.uniform4f(L.uBase, b.curve, b.photo, b.photoSat, b.detail);
    const r = s.relief, ang = r.angle * Math.PI / 180;
    gl.uniform4f(L.uRelief, r.amount, Math.cos(ang) * 0.8, -Math.sin(ang) * 0.8, r.radius);
    const c = s.contours;
    gl.uniform4f(L.uContour, c.count, c.thickness, c.opacity, c.on ? 1 : 0);
    gl.uniform3fv(L.uContourColor, hexToRgb(c.color));
    const fi = s.finish;
    gl.uniform4f(L.uFinish, fi.grain, fi.grainSize, fi.vignette, fi.contrast);
    gl.uniform4f(L.uFinish2, view.dither ?? 1, fi.seed ?? 0, fi.exposure, fi.saturation);
    const hl = s.highlighters.slice(0, MAX_HL);
    const A = new Float32Array(MAX_HL * 4), B = new Float32Array(MAX_HL * 4), C = new Float32Array(MAX_HL * 4), D = new Float32Array(MAX_HL * 4);
    hl.forEach((h, i) => {
      const off = (view.hlOffset && view.hlOffset[i]) || 0;
      const wmul = (view.hlWidth && view.hlWidth[i]) || 1;
      A.set([h.center + off, h.width * wmul / 2, h.feather, h.glowRadius], i * 4);
      B.set([...hexToRgb(h.color), h.intensity], i * 4);
      C.set([STYLE[h.style] ?? 0, BLEND[h.blend] ?? 0, h.detail, h.opacity], i * 4);
      D.set([h.thickness, h.tint, h.on ? 1 : 0, h.glow], i * 4);
    });
    gl.uniform1i(L.uHlCount, hl.length);
    gl.uniform4fv(L.uHlA, A); gl.uniform4fv(L.uHlB, B); gl.uniform4fv(L.uHlC, C); gl.uniform4fv(L.uHlD, D);
    gl.viewport(0, 0, view.fbW, view.fbH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // draw to the visible canvas
  render(s, layout, view) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.#draw(s, layout, { ...view, fbW: this.canvas.width, fbH: this.canvas.height });
  }

  // Render a region of an output image of outW×outH pixels. Returns rows
  // top-down: Uint8Array RGBA, or Float32Array RGBA when float is true.
  renderRegion(s, layout, outH, x0, y0, w, h, { float = false, view = {} } = {}) {
    const gl = this.gl;
    const useFloat = float && this.floatRT;
    const key = `${w}x${h}x${useFloat}`;
    if (this.rtKey !== key) {
      if (this.rt) { gl.deleteFramebuffer(this.rt.fb); gl.deleteTexture(this.rt.tex); }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, useFloat ? gl.RGBA32F : gl.RGBA8, w, h);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.rt = { fb, tex };
      this.rtKey = key;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.rt.fb);
    const px = 1 / outH;
    this.#draw(s, layout, { mode: 0, split: -1, dither: useFloat ? 0 : 1, ...view, fbW: w, fbH: h, origin: [x0 * px, y0 * px], px });
    const out = useFloat ? new Float32Array(w * h * 4) : new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, useFloat ? gl.FLOAT : gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // flip to top-down rows
    const row = w * 4, tmp = out.slice(0, row);
    for (let y = 0; y < h >> 1; y++) {
      const a = y * row, b = (h - 1 - y) * row;
      tmp.set(out.subarray(a, a + row));
      out.copyWithin(a, b, b + row);
      out.set(tmp, b);
    }
    return out;
  }

  // small render into a 2D canvas (thumbnails, preset previews)
  renderToCanvas(s, layout, longEdge, view) {
    const w = layout.artW >= 1 ? longEdge : Math.max(1, Math.round(longEdge * layout.artW));
    const h = layout.artW >= 1 ? Math.max(1, Math.round(longEdge / layout.artW)) : longEdge;
    const px = this.renderRegion(s, layout, h, 0, 0, w, h, { view });
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0);
    return c;
  }
}
