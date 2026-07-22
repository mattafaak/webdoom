#!/bin/bash
# tools/fetch-soundfont.sh — fetch the GeneralUser GS soundfont from your own
# server and install it for the GM music backend (task 17.2a).
#
# Usage: [SOUNDFONT_SRC=<ssh-host-or-url>] bash tools/fetch-soundfont.sh
#
# SOUNDFONT_SRC can be:
#   ssh host path:   user@myserver:~/soundfonts      (rsync, like fetch-wads.sh)
#   https:// URL:    https://my.server/soundfonts    (curl)
#   local path:      /path/to/my/soundfonts          (cp)
#
# Files expected in the source:
#   GeneralUser GS v1.471.sf2                  (or GS_v1.471.sf2)
#   LICENSE.txt  (or LICENSE-GeneralUser-GS.txt)
#
# After fetching, files are installed to:
#   soundfonts/generaluser-gs.sf2
#   soundfonts/LICENSE-GeneralUser-GS.txt
#
# The soundfonts/ directory is .gitignored — no .sf2 bytes enter the repo.
# The server that hosts the soundfont should also serve it over HTTPS for
# the browser GM backend.  This script is for local/CI operator setup only.
#
# GeneralUser GS license: free for use, redistribution allowed with credit.
# See https://schristiancollins.com/generaluser.php for the full license text.

set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${SOUNDFONT_SRC:-}"
DEST="soundfonts"
SF2_DEST="$DEST/generaluser-gs.sf2"
LIC_DEST="$DEST/LICENSE-GeneralUser-GS.txt"

mkdir -p "$DEST"

# ── Candidate filenames in source ────────────────────────────────────────────
SF2_NAMES=("GeneralUser GS v1.471.sf2" "GS_v1.471.sf2" "generaluser-gs.sf2" "GeneralUser_GS.sf2")
LIC_NAMES=("LICENSE.txt" "LICENSE-GeneralUser-GS.txt" "LICENSE" "license.txt")

if [ -z "$SRC" ]; then
    echo "ERROR: SOUNDFONT_SRC is not set."
    echo "  Set it to an ssh host path, https:// URL, or local directory:"
    echo "    SOUNDFONT_SRC=user@myserver:~/soundfonts bash tools/fetch-soundfont.sh"
    echo "    SOUNDFONT_SRC=https://my.server/soundfonts bash tools/fetch-soundfont.sh"
    echo "    SOUNDFONT_SRC=/path/to/local/soundfonts bash tools/fetch-soundfont.sh"
    exit 1
fi

echo "Fetching GeneralUser GS soundfont from: $SRC"

if [[ "$SRC" == https://* ]] || [[ "$SRC" == http://* ]]; then
    # HTTP(S) download
    SF2_URL=""
    LIC_URL=""
    for name in "${SF2_NAMES[@]}"; do
        encoded="${name// /%20}"
        if curl -fsIo /dev/null "$SRC/$encoded" 2>/dev/null; then
            SF2_URL="$SRC/$encoded"
            break
        fi
    done
    for name in "${LIC_NAMES[@]}"; do
        encoded="${name// /%20}"
        if curl -fsIo /dev/null "$SRC/$encoded" 2>/dev/null; then
            LIC_URL="$SRC/$encoded"
            break
        fi
    done
    if [ -z "$SF2_URL" ]; then
        echo "ERROR: could not find soundfont file at $SRC (tried: ${SF2_NAMES[*]})"
        exit 1
    fi
    echo "  Downloading $SF2_URL ..."
    curl -fL "$SF2_URL" -o "$SF2_DEST"
    # Optional integrity pin (17.2a review): export SOUNDFONT_SHA256=<hex> to
    # verify the download. Unset = trust the operator-controlled source
    # (fetch-wads.sh precedent).
    if [ -n "${SOUNDFONT_SHA256:-}" ]; then
        actual="$(sha256sum "$SF2_DEST" | cut -d' ' -f1)"
        if [ "$actual" != "$SOUNDFONT_SHA256" ]; then
            echo "ERROR: soundfont sha256 mismatch (expected $SOUNDFONT_SHA256, got $actual)"
            rm -f "$SF2_DEST"
            exit 1
        fi
        echo "  sha256 verified: $actual"
    fi
    if [ -n "$LIC_URL" ]; then
        curl -fL "$LIC_URL" -o "$LIC_DEST"
    else
        echo "  WARNING: license file not found at $SRC; please add it manually to $LIC_DEST"
    fi
elif [[ "$SRC" == *:* ]]; then
    # SSH/rsync path
    FOUND_SF2=""
    for name in "${SF2_NAMES[@]}"; do
        if rsync -t --partial --ignore-missing-args "$SRC/$name" "$SF2_DEST" 2>/dev/null &&
           [ -f "$SF2_DEST" ] && [ -s "$SF2_DEST" ]; then
            FOUND_SF2="$name"
            break
        fi
    done
    if [ -z "$FOUND_SF2" ]; then
        echo "ERROR: could not find soundfont file in $SRC (tried: ${SF2_NAMES[*]})"
        exit 1
    fi
    echo "  rsync'd: $FOUND_SF2"
    for name in "${LIC_NAMES[@]}"; do
        if rsync -t --partial --ignore-missing-args "$SRC/$name" "$LIC_DEST" 2>/dev/null &&
           [ -f "$LIC_DEST" ] && [ -s "$LIC_DEST" ]; then
            echo "  rsync'd: $name"
            break
        fi
    done
else
    # Local path
    FOUND_SF2=""
    for name in "${SF2_NAMES[@]}"; do
        if [ -f "$SRC/$name" ]; then
            cp "$SRC/$name" "$SF2_DEST"
            FOUND_SF2="$name"
            break
        fi
    done
    if [ -z "$FOUND_SF2" ]; then
        echo "ERROR: could not find soundfont file in $SRC (tried: ${SF2_NAMES[*]})"
        exit 1
    fi
    echo "  copied: $FOUND_SF2"
    for name in "${LIC_NAMES[@]}"; do
        if [ -f "$SRC/$name" ]; then
            cp "$SRC/$name" "$LIC_DEST"
            echo "  copied: $name"
            break
        fi
    done
fi

if [ ! -f "$SF2_DEST" ] || [ ! -s "$SF2_DEST" ]; then
    echo "ERROR: $SF2_DEST is missing or empty after fetch"
    exit 1
fi

SF2_SIZE=$(stat -c%s "$SF2_DEST" 2>/dev/null || stat -f%z "$SF2_DEST" 2>/dev/null || echo 0)
echo "Done: $SF2_DEST  ($(( SF2_SIZE / 1024 / 1024 )) MB)"

if [ ! -f "$LIC_DEST" ]; then
    echo "WARNING: $LIC_DEST not found — please add the GeneralUser GS license text manually."
    echo "  Download from: https://schristiancollins.com/generaluser.php"
fi
