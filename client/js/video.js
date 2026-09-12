// WebGL2 renderer: the engine's 8-bit indexed framebuffer is uploaded as
// an R8 texture and palettized in the fragment shader (palette flashes
// cost a 256x1 texture upload, nothing more). Canvas2D fallback included.
//
// Per-frame timing is collected when window.__wd_perf is set (enabled by the
// ?perfmarks=1 query flag in main.js).  The perf object must be initialised
// before createRenderer() is called, but the draw() hot-path only pays for a
// single null-check per frame when profiling is disabled.
//
// The framebuffer is 320x200 and cannot change size.  Task 18.3 made it
// resizable for Hor+ widescreen and layered a Panini remap on top of that in
// the fragment shader; both were removed with widescreen itself, so there is
// no resize() and no shader uniform left to set.

const VS = `#version 300 es
layout(location=0) in vec2 pos;
out vec2 uv;
void main() { uv = pos * vec2(.5, -.5) + .5; gl_Position = vec4(pos, 0, 1); }`;

const FS = `#version 300 es
precision mediump float;
uniform sampler2D fb, pal;
in vec2 uv; out vec4 color;
void main() {
    float idx = texture(fb, uv).r * 255.0;
    color = texture(pal, vec2((idx + .5) / 256.0, .5));
}`;

export function createRenderer(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false });
    if (!gl) return createRenderer2D(canvas);

    const prog = gl.createProgram();
    const _shaders = [];    // for dispose() (task 23.7b); deleteProgram only DETACHES
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
        const sh = gl.createShader(type);
        _shaders.push(sh);
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
    const _textures = [];   // for dispose() (task 23.7b)
    const mkTex = unit => {
        const t = gl.createTexture();
        _textures.push(t);
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

    // Framebuffer texture — R8, 320x200, immutable.
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

    return {
        kind: 'webgl2',

        // Task 23.7b: createRenderer runs per boot and getContext returns the
        // SAME context for the same canvas, so each boot leaked a program, two
        // shaders, a VBO and two textures with nothing ever deleting them.
        //
        // This body lived in createRenderer2D until this commit, where every
        // name in it -- gl, prog, quad, _textures -- was a local of THIS
        // function.  So the WebGL2 path, which is the one every real browser
        // takes, had no dispose at all: main.js's `h?.dispose?.()` found no
        // method and silently did nothing, while the canvas2d path threw
        // ReferenceError into its own catch.  The fix shipped and never ran,
        // and browser-teardown-test.mjs named these objects in its header while
        // measuring only DOM nodes.  It counts them now.
        dispose() {
            try {
                gl.deleteProgram(prog);
                for (const sh of _shaders) gl.deleteShader(sh);
                gl.deleteBuffer(quad);
                for (const t of _textures) gl.deleteTexture(t);
            } catch { /* context already lost */ }
            _shaders.length = 0;
            _textures.length = 0;
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
    // The framebuffer is a fixed 320x200, so there is nothing to resize.
    const ctx = canvas.getContext('2d');
    let img = ctx.createImageData(320, 200);
    let rgba = new Uint32Array(img.data.buffer);
    let currentW = 320, currentH = 200;
    const lut = new Uint32Array(256);


    return {
        // Task 23.7b: this path allocates no GL objects -- its per-boot cost is
        // the ImageData and the palette LUT, both plain JS, collected once this
        // object is dropped.  Kept as an explicit no-op so both renderers have
        // the same shape and an ABSENT dispose can never again read to
        // main.js's `h?.dispose?.()` as "nothing needed freeing".
        dispose() {
            img  = null;
            rgba = null;
        },

        kind: 'canvas2d',


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
