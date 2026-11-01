#!/bin/sh
# 拉取离线朗读需要的两样东西：sherpa-onnx 的 AAR 和中文语音模型。
#
# 为什么不在仓库里：模型 116MB、AAR 48MB，前者超过 GitHub 的单文件上限。
# 跑完这个脚本，`android/app/libs/` 和 `android/app/src/main/assets/sherpa-onnx/`
# 就齐了，之后的 `gradlew assembleDebug` 会把它打进 APK（约 156MB）。
#
# 用法：sh scripts/fetch-sherpa-model.sh
# 可重复执行：已存在的文件按大小校验后跳过，所以 CI 上拿缓存命中也走这一条。
set -e

VERSION=1.13.8
MODEL=vits-zh-hf-fanchen-C
# 脚本在 scripts/ 下，仓库根目录是它的上一级。
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP="$ROOT/.cache-sherpa"
BASE=https://github.com/k2-fsa/sherpa-onnx/releases/download

mkdir -p "$TMP" "$ROOT/android/app/libs" "$ROOT/android/app/src/main/assets/sherpa-onnx"

fetch() {  # $1 url  $2 output  $3 min-bytes
  if [ -f "$2" ] && [ "$(wc -c < "$2")" -ge "$3" ]; then
    echo "已有 $2"
    return
  fi
  for i in 1 2 3 4 5 6 7 8; do
    echo "下载 $1 (第 $i 次)"
    # 断点续传：GitHub 在国内经常半路断
    if curl -sSL -C - --max-time 600 -o "$2" "$1" && [ "$(wc -c < "$2")" -ge "$3" ]; then
      return
    fi
    sleep 2
  done
  echo "下载失败：$1" >&2
  exit 1
}

fetch "$BASE/v$VERSION/sherpa-onnx-$VERSION.aar" "$ROOT/android/app/libs/sherpa-onnx-$VERSION.aar" 48000000

# 模型已经解开过就不再动 tarball：本地第二次跑、CI 上缓存命中时都应该是空操作。
MODEL_DIR="$ROOT/android/app/src/main/assets/sherpa-onnx/$MODEL"
if [ ! -f "$MODEL_DIR/tokens.txt" ]; then
  fetch "$BASE/tts-models/$MODEL.tar.bz2" "$TMP/$MODEL.tar.bz2" 119000000
  rm -rf "$TMP/x" && mkdir -p "$TMP/x"
  tar xjf "$TMP/$MODEL.tar.bz2" -C "$TMP/x"
  cp -R "$TMP/x/$MODEL" "$ROOT/android/app/src/main/assets/sherpa-onnx/"
  # 模型包里带的 python / shell 脚本用不上，删掉能少几 KB 也少点噪音。
  rm -f "$MODEL_DIR"/*.py "$MODEL_DIR"/*.sh
fi

echo "好了。模型在 android/app/src/main/assets/sherpa-onnx/$MODEL"
