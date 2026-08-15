#!/usr/bin/env bash
#
# Build the native Android core for the Keen 4·5·6 APK: DOSBox-X cross-compiled with
# the NDK into libmain.so, plus the two shared libraries it links against
# (libSDL2.so, libpng16.so), all from the SAME pinned DOSBox-X source tree.
#
# Everything is built from source — the APK ships no third-party prebuilt binaries.
# DOSBox-X vendors its own SDL2 fork (vs/sdl2) and libpng (vs/libpng), so the
# emulator, the SDL2 it links against, and the org.libsdl.app Java glue in the APK
# all come out of one checkout and can never drift apart in version.
#
# Pipeline:
#   1. Check the source out at the pinned tag (same tag the Linux build uses).
#   2. Clean the tree and apply patches/*.patch  +  the SHARED Keen patch
#      ../../native/patches/desktop-pogo.patch — one patch set, all platforms.
#   3. Per ABI: build libpng16.so and libSDL2.so (CMake + NDK), then configure and
#      compile DOSBox-X against them in a hermetic environment (host pkg-config and
#      host libs hidden so autotools can't false-positive on the dev box).
#   4. Link the objects as a SHARED library exporting SDL_main — SDLActivity
#      dlopen()s libmain.so and looks up SDL_main.
#   5. Verify the artifact and install it into app/src/main/jniLibs/<abi>/.
#   6. Copy the version-matched org.libsdl.app Java glue into the app.
#
# Usage:
#   ./native/build-android.sh                      # both ABIs
#   DBX_ABIS="x86_64" ./native/build-android.sh    # emulator only (fast iteration)
#   ANDROID_NDK=/path/to/ndk ./native/build-android.sh
#
set -euo pipefail

DOSBOX_X_VERSION="${DOSBOX_X_VERSION:-2026.08.02}"   # keep in sync with native/build-dosbox-x.sh
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"                        # android-native/
REPO="$(cd "$ROOT/.." && pwd)"                        # repo root
SRC="$HERE/dosbox-x"
TMP="$HERE/build"
API="${DBX_API:-28}"                                  # must match minSdk in app/build.gradle
read -r -a ABIS <<< "${DBX_ABIS:-arm64-v8a x86_64}"

# The Keen patch shared with the Linux build (desktop-pogo: Alt-hold pogo combo
# driven from SDL key state). filter-cycle is deliberately NOT here: it calls
# LoadGLShader, which only exists when DOSBox-X is built with OpenGL, and the
# Android build is --disable-opengl (GLES device GL + desktop-GLSL shaders).
SHARED_PATCHES=("$REPO/native/patches/desktop-pogo.patch")

note() { printf '\n\033[1;36m>> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mxx %s\033[0m\n' "$*" >&2; exit 1; }

# --- prerequisites --------------------------------------------------------
: "${ANDROID_NDK:=${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}}"
if [ -z "$ANDROID_NDK" ]; then
  # newest side-by-side NDK under the SDK
  for base in "${ANDROID_SDK_ROOT:-$HOME/android-sdk}" "${ANDROID_HOME:-$HOME/Android/Sdk}"; do
    [ -d "$base/ndk" ] || continue
    ANDROID_NDK="$(find "$base/ndk" -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)"
    [ -n "$ANDROID_NDK" ] && break
  done
fi
[ -n "$ANDROID_NDK" ] && [ -d "$ANDROID_NDK" ] || die "Set ANDROID_NDK to your NDK path"
TOOLCHAIN="$ANDROID_NDK/toolchains/llvm/prebuilt/linux-x86_64"
[ -d "$TOOLCHAIN" ] || die "NDK toolchain not found at $TOOLCHAIN"
note "NDK: $ANDROID_NDK (API $API)"

for t in autoconf automake libtoolize git patch; do
  command -v "$t" >/dev/null || die "missing host build tool: $t"
done
command -v nasm >/dev/null || warn "nasm not found — x86 optimizations will be disabled"

# CMake + ninja: prefer the SDK's bundled pair (the Android toolchain file is
# tested against it, and its bin/ carries the matching ninja). Fall back to host
# cmake only if the SDK has none.
CMAKE_BIN=""
for base in "${ANDROID_SDK_ROOT:-$HOME/android-sdk}" "${ANDROID_HOME:-$HOME/Android/Sdk}"; do
  [ -d "$base/cmake" ] || continue
  CMAKE_BIN="$(find "$base/cmake" -maxdepth 3 -name cmake -type f -path '*/bin/*' | sort -V | tail -1)"
  [ -n "$CMAKE_BIN" ] && break
done
if [ -n "$CMAKE_BIN" ]; then
  export PATH="$(dirname "$CMAKE_BIN"):$PATH"    # so CMake finds the bundled ninja
else
  command -v cmake >/dev/null || die "no cmake found (install the SDK's cmake package)"
  command -v ninja >/dev/null || die "cmake found but ninja missing — install ninja-build"
  CMAKE_BIN="$(command -v cmake)"
fi
note "cmake: $CMAKE_BIN"

# --- 1. source at the pinned tag -----------------------------------------
TAG="dosbox-x-v$DOSBOX_X_VERSION"
if [ ! -d "$SRC/.git" ]; then
  note "cloning DOSBox-X $TAG"
  git clone --depth 1 --branch "$TAG" https://github.com/joncampbell123/dosbox-x "$SRC"
else
  CUR="$(git -C "$SRC" describe --tags --always 2>/dev/null || echo unknown)"
  if [ "$CUR" != "$TAG" ]; then
    note "moving source $CUR -> $TAG"
    git -C "$SRC" fetch --depth 1 --force origin "refs/tags/$TAG:refs/tags/$TAG"
    git -C "$SRC" checkout -q --force "$TAG"
  fi
fi

# --- 2. clean tree + apply patches ---------------------------------------
note "resetting source tree"
git -C "$SRC" reset -q --hard
git -C "$SRC" clean -qfdx
shopt -s nullglob
for p in "$HERE"/patches/*.patch "${SHARED_PATCHES[@]}"; do
  note "applying $(basename "$p")"
  git -C "$SRC" apply --whitespace=nowarn "$p" || die "patch failed to apply: $(basename "$p")
     Upstream ($TAG) has moved under this patch, or an earlier patch changed its
     context. Refresh it:
       cd $SRC && git apply --3way $p    # resolve, then:
       git diff -- <files> > $p"
done

note "running autogen.sh (our patches touch configure.ac)"
( cd "$SRC" && ./autogen.sh ) >"$TMP-autogen.log" 2>&1 || { tail -20 "$TMP-autogen.log"; die "autogen.sh failed"; }

# --- helpers --------------------------------------------------------------
abi_triple() { case "$1" in
  arm64-v8a)   echo aarch64-linux-android ;;
  x86_64)      echo x86_64-linux-android ;;
  armeabi-v7a) echo armv7a-linux-androideabi ;;
  x86)         echo i686-linux-android ;;
  *)           echo unknown ;;
esac; }

# Build one of the vendored dependencies (vs/libpng, vs/sdl2) with its own CMake.
cmake_dep() {
  local name="$1" srcdir="$2" abi="$3" outdir="$4"; shift 4
  local bdir="$TMP/$abi/dep-$name"
  note "[$abi] building $name"
  rm -rf "$bdir"; mkdir -p "$bdir"
  "$CMAKE_BIN" -S "$srcdir" -B "$bdir" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK/build/cmake/android.toolchain.cmake" \
    -DANDROID_ABI="$abi" -DANDROID_PLATFORM="android-$API" \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$bdir/prefix" \
    "$@" >"$bdir/cmake.log" 2>&1 || { tail -30 "$bdir/cmake.log"; die "[$abi] $name configure failed"; }
  "$CMAKE_BIN" --build "$bdir" --parallel "$(nproc)" >>"$bdir/cmake.log" 2>&1 \
    || { tail -40 "$bdir/cmake.log"; die "[$abi] $name build failed"; }
  find "$bdir" -maxdepth 1 -name '*.so*' -type f -exec cp -P {} "$outdir/" \;
}

build_abi() {
  local ABI="$1" TRIPLE BUILD JNI LIBDIR SHIM
  TRIPLE="$(abi_triple "$ABI")"; [ "$TRIPLE" != unknown ] || die "unknown ABI $ABI"
  JNI="$ROOT/app/src/main/jniLibs/$ABI"
  BUILD="$TMP/$ABI/dosbox-x"
  LIBDIR="$TMP/$ABI/lib"
  SHIM="$TMP/$ABI/shim"
  rm -rf "$BUILD" "$LIBDIR" "$SHIM"; mkdir -p "$BUILD" "$LIBDIR" "$SHIM/bin" "$JNI" "$TMP/empty-pkgconfig"

  # --- 3a. the two vendored libraries, from this same source tree ---------
  cmake_dep libpng "$SRC/vs/libpng" "$ABI" "$LIBDIR" \
    -DPNG_SHARED=ON -DPNG_STATIC=OFF -DPNG_TESTS=OFF -DPNG_TOOLS=OFF \
    -DPNG_FRAMEWORK=OFF -DZLIB_INCLUDE_DIR="$TOOLCHAIN/sysroot/usr/include" \
    -DZLIB_LIBRARY="$TOOLCHAIN/sysroot/usr/lib/$TRIPLE/$API/libz.so"

  cmake_dep SDL2 "$SRC/vs/sdl2" "$ABI" "$LIBDIR" \
    -DSDL_SHARED=ON -DSDL_STATIC=OFF -DSDL_TEST=OFF

  [ -f "$LIBDIR/libSDL2.so" ] || ln -sf "$(ls "$LIBDIR"/libSDL2*.so | head -1)" "$LIBDIR/libSDL2.so"
  [ -f "$LIBDIR/libpng.so" ]  || ln -sf "$(ls "$LIBDIR"/libpng16.so* | head -1)" "$LIBDIR/libpng.so"

  # --- 3b. DOSBox-X ------------------------------------------------------
  # A fake sdl2-config so DOSBox-X's configure uses the in-tree SDL2 headers and
  # links the libSDL2.so we just built (the same one the APK ships).
  cat > "$SHIM/bin/sdl2-config" <<EOF
#!/bin/sh
case "\$1" in
  --cflags) echo "-I$SRC/vs/sdl2/include -D_REENTRANT" ;;
  --libs|--static-libs) echo "-L$LIBDIR -lSDL2" ;;
  --version) echo "2.32.10" ;;
esac
EOF
  chmod +x "$SHIM/bin/sdl2-config"

  local CC CXX
  CC="$TOOLCHAIN/bin/${TRIPLE}${API}-clang"
  CXX="$TOOLCHAIN/bin/${TRIPLE}${API}-clang++"
  export CC CXX
  export AR="$TOOLCHAIN/bin/llvm-ar" RANLIB="$TOOLCHAIN/bin/llvm-ranlib" STRIP="$TOOLCHAIN/bin/llvm-strip"
  export SDL2_CONFIG="$SHIM/bin/sdl2-config"
  export PKG_CONFIG_LIBDIR="$TMP/empty-pkgconfig" PKG_CONFIG_PATH=""
  export PATH="$SHIM/bin:$PATH"

  note "[$ABI] configuring DOSBox-X ($TRIPLE, API $API)"
  # --disable-opengl: Android GL is GLES and the glshader set is desktop GLSL, so
  # DOSBox-X renders through the SDL surface output (GPU-scaled by patch 0005/0006).
  # --disable-gamelink: uses shm_open, absent on bionic.
  ( cd "$BUILD" && "$SRC/configure" \
      --host="$TRIPLE" \
      --enable-sdl2 --disable-sdl2test --disable-sdltest \
      --disable-sdlnet --disable-x11 --disable-libslirp --disable-libfluidsynth \
      --disable-alsa-midi --disable-opengl --disable-gamelink \
      ac_cv_lib_asound_snd_pcm_open=no \
      ac_cv_lib_curses_initscr=no ac_cv_lib_ncurses_initscr=no \
      ac_cv_lib_pdcurses_initscr=no ac_cv_lib_tinfo_nodelay=no \
      ac_cv_lib_rt_main=no \
      CPPFLAGS="-I$SRC/vs/sdl2/include -I$SRC/vs/libpng -I$TMP/$ABI/dep-libpng -fPIC" \
      CFLAGS="-fPIC -O2" CXXFLAGS="-fPIC -O2" \
      LDFLAGS="-L$LIBDIR -Wl,-rpath-link,$LIBDIR -Wl,--allow-shlib-undefined -static-libstdc++" \
      LIBS="-lz -lm" ) \
    > "$BUILD/configure.log" 2>&1 \
    || { tail -30 "$BUILD/configure.log"; die "[$ABI] configure failed (see $BUILD/configure.log)"; }

  note "[$ABI] compiling DOSBox-X (this takes a while)"
  # -k: keep building every object even though the final *executable* link fails.
  # That failure is EXPECTED — SDL renames main() to SDL_main on Android, so the
  # executable has no main(). We only want the objects; we link our own shared
  # library below. Tolerate the make failure, but reject any real compile error.
  ( cd "$BUILD" && make -k -j"$(nproc)" ) > "$BUILD/make.log" 2>&1 || true
  if grep -qE '\.(cpp|cc|c|h):[0-9]+:[0-9]+: error:' "$BUILD/make.log"; then
    warn "[$ABI] source compile errors — first failures:"
    grep -m20 -E '\.(cpp|cc|c|h):[0-9]+:[0-9]+: error:' "$BUILD/make.log" >&2 || true
    die "[$ABI] compile failed. Fix the source under $SRC and capture it as a new
     native/patches/NNNN-*.patch, then re-run."
  fi

  # --- 4. link libmain.so ------------------------------------------------
  # Reuse DOSBox-X's own executable link command (guaranteeing every object,
  # archive and library in the right order) and only swap the output for a shared
  # library that keeps SDL_main exported. `make -n` prints it without running it.
  note "[$ABI] linking libmain.so"
  local linkcmd shared
  linkcmd="$( ( cd "$BUILD/src" && make -n dosbox-x 2>/dev/null ) | grep -E ' -o dosbox-x dosbox\.o' | tail -1 )"
  [ -n "$linkcmd" ] || die "[$ABI] could not find the dosbox-x link command (did the build change?)"
  shared="${linkcmd/ -o dosbox-x / -shared -Wl,-soname,libmain.so -o libmain.so }"
  ( cd "$BUILD/src" && eval "$shared" ) 2> "$BUILD/link.log" \
    || { tail -40 "$BUILD/link.log"; die "[$ABI] link failed (see $BUILD/link.log)"; }

  # --- 5. install + verify ----------------------------------------------
  "$STRIP" --strip-unneeded "$BUILD/src/libmain.so" -o "$JNI/libmain.so"
  cp -L "$LIBDIR/libSDL2.so" "$JNI/libSDL2.so"
  cp -L "$LIBDIR"/libpng16.so* "$JNI/libpng16.so"
  "$STRIP" --strip-unneeded "$JNI/libSDL2.so" "$JNI/libpng16.so"

  local syms needed
  syms="$("$TOOLCHAIN/bin/llvm-nm" -D --defined-only "$JNI/libmain.so")"
  [[ "$syms" == *" T SDL_main"* ]] \
    || die "[$ABI] libmain.so does not export SDL_main — SDLActivity cannot run it"
  [[ "$syms" == *"Java_com_awkto_keen456_Native_nativeSetEnv"* ]] \
    || die "[$ABI] libmain.so is missing the Keen JNI bridge (patch 0003 did not take)"
  needed="$("$TOOLCHAIN/bin/llvm-readelf" -d "$JNI/libmain.so")"
  if [[ "$needed" =~ NEEDED.*lib(rt|asound|curses|ncurses)\.so ]]; then
    die "[$ABI] libmain.so NEEDs a host-only library — Android will fail to load it"
  fi
  note "[$ABI] OK — libmain.so $(du -h "$JNI/libmain.so" | cut -f1), exports SDL_main + Keen JNI"
}

for ABI in "${ABIS[@]}"; do build_abi "$ABI"; done

# --- 6. version-matched SDL Java glue ------------------------------------
# Taken from the SAME source tree as the libSDL2.so above, so the Java and native
# halves of SDL can never be a version apart.
GLUE="$ROOT/app/src/main/java/org/libsdl/app"
note "refreshing SDL Java glue -> ${GLUE#$REPO/}"
mkdir -p "$GLUE"
cp "$SRC"/vs/sdl2/android-project/app/src/main/java/org/libsdl/app/*.java "$GLUE/"

note "done — ABIs: ${ABIS[*]}"
echo "Native libs are git-ignored build output; CI rebuilds them (cache key = tag + patch hash)."
