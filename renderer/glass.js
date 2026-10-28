// Liquid glass: a WebGL port of the Metal shader in BarredEwe/LiquidGlass
// (MIT, github.com/BarredEwe/LiquidGlass). Like that library it bends a
// Gaussian-blurred snapshot of what sits behind the glass. A transparent
// window cannot see the desktop, so the island bends a screenshot of it; the
// panel's panes then bend the island.
const Glass = (() => {
  const VS = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

  // Uniform names follow the Metal original. Coordinates are device pixels
  // from the top left. The original sizes its refraction and rim bands by the
  // box height, which suits a button; on a tall panel that band reaches the
  // diagonal seam of the box SDF, so here both bands are fixed widths.
  // The original's per-frame grain is left out: on a large dark panel it reads
  // as TV static.
  const FS = `#version 300 es
precision highp float;
uniform sampler2D sharpTex;
uniform sampler2D blurTex;
uniform vec2 resolution;
uniform vec4 box;
uniform float cornerRadius;
uniform float blurScale;
uniform vec3 tintColor;
uniform float tintAlpha;
uniform vec2 light;
uniform float opacity;
uniform float fromFrame;
uniform float px;
out vec4 outColor;

float boxSDF(vec2 p, vec2 size, float r) {
  vec2 q = abs(p) - size * 0.5 + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

// The original hashes x and y apart, which draws faint columns; this one
// mixes them.
vec2 randomVec2(vec2 co) {
  vec2 seed = fract(co * 0.12345 + vec2(4.44, 7.77));
  return fract(sin(vec2(dot(seed, vec2(127.1, 311.7)), dot(seed, vec2(269.5, 183.3)))) * 43758.5453);
}

// Top-left coordinates to texture coordinates. A rendered frame (the island,
// under a pane) is stored bottom-up; an uploaded image is stored top-down.
vec2 tc(vec2 p) { return fromFrame > 0.5 ? vec2(p.x, 1.0 - p.y) : p; }

vec3 saturateColor(vec3 c, float f) {
  return mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, f);
}

vec3 blurredColor(vec2 uv) {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    vec2 jitter = randomVec2(uv + vec2(float(i) * 0.25)) * 0.5;
    sum += texture(blurTex, tc(uv + jitter / resolution.x)).rgb;
  }
  vec3 avg = saturateColor(sum / 9.0, 1.8);
  return mix(avg, avg * avg, 0.45);
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, resolution.y - gl_FragCoord.y);
  vec2 uv = frag / resolution;
  float sdf = boxSDF(frag - box.xy - box.zw * 0.5, box.zw, cornerRadius);
  vec2 g = vec2(dFdx(sdf), -dFdy(sdf));
  vec2 grad = g / max(length(g), 1e-4);

  vec3 base = texture(sharpTex, tc(uv)).rgb;
  float weight = pow(blurScale, 1.5);

  // Refraction: pull the image inward toward the rim, as a lens does.
  vec2 refract = grad * exp(sdf / (14.0 * px)) * -0.16 * min(box.w, 90.0 * px) / resolution;
  vec2 split = refract * 0.08;
  vec2 at = uv + refract;
  vec3 blurred = vec3(blurredColor(at + split).r, blurredColor(at).g, blurredColor(at - split).b);
  vec3 mixed = mix(base, blurred, weight);

  // Rim light on the edges that face the light.
  float facing = clamp(1.0 - abs(dot(grad, light)), 0.0, 1.0);
  mixed += clamp((1.0 - sqrt(facing)) * exp(sdf / (2.0 * px)), 0.0, 1.0) * 0.5;

  mixed = mix(mixed, tintColor, tintAlpha * weight);
  mixed = mix(mixed, vec3(0.96, 0.98, 1.0), 0.06 * weight);

  float a = clamp(0.5 - sdf, 0.0, 1.0) * opacity;
  outColor = vec4(mixed * a, a);
}`;

  const COPY = `#version 300 es
precision highp float;
uniform sampler2D src;
uniform vec2 resolution;
out vec4 outColor;
void main() { outColor = texture(src, gl_FragCoord.xy / resolution); }`;

  // The island is dark enough for white text on any wallpaper; panes lift a
  // little off it.
  const ISLAND = { blurScale: 1, tintColor: [0.05, 0.05, 0.07], tintAlpha: 0.72 };
  const PANE = { blurScale: 0.35, tintColor: [1, 1, 1], tintAlpha: 0.1 };
  const BLUR_PX = 18;

  let gl = null, canvas = null, island = null, panel = null;
  let glassProg, copyProg, U = {}, CU = {};
  let sharpTex, blurTex, fbo, fboTex, fboSize = [0, 0];
  let lightNow = 136, lightTo = 136, lastFrame = 0;
  let running = false;

  function compile(fs) {
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(prog, sh);
    }
    gl.bindAttribLocation(prog, 0, 'p');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    return prog;
  }

  function uniforms(prog, names) {
    const out = {};
    for (const n of names) out[n] = gl.getUniformLocation(prog, n);
    return out;
  }

  function texture() {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([18, 18, 22, 255]));
    return t;
  }

  function init(opts) {
    island = opts.island;
    panel = opts.panel;
    canvas = document.createElement('canvas');
    canvas.id = 'glass';
    opts.stage.prepend(canvas);
    gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) throw new Error('no WebGL2');
    glassProg = compile(FS);
    copyProg = compile(COPY);
    U = uniforms(glassProg, ['sharpTex', 'blurTex', 'resolution', 'box', 'cornerRadius', 'blurScale', 'tintColor', 'tintAlpha', 'light', 'opacity', 'fromFrame', 'px']);
    CU = uniforms(copyProg, ['src', 'resolution']);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    sharpTex = texture();
    blurTex = texture();
    fboTex = texture();
    fbo = gl.createFramebuffer();
    setLight(opts.lightAngle || 136);
  }

  // The snapshot is uploaded twice: sharp, and Gaussian-blurred the way the
  // library's texture provider blurs it before the shader runs.
  function setBackdrop(img) {
    if (!gl) return;
    const w = img.naturalWidth, h = img.naturalHeight;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const pad = BLUR_PX * 3;
    ctx.filter = `blur(${BLUR_PX * (w / innerWidth)}px)`;
    ctx.drawImage(img, -pad, -pad, w + pad * 2, h + pad * 2);
    for (const [tex, src] of [[sharpTex, img], [blurTex, c]]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    }
  }

  // Degrees, 0 = light from the right, 90 = from above. Unless instant, the
  // light eases toward the new angle over about half a second.
  function setLight(deg, instant) {
    lightTo = deg;
    if (instant) lightNow = deg;
  }

  function lightVector(now) {
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0;
    lastFrame = now;
    const diff = ((lightTo - lightNow) % 360 + 540) % 360 - 180;
    lightNow += diff * (1 - Math.exp(-dt / 0.18));
    const r = lightNow * Math.PI / 180;
    return [Math.cos(r) * Math.SQRT2, -Math.sin(r) * Math.SQRT2];
  }

  function resize() {
    const dpr = devicePixelRatio || 1;
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (fboSize[0] !== w || fboSize[1] !== h) {
      gl.bindTexture(gl.TEXTURE_2D, fboTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
      fboSize = [w, h];
    }
    return dpr;
  }

  function drawBox(rect, radius, look, opacity, sharp, blur, clip, dpr) {
    const H = canvas.height;
    const x0 = Math.max(0, Math.floor(clip.left * dpr)), y0 = Math.max(0, Math.floor(clip.top * dpr));
    const x1 = Math.min(canvas.width, Math.ceil(clip.right * dpr)), y1 = Math.min(H, Math.ceil(clip.bottom * dpr));
    if (x1 <= x0 || y1 <= y0) return;
    gl.scissor(x0, H - y1, x1 - x0, y1 - y0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sharp);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, blur);
    gl.uniform4f(U.box, rect.left * dpr, rect.top * dpr, rect.width * dpr, rect.height * dpr);
    gl.uniform1f(U.cornerRadius, Math.min(radius, rect.width / 2, rect.height / 2) * dpr);
    gl.uniform1f(U.blurScale, look.blurScale);
    gl.uniform3fv(U.tintColor, look.tintColor);
    gl.uniform1f(U.tintAlpha, look.tintAlpha);
    gl.uniform1f(U.opacity, opacity);
    gl.uniform1f(U.fromFrame, sharp === fboTex ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  const inter = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });

  // Pass one draws the island into a texture; pass two copies it to the
  // screen and draws each visible pane over it, bending that texture.
  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    const dpr = resize();
    const rect = island.getBoundingClientRect();
    const style = getComputedStyle(island);
    const opacity = parseFloat(style.opacity);
    const radius = parseFloat(style.borderTopLeftRadius) * (rect.width / island.offsetWidth || 1);
    gl.viewport(0, 0, canvas.width, canvas.height);

    gl.useProgram(glassProg);
    gl.uniform1i(U.sharpTex, 0);
    gl.uniform1i(U.blurTex, 1);
    gl.uniform2f(U.resolution, canvas.width, canvas.height);
    const light = lightVector(performance.now());
    gl.uniform2f(U.light, light[0], light[1]);
    gl.uniform1f(U.px, dpr);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    drawBox(rect, radius, ISLAND, 1, sharpTex, blurTex, rect, dpr);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.SCISSOR_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(copyProg);
    gl.uniform1i(CU.src, 0);
    gl.uniform2f(CU.resolution, canvas.width, canvas.height);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fboTex);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    canvas.style.opacity = opacity;

    const paneOpacity = island.dataset.view === 'panel' ? parseFloat(getComputedStyle(panel).opacity) : 0;
    if (paneOpacity < 0.01) return;
    gl.useProgram(glassProg);
    gl.enable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const el of panel.querySelectorAll('.pane')) {
      if (el.hidden || el.closest('[hidden]')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const scroller = el.parentElement.closest('.feed, .chats');
      const clip = scroller ? inter(inter(r, scroller.getBoundingClientRect()), rect) : inter(r, rect);
      drawBox(r, parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, PANE, paneOpacity, fboTex, fboTex, clip, dpr);
    }
  }

  function run(on) {
    if (!gl || on === running) return;
    running = on;
    if (on) requestAnimationFrame(frame);
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clear(gl.COLOR_BUFFER_BIT); }
  }

  return { init, setBackdrop, setLight, run };
})();
