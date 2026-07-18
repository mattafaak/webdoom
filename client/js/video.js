// WebGL2 renderer: the engine's 8-bit indexed framebuffer is uploaded as
// an R8 texture and palettized in the fragment shader (palette flashes
// cost a 256x1 texture upload, nothing more). Canvas2D fallback included.
//
// Per-frame timing is collected when window.__wd_perf is set (enabled by the
// ?perfmarks=1 query flag in main.js).  The perf object must be initialised
// before createRenderer() is called, but the draw() hot-path only pays for a
// single null-check per frame when profiling is disabled.

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
    mkTex(0);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, 320, 200);
    mkTex(1);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB8, 256, 1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.uniform1i(gl.getUniformLocation(prog, 'fb'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'pal'), 1);

    return {
        kind: 'webgl2',
        draw(framebuffer, palette, paletteDirty) {
            // (a) palette upload — only when palette changes (WebGL2: GPU does
            // the 64K indexed→RGBA expansion; JS side uploads 256×1 RGB texture).
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
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 320, 200, gl.RED, gl.UNSIGNED_BYTE, framebuffer);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            if (perf) perf.upload.push(performance.now() - t1);
        },
    };
}

function createRenderer2D(canvas) {
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(320, 200);
    const rgba = new Uint32Array(img.data.buffer);
    const lut = new Uint32Array(256);
    return {
        kind: 'canvas2d',
        draw(framebuffer, palette, paletteDirty) {
            // (a) palette expand — Canvas2D does the 64K indexed→RGBA lookup in JS
            const perf = window.__wd_perf;
            if (paletteDirty) {
                const t0 = perf ? performance.now() : 0;
                for (let i = 0; i < 256; i++)
                    lut[i] = 0xff000000 | (palette[i*3+2] << 16) | (palette[i*3+1] << 8) | palette[i*3];
                if (perf) perf.palette.push(performance.now() - t0);
            }
            // (b) pixel expansion + putImageData upload
            const t1 = perf ? performance.now() : 0;
            for (let i = 0; i < 64000; i++)
                rgba[i] = lut[framebuffer[i]];
            ctx.putImageData(img, 0, 0);
            if (perf) perf.upload.push(performance.now() - t1);
        },
    };
}
