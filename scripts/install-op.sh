#!/usr/bin/env bash
# Downloads the 1Password CLI beta into .bin/op for the current build.
# The beta channel is required for `op run --environment`.
# Pin the version explicitly so builds are reproducible.

set -euo pipefail

OP_VERSION="${OP_VERSION:-2.35.0-beta.01}"
OP_BIN_DIR="${OP_BIN_DIR:-.bin}"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi

  echo "install-op: no SHA-256 tool found (need sha256sum or shasum)" >&2
  exit 1
}

lowercase() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

expected_sha256() {
  case "${OP_VERSION}:${os}:${op_arch}" in
    "2.35.0-beta.01:darwin:arm64")
      echo "0a07daa0bbb88c81ef0ab73e54a20eb7a9371374a58fb5ac6db56ef727d9b531"
      ;;
    "2.35.0-beta.01:darwin:amd64")
      echo "967e9ab535877df57bb4bb74d487005c8a1823aae378d9158e4407833ec86560"
      ;;
    "2.35.0-beta.01:linux:amd64")
      echo "a0dce54733cf331737a00e1491257f56886ace82c0a3d481c5cc33a9d7305bce"
      ;;
    "2.35.0-beta.01:linux:arm64")
      echo "1e598d0271de16f5a995c2014961cfe9111b11f05358ab73314454aeabb736cd"
      ;;
    *)
      echo "install-op: no pinned SHA-256 for ${OP_VERSION} (${os}/${op_arch})" >&2
      echo "install-op: set OP_SHA256 after verifying the release metadata" >&2
      exit 1
      ;;
  esac
}

arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) op_arch="amd64" ;;
  aarch64 | arm64) op_arch="arm64" ;;
  *) echo "install-op: unsupported arch: $arch" >&2; exit 1 ;;
esac

os="$(lowercase "$(uname -s)")"
case "$os" in
  linux | darwin) ;;
  *) echo "install-op: unsupported os: $os" >&2; exit 1 ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  echo "install-op: curl is required but not found" >&2
  exit 1
fi

if ! command -v unzip >/dev/null 2>&1; then
  echo "install-op: unzip is required but not found" >&2
  exit 1
fi

url="https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VERSION}/op_${os}_${op_arch}_v${OP_VERSION}.zip"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "install-op: downloading op ${OP_VERSION} (${os}/${op_arch})"
curl --fail --silent --show-error --location "$url" -o "$tmp/op.zip"

expected="${OP_SHA256:-$(expected_sha256)}"
actual="$(sha256 "$tmp/op.zip")"

if [[ "$(lowercase "$actual")" != "$(lowercase "$expected")" ]]; then
  echo "install-op: checksum mismatch for op ${OP_VERSION} (${os}/${op_arch})" >&2
  echo "install-op: expected $(lowercase "$expected")" >&2
  echo "install-op: got      $(lowercase "$actual")" >&2
  exit 1
fi

mkdir -p "$OP_BIN_DIR"
unzip -q -o "$tmp/op.zip" -d "$tmp"
mv "$tmp/op" "$OP_BIN_DIR/op"
chmod +x "$OP_BIN_DIR/op"

echo "install-op: installed $("$OP_BIN_DIR/op" --version) -> $OP_BIN_DIR/op"
