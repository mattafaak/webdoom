# source this file: puts the pinned emcc on PATH.
# Pinned toolchain: emsdk 6.0.2 (shared install; run tools/setup-emsdk.sh if missing)
EMSDK_DIR="${EMSDK_DIR:-$HOME/projects/bee-kettle-doom/emsdk}"
EMSDK_VERSION=6.0.2

if [ ! -x "$EMSDK_DIR/upstream/emscripten/emcc" ]; then
    echo "emsdk not found at $EMSDK_DIR — run tools/setup-emsdk.sh" >&2
    return 1 2>/dev/null || exit 1
fi

source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
if ! emcc --version | head -1 | grep -q "$EMSDK_VERSION"; then
    echo "warning: emcc is not the pinned $EMSDK_VERSION:" >&2
    emcc --version | head -1 >&2
fi
