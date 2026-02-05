#!/bin/bash
set -e

# EVC Team Relay - Plugin Installation Script
# This script installs the plugin to your Obsidian vault

VAULT_PATH="/Users/rogozhin/Obsidian/Rogozhin"
PLUGIN_DIR="$VAULT_PATH/.obsidian/plugins/evc-team-relay"
BUILD_DIR="$(dirname "$0")"

echo "🚀 Installing EVC Team Relay plugin..."
echo ""

# Check if vault exists
if [ ! -d "$VAULT_PATH" ]; then
    echo "❌ Error: Vault not found at $VAULT_PATH"
    exit 1
fi

# Create .obsidian/plugins directory if it doesn't exist
mkdir -p "$VAULT_PATH/.obsidian/plugins"

# Create plugin directory
echo "📁 Creating plugin directory..."
mkdir -p "$PLUGIN_DIR"

# Copy plugin files
echo "📦 Copying plugin files..."
cp "$BUILD_DIR/main.js" "$PLUGIN_DIR/"
cp "$BUILD_DIR/manifest.json" "$PLUGIN_DIR/"
cp "$BUILD_DIR/styles.css" "$PLUGIN_DIR/"
if [ -f "$BUILD_DIR/icon.svg" ]; then
    cp "$BUILD_DIR/icon.svg" "$PLUGIN_DIR/"
fi

# Create default data.json if it doesn't exist
if [ ! -f "$PLUGIN_DIR/data.json" ]; then
    echo "⚙️  Creating default configuration..."
    cat > "$PLUGIN_DIR/data.json" << 'EOF'
{
  "relayOnPrem": {
    "enabled": false,
    "controlPlaneUrl": "https://cp.5evofarm.entire.vc",
    "relayServerUrl": ""
  },
  "sharedFolders": [],
  "endpoints": {},
  "debugging": false
}
EOF
else
    echo "⚙️  Existing configuration found, keeping it..."
fi

echo ""
echo "✅ Installation complete!"
echo ""
echo "📝 Next steps:"
echo "1. Reload Obsidian (Ctrl+R or Cmd+R)"
echo "2. Go to Settings → Community Plugins"
echo "3. Enable 'EVC Team Relay'"
echo "4. Configure in Settings → EVC Team Relay"
echo ""
echo "🔑 Test credentials:"
echo "   - test@entire.vc / Test1234"
echo "   - demo@entire.vc / Demo1234"
echo "   - admin@entire.vc / Admin1234"
echo ""
echo "🌐 Control Plane: https://cp.5evofarm.entire.vc"
echo "🔗 Relay Server: https://relay.5evofarm.entire.vc"
echo ""
