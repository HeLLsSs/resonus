const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// expo-router arrastra expo-symbols y con él ~6 MB de fuentes MaterialSymbols
// en 7 pesos que solo usan SymbolView/NativeTabs, que esta app no usa
// (expo/expo#43614). Resolvemos ese paquete a un stub para que Metro no
// empaquete las fuentes. Si algún día usamos NativeTabs, quitar esto.
//
// An icon carries its size as a number on the spot, in some four hundred
// places, so a television would keep phone-sized icons beside text that has
// grown by half. Each icon set is answered with a wrapper that runs the size
// through the same scaling as the type ladder (see `src/lib/tvIcons`); on a
// phone the factor is one and the wrapper is the icon. The wrappers import the
// package's `build/` path, which is why this does not point at itself.
const TV_ICON_SETS = ['Ionicons', 'MaterialCommunityIcons', 'MaterialIcons'];

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('@expo-google-fonts/material-symbols')) {
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, 'src/stubs/material-symbols.js'),
    };
  }
  for (const set of TV_ICON_SETS) {
    if (moduleName === `@expo/vector-icons/${set}`) {
      return {
        type: 'sourceFile',
        filePath: path.resolve(__dirname, `src/lib/tvIcons/${set}.tsx`),
      };
    }
  }
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

// The web build of expo-sqlite ships its engine as a .wasm file, which Metro
// only bundles once told it is an asset. Nothing on a phone reads this line.
config.resolver.assetExts.push('wasm');

module.exports = config;
