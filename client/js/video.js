// WebGL2 renderer: the engine's 8-bit indexed framebuffer is uploaded as
// an R8 texture and palettized in the fragment shader (palette flashes
// cost a 256x1 texture upload, nothing more). Canvas2D fallback included.
//
// Per-frame timing is collected when window.__wd_perf is set (enabled by the
// ?perfmarks=1 query flag in main.js).  The perf object must be initialised
// before createRenderer() is called, but the draw() hot-path only pays for a
// single null-check per frame when profiling is disabled.
//
// Dynamic canvas/texture sizing (task 18.3):
//   texStorage2D is immutable — on resize the framebuffer texture is deleted
//   and recreated.  Call renderer.resize(w, h) before the frame that uses the
//   new dimensions.  Palette texture (256×1) is immutable and never resized.
//
// Panini/cylindrical remap (task 18.3):
//   Progressive horizontal barrel remap in the fragment shader.  Strength 0
//   at 4:3 aspect (identity), moderate at 21:9+.  OFF by default; controlled
//   by renderer.setPaniniStrength(s).  Outside all engine goldens (the shader
//   operates on JS-side UV, not the engine framebuffer).

const VS = `#version 300 es
layout(location=0) in vec2 pos;
out vec2 uv;
void main() { uv = pos * vec2(.5, -.5) + .5; gl_Position = vec4(pos, 0, 1); }`;

// paniniStrength: 0.0 = identity (OFF by default); set via setPaniniStrength().
// Cylindrical barrel remap — horizontal only:
//   cx (centered [-1,1]) → cx / (1 + paniniStrength * cx²)
//   Centre unchanged; edges compressed inward → natural panoramic look on
//   wide-aspect framebuffers.  Strength capped at 0.4 by JS to stay moderate.
const FS = `#version 300 es
precision mediump float;
uniform sampler2D fb, pal;
uniform float paniniStrength;
in vec2 uv; out vec4 color;
void main() {
    vec2 st = uv;
    if (paniniStrength > 0.001) {
        float cx = st.x * 2.0 - 1.0;
        float sx = cx / (1.0 + paniniStrength * cx * cx);
        st.x = clamp(sx * 0.5 + 0.5, 0.0, 1.0);
    }
    float idx = texture(fb, st).r * 255.0;
    color = texture(pal, vec2((idx + .5) / 256.0, .5));
}`;

export function createRenderer(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false });
    if (!gl) return createRenderer2D(canvas);

    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
            throw new Error(gl.getShaderInfoLog(sh));
        gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Create a texture bound to the given unit with nearest-neighbour params.
    const mkTex = unit => {
        const t = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
    };

    // Palette texture — 256×1 RGB8, immutable (never resized).
    mkTex(1);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB8, 256, 1);

    // Framebuffer texture — R8, resizable via resize().
    // texStorage2D is immutable: resize deletes and recreates the texture.
    let fbTex = null;
    let currentW = 0, currentH = 0;

    function allocFbTex(w, h) {
        if (fbTex) gl.deleteTexture(fbTex);
        fbTex = mkTex(0);            // activeTexture(TEXTURE0), create+bind
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, w, h);
        currentW = w;
        currentH = h;
    }

    allocFbTex(320, 200); // initial allocation

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.uniform1i(gl.getUniformLocation(prog, 'fb'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'pal'), 1);
    const locPanini = gl.getUniformLocation(prog, 'paniniStrength');
    gl.uniform1f(locPanini, 0.0); // OFF by default

    return {
        kind: 'webgl2',

        // Resize the framebuffer texture (and canvas attributes) to w×h.
        // No-op if dimensions are unchanged.  Called by main.js when
        // doom._web_screenwidth() changes after a deferred web_set_wide() call.
        resize(w, h) {
            if (w === currentW && h === currentH) return;
            allocFbTex(w, h);
            canvas.width  = w;
            canvas.height = h;
            gl.viewport(0, 0, w, h);
        },

        // Set the Panini/cylindrical remap strength (0.0 = identity/OFF).
        // Computed from aspect ratio in main.js; 0 when panini setting is false.
        setPaniniStrength(s) {
            gl.uniform1f(locPanini, s);
        },

        draw(framebuffer, palette, paletteDirty) {
            // (a) palette upload — only when palette changes
            const perf = window.__wd_perf;
            if (paletteDirty) {
                const t0 = perf ? performance.now() : 0;
                gl.activeTexture(gl.TEXTURE1);
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGB, gl.UNSIGNED_BYTE, palette);
                if (perf) perf.palette.push(performance.now() - t0);
            }
            // (b) framebuffer texture upload + GPU draw
            const t1 = perf ? performance.now() : 0;
            gl.activeTexture(gl.TEXTURE0);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, currentW, currentH, gl.RED, gl.UNSIGNED_BYTE, framebuffer);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            if (perf) perf.upload.push(performance.now() - t1);
        },
    };
}

function createRenderer2D(canvas) {
    // Canvas2D fallback: explicit degradation when WebGL2 is unavailable.
    // Width/height track the current render dimensions; resize() is supported
    // but emits a loud status notice (cannot match WebGL2 quality).
    const ctx = canvas.getContext('2d');
    let img = ctx.createImageData(320, 200);
    let rgba = new Uint32Array(img.data.buffer);
    let currentW = 320, currentH = 200;
    const lut = new Uint32Array(256);

    // Loud degradation: users are aware this path has limited resize support.
    const _status = typeof document !== 'undefined' && document.getElementById?.('status');

    return {
        kind: 'canvas2d',

        resize(w, h) {
            if (w === currentW && h === currentH) return;
            currentW = w; currentH = h;
            canvas.width  = w;
            canvas.height = h;
            img  = ctx.createImageData(w, h);
            rgba = new Uint32Array(img.data.buffer);
            if (_status) {
                _status.textContent =
                    `canvas2d: resized to ${w}×${h} — WebGL2 not available; wide mode may look stretched`;
            }
        },

        setPaniniStrength(_s) { /* no-op: canvas2d path does not implement shader remap */ },

        draw(framebuffer, palette, paletteDirty) {
            // (a) palette expand
            const perf = window.__wd_perf;
            if (paletteDirty) {
                const t0 = perf ? performance.now() : 0;
                for (let i = 0; i < 256; i++)
                    lut[i] = 0xff000000 | (palette[i*3+2] << 16) | (palette[i*3+1] << 8) | palette[i*3];
                if (perf) perf.palette.push(performance.now() - t0);
            }
            // (b) pixel expansion + putImageData upload
            const t1 = perf ? performance.now() : 0;
            const n = currentW * currentH;
            for (let i = 0; i < n; i++)
                rgba[i] = lut[framebuffer[i]];
            ctx.putImageData(img, 0, 0);
            if (perf) perf.upload.push(performance.now() - t1);
        },
    };
}
