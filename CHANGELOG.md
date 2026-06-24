# Changelog

## 1.1.33
- Fix ESLint issues in test files and build scripts (no-restricted-imports, unused vars, empty blocks)
- Replace deprecated setWarning() with setDestructive() in ShareManagementModal
- Remove unused eslint-disable directives in MockTimeProvider
- Add CHANGELOG

## 1.1.32
- Fix forbidden eslint-disable directives on obsidianmd rules
- Fix ShareManagementModal UI text to sentence-case

## 1.1.31
- Fix all bare-timer usage (window.setTimeout/setInterval/clearTimeout/clearInterval)
- Fix activeDocument usage (replace bare document. references)
- Fix globalThis usage
- Fix CSS: remove !important, :has(), text-decoration rules
- Wire eslint-plugin-obsidianmd

## 1.1.30
- Initial community review fixes
