#!/usr/bin/env bash

set -euo pipefail

mode="${1:-}"
publish_target="${2:-}"

if [[ "${mode}" != "--publish" ]]; then
  echo "usage: bash scripts/corehub-cli-npm-publish.sh --publish [package.tgz]" >&2
  exit 2
fi

if [[ -n "${publish_target}" && -f "${publish_target}" ]]; then
  case "${publish_target}" in
    /*|./*|../*) ;;
    *) publish_target="./${publish_target}" ;;
  esac
fi

package_metadata="$(
  node --input-type=module <<'EOF'
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf8"));
process.stdout.write(JSON.stringify({ name: pkg.name, version: pkg.version, private: pkg.private === true }));
EOF
)"

package_name="$(printf '%s' "$package_metadata" | node -e 'const chunks=[]; process.stdin.on("data", c => chunks.push(c)); process.stdin.on("end", () => process.stdout.write(JSON.parse(Buffer.concat(chunks).toString()).name ?? ""));')"
package_version="$(printf '%s' "$package_metadata" | node -e 'const chunks=[]; process.stdin.on("data", c => chunks.push(c)); process.stdin.on("end", () => process.stdout.write(JSON.parse(Buffer.concat(chunks).toString()).version ?? ""));')"
package_private="$(printf '%s' "$package_metadata" | node -e 'const chunks=[]; process.stdin.on("data", c => chunks.push(c)); process.stdin.on("end", () => process.stdout.write(String(JSON.parse(Buffer.concat(chunks).toString()).private)));')"

if [[ "${package_private}" == "true" ]]; then
  echo "${package_name} is still marked private in package.json." >&2
  echo "Real npm publish requires explicit release approval and package.json private=false." >&2
  exit 1
fi

if [[ -z "${package_version}" ]]; then
  echo "Unable to resolve package.json version." >&2
  exit 1
fi

if [[ ! "${package_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "CoreHub CLI npm publish only supports stable X.Y.Z versions; found ${package_version}." >&2
  exit 1
fi

echo "Resolved package: ${package_name}@${package_version}"
echo "Resolved npm dist-tag: latest"
echo "Publish auth: GitHub OIDC trusted publishing"
if [[ -n "${publish_target}" ]]; then
  echo "Resolved publish target: ${publish_target}"
  npm publish "${publish_target}" --access public --tag latest --provenance
  exit 0
fi

npm publish --access public --tag latest --provenance
