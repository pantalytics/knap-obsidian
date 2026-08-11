import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

// read minAppVersion from manifest.json and bump version to target version
let manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

// update versions.json with target version and minAppVersion from manifest.json
let versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));

// manifest-beta.json is what BRAT reads off the default branch for the beta
// channel. CI fails when it disagrees with manifest.json, and it used to be the
// one file `npm version` left behind, so every bump needed a manual edit that
// was only ever remembered by the build going red.
let beta = JSON.parse(readFileSync("manifest-beta.json", "utf8"));
beta.version = targetVersion;
writeFileSync("manifest-beta.json", JSON.stringify(beta, null, "\t"));
